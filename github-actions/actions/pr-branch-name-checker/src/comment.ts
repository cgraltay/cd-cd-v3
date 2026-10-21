import type { getOctokit } from '@actions/github';
import { upsertPullRequestComment } from '../../../shared/pr-comment';
import type { BranchNameResult } from './check';

const commentKey = 'pr-branch-name-checker';

function displayValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;');
}

export async function upsertBranchNameComment(
  client: ReturnType<typeof getOctokit>,
  pullRequest: { owner: string; repo: string; number: number },
  result: BranchNameResult,
  allowedSourcePatterns: string[]
): Promise<void> {
  if (!result.checked || result.valid) {
    return;
  }

  const patterns = allowedSourcePatterns.slice(0, 10);
  const body = [
    '## PR branch name does not match policy',
    '',
    'The source branch is not allowed for this PR target.',
    '',
    '**Source branch**',
    `<pre>${displayValue(result.sourceBranch)}</pre>`,
    '',
    '**Target branch**',
    `<pre>${displayValue(result.targetBranch)}</pre>`,
    '',
    '**Allowed source regexes (whole-name, case-sensitive)**',
    `<pre>${patterns.map(displayValue).join('\n')}</pre>`,
    ...(allowedSourcePatterns.length > patterns.length
      ? ['', 'Additional patterns are configured; see the branch policy.']
      : []),
    '',
    'Use a source branch matching one of the configured expressions. This status check remains failed until the naming policy is satisfied.'
  ].join('\n');

  await upsertPullRequestComment(client, pullRequest, {
    key: commentKey,
    body
  });
}
