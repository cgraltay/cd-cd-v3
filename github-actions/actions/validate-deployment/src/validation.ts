import path from 'node:path';
import { z } from 'zod';

export const validationSettingsSchema = z
  .object({
    mode: z.enum(['delta', 'full']),
    sourceDirs: z.array(z.string().trim().min(1)).min(1),
    testLevel: z
      .enum([
        'RunRelevantTests',
        'RunLocalTests',
        'RunAllTestsInOrg',
        'RunSpecifiedTests'
      ])
      .default('RunRelevantTests'),
    tests: z.array(z.string().trim().min(1)).default([]),
    waitMinutes: z.number().int().min(1).max(1440).default(180)
  })
  .superRefine((settings, context) => {
    if (
      settings.testLevel === 'RunSpecifiedTests' &&
      settings.tests.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'RunSpecifiedTests requires test names.'
      });
    }
  });
export type ValidationSettings = z.infer<typeof validationSettingsSchema>;

export interface ChangedFile {
  filename: string;
  status: string;
}

export function sourcePaths(
  settings: ValidationSettings,
  project: unknown,
  files: ChangedFile[]
): string[] {
  const parsed = z
    .object({ packageDirectories: z.array(z.object({ path: z.string() })) })
    .safeParse(project);
  if (!parsed.success) {
    throw new Error(
      'A valid sfdx-project.json with packageDirectories is required.'
    );
  }
  const safePath = (value: string) => {
    const normalized = path.posix
      .normalize(value.replaceAll('\\', '/'))
      .replace(/\/$/, '');
    if (
      path.posix.isAbsolute(normalized) ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      /^[A-Za-z]:/.test(normalized)
    ) {
      throw new Error('Validation source paths must stay within the project.');
    }
    return normalized;
  };
  const requested = [...new Set(settings.sourceDirs.map(safePath))];
  const ordered = [
    ...parsed.data.packageDirectories
      .map((entry) => safePath(entry.path))
      .filter((directory) => requested.includes(directory)),
    ...requested.filter(
      (directory) =>
        !parsed.data.packageDirectories.some(
          (entry) => safePath(entry.path) === directory
        )
    )
  ];
  if (settings.mode === 'full') {
    return ordered;
  }
  return [
    ...new Set(
      ordered.flatMap((directory) =>
        files
          .filter(
            (file) =>
              file.status !== 'removed' &&
              file.filename === safePath(file.filename)
          )
          .filter(
            (file) =>
              directory === '.' || file.filename.startsWith(directory + '/')
          )
          .map((file) => file.filename)
      )
    )
  ];
}

export function dryRunArgs(
  settings: ValidationSettings,
  sources: string[],
  alias: string
): string[] {
  if (sources.length === 0) {
    throw new Error('Validation must not run without explicit source paths.');
  }
  return [
    'project',
    'deploy',
    'start',
    ...sources.flatMap((source) => ['--source-dir', './' + source]),
    '--target-org',
    alias,
    '--wait',
    String(settings.waitMinutes),
    '--dry-run',
    '--json',
    '--test-level',
    settings.testLevel,
    ...(settings.testLevel === 'RunSpecifiedTests'
      ? settings.tests.flatMap((name) => ['--tests', name])
      : [])
  ];
}

const resultSchema = z
  .object({
    status: z.number().optional(),
    name: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    result: z
      .object({
        id: z.string().optional(),
        success: z.boolean().optional(),
        status: z.string().optional(),
        details: z.record(z.string(), z.unknown()).optional(),
        files: z.unknown().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export type ValidationOutcome = 'Succeeded' | 'Failed' | 'Skipped';
export interface DryRunResult {
  outcome: ValidationOutcome;
  exitCode: number;
  report: z.infer<typeof resultSchema>;
}

export function parseDryRun(stdout: string, exitCode: number): DryRunResult {
  let report: z.infer<typeof resultSchema>;
  try {
    report = resultSchema.parse(JSON.parse(stdout.trim()));
  } catch {
    return {
      outcome: 'Failed',
      exitCode,
      report: {
        name: 'InvalidValidationReport',
        message: 'Salesforce dry run did not return a valid JSON result.'
      }
    };
  }
  const nothing =
    report.name === 'NothingToDeploy' || report.code === 'NothingToDeploy';
  const success =
    exitCode === 0 &&
    report.status === 0 &&
    report.result?.success === true &&
    report.result.status === 'Succeeded';
  return {
    outcome: nothing ? 'Skipped' : success ? 'Succeeded' : 'Failed',
    exitCode,
    report
  };
}

export function redactReport(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    return secrets
      .filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, '***'), value);
  }
  if (Array.isArray(value))
    return value.map((entry) => redactReport(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|password|private.?key|authorization/i.test(key)
          ? '***'
          : redactReport(entry, secrets)
      ])
    );
  }
  return value;
}
