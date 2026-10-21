import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkPullRequestTitle } from '../actions/pr-title-checker/src/check';
import { syncTitleComment } from '../actions/pr-title-checker/src/comment';
import { readConfig, resolveConfig } from '../actions/config-reader/src/config';

function configWithPolicy(policy: unknown) {
  return { version: 1, branches: { develop: { prTitle: policy } } };
}
const config = configWithPolicy({
  enabled: true,
  allowedPatterns: ['^ASOS-[0-9]+: .+$']
});

test('title checker accepts the configured ticket-and-description format', async () => {
  const result = await checkPullRequestTitle(
    config,
    'ASOS-123: Add account validation',
    'develop'
  );
  assert.equal(result.checked, true);
  assert.equal(result.valid, true);
  assert.equal(result.matchedBranch, 'develop');
  assert.equal(result.matchedPattern, '^ASOS-[0-9]+: .+$');
});

for (const title of [
  'Add account validation',
  'ASOS-abc: Fix',
  'ASOS-123:',
  'asos-123: Fix',
  'prefix ASOS-123: Fix',
  ' ASOS-123: Fix',
  'ASOS-123: Fix\n'
]) {
  test(`title checker rejects ${JSON.stringify(title)}`, async () => {
    const result = await checkPullRequestTitle(config, title, 'develop');
    assert.equal(result.checked, true);
    assert.equal(result.valid, false);
    assert.equal(result.matchedPattern, null);
  });
}

test('title checker uses exact target policies ahead of globs', async () => {
  const rules = {
    version: 1,
    branches: {
      '**': { prTitle: { enabled: true, allowedPatterns: ['^HOTFIX: .+$'] } },
      develop: {
        prTitle: { enabled: true, allowedPatterns: ['^ASOS-[0-9]+: .+$'] }
      }
    }
  };
  assert.equal(
    (await checkPullRequestTitle(rules, 'ASOS-123: Fix', 'develop')).valid,
    true
  );
  assert.equal(
    (await checkPullRequestTitle(rules, 'HOTFIX: Fix', 'develop')).valid,
    false
  );
  assert.equal(
    (await checkPullRequestTitle(rules, 'HOTFIX: Fix', 'main')).valid,
    true
  );
});

test('title checker skips absent or disabled policies and preserves the title verbatim', async () => {
  for (const policy of [undefined, {}, { enabled: false }]) {
    const result = await checkPullRequestTitle(
      configWithPolicy(policy),
      ' Unrestricted title ',
      'develop'
    );
    assert.equal(result.checked, false);
    assert.equal(result.valid, true);
    assert.equal(result.title, ' Unrestricted title ');
  }
});

test('title checker rejects missing context and unknown targets', async () => {
  for (const [title, branch] of [
    ['', 'develop'],
    [' ', 'develop'],
    ['ASOS-123: Fix', '']
  ]) {
    await assert.rejects(
      () => checkPullRequestTitle(config, title, branch),
      /required/
    );
  }
  await assert.rejects(
    () => checkPullRequestTitle(config, 'ASOS-123: Fix', 'main'),
    /No branch rule/
  );
  await assert.rejects(
    () => checkPullRequestTitle({}, 'ASOS-123: Fix', 'develop'),
    /No branch rule/
  );
});

for (const policy of [
  { enabled: true },
  { enabled: true, allowedPatterns: [] },
  { enabled: true, allowedPatterns: ['['] },
  { enabled: true, allowedPatterns: [' '] },
  { enabled: 'true', allowedPatterns: ['.+'] },
  { enabled: true, allowedPatterns: 'regex' },
  { enabled: true, allowedPatterns: ['a'.repeat(1025)] }
]) {
  test(`title checker rejects malformed policy ${JSON.stringify(policy).slice(0, 100)}`, async () => {
    await assert.rejects(
      () =>
        checkPullRequestTitle(
          configWithPolicy(policy),
          'ASOS-123: Fix',
          'develop'
        ),
      /Invalid branch configuration/
    );
  });
}

test(
  'title checker shares bounded regex evaluation and input limits',
  { timeout: 10000 },
  async () => {
    await assert.rejects(
      () =>
        checkPullRequestTitle(
          configWithPolicy({ enabled: true, allowedPatterns: ['(a+)+'] }),
          'a'.repeat(100) + '!',
          'develop'
        ),
      /PR title regex matching exceeded the two-second limit/
    );
    await assert.rejects(
      () => checkPullRequestTitle(config, 'a'.repeat(1025), 'develop'),
      /1024 characters/
    );
  }
);

test('config reader preserves validated PR title policies', () => {
  assert.deepEqual(
    resolveConfig(config, 'develop').branchConfig.prTitle,
    config.branches.develop.prTitle
  );
});

test('documented example config enables title validation for develop', async () => {
  const directory = path.resolve(__dirname, '..', 'actions', 'config-reader');
  const example = readConfig(
    readFileSync(path.join(directory, 'ci-cd-config.example.json'), 'utf8')
  );
  const guide = readFileSync(path.join(directory, 'CONFIGURATION.md'), 'utf8');
  const block = guide.match(/```json\s*([\s\S]*?)```/);
  assert.ok(block);
  assert.deepEqual(example, JSON.parse(block[1]));
  assert.equal(
    (
      await checkPullRequestTitle(
        example,
        'ASOS-123: Fix validation',
        'develop'
      )
    ).valid,
    true
  );
  assert.equal(
    (await checkPullRequestTitle(example, 'Wrong title', 'develop')).valid,
    false
  );
  assert.equal(
    (await checkPullRequestTitle(example, 'Promotion to QA', 'qa')).checked,
    false
  );
});

test('title feedback escapes markup, limits displayed patterns, and skips disabled checks', async () => {
  const { getOctokit } = await import('@actions/github');
  const calls: string[] = [];
  const client = getOctokit('test-token-not-a-secret', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request.method);
        if (request.method === 'GET') {
          return Response.json([]);
        }
        const payload = (await request.json()) as { body: string };
        assert.ok(payload.body.includes('&lt;&#64;team&amp;&gt;'));
        assert.ok(!payload.body.includes('<@team'));
        assert.ok(!payload.body.includes('pattern-10'));
        assert.match(payload.body, /Additional patterns/);
        return Response.json({ id: 123 });
      }
    }
  });
  const pullRequest = { owner: 'example', repo: 'salesforce', number: 42 };
  const result = {
    checked: true,
    valid: false,
    title: '<@team&>',
    targetBranch: 'develop',
    matchedBranch: 'develop',
    matchedPattern: null
  };
  const patterns = Array.from({ length: 11 }, (_, index) => `pattern-${index}`);
  await syncTitleComment(
    client,
    pullRequest,
    { ...result, checked: false },
    patterns
  );
  assert.deepEqual(calls, []);
  await syncTitleComment(client, pullRequest, result, patterns);
  assert.deepEqual(calls, ['GET', 'POST']);
});

test('compiled title checker creates, updates, deletes, and recreates its failure comment', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pr-title-checker-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.resolve(__dirname, '..');
  const bundleDirectory = path.join(directory, 'dist');
  execFileSync(
    process.execPath,
    [
      require.resolve('@vercel/ncc/dist/ncc/cli.js'),
      'build',
      path.join(projectRoot, 'actions', 'pr-title-checker', 'src', 'index.ts'),
      '--out',
      bundleDirectory
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );

  const marker = '<!-- sf-cicd:pr-title-checker -->';
  const comments = [
    {
      id: 1,
      body: '<!-- sf-cicd:pr-branch-name-checker -->\nKeep this comment',
      user: { type: 'Bot' }
    }
  ];
  const methods: string[] = [];
  let denyWrites = false;
  let nextId = 2;
  const server = createServer(async (request, response) => {
    const method = request.method ?? '';
    methods.push(method);
    response.setHeader('content-type', 'application/json');
    if (method === 'GET') {
      response.end(JSON.stringify(comments));
      return;
    }
    if (denyWrites) {
      response.statusCode = 403;
      response.end(
        JSON.stringify({ message: 'Resource not accessible by integration' })
      );
      return;
    }
    const id = Number(request.url?.split('/').at(-1));
    if (method === 'DELETE') {
      const index = comments.findIndex((comment) => comment.id === id);
      assert.ok(index >= 0);
      comments.splice(index, 1);
      response.statusCode = 204;
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
    }
    const payload = JSON.parse(body) as { body: string };
    assert.ok(payload.body.startsWith(marker));
    assert.ok(!payload.body.includes('private-config-marker'));
    if (method === 'POST') {
      const comment = {
        id: nextId++,
        body: payload.body,
        user: { type: 'Bot' }
      };
      comments.push(comment);
      response.statusCode = 201;
      response.end(JSON.stringify(comment));
    } else {
      assert.equal(method, 'PATCH');
      const comment = comments.find((entry) => entry.id === id);
      assert.ok(comment);
      comment.body = payload.body;
      response.end(JSON.stringify(comment));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const runAction = (
    title: string,
    options: {
      config?: Record<string, unknown>;
      token?: string;
      eventTitle?: string;
      noContext?: boolean;
    } = {}
  ) =>
    new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      outputs: Record<string, string>;
    }>((resolve, reject) => {
      const eventPath = path.join(directory, 'event.json');
      const outputPath = path.join(directory, 'output.txt');
      writeFileSync(
        eventPath,
        JSON.stringify(
          options.noContext
            ? {}
            : {
                action: 'edited',
                pull_request: {
                  number: 42,
                  title: options.eventTitle ?? title,
                  base: { ref: 'develop' }
                }
              }
        )
      );
      writeFileSync(outputPath, '');
      const child = spawn(
        process.execPath,
        [path.join(bundleDirectory, 'index.js')],
        {
          timeout: 10000,
          env: {
            ...process.env,
            INPUT_CONFIG: JSON.stringify(
              options.config ?? { ...config, label: 'private-config-marker' }
            ),
            INPUT_TITLE: options.eventTitle === undefined ? '' : title,
            'INPUT_TARGET-BRANCH': options.noContext ? 'develop' : '',
            'INPUT_GITHUB-TOKEN':
              options.token ?? 'local-test-token-not-a-secret',
            GITHUB_TOKEN: '',
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: 'example/salesforce',
            GITHUB_BASE_REF: 'develop',
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
            GITHUB_OUTPUT: outputPath
          }
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        const content = readFileSync(outputPath, 'utf8').trimEnd();
        const lines = content ? content.split(/\r?\n/) : [];
        const outputs: Record<string, string> = {};
        for (let index = 0; index < lines.length; index += 3) {
          const [name, delimiter] = lines[index].split('<<');
          assert.equal(lines[index + 2], delimiter);
          outputs[name] = lines[index + 1];
        }
        resolve({ code, stdout, stderr, outputs });
      });
    });

  await context.test(
    'invalid title creates one failure comment and fails the action',
    async () => {
      const result = await runAction('Wrong title');
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.outputs.valid, 'false');
      assert.ok(!result.stdout.includes('private-config-marker'));
      assert.deepEqual(methods, ['GET', 'POST']);
      assert.equal(comments.length, 2);
      assert.ok(comments[1].body.includes('Wrong title'));
    }
  );
  await context.test(
    'another invalid title updates the same comment',
    async () => {
      const result = await runAction('Still wrong');
      assert.equal(result.code, 1, result.stderr);
      assert.equal(comments.length, 2);
      assert.equal(comments[1].id, 2);
      assert.ok(comments[1].body.includes('Still wrong'));
      assert.deepEqual(methods.slice(-2), ['GET', 'PATCH']);
    }
  );
  await context.test(
    'corrected title deletes its failure comment and passes',
    async () => {
      const result = await runAction('ASOS-123: Add validation');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.valid, 'true');
      assert.equal(result.outputs['matched-pattern'], '^ASOS-[0-9]+: .+$');
      assert.deepEqual(methods.slice(-2), ['GET', 'DELETE']);
      assert.equal(comments.length, 1);
      assert.equal(comments[0].id, 1);
    }
  );
  await context.test(
    'valid rerun with no failure comment performs no deletion',
    async () => {
      const count = methods.length;
      const result = await runAction('ASOS-124: Add tests');
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(methods.slice(count), ['GET']);
    }
  );
  await context.test(
    'a later invalid title recreates one comment, then updates it',
    async () => {
      const first = await runAction('Wrong again');
      assert.equal(first.code, 1);
      assert.equal(comments.length, 2);
      assert.equal(comments[1].id, 3);
      const second = await runAction('Wrong again, edited');
      assert.equal(second.code, 1);
      assert.equal(comments.length, 2);
      assert.equal(comments[1].id, 3);
      assert.deepEqual(methods.slice(-4), ['GET', 'POST', 'GET', 'PATCH']);
    }
  );
  await context.test(
    'explicit title input is not trimmed and overrides event title',
    async () => {
      const result = await runAction(' ASOS-123: Add validation', {
        eventTitle: 'ASOS-123: Valid event title'
      });
      assert.equal(result.code, 1);
      assert.equal(result.outputs.title, ' ASOS-123: Add validation');
    }
  );
  await context.test('disabled policies skip feedback management', async () => {
    const count = methods.length;
    const result = await runAction('Anything', {
      config: configWithPolicy({ enabled: false })
    });
    assert.equal(result.code, 0);
    assert.equal(result.outputs.checked, 'false');
    assert.equal(methods.length, count);
  });
  await context.test(
    'missing token preserves check result and warns without API calls',
    async () => {
      const count = methods.length;
      const result = await runAction('Wrong title', { token: '' });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /no GitHub token/);
      assert.equal(methods.length, count);
    }
  );
  await context.test(
    'missing PR context preserves a manual check and warns',
    async () => {
      const count = methods.length;
      const result = await runAction('ASOS-123: Manual title', {
        noContext: true,
        eventTitle: 'Unused'
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /PR context is unavailable/);
      assert.equal(methods.length, count);
    }
  );
  await context.test(
    'forbidden cleanup warns without changing a valid title result',
    async () => {
      denyWrites = true;
      const result = await runAction('ASOS-123: Corrected');
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Unable to create, update, or delete/);
      assert.match(result.stdout, /pull-requests: write/);
      assert.equal(comments.length, 2);
    }
  );
});
