import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadOrgsConfig, readOrgsConfig } from '../shared/orgs';
import { resolveConfig } from '../actions/config-reader/src/config';
import {
  dryRunArgs,
  parseDryRun,
  redactReport,
  sourcePaths,
  validationSettingsSchema
} from '../actions/validate-deployment/src/validation';
import { validateSources } from '../actions/validate-deployment/src/run';
import {
  publishValidationComment,
  validationCommentKey
} from '../actions/validate-deployment/src/comment';

const profiles = {
  version: 1,
  orgs: {
    qa: {
      environment: 'salesforce-qa',
      auth: 'jwt',
      instanceUrl: 'https://test.salesforce.com',
      usernameSecret: 'SF_USERNAME',
      clientIdSecret: 'SF_CLIENT_ID',
      jwtKeySecret: 'SF_JWT_PRIVATE_KEY'
    },
    uat: {
      environment: 'salesforce-uat',
      auth: 'jwt',
      instanceUrl: 'https://test.salesforce.com',
      usernameSecret: 'SF_USERNAME',
      clientIdSecret: 'SF_CLIENT_ID',
      jwtKeySecret: 'SF_JWT_PRIVATE_KEY'
    }
  }
};

test('org configuration JSON takes precedence without reading a file', () => {
  assert.deepEqual(
    loadOrgsConfig(JSON.stringify(profiles), '/nonexistent/orgs.config.json'),
    readOrgsConfig(JSON.stringify(profiles))
  );
  assert.throws(
    () => loadOrgsConfig('{', '/nonexistent/orgs.config.json'),
    /Invalid orgs configuration/
  );
  assert.equal(loadOrgsConfig(''), undefined);
});

test('org configuration file remains a validated fallback', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orgs-input-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'orgs.config.json');
  writeFileSync(file, JSON.stringify(profiles));
  assert.deepEqual(
    loadOrgsConfig(' \n', file),
    readOrgsConfig(JSON.stringify(profiles))
  );
  assert.throws(
    () => loadOrgsConfig('', path.join(directory, 'missing.json')),
    /Unable to read/
  );
  writeFileSync(file, '{');
  assert.throws(() => loadOrgsConfig('', file), /Invalid orgs configuration/);
});

test('validation matrix resolves per-org environments and secret names without credentials', () => {
  const orgs = readOrgsConfig(JSON.stringify(profiles));
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        develop: {
          validation: {
            enabled: true,
            orgs: ['qa', 'uat'],
            testLevel: 'RunSpecifiedTests',
            tests: ['AccountTest'],
            waitMinutes: 30
          }
        }
      }
    },
    'develop',
    'develop',
    undefined,
    orgs
  );
  assert.deepEqual(
    plan.validationMatrix.include.map((entry) => [
      entry.org,
      entry.environment
    ]),
    [
      ['qa', 'salesforce-qa'],
      ['uat', 'salesforce-uat']
    ]
  );
  for (const entry of plan.validationMatrix.include) {
    assert.equal(entry.jwtKeySecret, 'SF_JWT_PRIVATE_KEY');
    assert.equal(entry.testLevel, 'RunSpecifiedTests');
    assert.deepEqual(entry.tests, ['AccountTest']);
    assert.equal(entry.waitMinutes, 30);
    assert.ok(!Object.hasOwn(entry, 'jwtPrivateKey'));
  }
});

test('org profiles reject secret values, unsupported auth, and unsafe login URLs', () => {
  for (const profile of [
    { ...profiles.orgs.qa, jwtPrivateKey: 'PRIVATE-KEY-MUST-NOT-LEAK' },
    { ...profiles.orgs.qa, auth: 'password' },
    { ...profiles.orgs.qa, instanceUrl: 'http://test.salesforce.com' },
    {
      ...profiles.orgs.qa,
      instanceUrl: 'https://user:password@test.salesforce.com'
    },
    { ...profiles.orgs.qa, jwtKeySecret: '' }
  ]) {
    assert.throws(
      () =>
        readOrgsConfig(JSON.stringify({ version: 1, orgs: { qa: profile } })),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid orgs configuration/);
        assert.ok(!error.message.includes('PRIVATE-KEY-MUST-NOT-LEAK'));
        return true;
      }
    );
  }
});

test('validation matrix rejects orgs without a connection profile', () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          version: 1,
          branches: {
            develop: { validation: { enabled: true, orgs: ['missing'] } }
          }
        },
        'develop',
        'develop',
        undefined,
        readOrgsConfig(JSON.stringify(profiles))
      ),
    /selected org is missing/
  );
});

test('validation policy requires named tests for RunSpecifiedTests', () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          version: 1,
          branches: {
            develop: {
              validation: {
                enabled: true,
                orgs: ['qa'],
                testLevel: 'RunSpecifiedTests'
              }
            }
          }
        },
        'develop'
      ),
    /Invalid branch configuration/
  );
});

test('validation policy supports the legacy RunRelevantTests behavior', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        develop: {
          validation: {
            enabled: true,
            orgs: ['qa'],
            testLevel: 'RunRelevantTests',
            waitMinutes: 180
          }
        }
      }
    },
    'develop',
    'develop',
    undefined,
    readOrgsConfig(JSON.stringify(profiles))
  );
  assert.equal(plan.validationMatrix.include[0].testLevel, 'RunRelevantTests');
  assert.equal(plan.validationMatrix.include[0].waitMinutes, 180);
  assert.equal(plan.validationMatrix.include[0].environment, 'salesforce-qa');
});

test('documented branch config and org profiles form a credential-free environment matrix', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const branchPath = path.join(projectRoot, 'actions', 'config-reader');
  const config = JSON.parse(
    readFileSync(path.join(branchPath, 'ci-cd-config.example.json'), 'utf8')
  );
  const guide = readFileSync(path.join(branchPath, 'CONFIGURATION.md'), 'utf8');
  const block = guide.match(/```json\s*([\s\S]*?)```/);
  assert.ok(block);
  assert.deepEqual(config, JSON.parse(block[1]));
  const orgs = readOrgsConfig(
    readFileSync(
      path.join(branchPath, 'orgs-connections-config.example.json'),
      'utf8'
    )
  );
  for (const branch of ['develop', 'qa', 'uat', 'main']) {
    const plan = resolveConfig(config, branch, branch, undefined, orgs);
    assert.equal(plan.validationEnabled, true);
    for (const row of plan.validationMatrix.include) {
      assert.ok(row.environment);
      assert.equal(row.testLevel, 'RunRelevantTests');
      assert.equal(row.waitMinutes, 180);
      assert.equal(row.jwtKeySecret, 'SF_JWT_PRIVATE_KEY');
    }
  }
});

test('validation orders full and changed-file sources by the Salesforce project', () => {
  const project = {
    packageDirectories: [{ path: 'shared' }, { path: 'force-app' }]
  };
  const settings = validationSettingsSchema.parse({
    mode: 'delta',
    sourceDirs: ['force-app', 'shared']
  });
  const files = [
    { filename: 'force-app/main/default/classes/X.cls', status: 'added' },
    { filename: 'shared/main/default/classes/Y.cls', status: 'modified' },
    { filename: 'shared/main/default/classes/Old.cls', status: 'removed' },
    { filename: 'outside/X.cls', status: 'added' }
  ];
  assert.deepEqual(sourcePaths(settings, project, files), [
    'shared/main/default/classes/Y.cls',
    'force-app/main/default/classes/X.cls'
  ]);
  assert.deepEqual(sourcePaths({ ...settings, mode: 'full' }, project, files), [
    'shared',
    'force-app'
  ]);
  assert.throws(
    () =>
      sourcePaths({ ...settings, sourceDirs: ['../outside'] }, project, files),
    /within the project/
  );
  assert.throws(
    () =>
      sourcePaths(settings, project, [
        { filename: '../outside.cls', status: 'added' }
      ]),
    /within the project/
  );
});

test('validation defaults to RunRelevantTests and a 180-minute dry run', () => {
  const settings = validationSettingsSchema.parse({
    mode: 'full',
    sourceDirs: ['force-app']
  });
  const args = dryRunArgs(settings, ['force-app'], 'unique-org-alias');
  assert.deepEqual(args, [
    'project',
    'deploy',
    'start',
    '--source-dir',
    './force-app',
    '--target-org',
    'unique-org-alias',
    '--wait',
    '180',
    '--dry-run',
    '--json',
    '--test-level',
    'RunRelevantTests'
  ]);
  assert.ok(!args.includes('--tests'));
  assert.throws(() => dryRunArgs(settings, [], 'org'), /explicit source paths/);
});

test('validation distinguishes success, failures, incomplete results, and NothingToDeploy', () => {
  assert.equal(
    parseDryRun(
      JSON.stringify({
        status: 0,
        result: { success: true, status: 'Succeeded' }
      }),
      0
    ).outcome,
    'Succeeded'
  );
  for (const [report, exit] of [
    [{}, 0],
    [{ status: 0, result: { success: true, status: 'InProgress' } }, 0],
    [{ status: 0, result: { success: true, status: 'Succeeded' } }, 1]
  ] as const) {
    assert.equal(parseDryRun(JSON.stringify(report), exit).outcome, 'Failed');
  }
  assert.equal(parseDryRun('{', 0).outcome, 'Failed');
  assert.equal(
    parseDryRun(JSON.stringify({ name: 'NothingToDeploy' }), 1).outcome,
    'Skipped'
  );
});

test('validation artifacts redact credentials and token fields structurally', () => {
  assert.deepEqual(
    redactReport(
      {
        message: 'user@example.com failed',
        nested: { accessToken: 'session', value: 'secret-key' }
      },
      ['user@example.com', 'secret-key']
    ),
    {
      message: '*** failed',
      nested: { accessToken: '***', value: '***' }
    }
  );
});

test('JWT validation isolates auth state, uses a protected key, redacts reports, and cleans up', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jwt-validation-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'force-app'));
  writeFileSync(
    path.join(directory, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app' }] })
  );
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const profile = readOrgsConfig(JSON.stringify(profiles)).orgs.qa;
  const calls: string[][] = [];
  let authDirectory = '';
  const result = await validateSources({
    org: 'qa',
    profile,
    settings: validationSettingsSchema.parse({
      mode: 'full',
      sourceDirs: ['force-app']
    }),
    files: [],
    workspace: directory,
    username: 'integration@example.com',
    clientId: 'client-id-value',
    jwtPrivateKey: privateKey,
    tempDirectory: directory,
    execute: async (args, options) => {
      calls.push(args);
      authDirectory = options.env.HOME;
      assert.ok(authDirectory.startsWith(directory));
      assert.equal(options.env['INPUT_JWT-PRIVATE-KEY'], undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.INPUT_CONFIG, undefined);
      assert.equal(options.env.SF_ACCESS_TOKEN, undefined);
      assert.equal(options.env.SFDX_AUTH_URL, undefined);
      if (args[0] === 'org') {
        const keyFile = args[args.indexOf('--jwt-key-file') + 1];
        assert.equal(statSync(keyFile).mode & 0o777, 0o600);
        assert.equal(readFileSync(keyFile, 'utf8'), privateKey);
        assert.ok(!args.includes('--set-default'));
        return {
          exitCode: 0,
          stdout: '{"result":{"accessToken":"DO-NOT-PERSIST"}}',
          stderr: ''
        };
      }
      assert.ok(args.includes('--dry-run'));
      assert.ok(args.includes('RunRelevantTests'));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 0,
          result: {
            success: true,
            status: 'Succeeded',
            id: '0AfExample',
            username: 'integration@example.com',
            accessToken: 'session-secret'
          }
        }),
        stderr: ''
      };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result.outcome, 'Succeeded');
  assert.equal(existsSync(authDirectory), false);
  const report = readFileSync(result.reportPath, 'utf8');
  assert.ok(!report.includes('DO-NOT-PERSIST'));
  assert.ok(!report.includes('integration@example.com'));
  assert.ok(!report.includes('session-secret'));
  assert.ok(!report.includes('PRIVATE KEY'));
});

test('JWT authentication failure removes private key and state without running validation', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jwt-failure-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'force-app'));
  writeFileSync(
    path.join(directory, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app' }] })
  );
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  let authDirectory = '';
  await assert.rejects(
    () =>
      validateSources({
        org: 'qa',
        profile: readOrgsConfig(JSON.stringify(profiles)).orgs.qa,
        settings: validationSettingsSchema.parse({
          mode: 'full',
          sourceDirs: ['force-app']
        }),
        files: [],
        workspace: directory,
        username: 'integration@example.com',
        clientId: 'client-id-value',
        jwtPrivateKey: privateKey,
        tempDirectory: directory,
        execute: async (args, options) => {
          assert.equal(args[0], 'org');
          authDirectory = options.env.HOME;
          return {
            exitCode: 1,
            stdout: 'private upstream error',
            stderr: 'private upstream error'
          };
        }
      }),
    /JWT authentication failed/
  );
  assert.equal(existsSync(authDirectory), false);
});

test('validation comments isolate orgs and keep component, test, and coverage sections', async () => {
  const { getOctokit } = await import('@actions/github');
  let body = '';
  const client = getOctokit('fake-test-token', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === 'GET') return Response.json([]);
        body = ((await request.json()) as { body: string }).body;
        return Response.json({ id: 1 });
      }
    }
  });
  await publishValidationComment(
    client,
    { owner: 'example', repo: 'salesforce', number: 42 },
    {
      org: 'qa',
      environment: 'salesforce-qa',
      sources: ['force-app'],
      sourceCount: 2,
      testLevel: 'RunRelevantTests',
      result: parseDryRun(
        JSON.stringify({
          status: 1,
          result: {
            status: 'Failed',
            success: false,
            details: {
              componentFailures: {
                fullName: 'X',
                componentType: 'ApexClass',
                fileName: 'classes/X.cls',
                problem: '<@team&>',
                lineNumber: 2
              },
              runTestResult: {
                failures: {
                  name: 'XTest',
                  methodName: 'fails',
                  message: 'Test failed'
                },
                codeCoverageWarnings: {
                  name: 'X',
                  message: 'Insufficient coverage'
                }
              }
            },
            files: [
              {
                fullName: 'X',
                type: 'ApexClass',
                filePath: '/runner/source/force-app/classes/X.cls'
              }
            ]
          }
        }),
        1
      )
    }
  );
  assert.ok(body.includes(validationCommentKey('qa')));
  assert.notEqual(validationCommentKey('qa'), validationCommentKey('uat'));
  assert.match(body, /Component Failures/);
  assert.match(body, /Test Failures/);
  assert.match(body, /Coverage Failures/);
  assert.ok(body.includes('force-app/classes/X.cls'));
  assert.ok(body.includes('Source paths: 2'));
  assert.ok(body.includes('&lt;&#64;team&amp;&gt;'));
});

test('compiled validation action authenticates, dry-runs, reports per org, and cleans up', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'compiled-validation-'));
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
        'validate-deployment',
        'src',
        'index.ts'
      ),
      '--out',
      bundleDirectory
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );
  const readerDirectory = path.join(directory, 'reader');
  execFileSync(
    process.execPath,
    [
      require.resolve('@vercel/ncc/dist/ncc/cli.js'),
      'build',
      path.join(projectRoot, 'actions', 'config-reader', 'src', 'index.ts'),
      '--out',
      readerDirectory
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  mkdirSync(path.join(directory, 'force-app', 'classes'), { recursive: true });
  writeFileSync(
    path.join(directory, 'force-app', 'classes', 'X.cls'),
    'public class X {}\n'
  );
  writeFileSync(
    path.join(directory, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app' }] })
  );
  const profilesPath = path.join(directory, 'orgs.config.json');
  writeFileSync(profilesPath, JSON.stringify(profiles));
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  writeFileSync(
    path.join(bin, 'sf'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);",
      "if (process.env.GITHUB_TOKEN || process.env['INPUT_GITHUB-TOKEN'] || process.env['INPUT_JWT-PRIVATE-KEY']) throw new Error('Secret input leaked to CLI env');",
      "fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify({ command: args[0], home: process.env.HOME }) + '\\n');",
      "if (args[0] === 'org') {",
      "  const keyFile = args[args.indexOf('--jwt-key-file') + 1];",
      "  if ((fs.statSync(keyFile).mode & 0o777) !== 0o600 || !fs.readFileSync(keyFile, 'utf8').includes('PRIVATE KEY')) process.exit(8);",
      "  if (args.includes('--set-default') || path.dirname(keyFile) !== process.env.HOME) process.exit(8);",
      "  fs.mkdirSync(path.join(process.env.HOME, '.sf')); fs.writeFileSync(path.join(process.env.HOME, '.sf', 'state.json'), 'temporary-auth-state');",
      "  if (process.env.FAKE_MODE === 'auth-failure') { console.log('PRIVATE-AUTH-ERROR'); process.exit(1); }",
      "  console.log(JSON.stringify({ status: 0, result: { accessToken: 'AUTH-TOKEN-MUST-NOT-LEAK' } }));",
      '} else {',
      "  if (args[0] !== 'project' || !args.includes('--dry-run') || !args.includes('RunRelevantTests')) process.exit(8);",
      "  if (process.env.FAKE_MODE === 'nothing') { console.log(JSON.stringify({ name: 'NothingToDeploy', message: 'Ignored source' })); process.exit(1); }",
      "  if (process.env.FAKE_MODE === 'bad-json') { console.log('RAW-PRIVATE-CLI-OUTPUT'); process.exit(0); }",
      "  const failed = process.env.FAKE_MODE === 'failed';",
      "  console.log(JSON.stringify({ status: failed ? 1 : 0, result: { success: !failed, status: failed ? 'Failed' : 'Succeeded', id: '0AfExample', accessToken: 'SESSION-TOKEN-MUST-NOT-LEAK', details: failed ? { componentFailures: [{ fullName: 'X', problem: 'Compilation failure' }], runTestResult: { failures: [{ name: 'XTest', message: 'Assertion failure' }], codeCoverageWarnings: [{ name: 'X', message: 'Coverage failure' }] } } : {} } }));",
      '  process.exit(failed ? 1 : 0);',
      '}'
    ].join('\n'),
    { mode: 0o755 }
  );

  const comments: { id: number; body: string; user: { type: string } }[] = [];
  let removed = false;
  let denyWrites = false;
  let nextId = 1;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(
        JSON.stringify(
          pathname.endsWith('/files')
            ? [
                {
                  filename: 'force-app/classes/X.cls',
                  status: removed ? 'removed' : 'modified'
                }
              ]
            : comments
        )
      );
      return;
    }
    if (denyWrites) {
      response.statusCode = 403;
      response.end(JSON.stringify({ message: 'Forbidden' }));
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { body: string };
    if (request.method === 'PATCH') {
      const comment = comments.find(
        (entry) => entry.id === Number(pathname.split('/').at(-1))
      );
      assert.ok(comment);
      comment.body = payload.body;
      response.end(JSON.stringify(comment));
    } else {
      const comment = {
        id: nextId++,
        body: payload.body,
        user: { type: 'Bot' }
      };
      comments.push(comment);
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
  const branchConfig = {
    version: 1,
    branches: {
      develop: {
        validation: {
          enabled: true,
          mode: 'delta',
          orgs: ['qa', 'uat'],
          testLevel: 'RunRelevantTests',
          waitMinutes: 180
        }
      }
    }
  };
  const event = path.join(directory, 'event.json');
  const eventData = {
    action: 'synchronize',
    pull_request: {
      number: 42,
      base: { ref: 'develop' },
      head: { repo: { full_name: 'example/salesforce' } }
    }
  };
  writeFileSync(event, JSON.stringify(eventData));

  const runAction = (
    org: string,
    mode = 'success',
    overrides: {
      key?: string;
      config?: unknown;
      bundle?: string;
      orgsInput?: string;
      orgsPath?: string;
    } = {}
  ) =>
    new Promise<{
      code: number | null;
      stdout: string;
      outputs: Record<string, string>;
      trace: string;
    }>((resolve, reject) => {
      const id = org + '-' + mode + '-' + Math.random().toString(16).slice(2);
      const output = path.join(directory, id + '-output');
      const trace = path.join(directory, id + '-trace');
      writeFileSync(output, '');
      const child = spawn(
        process.execPath,
        [overrides.bundle ?? path.join(bundleDirectory, 'index.js')],
        {
          timeout: 15000,
          env: {
            ...process.env,
            PATH: bin + path.delimiter + process.env.PATH,
            INPUT_CONFIG: JSON.stringify(overrides.config ?? branchConfig),
            INPUT_ORG: org,
            'INPUT_ORGS-CONFIG': overrides.orgsInput ?? '',
            'INPUT_ORGS-CONFIG-PATH': overrides.orgsPath ?? profilesPath,
            INPUT_USERNAME: 'integration@example.com',
            'INPUT_CLIENT-ID': 'test-client-id',
            'INPUT_JWT-PRIVATE-KEY': overrides.key ?? privateKey,
            'INPUT_GITHUB-TOKEN': 'fake-github-token',
            'INPUT_WORKING-DIRECTORY': '.',
            INPUT_BRANCH: '',
            GITHUB_TOKEN: '',
            GITHUB_ENVIRONMENT: '',
            GITHUB_WORKSPACE: directory,
            RUNNER_TEMP: directory,
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: event,
            GITHUB_REPOSITORY: 'example/salesforce',
            GITHUB_BASE_REF: 'develop',
            GITHUB_REF_NAME: '42/merge',
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
            GITHUB_OUTPUT: output,
            FAKE_MODE: mode,
            FAKE_TRACE: trace
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
        assert.ok(!stdout.includes('AUTH-TOKEN-MUST-NOT-LEAK'));
        assert.ok(!stdout.includes('PRIVATE-AUTH-ERROR'));
        const text = readFileSync(output, 'utf8').trimEnd();
        const lines = text ? text.split(/\r?\n/) : [];
        const outputs: Record<string, string> = {};
        for (let index = 0; index < lines.length; index += 3) {
          const [name, delimiter] = lines[index].split('<<');
          assert.equal(lines[index + 2], delimiter);
          outputs[name] = lines[index + 1];
        }
        if (existsSync(trace))
          for (const line of readFileSync(trace, 'utf8').trim().split('\n')) {
            const data = JSON.parse(line) as { home: string };
            assert.equal(
              existsSync(data.home),
              false,
              'Authentication state must be removed.'
            );
          }
        resolve({ code, stdout: stdout + stderr, outputs, trace });
      });
    });

  await context.test(
    'config reader emits environment profiles in compiled matrix outputs',
    async () => {
      const result = await runAction('qa', 'success', {
        bundle: path.join(readerDirectory, 'index.js')
      });
      assert.equal(result.code, 0, result.stdout);
      const matrix = JSON.parse(result.outputs['validation-matrix']);
      assert.deepEqual(
        matrix.include.map(
          (entry: { environment: string }) => entry.environment
        ),
        ['salesforce-qa', 'salesforce-uat']
      );
      assert.equal(matrix.include[0].jwtKeySecret, 'SF_JWT_PRIVATE_KEY');
      assert.ok(!JSON.stringify(matrix).includes('PRIVATE KEY'));
      assert.deepEqual(
        JSON.parse(result.outputs['orgs-config']),
        readOrgsConfig(JSON.stringify(profiles))
      );
    }
  );
  await context.test(
    'reader and validator support variable JSON with no org config file',
    async () => {
      const variableProfiles = {
        ...profiles,
        orgs: {
          ...profiles.orgs,
          qa: { ...profiles.orgs.qa, environment: 'variable-qa' }
        }
      };
      const missingFile = path.join(directory, 'does-not-exist.json');
      const reader = await runAction('qa', 'success', {
        bundle: path.join(readerDirectory, 'index.js'),
        orgsInput: JSON.stringify(variableProfiles),
        orgsPath: missingFile
      });
      assert.equal(reader.code, 0, reader.stdout);
      assert.deepEqual(
        JSON.parse(reader.outputs['orgs-config']),
        readOrgsConfig(JSON.stringify(variableProfiles))
      );
      assert.equal(
        JSON.parse(reader.outputs['validation-matrix']).include[0].environment,
        'variable-qa'
      );
      const validation = await runAction('qa', 'success', {
        orgsInput: reader.outputs['orgs-config'],
        orgsPath: missingFile
      });
      assert.equal(validation.code, 0, validation.stdout);
      assert.equal(validation.outputs.outcome, 'Succeeded');
      const comment = comments.find((entry) =>
        entry.body.includes(validationCommentKey('qa'))
      );
      assert.ok(comment?.body.includes('variable-qa'));
    }
  );
  await context.test(
    'malformed org variable fails instead of using the valid file fallback',
    async () => {
      for (const bundle of [
        path.join(readerDirectory, 'index.js'),
        path.join(bundleDirectory, 'index.js')
      ]) {
        const result = await runAction('qa', 'success', {
          bundle,
          orgsInput: '{"private":"sensitive-marker"'
        });
        assert.equal(result.code, 1);
        assert.match(result.stdout, /Invalid orgs configuration/);
        assert.ok(!result.stdout.includes('sensitive-marker'));
        assert.deepEqual(result.outputs, {});
        assert.equal(existsSync(result.trace), false);
      }
    }
  );
  await context.test(
    'validation never loads example profiles when org inputs are absent',
    async () => {
      const result = await runAction('qa', 'success', {
        orgsInput: '',
        orgsPath: ''
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Org profile configuration is required/);
      assert.deepEqual(result.outputs, {});
      assert.equal(existsSync(result.trace), false);
    }
  );
  await context.test(
    'successful checks for two orgs keep independent feedback',
    async () => {
      const results = await Promise.all([runAction('qa'), runAction('uat')]);
      for (const result of results) {
        assert.equal(result.code, 0, result.stdout);
        assert.equal(result.outputs.outcome, 'Succeeded');
        assert.ok(existsSync(result.outputs['report-path']));
      }
      assert.notEqual(
        results[0].outputs['artifact-name'],
        results[1].outputs['artifact-name']
      );
      assert.equal(comments.length, 2);
    }
  );
  await context.test(
    'failed validations update the same org comment before failing the action',
    async () => {
      const result = await runAction('qa', 'failed');
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.outputs.outcome, 'Failed');
      assert.equal(comments.length, 2);
      const comment = comments.find((entry) =>
        entry.body.includes(validationCommentKey('qa'))
      );
      assert.ok(comment);
      for (const heading of [
        'Component Failures',
        'Test Failures',
        'Coverage Failures'
      ])
        assert.ok(comment.body.includes(heading));
      const report = readFileSync(result.outputs['report-path'], 'utf8');
      assert.ok(!report.includes('SESSION-TOKEN-MUST-NOT-LEAK'));
    }
  );
  await context.test(
    'NothingToDeploy is a reported skip rather than a failed job',
    async () => {
      const result = await runAction('qa', 'nothing');
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.outputs.outcome, 'Skipped');
    }
  );
  await context.test(
    'invalid JSON is failed and raw CLI output is not persisted',
    async () => {
      const result = await runAction('qa', 'bad-json');
      assert.equal(result.code, 1);
      assert.equal(result.outputs.outcome, 'Failed');
      assert.ok(
        !readFileSync(result.outputs['report-path'], 'utf8').includes(
          'RAW-PRIVATE-CLI-OUTPUT'
        )
      );
    }
  );
  await context.test(
    'auth errors and missing keys fail without leaking raw auth output',
    async () => {
      const failed = await runAction('qa', 'auth-failure');
      assert.equal(failed.code, 1);
      assert.match(failed.stdout, /JWT authentication failed/);
      const missing = await runAction('qa', 'success', { key: '' });
      assert.equal(missing.code, 1);
      assert.match(missing.stdout, /private key secret inputs/);
    }
  );
  await context.test(
    'feedback write errors do not change validation outcome',
    async () => {
      denyWrites = true;
      const result = await runAction('qa');
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, /Unable to publish/);
      denyWrites = false;
    }
  );
  await context.test(
    'removed-only delta skips authentication even without credentials',
    async () => {
      removed = true;
      const result = await runAction('qa', 'auth-failure', { key: '' });
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.outputs.outcome, 'Skipped');
      assert.equal(existsSync(result.trace), false);
      removed = false;
    }
  );
  await context.test(
    'full mode does not depend on a PR changed-file list',
    async () => {
      removed = true;
      const result = await runAction('qa', 'success', {
        config: {
          version: 1,
          branches: {
            develop: {
              validation: { enabled: true, mode: 'full', orgs: ['qa'] }
            }
          }
        }
      });
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.outputs['sources-count'], '1');
      removed = false;
    }
  );
  await context.test(
    'fork events fail before authentication or source validation',
    async () => {
      writeFileSync(
        event,
        JSON.stringify({
          ...eventData,
          pull_request: {
            ...eventData.pull_request,
            head: { repo: { full_name: 'untrusted/fork' } }
          }
        })
      );
      const result = await runAction('qa');
      assert.equal(result.code, 1);
      assert.match(result.stdout, /restricted to same-repository/);
      assert.equal(existsSync(result.trace), false);
      writeFileSync(event, JSON.stringify(eventData));
    }
  );
});
