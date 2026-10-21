import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkBranchName } from '../actions/pr-branch-name-checker/src/check';
import { readConfig, resolveConfig } from '../actions/config-reader/src/config';

function configWithPolicy(policy: unknown) {
  return { version: 1, branches: { develop: { branchName: policy } } };
}

const config = configWithPolicy({
  enabled: true,
  allowedSourcePatterns: ['^feature/[^/]+$', '^bugfix/[^/]+$', '^hotfix/[^/]+$']
});

test('regex naming accepts numeric ticket identifiers and rejects other shapes', async () => {
  const rules = configWithPolicy({
    enabled: true,
    allowedSourcePatterns: ['^feature/ASOS-[0-9]+$']
  });

  for (const source of ['feature/ASOS-1', 'feature/ASOS-123']) {
    const result = await checkBranchName(rules, source, 'develop');
    assert.equal(result.valid, true);
    assert.equal(result.matchedPattern, '^feature/ASOS-[0-9]+$');
  }

  for (const source of [
    'feature/ASOS-',
    'feature/ASOS-abc',
    'feature/ASOS-123-extra',
    'prefix-feature/ASOS-123',
    'Feature/ASOS-123'
  ]) {
    assert.equal(
      (await checkBranchName(rules, source, 'develop')).valid,
      false
    );
  }
});

test('regex naming requires a whole-branch match even without anchors', async () => {
  const rules = configWithPolicy({
    enabled: true,
    allowedSourcePatterns: ['feature/ASOS-\\d+']
  });
  assert.equal(
    (await checkBranchName(rules, 'feature/ASOS-123', 'develop')).valid,
    true
  );
  assert.equal(
    (await checkBranchName(rules, 'feature/ASOS-123-extra', 'develop')).valid,
    false
  );
  assert.equal(
    (await checkBranchName(rules, 'feature/ASOS-123\n', 'develop')).valid,
    false
  );
});

test('regex naming rejects invalid expressions during config validation', async () => {
  for (const pattern of [
    '[',
    '(',
    '*feature',
    'feature/**',
    'a'.repeat(1025)
  ]) {
    const rules = configWithPolicy({
      enabled: true,
      allowedSourcePatterns: [pattern]
    });
    await assert.rejects(
      () => checkBranchName(rules, 'feature/x', 'develop'),
      /Invalid branch configuration/
    );
    assert.throws(
      () => resolveConfig(rules, 'develop'),
      /Invalid branch configuration/
    );
  }
});

test(
  'regex naming times out pathological expressions without hanging the action',
  { timeout: 10000 },
  async () => {
    const rules = configWithPolicy({
      enabled: true,
      allowedSourcePatterns: ['(a+)+']
    });
    await assert.rejects(
      () => checkBranchName(rules, 'a'.repeat(100) + '!', 'develop'),
      /two-second limit/
    );
  }
);

test('regex naming rejects excessively long untrusted branch inputs', async () => {
  const rules = configWithPolicy({
    enabled: true,
    allowedSourcePatterns: ['.*']
  });
  await assert.rejects(
    () => checkBranchName(rules, 'a'.repeat(1025), 'develop'),
    /1024 characters/
  );
});

for (const source of ['feature/x', 'bugfix/fix-login', 'hotfix/urgent']) {
  test(`branch checker allows ${source} into develop`, async () => {
    const result = await checkBranchName(config, source, 'develop');
    assert.equal(result.checked, true);
    assert.equal(result.valid, true);
    assert.equal(result.matchedBranch, 'develop');
    assert.equal(result.matchedPattern, '^' + source.split('/')[0] + '/[^/]+$');
  });
}

for (const source of [
  'feature',
  'feature/',
  'Feature/x',
  'chore/x',
  'my-feature/x',
  'feature/team/x'
]) {
  test(`branch checker rejects ${source} into develop`, async () => {
    const result = await checkBranchName(config, source, 'develop');
    assert.equal(result.checked, true);
    assert.equal(result.valid, false);
    assert.equal(result.matchedPattern, null);
  });
}

test('branch checker supports exact source names and regexes for nested names', async () => {
  const rules = configWithPolicy({
    enabled: true,
    allowedSourcePatterns: ['^qa$', '^feature/.+$']
  });
  assert.equal((await checkBranchName(rules, 'qa', 'develop')).valid, true);
  assert.equal(
    (await checkBranchName(rules, 'feature/team/x', 'develop')).valid,
    true
  );
  assert.equal((await checkBranchName(rules, 'uat', 'develop')).valid, false);
});

test('branch checker selects target policies using exact names before wildcards', async () => {
  const rules = {
    version: 1,
    branches: {
      '**': {
        branchName: { enabled: true, allowedSourcePatterns: ['^hotfix/[^/]+$'] }
      },
      develop: {
        branchName: {
          enabled: true,
          allowedSourcePatterns: ['^feature/[^/]+$']
        }
      }
    }
  };

  assert.equal(
    (await checkBranchName(rules, 'feature/x', 'develop')).valid,
    true
  );
  assert.equal(
    (await checkBranchName(rules, 'hotfix/x', 'develop')).valid,
    false
  );
  assert.equal((await checkBranchName(rules, 'hotfix/x', 'main')).valid, true);
});

test('branch checker skips a missing or disabled policy on a configured target', async () => {
  for (const policy of [undefined, {}, { enabled: false }]) {
    const result = await checkBranchName(
      configWithPolicy(policy),
      'anything/x',
      'develop'
    );
    assert.equal(result.checked, false);
    assert.equal(result.valid, true);
  }
});

test('branch checker fails when no target rule matches', async () => {
  await assert.rejects(
    () => checkBranchName(config, 'feature/x', 'main'),
    /No branch rule/
  );
  await assert.rejects(
    () => checkBranchName({}, 'feature/x', 'develop'),
    /No branch rule/
  );
});

test('branch checker requires source and target names', async () => {
  for (const [source, target] of [
    ['', 'develop'],
    ['feature/x', ''],
    [' ', 'develop']
  ]) {
    await assert.rejects(
      () => checkBranchName(config, source, target),
      /branch names are required/
    );
  }
});

for (const policy of [
  { enabled: true },
  { enabled: true, allowedSourcePatterns: [] },
  { enabled: true, allowedSourcePatterns: [' '] },
  { enabled: 'true', allowedSourcePatterns: ['^feature/[^/]+$'] },
  { enabled: true, allowedSourcePatterns: '^feature/[^/]+$' },
  { enabled: false, allowedSourcePatterns: ['['] }
]) {
  test(`branch checker rejects invalid policy ${JSON.stringify(policy)}`, async () => {
    await assert.rejects(
      () => checkBranchName(configWithPolicy(policy), 'feature/x', 'develop'),
      /Invalid branch configuration/
    );
  });
}

test('branch checker treats exclamation and hash characters literally in regexes', async () => {
  const rules = configWithPolicy({
    enabled: true,
    allowedSourcePatterns: ['^!feature/[^/]+$', '^#feature/[^/]+$']
  });
  assert.equal(
    (await checkBranchName(rules, 'chore/x', 'develop')).valid,
    false
  );
  assert.equal(
    (await checkBranchName(rules, '!feature/x', 'develop')).valid,
    true
  );
  assert.equal(
    (await checkBranchName(rules, '#feature/x', 'develop')).valid,
    true
  );
});

test('config reader preserves the validated branch naming policy', () => {
  const plan = resolveConfig(config, 'develop');
  assert.deepEqual(
    plan.branchConfig.branchName,
    config.branches.develop.branchName
  );
});

test('example JSON agrees with the guide and enables develop naming checks', async () => {
  const directory = path.resolve(__dirname, '..', 'actions', 'config-reader');
  const example = readConfig(
    readFileSync(path.join(directory, 'ci-cd-config.example.json'), 'utf8')
  );
  const guide = readFileSync(path.join(directory, 'CONFIGURATION.md'), 'utf8');
  const block = guide.match(/```json\s*([\s\S]*?)```/);
  assert.ok(block);
  assert.deepEqual(example, JSON.parse(block[1]));
  assert.equal(
    (await checkBranchName(example, 'feature/ASOS-123', 'develop')).valid,
    true
  );
  assert.equal(
    (await checkBranchName(example, 'bugfix/ASOS-456', 'develop')).valid,
    true
  );
  assert.equal(
    (await checkBranchName(example, 'feature/ASOS-abc', 'develop')).valid,
    false
  );
  assert.equal(
    (await checkBranchName(example, 'chore/x', 'develop')).valid,
    false
  );
  assert.equal(
    (await checkBranchName(example, 'develop', 'qa')).checked,
    false
  );
});

test('compiled branch checker enforces GitHub inputs and failure statuses', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pr-branch-checker-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.resolve(__dirname, '..');
  const bundleDirectory = path.join(directory, 'dist');

  execFileSync(
    process.execPath,
    [
      require.resolve('@vercel/ncc/dist/ncc/cli.js'),
      'build',
      path.join(
        projectRoot,
        'actions',
        'pr-branch-name-checker',
        'src',
        'index.ts'
      ),
      '--out',
      bundleDirectory
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );

  const marker = 'must-not-be-logged-config-value';
  const cases = [
    {
      name: 'allowed feature',
      source: 'feature/x',
      target: 'develop',
      config: { ...config, label: marker },
      exit: 0,
      checked: 'true',
      valid: 'true',
      matched: '^feature/[^/]+$'
    },
    {
      name: 'allowed bugfix',
      source: 'bugfix/x',
      target: 'develop',
      config,
      exit: 0,
      checked: 'true',
      valid: 'true',
      matched: '^bugfix/[^/]+$'
    },
    {
      name: 'explicit branch overrides',
      source: 'bugfix/override',
      target: 'develop',
      config,
      exit: 0,
      checked: 'true',
      valid: 'true',
      matched: '^bugfix/[^/]+$',
      explicit: true
    },
    {
      name: 'numeric ticket regex',
      source: 'feature/ASOS-123',
      target: 'develop',
      config: configWithPolicy({
        enabled: true,
        allowedSourcePatterns: ['^feature/ASOS-[0-9]+$']
      }),
      exit: 0,
      checked: 'true',
      valid: 'true',
      matched: '^feature/ASOS-[0-9]+$'
    },
    {
      name: 'rejected nonnumeric ticket',
      source: 'feature/ASOS-abc',
      target: 'develop',
      config: configWithPolicy({
        enabled: true,
        allowedSourcePatterns: ['^feature/ASOS-[0-9]+$']
      }),
      exit: 1,
      checked: 'true',
      valid: 'false',
      matched: ''
    },
    {
      name: 'malformed regex',
      source: 'feature/x',
      target: 'develop',
      config: configWithPolicy({ enabled: true, allowedSourcePatterns: ['['] }),
      exit: 1
    },
    {
      name: 'timed out regex',
      source: 'a'.repeat(100) + '!',
      target: 'develop',
      config: configWithPolicy({
        enabled: true,
        allowedSourcePatterns: ['(a+)+']
      }),
      exit: 1
    },
    {
      name: 'disallowed name',
      source: 'chore/x',
      target: 'develop',
      config,
      exit: 1,
      checked: 'true',
      valid: 'false',
      matched: ''
    },
    {
      name: 'disabled policy',
      source: 'chore/x',
      target: 'develop',
      config: configWithPolicy({ enabled: false }),
      exit: 0,
      checked: 'false',
      valid: 'true',
      matched: ''
    },
    {
      name: 'unknown target',
      source: 'feature/x',
      target: 'main',
      config,
      exit: 1
    },
    { name: 'missing PR context', source: '', target: '', config, exit: 1 },
    {
      name: 'invalid policy',
      source: 'feature/x',
      target: 'develop',
      config: configWithPolicy({ enabled: true }),
      exit: 1
    },
    {
      name: 'malformed JSON',
      source: 'feature/x',
      target: 'develop',
      config,
      input: `{"label":"${marker}"`,
      exit: 1
    },
    {
      name: 'missing JSON',
      source: 'feature/x',
      target: 'develop',
      config,
      input: '',
      exit: 1
    }
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, () => {
      const output = path.join(
        directory,
        `${scenario.name.replaceAll(' ', '-')}-output`
      );
      writeFileSync(output, '');
      const result = spawnSync(
        process.execPath,
        [path.join(bundleDirectory, 'index.js')],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            INPUT_CONFIG: scenario.input ?? JSON.stringify(scenario.config),
            'INPUT_GITHUB-TOKEN': '',
            GITHUB_TOKEN: '',
            'INPUT_SOURCE-BRANCH': scenario.explicit ? scenario.source : '',
            'INPUT_TARGET-BRANCH': scenario.explicit ? scenario.target : '',
            GITHUB_HEAD_REF: scenario.explicit
              ? 'chore/ignored'
              : scenario.source,
            GITHUB_BASE_REF: scenario.explicit
              ? 'unconfigured'
              : scenario.target,
            GITHUB_OUTPUT: output
          }
        }
      );

      assert.ifError(result.error);
      assert.equal(
        result.status,
        scenario.exit,
        `${result.stdout}${result.stderr}`
      );
      assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
      if (scenario.valid === 'false') {
        assert.match(result.stdout, /no GitHub token was provided/);
      }
      const content = readFileSync(output, 'utf8');

      if (scenario.checked === undefined) {
        assert.equal(content, '');
        return;
      }

      const lines = content.trimEnd().split(/\r?\n/);
      const outputs: Record<string, string> = {};

      for (let index = 0; index < lines.length; index += 3) {
        const [name, delimiter] = lines[index].split('<<');
        assert.equal(lines[index + 2], delimiter);
        outputs[name] = lines[index + 1];
      }

      assert.equal(outputs.checked, scenario.checked);
      assert.equal(outputs.valid, scenario.valid);
      assert.equal(outputs['source-branch'], scenario.source);
      assert.equal(outputs['target-branch'], scenario.target);
      assert.equal(outputs['matched-pattern'], scenario.matched);
    });
  }

  await context.test(
    'compiled rejection posts once, updates on reruns, and still fails when comments are forbidden',
    async (subcontext) => {
      const methods: string[] = [];
      const comments: { id: number; body: string; user: { type: string } }[] =
        [];
      let denyWrites = false;
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
            JSON.stringify({
              message: 'Resource not accessible by integration'
            })
          );
          return;
        }

        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
        }
        const payload = JSON.parse(body) as { body: string };
        assert.ok(payload.body.includes('chore/x'));
        assert.ok(payload.body.includes('^feature/[^/]+$'));
        assert.ok(!payload.body.includes(marker));

        if (method === 'POST') {
          comments.push({ id: 123, body: payload.body, user: { type: 'Bot' } });
          response.statusCode = 201;
        } else {
          assert.equal(method, 'PATCH');
          assert.ok(request.url?.endsWith('/issues/comments/123'));
          comments[0].body = payload.body;
        }

        response.end(JSON.stringify(comments[0]));
      });

      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      subcontext.after(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      );
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const event = path.join(directory, 'comment-pr-event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));
      const token = 'local-test-token-not-a-secret';

      const runAction = (source: string) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const output = path.join(directory, 'comment-output');
            writeFileSync(output, '');
            const child = spawn(
              process.execPath,
              [path.join(bundleDirectory, 'index.js')],
              {
                timeout: 10000,
                env: {
                  ...process.env,
                  INPUT_CONFIG: JSON.stringify({ ...config, label: marker }),
                  'INPUT_GITHUB-TOKEN': token,
                  'INPUT_SOURCE-BRANCH': source,
                  'INPUT_TARGET-BRANCH': 'develop',
                  GITHUB_TOKEN: '',
                  GITHUB_HEAD_REF: source,
                  GITHUB_BASE_REF: 'develop',
                  GITHUB_REPOSITORY: 'example/salesforce',
                  GITHUB_EVENT_NAME: 'pull_request',
                  GITHUB_EVENT_PATH: event,
                  GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
                  GITHUB_OUTPUT: output
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
            child.once('close', (code) => resolve({ code, stdout, stderr }));
          }
        );

      const first = await runAction('chore/x');
      assert.equal(first.code, 1, first.stderr);
      assert.deepEqual(methods, ['GET', 'POST']);
      assert.equal(comments.length, 1);
      assert.ok(!first.stdout.includes(marker));

      const second = await runAction('chore/x');
      assert.equal(second.code, 1, second.stderr);
      assert.deepEqual(methods, ['GET', 'POST', 'GET', 'PATCH']);
      assert.equal(comments.length, 1);

      const accepted = await runAction('feature/x');
      assert.equal(accepted.code, 0, accepted.stderr);
      assert.equal(methods.length, 4);

      denyWrites = true;
      const denied = await runAction('chore/x');
      assert.equal(denied.code, 1, denied.stderr);
      assert.match(denied.stdout, /Unable to post PR feedback/);
      assert.match(denied.stdout, /pull-requests: write/);
      assert.deepEqual(methods, [
        'GET',
        'POST',
        'GET',
        'PATCH',
        'GET',
        'PATCH'
      ]);
    }
  );
});
