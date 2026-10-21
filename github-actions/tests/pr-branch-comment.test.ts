import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upsertBranchNameComment } from '../actions/pr-branch-name-checker/src/comment';
import {
  deletePullRequestComment,
  upsertPullRequestComment
} from '../shared/pr-comment';

const result = {
  checked: true,
  valid: false,
  sourceBranch: 'chore/x',
  targetBranch: 'develop',
  matchedBranch: 'develop',
  matchedPattern: null
};
const pullRequest = { owner: 'example', repo: 'salesforce', number: 42 };
const marker = '<!-- sf-cicd:pr-branch-name-checker -->';

async function clientWithFetch(
  handler: (request: Request) => Promise<Response>
) {
  const { getOctokit } = await import('@actions/github');
  return getOctokit('test-token-not-a-secret', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) =>
        handler(new Request(input, init))
    }
  });
}

test('shared PR comments isolate different action keys and update only their own bot comment', async () => {
  const updates: string[] = [];
  const client = await clientWithFetch(async (request) => {
    if (request.method === 'GET') {
      return Response.json([
        {
          id: 1,
          body: '<!-- sf-cicd:validation -->\nHuman text',
          user: { type: 'User' }
        },
        { id: 2, body: marker, user: { type: 'Bot' } },
        {
          id: 3,
          body: '<!-- sf-cicd:validation -->\nOld validation',
          user: { type: 'Bot' }
        },
        {
          id: 4,
          body: '<!-- sf-cicd:deployment -->\nOld deployment',
          user: { type: 'Bot' }
        }
      ]);
    }

    assert.equal(request.method, 'PATCH');
    updates.push(new URL(request.url).pathname);
    const payload = (await request.json()) as { body: string };
    assert.ok(payload.body.startsWith('<!-- sf-cicd:'));
    return Response.json({ id: 3 });
  });

  await upsertPullRequestComment(client, pullRequest, {
    key: 'validation',
    body: '## Validation\n\nPassed.'
  });
  await upsertPullRequestComment(client, pullRequest, {
    key: 'deployment',
    body: '## Deployment\n\nFailed.'
  });
  assert.deepEqual(updates, [
    '/repos/example/salesforce/issues/comments/3',
    '/repos/example/salesforce/issues/comments/4'
  ]);
});

test('shared PR comments create a new action comment without overwriting another action', async () => {
  const methods: string[] = [];
  const client = await clientWithFetch(async (request) => {
    methods.push(request.method);

    if (request.method === 'GET') {
      return Response.json([{ id: 1, body: marker, user: { type: 'Bot' } }]);
    }

    assert.equal(request.method, 'POST');
    const payload = (await request.json()) as { body: string };
    assert.equal(
      payload.body,
      '<!-- sf-cicd:deployment -->\n## Deployment\n\nComplete.'
    );
    return Response.json({ id: 2 });
  });

  await upsertPullRequestComment(client, pullRequest, {
    key: 'deployment',
    body: '## Deployment\n\nComplete.'
  });
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('shared PR comments reject invalid identity keys before any API call', async () => {
  const client = await clientWithFetch(async () => {
    assert.fail('The GitHub API must not be called for invalid comment keys.');
  });

  for (const key of [
    '',
    'Validation',
    'validation -->',
    'with spaces',
    'a'.repeat(101)
  ]) {
    await assert.rejects(
      () =>
        upsertPullRequestComment(client, pullRequest, { key, body: 'Example' }),
      /PR comment keys/
    );
  }
});

test('shared PR comment deletion removes only matching bot comments including duplicates', async () => {
  const methods: string[] = [];
  const deleted: string[] = [];
  const client = await clientWithFetch(async (request) => {
    methods.push(request.method);
    if (request.method === 'GET') {
      return Response.json([
        {
          id: 1,
          body: '<!-- sf-cicd:pr-title-checker -->',
          user: { type: 'User' }
        },
        { id: 2, body: marker, user: { type: 'Bot' } },
        {
          id: 3,
          body: '<!-- sf-cicd:pr-title-checker -->\nOld failure',
          user: { type: 'Bot' }
        },
        {
          id: 4,
          body: '<!-- sf-cicd:pr-title-checker -->\nDuplicate failure',
          user: { type: 'Bot' }
        }
      ]);
    }

    assert.equal(request.method, 'DELETE');
    deleted.push(new URL(request.url).pathname);
    return new Response(null, { status: 204 });
  });

  await deletePullRequestComment(client, pullRequest, {
    key: 'pr-title-checker'
  });
  assert.deepEqual(methods, ['GET', 'DELETE', 'DELETE']);
  assert.deepEqual(deleted, [
    '/repos/example/salesforce/issues/comments/3',
    '/repos/example/salesforce/issues/comments/4'
  ]);
});

test('shared PR comment deletion is a no-op when there is no matching comment', async () => {
  const methods: string[] = [];
  const client = await clientWithFetch(async (request) => {
    methods.push(request.method);
    return Response.json([{ id: 1, body: marker, user: { type: 'Bot' } }]);
  });
  await deletePullRequestComment(client, pullRequest, {
    key: 'pr-title-checker'
  });
  assert.deepEqual(methods, ['GET']);
});

test('shared PR comment deletion finds failures on subsequent pages', async () => {
  const methods: string[] = [];
  const client = await clientWithFetch(async (request) => {
    methods.push(request.method);
    if (methods.length === 1) {
      return Response.json([], {
        headers: {
          link: '<https://api.github.com/repos/example/salesforce/issues/42/comments?page=2>; rel="next"'
        }
      });
    }
    if (request.method === 'GET') {
      return Response.json([
        {
          id: 3,
          body: '<!-- sf-cicd:pr-title-checker -->',
          user: { type: 'Bot' }
        }
      ]);
    }
    return new Response(null, { status: 204 });
  });
  await deletePullRequestComment(client, pullRequest, {
    key: 'pr-title-checker'
  });
  assert.deepEqual(methods, ['GET', 'GET', 'DELETE']);
});

test('shared PR comment deletion tolerates already-deleted comments but exposes permission errors', async () => {
  for (const status of [404, 403]) {
    const client = await clientWithFetch(async (request) =>
      request.method === 'GET'
        ? Response.json([
            {
              id: 3,
              body: '<!-- sf-cicd:pr-title-checker -->',
              user: { type: 'Bot' }
            }
          ])
        : Response.json({ message: 'Cannot delete comment' }, { status })
    );
    const operation = deletePullRequestComment(client, pullRequest, {
      key: 'pr-title-checker'
    });
    if (status === 404) {
      await operation;
    } else {
      await assert.rejects(operation, (error: unknown) => {
        assert.equal((error as { status: number }).status, 403);
        return true;
      });
    }
  }
});

test('shared PR comment deletion validates keys before any API request', async () => {
  const client = await clientWithFetch(async () =>
    assert.fail('No API call expected.')
  );
  await assert.rejects(
    () => deletePullRequestComment(client, pullRequest, { key: '' }),
    /PR comment keys/
  );
});

test('branch rejection creates a useful PR comment with the allowed regexes', async () => {
  const methods: string[] = [];
  const client = await clientWithFetch(async (request) => {
    methods.push(request.method);
    assert.equal(
      new URL(request.url).pathname,
      '/repos/example/salesforce/issues/42/comments'
    );

    if (request.method === 'GET') {
      return Response.json([]);
    }

    const payload = (await request.json()) as { body: string };
    assert.match(payload.body, /PR branch name does not match policy/);
    assert.ok(payload.body.includes(marker));
    assert.ok(payload.body.includes('chore/x'));
    assert.ok(payload.body.includes('develop'));
    assert.ok(payload.body.includes('^feature/ASOS-[0-9]+$'));
    return Response.json({ id: 123 });
  });

  await upsertBranchNameComment(client, pullRequest, result, [
    '^feature/ASOS-[0-9]+$'
  ]);
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('branch rejection updates an existing bot comment rather than posting again', async () => {
  const methods: string[] = [];
  const client = await clientWithFetch(async (request) => {
    methods.push(request.method);

    if (request.method === 'GET') {
      return Response.json([
        { id: 1, body: marker, user: { type: 'User' } },
        { id: 2, body: 'An unrelated comment', user: { type: 'Bot' } },
        { id: 3, body: marker + '\nOld policy feedback', user: { type: 'Bot' } }
      ]);
    }

    assert.equal(request.method, 'PATCH');
    assert.equal(
      new URL(request.url).pathname,
      '/repos/example/salesforce/issues/comments/3'
    );
    return Response.json({ id: 3 });
  });

  await upsertBranchNameComment(client, pullRequest, result, ['^feature/.+$']);
  assert.deepEqual(methods, ['GET', 'PATCH']);
});

test('branch comments search all pages before creating a duplicate', async () => {
  let pages = 0;
  const methods: string[] = [];
  const client = await clientWithFetch(async (request) => {
    methods.push(request.method);

    if (request.method === 'GET') {
      pages += 1;

      if (pages === 1) {
        return Response.json([], {
          headers: {
            link: '<https://api.github.com/repos/example/salesforce/issues/42/comments?page=2>; rel="next"'
          }
        });
      }

      return Response.json([{ id: 7, body: marker, user: { type: 'Bot' } }]);
    }

    assert.equal(request.method, 'PATCH');
    return Response.json({ id: 7 });
  });

  await upsertBranchNameComment(client, pullRequest, result, ['^feature/.+$']);
  assert.deepEqual(methods, ['GET', 'GET', 'PATCH']);
});

test('accepted names and disabled policies never call the GitHub API', async () => {
  const client = await clientWithFetch(async () => {
    assert.fail('The GitHub API must not be called.');
  });

  await upsertBranchNameComment(
    client,
    pullRequest,
    { ...result, valid: true },
    []
  );
  await upsertBranchNameComment(
    client,
    pullRequest,
    { ...result, checked: false },
    []
  );
});

test('comment content escapes branch markup and mentions and limits large policy lists', async () => {
  const patterns = Array.from(
    { length: 11 },
    (_, index) => `^feature/<@team&-${index}>$`
  );
  const client = await clientWithFetch(async (request) => {
    if (request.method === 'GET') {
      return Response.json([]);
    }

    const payload = (await request.json()) as { body: string };
    assert.ok(payload.body.includes('&lt;&#64;team&amp;-0&gt;'));
    assert.ok(!payload.body.includes('<@team'));
    assert.ok(!payload.body.includes('-10&gt;'));
    assert.match(payload.body, /Additional patterns/);
    return Response.json({ id: 123 });
  });

  await upsertBranchNameComment(
    client,
    pullRequest,
    { ...result, sourceBranch: '<@team&>' },
    patterns
  );
});

test('GitHub permission failures are surfaced to the action for warning handling', async () => {
  const client = await clientWithFetch(async () =>
    Response.json(
      { message: 'Resource not accessible by integration' },
      { status: 403 }
    )
  );
  await assert.rejects(
    () =>
      upsertBranchNameComment(client, pullRequest, result, ['^feature/.+$']),
    (error: unknown) => {
      assert.equal((error as { status: number }).status, 403);
      return true;
    }
  );
});
