import { createHash } from 'node:crypto';
import type { getOctokit } from '@actions/github';
import { replacePullRequestComment } from '../../../shared/pr-comment';
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
function text(value: unknown): string {
  return display(
    String(value)
      .slice(0, 300)
      .replace(/[\r\n]+/g, ' ')
      .replace(/[\\`*_[\]{}()#!|]/g, '\\$&')
  );
}
function code(value: unknown): string {
  const valueText = String(value)
    .slice(0, 300)
    .replace(/[\r\n]+/g, ' ');
  const fence = '`'.repeat(
    Math.max(
      0,
      ...(valueText.match(/`+/g) ?? []).map((match) => match.length)
    ) + 1
  );
  return valueText.includes('`')
    ? `${fence} ${valueText} ${fence}`
    : `${fence}${valueText}${fence}`;
}
function section(
  items: Record<string, unknown>[],
  format: (item: Record<string, unknown>) => string,
  empty: string
): string {
  return items.length
    ? items.slice(0, 10).map(format).join('\n\n') +
        (items.length > 10
          ? '\n\nAdditional failures are available in the result artifact.'
          : '')
    : empty;
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
    `## Deployment Dry Run ${result.outcome}`,
    '',
    `- Org: ${code(options.org.slice(0, 100))}`,
    `- Environment: ${code(options.environment.slice(0, 100))}`,
    `- Test level: ${code(options.testLevel)}`,
    `- Source paths: ${code(options.sourceCount)}`,
    `- Deploy ID: ${code(result.report.result?.id ?? 'N/A')}`,
    `- CLI exit code: ${code(result.exitCode)}`,
    ...(result.report.message
      ? [`- Message: ${text(result.report.message)}`]
      : []),
    '',
    '### Component Failures',
    section(
      components,
      (failure) => {
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
        const location = [
          failure.lineNumber ? `line ${text(failure.lineNumber)}` : '',
          failure.columnNumber ? `column ${text(failure.columnNumber)}` : ''
        ]
          .filter(Boolean)
          .join(', ');
        return [
          `- ${code(filename)}${location ? ` (${location})` : ''}  `,
          `  Component: ${code(failure.componentType ?? 'Unknown type')} ${code(failure.fullName ?? 'Unknown name')}  `,
          `  Problem: ${text(failure.problem ?? failure.message ?? 'No details returned.')}`
        ].join('\n');
      },
      'No component failures.'
    ),
    '',
    '### Test Failures',
    section(
      failures,
      (failure) =>
        [
          `- ${code([failure.name, failure.methodName].filter(Boolean).join('.') || 'Unknown test')}  `,
          `  Message: ${text(failure.message ?? 'No failure detail returned.')}`
        ].join('\n'),
      'No test failures.'
    ),
    '',
    '### Coverage Failures',
    section(
      coverage,
      (failure) =>
        `- ${code(failure.name ?? failure.id ?? 'Apex coverage')}: ${text(failure.message ?? 'No coverage detail returned.')}`,
      'No coverage failures.'
    ),
    '',
    'The workflow uploads the complete sanitized JSON result as an artifact.',
    ...(options.runUrl
      ? ['', `[Workflow run and artifacts](${options.runUrl})`]
      : [])
  ].join('\n');
  await replacePullRequestComment(client, pullRequest, {
    key: validationCommentKey(options.org),
    body
  });
}
