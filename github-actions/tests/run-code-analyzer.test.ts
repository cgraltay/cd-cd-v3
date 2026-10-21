import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codeAnalyzerPolicySchema } from '../shared/code-analyzer';
import {
  analyzerArgs,
  inlineComments,
  parseAnalyzerReport,
  reviewableLines,
  selectFiles
} from '../actions/run-code-analyzer/src/analyzer';
import { analyzePullRequest } from '../actions/run-code-analyzer/src/run';
import { readConfig, resolveConfig } from '../actions/config-reader/src/config';

const file = {
  filename: 'force-app/classes/X.cls',
  status: 'added',
  patch: '@@ -0,0 +1,3 @@\n+public class X {\n+  void work() {}\n+}'
};

test('analyzer selects changed Apex classes and triggers within package boundaries', () => {
  assert.deepEqual(
    selectFiles(
      [
        file,
        { filename: 'force-app/triggers/X.trigger', status: 'modified' },
        { filename: 'force-app/classes/Old.cls', status: 'removed' },
        { filename: 'force-app-other/X.cls', status: 'added' },
        { filename: '../force-app/X.cls', status: 'added' },
        { filename: '/force-app/X.cls', status: 'added' },
        { filename: 'force-app/a/../X.cls', status: 'added' },
        { filename: 'force-app/X.cls-meta.xml', status: 'added' }
      ],
      ['force-app/']
    ).map((entry) => entry.filename),
    [file.filename, 'force-app/triggers/X.trigger']
  );
  assert.throws(
    () => selectFiles([file], ['../outside']),
    /within the repository/
  );
});

test('analyzer builds shell-free CLI argument arrays with explicit targets and selectors', () => {
  const policy = codeAnalyzerPolicySchema.parse({
    enabled: true,
    ruleSelectors: ['pmd', 'regex:Recommended']
  });
  const args = analyzerArgs(
    policy,
    [file],
    '/repo/code-analyzer.yml',
    '/tmp/report.json'
  );
  assert.deepEqual(args, [
    'code-analyzer',
    'run',
    '--config-file',
    '/repo/code-analyzer.yml',
    '--workspace',
    '.',
    '--output-file',
    '/tmp/report.json',
    '--rule-selector',
    'pmd',
    '--rule-selector',
    'regex:Recommended',
    '--target',
    './force-app/classes/X.cls'
  ]);
  assert.throws(
    () => analyzerArgs(policy, [], 'config.yml', 'report.json'),
    /must not be empty/
  );
});

test('analyzer maps right-side reviewable lines without treating deleted lines as targets', () => {
  const patch =
    '@@ -1,3 +1,3 @@\n context\n-old\n+new\n tail\n@@ -20,0 +21,1 @@\n+added';
  assert.deepEqual([...reviewableLines(patch)], [1, 2, 3, 21]);
  assert.equal(reviewableLines(undefined).size, 0);
});

test('analyzer validates JSON report structure and severity values', () => {
  assert.deepEqual(parseAnalyzerReport('{"violations":[]}').violations, []);
  for (const input of [
    '{',
    '{}',
    '{"violations":"invalid"}',
    '{"violations":[{"severity":8}]}'
  ]) {
    assert.throws(
      () => parseAnalyzerReport(input),
      /valid JSON violations report/
    );
  }
});

test('analyzer creates escaped inline comments only on reviewable changed files', () => {
  const violation = {
    rule: 'Rule',
    engine: 'pmd',
    severity: 2,
    message: '<@team&>',
    locations: [{ file: path.resolve('/repo', file.filename), startLine: 2 }]
  };
  const report = parseAnalyzerReport(
    JSON.stringify({
      violations: [
        violation,
        { ...violation, locations: [{ file: file.filename, startLine: 50 }] },
        { ...violation, locations: [{ file: '../outside.cls', startLine: 2 }] },
        { ...violation, locations: [] }
      ]
    })
  );
  const comments = inlineComments(report, [file], '/repo');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].line, 2);
  assert.equal(comments[0].path, file.filename);
  assert.ok(comments[0].body.includes('&lt;&#64;team&amp;&gt;'));
});

test('analyzer policy has safe disabled defaults and validates thresholds', () => {
  const policy = codeAnalyzerPolicySchema.parse({});
  assert.equal(policy.enabled, false);
  assert.equal(policy.failOnSeverity, 5);
  for (const value of [
    { failOnSeverity: 0 },
    { packageDirectories: [] },
    { maxInlineComments: 101 },
    { ruleSelectors: [] }
  ]) {
    assert.equal(codeAnalyzerPolicySchema.safeParse(value).success, false);
  }
});

test('documented analyzer example matches the guide and resolves its branch policy', () => {
  const directory = path.resolve(__dirname, '..', 'actions', 'config-reader');
  const example = readConfig(
    readFileSync(path.join(directory, 'ci-cd-config.example.json'), 'utf8')
  );
  const guide = readFileSync(path.join(directory, 'CONFIGURATION.md'), 'utf8');
  const block = guide.match(/```json\s*([\s\S]*?)```/);
  assert.ok(block);
  assert.deepEqual(example, JSON.parse(block[1]));
  const policy = codeAnalyzerPolicySchema.parse(
    resolveConfig(example, 'develop').branchConfig.codeAnalyzer
  );
  assert.equal(policy.enabled, true);
  assert.equal(policy.configPath, 'code-analyzer.yml');
});

test(
  'real Salesforce PMD accepts the default config, ruleset, and report schema',
  { skip: process.env.SF_ANALYZER_SMOKE !== '1', timeout: 120000 },
  (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sf-analyzer-smoke-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const repository = path.resolve(__dirname, '..', '..');
    copyFileSync(
      path.join(repository, 'code-analyzer.yml'),
      path.join(directory, 'code-analyzer.yml')
    );
    copyFileSync(
      path.join(repository, 'pmd-ruleset.xml'),
      path.join(directory, 'pmd-ruleset.xml')
    );
    mkdirSync(path.join(directory, 'force-app'));
    writeFileSync(
      path.join(directory, 'force-app', 'AnalyzerSmoke.cls'),
      "public with sharing class AnalyzerSmoke { public static void work() { System.debug('example'); } }\n"
    );
    const reportPath = path.join(directory, 'report.json');
    const policy = codeAnalyzerPolicySchema.parse({
      enabled: true,
      ruleSelectors: ['pmd']
    });
    try {
      execFileSync(
        'sf',
        analyzerArgs(
          policy,
          [{ filename: 'force-app/AnalyzerSmoke.cls', status: 'added' }],
          path.join(directory, 'code-analyzer.yml'),
          reportPath
        ),
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 90000,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      assert.fail(
        `Real Salesforce Code Analyzer failed: ${output.stdout ?? ''}\n${output.stderr ?? ''}`
      );
    }
    const report = parseAnalyzerReport(readFileSync(reportPath, 'utf8'));
    assert.ok(Array.isArray(report.violations));
  }
);

test('analyzer runner executes once, clears only its bot feedback, and counts non-inline blocking findings', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'analyzer-runner-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'code-analyzer.yml'), 'engines: {}\n');
  const { getOctokit } = await import('@actions/github');
  const requests: string[] = [];
  const client = getOctokit('fake-test-token', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        requests.push(request.method + ' ' + pathname);
        if (request.method === 'GET' && pathname.endsWith('/files')) {
          return Response.json([file]);
        }
        if (
          request.method === 'GET' &&
          pathname.endsWith('/pulls/42/comments')
        ) {
          return Response.json([
            {
              id: 1,
              body: '<!-- sf-cicd:run-code-analyzer -->',
              user: { type: 'User' }
            },
            { id: 2, body: 'Unrelated', user: { type: 'Bot' } },
            { id: 3, body: '<!-- run-code-analyzer -->', user: { type: 'Bot' } }
          ]);
        }
        if (request.method === 'GET') {
          return Response.json([]);
        }
        if (request.method === 'DELETE') {
          assert.ok(pathname.endsWith('/3'));
          return new Response(null, { status: 204 });
        }
        const payload = (await request.json()) as Record<string, unknown>;
        if (pathname.endsWith('/pulls/42/comments')) {
          assert.equal(payload.commit_id, 'a'.repeat(40));
          assert.equal(payload.line, 2);
        }
        return Response.json({ id: 10 });
      }
    }
  });
  let runs = 0;
  const result = await analyzePullRequest({
    client,
    owner: 'example',
    repo: 'salesforce',
    number: 42,
    headSha: 'a'.repeat(40),
    workspace: directory,
    tempDirectory: directory,
    policy: codeAnalyzerPolicySchema.parse({
      enabled: true,
      failOnSeverity: 3
    }),
    execute: async (args, workspace) => {
      runs += 1;
      assert.equal(workspace, directory);
      const reportPath = args[args.indexOf('--output-file') + 1];
      writeFileSync(
        reportPath,
        JSON.stringify({
          violations: [
            {
              rule: 'Rule',
              engine: 'pmd',
              severity: 2,
              message: 'Inline finding',
              locations: [{ file: file.filename, startLine: 2 }]
            },
            {
              rule: 'OtherRule',
              engine: 'pmd',
              severity: 3,
              message: 'Outside diff',
              locations: [{ file: file.filename, startLine: 200 }]
            }
          ]
        })
      );
      return 0;
    }
  });
  assert.equal(runs, 1);
  assert.equal(result.filesAnalyzed, 1);
  assert.equal(result.violations, 2);
  assert.equal(result.blockingViolations, 2);
  assert.equal(result.inlineComments, 1);
  assert.ok(
    requests.includes('DELETE /repos/example/salesforce/pulls/comments/3')
  );
  assert.ok(
    requests.includes('POST /repos/example/salesforce/issues/42/comments')
  );
});

test('analyzer runner skips empty PR targets and removes stale analyzer feedback', async () => {
  const { getOctokit } = await import('@actions/github');
  const deleted: string[] = [];
  const client = getOctokit('fake-test-token', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        if (request.method === 'DELETE') {
          deleted.push(pathname);
          return new Response(null, { status: 204 });
        }
        if (pathname.endsWith('/files')) {
          return Response.json([{ ...file, status: 'removed' }]);
        }
        return Response.json([
          {
            id: 3,
            body: '<!-- sf-cicd:run-code-analyzer -->',
            user: { type: 'Bot' }
          }
        ]);
      }
    }
  });
  const result = await analyzePullRequest({
    client,
    owner: 'example',
    repo: 'salesforce',
    number: 42,
    headSha: 'a'.repeat(40),
    workspace: '/repo',
    policy: codeAnalyzerPolicySchema.parse({ enabled: true }),
    execute: async () => assert.fail('Analyzer must not run without targets.')
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reportPath, '');
  assert.equal(deleted.length, 2);
});

test('analyzer command failure preserves existing feedback and does not accept a stale report', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'analyzer-error-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'code-analyzer.yml'), 'engines: {}\n');
  const { getOctokit } = await import('@actions/github');
  const client = getOctokit('fake-test-token', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        assert.ok(request.url.endsWith('/files?per_page=100'));
        return Response.json([file]);
      }
    }
  });
  const options = {
    client,
    owner: 'example',
    repo: 'salesforce',
    number: 42,
    headSha: 'a'.repeat(40),
    workspace: directory,
    tempDirectory: directory,
    policy: codeAnalyzerPolicySchema.parse({ enabled: true })
  };
  await assert.rejects(
    () => analyzePullRequest({ ...options, execute: async () => 1 }),
    /exit code 1/
  );
  await assert.rejects(
    () => analyzePullRequest({ ...options, execute: async () => 0 }),
    /did not write its JSON report/
  );
});

test('compiled analyzer action runs sf, gates findings, clears fixed feedback, and skips empty targets', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'compiled-analyzer-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.resolve(__dirname, '..');
  const bundleDirectory = path.join(directory, 'dist');
  execFileSync(
    process.execPath,
    [
      require.resolve('@vercel/ncc/dist/ncc/cli.js'),
      'build',
      path.join(projectRoot, 'actions', 'run-code-analyzer', 'src', 'index.ts'),
      '--out',
      bundleDirectory
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  mkdirSync(path.join(directory, 'force-app', 'classes'), { recursive: true });
  writeFileSync(path.join(directory, file.filename), 'public class X {}\n');
  writeFileSync(path.join(directory, 'code-analyzer.yml'), 'engines: {}\n');
  writeFileSync(
    path.join(bin, 'sf'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "if (process.env.GITHUB_TOKEN || process.env['INPUT_GITHUB-TOKEN']) throw new Error('GitHub token leaked to sf');",
      'const args = process.argv.slice(2);',
      "if (args[0] !== 'code-analyzer' || args[1] !== 'run') process.exit(8);",
      "if (process.env.FAKE_ANALYZER_MODE === 'error') process.exit(2);",
      "const violations = process.env.FAKE_ANALYZER_MODE === 'clean' ? [] : [{ rule: 'TestRule', engine: 'pmd', severity: 3, message: 'Example finding', locations: [{ file: 'force-app/classes/X.cls', startLine: 2 }] }];",
      "fs.writeFileSync(args[args.indexOf('--output-file') + 1], JSON.stringify({ violations }));"
    ].join('\n'),
    { mode: 0o755 }
  );
  const summaries: { id: number; body: string; user: { type: string } }[] = [];
  const reviews: { id: number; body: string; user: { type: string } }[] = [];
  let removed = false;
  let denyFeedback = false;
  let nextId = 1;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(
        JSON.stringify(
          pathname.endsWith('/files')
            ? [{ ...file, status: removed ? 'removed' : 'added' }]
            : pathname.includes('/pulls/')
              ? reviews
              : summaries
        )
      );
      return;
    }
    if (denyFeedback) {
      response.statusCode = 403;
      response.end(JSON.stringify({ message: 'Forbidden' }));
      return;
    }
    const collection = pathname.includes('/pulls/') ? reviews : summaries;
    if (request.method === 'DELETE') {
      const id = Number(pathname.split('/').at(-1));
      const index = collection.findIndex((comment) => comment.id === id);
      if (index >= 0) collection.splice(index, 1);
      response.statusCode = 204;
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { body: string };
    if (request.method === 'PATCH') {
      const existing = collection.find(
        (comment) => comment.id === Number(pathname.split('/').at(-1))
      );
      assert.ok(existing);
      existing.body = payload.body;
      response.end(JSON.stringify(existing));
    } else {
      const comment = {
        id: nextId++,
        body: payload.body,
        user: { type: 'Bot' }
      };
      collection.push(comment);
      response.statusCode = 201;
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
  const event = path.join(directory, 'event.json');
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: {
        number: 42,
        base: { ref: 'develop' },
        head: { sha: 'a'.repeat(40) }
      }
    })
  );
  const runAction = (mode: string, enabled = true) =>
    new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      outputs: Record<string, string>;
    }>((resolve, reject) => {
      const output = path.join(directory, 'output.txt');
      writeFileSync(output, '');
      const child = spawn(
        process.execPath,
        [path.join(bundleDirectory, 'index.js')],
        {
          timeout: 15000,
          env: {
            ...process.env,
            PATH: bin + path.delimiter + process.env.PATH,
            INPUT_CONFIG: JSON.stringify({
              version: 1,
              branches: { develop: { codeAnalyzer: { enabled } } }
            }),
            'INPUT_GITHUB-TOKEN': 'local-test-token-not-a-secret',
            'INPUT_WORKING-DIRECTORY': '.',
            GITHUB_TOKEN: '',
            GITHUB_WORKSPACE: directory,
            RUNNER_TEMP: directory,
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: event,
            GITHUB_REPOSITORY: 'example/salesforce',
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
            GITHUB_OUTPUT: output,
            FAKE_ANALYZER_MODE: mode
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
        const content = readFileSync(output, 'utf8').trimEnd();
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
    'blocking findings fail with report output and inline feedback',
    async () => {
      const result = await runAction('findings');
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.outputs['blocking-violations'], '1');
      assert.equal(result.outputs['files-analyzed'], '1');
      assert.ok(
        readFileSync(result.outputs['report-path'], 'utf8').includes('TestRule')
      );
      assert.equal(reviews.length, 1);
      assert.equal(summaries.length, 1);
    }
  );
  await context.test(
    'CLI failures fail without clearing previous findings',
    async () => {
      const result = await runAction('error');
      assert.equal(result.code, 1);
      assert.match(result.stdout, /exit code 2/);
      assert.equal(reviews.length, 1);
      assert.equal(summaries.length, 1);
    }
  );
  await context.test(
    'feedback permission errors do not hide blocking findings',
    async () => {
      denyFeedback = true;
      const result = await runAction('findings');
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.outputs['blocking-violations'], '1');
      assert.match(result.stdout, /Unable to synchronize/);
      denyFeedback = false;
    }
  );
  await context.test(
    'clean scan removes previous inline and summary comments',
    async () => {
      const result = await runAction('clean');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.violations, '0');
      assert.equal(reviews.length, 0);
      assert.equal(summaries.length, 0);
    }
  );
  await context.test('no changed Apex files skip the CLI', async () => {
    removed = true;
    const result = await runAction('error');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.skipped, 'true');
    assert.equal(result.outputs['report-path'], '');
  });
  await context.test(
    'disabled policy skips analysis without requiring an analyzer config',
    async () => {
      const result = await runAction('error', false);
      assert.equal(result.code, 0);
      assert.equal(result.outputs.skipped, 'true');
      assert.equal(result.outputs['files-analyzed'], '0');
      assert.equal(result.outputs.violations, '0');
      assert.equal(result.outputs['report-path'], '');
    }
  );
});
