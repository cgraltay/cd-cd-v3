import type { getOctokit } from '@actions/github';

function commentMarker(key: string): string {
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(key)) {
    throw new Error(
      'PR comment keys must start with a lowercase letter and contain only lowercase letters, digits, or hyphens, up to 100 characters.'
    );
  }

  return `<!-- sf-cicd:${key} -->`;
}

export async function upsertPullRequestComment(
  client: ReturnType<typeof getOctokit>,
  pullRequest: { owner: string; repo: string; number: number },
  comment: { key: string; body: string }
): Promise<void> {
  const marker = commentMarker(comment.key);
  const body = `${marker}\n${comment.body}`;
  const { owner, repo, number } = pullRequest;
  const comments = await client.paginate(client.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100
  });
  const existing = comments.find(
    (existingComment) =>
      existingComment.user?.type === 'Bot' &&
      existingComment.body?.includes(marker)
  );

  if (existing) {
    await client.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body
    });
  } else {
    await client.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body
    });
  }
}

export async function deletePullRequestComment(
  client: ReturnType<typeof getOctokit>,
  pullRequest: { owner: string; repo: string; number: number },
  comment: { key: string }
): Promise<void> {
  const marker = commentMarker(comment.key);
  const { owner, repo, number } = pullRequest;
  const comments = await client.paginate(client.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100
  });

  for (const existing of comments) {
    if (existing.user?.type !== 'Bot' || !existing.body?.includes(marker)) {
      continue;
    }

    try {
      await client.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: existing.id
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        throw error;
      }
    }
  }
}
