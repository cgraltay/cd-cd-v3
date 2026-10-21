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

export function releaseSources(
  workspace: string,
  headSha: string,
  branchSha: string,
  settings: ValidationSettings,
  baseSha?: string
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
  if (!baseSha && settings.mode === 'delta') {
    throw new Error(
      'No successful actual deployment baseline exists. Bootstrap this org with a full deployment.'
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
