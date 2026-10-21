import path from 'node:path';
import { z } from 'zod';
import { codeAnalyzerPolicySchema } from '../../../shared/code-analyzer';

export type AnalyzerPolicy = z.infer<typeof codeAnalyzerPolicySchema>;
export interface PullRequestFile {
  filename: string;
  status: string;
  patch?: string;
}

const locationSchema = z
  .object({
    file: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive().optional()
  })
  .passthrough();

export const analyzerReportSchema = z
  .object({
    violations: z.array(
      z
        .object({
          rule: z.string(),
          engine: z.string(),
          severity: z.number().int().min(1).max(5),
          message: z.string(),
          locations: z.array(locationSchema).default([]),
          primaryLocationIndex: z.number().int().nonnegative().default(0)
        })
        .passthrough()
    )
  })
  .passthrough();

export type AnalyzerReport = z.infer<typeof analyzerReportSchema>;
export const reviewCommentMarker = '<!-- sf-cicd:run-code-analyzer -->';

export function selectFiles(
  files: PullRequestFile[],
  directories: string[]
): PullRequestFile[] {
  const packages = directories.map((directory) =>
    path.posix.normalize(directory.replaceAll('\\', '/')).replace(/\/$/, '')
  );
  if (
    packages.some(
      (directory) =>
        path.posix.isAbsolute(directory) ||
        directory === '..' ||
        directory.startsWith('../')
    )
  ) {
    throw new Error(
      'Analyzer package directories must stay within the repository.'
    );
  }
  return files.filter((file) => {
    const name = file.filename;
    return (
      file.status !== 'removed' &&
      /\.(cls|trigger)$/.test(name) &&
      !name.includes('\\') &&
      !path.posix.isAbsolute(name) &&
      path.posix.normalize(name) === name &&
      !name.startsWith('../') &&
      name !== '..' &&
      packages.some(
        (directory) => directory === '.' || name.startsWith(directory + '/')
      )
    );
  });
}

export function analyzerArgs(
  policy: AnalyzerPolicy,
  files: PullRequestFile[],
  configPath: string,
  reportPath: string
): string[] {
  if (files.length === 0) {
    throw new Error('Analyzer targets must not be empty.');
  }
  return [
    'code-analyzer',
    'run',
    '--config-file',
    configPath,
    '--workspace',
    '.',
    '--output-file',
    reportPath,
    ...policy.ruleSelectors.flatMap((selector) => [
      '--rule-selector',
      selector
    ]),
    ...files.flatMap((file) => ['--target', './' + file.filename])
  ];
}

export function parseAnalyzerReport(input: string): AnalyzerReport {
  try {
    return analyzerReportSchema.parse(JSON.parse(input));
  } catch {
    throw new Error(
      'Salesforce Code Analyzer did not produce a valid JSON violations report.'
    );
  }
}

export function reviewableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let current: number | undefined;
  for (const line of (patch ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      current = Number(hunk[1]);
    } else if (
      current !== undefined &&
      (line.startsWith(' ') || line.startsWith('+'))
    ) {
      lines.add(current++);
    }
  }
  return lines;
}

function displayValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;');
}

export function inlineComments(
  report: AnalyzerReport,
  files: PullRequestFile[],
  workspace: string
) {
  const byPath = new Map(
    files.map((file) => [file.filename, reviewableLines(file.patch)])
  );
  return report.violations.flatMap((violation) => {
    const location =
      violation.locations[violation.primaryLocationIndex] ??
      violation.locations[0];
    if (!location) {
      return [];
    }
    const filename = path
      .relative(workspace, path.resolve(workspace, location.file))
      .split(path.sep)
      .join('/');
    const candidates = byPath.get(filename);
    if (!candidates) {
      return [];
    }
    const end = location.endLine ?? location.startLine;
    const line = [...candidates].find(
      (candidate) => candidate >= location.startLine && candidate <= end
    );
    if (line === undefined) {
      return [];
    }
    return [
      {
        path: filename,
        line,
        side: 'RIGHT' as const,
        body: `${reviewCommentMarker}\n\n**Salesforce Code Analyzer**\n\n<pre>${displayValue(violation.rule)} (${displayValue(violation.engine)}, severity ${violation.severity})\n\n${displayValue(violation.message)}</pre>`
      }
    ];
  });
}
