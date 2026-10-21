import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  sourcePaths,
  type ValidationSettings
} from '../../validate-deployment/src/validation';
import { shaSchema } from './history';

function git(workspace: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    throw new Error(
      'Git release check failed. Fetch complete branch history and verify commit ancestry.'
    );
  }
}

export function assertAncestor(
  workspace: string,
  ancestor: string,
  descendant: string
): void {
  git(workspace, [
    'merge-base',
    '--is-ancestor',
    shaSchema.parse(ancestor),
    shaSchema.parse(descendant)
  ]);
}

export type SourceSelection = 'full-branch' | 'commit-range' | 'branch-changes';
export interface SourceRange {
  selection: SourceSelection;
  branchSha: string;
  headSha: string;
  baseSha?: string;
  startSha?: string;
  comparisonSha?: string;
}

export function selectSourceRange(
  workspace: string,
  selection: SourceSelection,
  branchSha: string,
  options: { startSha?: string; endSha?: string; comparisonSha?: string } = {}
): SourceRange {
  shaSchema.parse(branchSha);
  if (selection === 'full-branch') {
    if (options.startSha || options.endSha || options.comparisonSha) {
      throw new Error(
        'Full Branch takes only a source branch, not commit or comparison inputs.'
      );
    }
    return { selection, branchSha, headSha: branchSha };
  }
  if (selection === 'commit-range') {
    if (!options.startSha || !options.endSha || options.comparisonSha) {
      throw new Error(
        'Commit Range requires start and end commits on the selected branch.'
      );
    }
    const startSha = shaSchema.parse(options.startSha);
    const headSha = shaSchema.parse(options.endSha);
    assertAncestor(workspace, startSha, headSha);
    assertAncestor(workspace, headSha, branchSha);
    const parents = git(workspace, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      startSha
    ])
      .trim()
      .split(' ');
    return { selection, branchSha, headSha, startSha, baseSha: parents[1] };
  }
  if (!options.comparisonSha || options.startSha || options.endSha) {
    throw new Error(
      'Branch Changes requires a comparison branch, not commit inputs.'
    );
  }
  const comparisonSha = shaSchema.parse(options.comparisonSha);
  const baseSha = git(workspace, [
    'merge-base',
    branchSha,
    comparisonSha
  ]).trim();
  return {
    selection,
    branchSha,
    headSha: branchSha,
    comparisonSha,
    baseSha: shaSchema.parse(baseSha)
  };
}

export function releaseSources(
  workspace: string,
  headSha: string,
  branchSha: string,
  settings: ValidationSettings,
  baseSha?: string,
  emptyBase = false
): { sources: string[]; payloadHash: string } {
  shaSchema.parse(headSha);
  shaSchema.parse(branchSha);
  if (
    realpathSync(workspace) !==
      realpathSync(git(workspace, ['rev-parse', '--show-toplevel']).trim()) ||
    git(workspace, ['rev-parse', 'HEAD']).trim() !== headSha ||
    git(workspace, ['status', '--porcelain', '--untracked-files=all']).trim()
  ) {
    throw new Error(
      'Release metadata must be a clean project-root checkout of the pinned source commit.'
    );
  }
  assertAncestor(workspace, headSha, branchSha);
  if (baseSha) assertAncestor(workspace, baseSha, headSha);
  if (!baseSha && settings.mode === 'delta' && !emptyBase) {
    throw new Error(
      'Delta selection requires an explicit comparison base or a range starting at the root commit.'
    );
  }
  const project = JSON.parse(
    readFileSync(path.join(workspace, 'sfdx-project.json'), 'utf8')
  ) as unknown;
  const directories = sourcePaths({ ...settings, mode: 'full' }, project, []);
  const inScope = (filename: string) =>
    directories.some(
      (directory) =>
        directory === '.' ||
        filename === directory ||
        filename.startsWith(directory + '/')
    );
  const changes: { filename: string; status: string }[] = [];
  if (emptyBase) {
    for (const filename of git(workspace, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      headSha
    ])
      .split('\0')
      .filter(Boolean)) {
      changes.push({ filename, status: 'added' });
    }
  }
  if (baseSha) {
    const fields = git(workspace, [
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      shaSchema.parse(baseSha),
      headSha,
      '--'
    ]).split('\0');
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index];
      const filename = fields[index + 1];
      if (status === 'D' && inScope(filename)) {
        throw new Error(
          'Metadata removals/renames require destructive deployment support, which is not enabled.'
        );
      }
      if (
        settings.mode === 'delta' &&
        ['sfdx-project.json', '.forceignore'].includes(filename)
      ) {
        throw new Error(
          'Project configuration or .forceignore changed. Select full mode.'
        );
      }
      changes.push({
        filename,
        status: status === 'D' ? 'removed' : 'modified'
      });
    }
  }
  const sources = sourcePaths(settings, project, changes);
  const checkPath = (relative: string): void => {
    const absolute = path.resolve(workspace, relative);
    if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) {
      throw new Error('Release source paths must remain inside the project.');
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error('Release source/configuration symlinks are not allowed.');
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute)) {
        if (child !== '.git') checkPath(path.join(relative, child));
      }
    }
  };
  checkPath('sfdx-project.json');
  try {
    lstatSync(path.join(workspace, '.forceignore'));
    checkPath('.forceignore');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const source of sources) {
    let parent = source;
    while (parent !== '.' && parent !== path.dirname(parent)) {
      if (lstatSync(path.join(workspace, parent)).isSymbolicLink())
        throw new Error('Release source symlinks are not allowed.');
      parent = path.dirname(parent);
    }
    checkPath(source);
  }
  return {
    sources,
    payloadHash: createHash('sha256')
      .update(JSON.stringify({ headSha, settings, sources }))
      .digest('hex')
  };
}
