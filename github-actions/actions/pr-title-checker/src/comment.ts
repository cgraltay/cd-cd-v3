import type { getOctokit } from '@actions/github';
import {
  deletePullRequestComment,
  upsertPullRequestComment
} from '../../../shared/pr-comment';
import type { TitleCheckResult } from './check';

const commentKey = 'pr-title-checker';

function displayValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;');
}

export async function syncTitleComment(
  client: ReturnType<typeof getOctokit>,
  pullRequest: { owner: string; repo: string; number: number },
  result: TitleCheckResult,
  allowedPatterns: string[]
): Promise<void> {
  if (!result.checked) {
    return;
  }
  if (result.valid) {
    await deletePullRequestComment(client, pullRequest, { key: commentKey });
    return;
  }

  const patterns = allowedPatterns.slice(0, 10);
  const body = [
    '## PR title does not match policy',
    '',
    'The PR title does not match the naming rules for its target branch.',
    '',
    '**Current title**',
    `<pre>${displayValue(result.title)}</pre>`,
    '',
    '**Target branch**',
    `<pre>${displayValue(result.targetBranch)}</pre>`,
    '',
    '**Allowed title regexes (whole-title, case-sensitive)**',
    `<pre>${patterns.map(displayValue).join('\n')}</pre>`,
    ...(allowedPatterns.length > patterns.length
      ? ['', 'Additional patterns are configured; see the title policy.']
      : []),
    '',
    'Edit the PR title to match an allowed expression. The next title check will remove this comment once the title is valid.'
  ].join('\n');
  await upsertPullRequestComment(client, pullRequest, {
    key: commentKey,
    body
  });
}
