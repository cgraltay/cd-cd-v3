import { createHash } from 'node:crypto';
import type { getOctokit } from '@actions/github';
import { upsertPullRequestComment } from '../../../shared/pr-comment';
import type { DryRunResult } from './validation';

export function validationCommentKey(org: string): string {
  return (
    'validate-deployment-' +
    createHash('sha256').update(org).digest('hex').slice(0, 16)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function entries(value: unknown): Record<string, unknown>[] {
  return (
    value === undefined || value === null
      ? []
      : Array.isArray(value)
        ? value
        : [value]
  ).map(record);
}
function display(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;');
}
function section(
  items: Record<string, unknown>[],
  format: (item: Record<string, unknown>) => string
): string {
  return items.length
    ? '<pre>' +
        items
          .slice(0, 10)
          .map((item) => display(format(item).slice(0, 300)))
          .join('\n\n') +
        '</pre>' +
        (items.length > 10
          ? '\n\nAdditional failures are available in the result artifact.'
          : '')
    : 'None.';
}

export async function publishValidationComment(
  client: ReturnType<typeof getOctokit>,
  pullRequest: { owner: string; repo: string; number: number },
  options: {
    org: string;
    environment: string;
    testLevel: string;
    sources: string[];
    sourceCount: number;
    result: DryRunResult;
    runUrl?: string;
  }
): Promise<void> {
  const { result } = options;
  const details = record(result.report.result?.details);
  const tests = record(details.runTestResult);
  const files = entries(result.report.result?.files);
  const components = entries(details.componentFailures);
  const failures = entries(tests.failures);
  const coverage = entries(tests.codeCoverageWarnings);
  const body = [
    `## Deployment dry run ${result.outcome}`,
    '',
    `<pre>Org: ${display(options.org.slice(0, 100))}\nEnvironment: ${display(options.environment.slice(0, 100))}\nTest level: ${display(options.testLevel)}\nSource paths: ${options.sourceCount}\nDeploy ID: ${display(result.report.result?.id ?? 'N/A')}\nCLI exit code: ${result.exitCode}</pre>`,
    ...(result.report.message
      ? ['', '<pre>' + display(result.report.message.slice(0, 300)) + '</pre>']
      : []),
    '',
    '### Component Failures',
    section(components, (failure) => {
      const file = files.find(
        (entry) =>
          entry.fullName === failure.fullName &&
          (!failure.componentType ||
            !entry.type ||
            entry.type === failure.componentType)
      );
      const name = String(
        file?.filePath ??
          failure.fileName ??
          failure.fullName ??
          'Unknown component'
      ).replaceAll('\\', '/');
      const source = options.sources.find((directory) =>
        name.includes(directory + '/')
      );
      const filename =
        source && name.includes('/' + source + '/')
          ? name.slice(name.indexOf('/' + source + '/') + 1)
          : name;
      return `${filename} (line ${failure.lineNumber ?? '?'}, column ${failure.columnNumber ?? '?'})\n${failure.componentType ?? ''} ${failure.fullName ?? ''}\n${failure.problem ?? failure.message ?? 'No details returned.'}`;
    }),
    '',
    '### Test Failures',
    section(
      failures,
      (failure) =>
        `${failure.name ?? 'Unknown test'}.${failure.methodName ?? ''}\n${failure.message ?? ''}\n${failure.stackTrace ?? ''}`
    ),
    '',
    '### Coverage Failures',
    section(
      coverage,
      (failure) =>
        `${failure.name ?? failure.id ?? 'Apex coverage'}: ${failure.message ?? ''}`
    ),
    '',
    'The workflow uploads the complete sanitized JSON result as an artifact.',
    ...(options.runUrl
      ? ['', `[Workflow run and artifacts](${options.runUrl})`]
      : [])
  ].join('\n');
  await upsertPullRequestComment(client, pullRequest, {
    key: validationCommentKey(options.org),
    body
  });
}
