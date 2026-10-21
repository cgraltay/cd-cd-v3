import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
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
import { parseDocument } from 'yaml';
import { readOrgsConfig } from '../shared/orgs';
import {
  checkOrgConnection,
  connectionMatrix
} from '../actions/check-org-connection/src/check';

const profiles = readOrgsConfig(
  JSON.stringify({
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
  })
);
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

test('manual connection matrix selects one org or all profiles without credentials', () => {
  assert.deepEqual(
    connectionMatrix(profiles, '').include.map((entry) => [
      entry.org,
      entry.environment
    ]),
    [
      ['qa', 'salesforce-qa'],
      ['uat', 'salesforce-uat']
    ]
  );
  assert.deepEqual(
    connectionMatrix(profiles, ' uat ').include.map((entry) => entry.org),
    ['uat']
  );
  assert.throws(
    () => connectionMatrix(profiles, 'missing'),
    /selected org is missing/
  );
  assert.throws(
    () => connectionMatrix({ version: 1, orgs: {} }, ''),
    /one and 256/
  );
  assert.throws(
    () =>
      connectionMatrix(
        {
          version: 1,
          orgs: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [
              `org-${index}`,
              profiles.orgs.qa
            ])
          )
        },
        ''
      ),
    /one and 256/
  );
  assert.ok(
    !JSON.stringify(connectionMatrix(profiles, '')).includes('PRIVATE KEY')
  );
});

test('org check verifies live API access after isolated JWT login and removes local auth state', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'org-connection-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let home = '';
  let calls = 0;
  const result = await checkOrgConnection({
    profile: profiles.orgs.qa,
    workspace: directory,
    username: 'integration@example.com',
    clientId: 'client-id',
    jwtPrivateKey: privateKey,
    tempDirectory: directory,
    execute: async (args, options) => {
      calls += 1;
      home = options.env.HOME;
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env['INPUT_JWT-PRIVATE-KEY'], undefined);
      if (args[0] === 'org') {
        const keyFile = args[args.indexOf('--jwt-key-file') + 1];
        assert.equal(statSync(keyFile).mode & 0o777, 0o600);
        assert.equal(readFileSync(keyFile, 'utf8'), privateKey);
        return {
          exitCode: 0,
          stdout: '{"status":0,"result":{"accessToken":"DO-NOT-LOG"}}',
          stderr: ''
        };
      }
      assert.deepEqual(args.slice(0, 4), [
        'data',
        'query',
        '--query',
        'SELECT Id FROM Organization LIMIT 1'
      ]);
      assert.ok(!args.includes('--dry-run'));
      assert.ok(!args.includes('deploy'));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 0,
          result: {
            done: true,
            totalSize: 1,
            records: [{ Id: '00D000000000001AAA' }]
          }
        }),
        stderr: ''
      };
    }
  });
  assert.deepEqual(result, { orgId: '00D000000000001AAA' });
  assert.equal(calls, 2);
  assert.equal(existsSync(home), false);
});

for (const mode of [
  'auth-failure',
  'api-failure',
  'invalid-json',
  'incomplete-result'
]) {
  test(`org connection ${mode} fails safely and cleans up credentials`, async (context) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'org-connection-failure-')
    );
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    let home = '';
    await assert.rejects(
      () =>
        checkOrgConnection({
          profile: profiles.orgs.qa,
          workspace: directory,
          username: 'integration@example.com',
          clientId: 'client-id',
          jwtPrivateKey: privateKey,
          tempDirectory: directory,
          execute: async (args, options) => {
            home = options.env.HOME;
            if (args[0] === 'org')
              return {
                exitCode: mode === 'auth-failure' ? 1 : 0,
                stdout: 'SECRET-AUTH-RESPONSE',
                stderr: ''
              };
            return {
              exitCode: mode === 'api-failure' ? 1 : 0,
              stdout:
                mode === 'invalid-json'
                  ? 'SECRET-API-RESPONSE'
                  : '{"status":0,"result":{"done":false}}',
              stderr: ''
            };
          }
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /JWT authentication failed|API connection check/
        );
        assert.ok(!error.message.includes('SECRET-'));
        return true;
      }
    );
    assert.equal(existsSync(home), false);
  });
}

test('missing credentials and malformed keys cannot pass a connection check', async () => {
  const options = {
    profile: profiles.orgs.qa,
    workspace: process.cwd(),
    username: 'integration@example.com',
    clientId: 'client-id',
    jwtPrivateKey: privateKey
  };
  await assert.rejects(
    () => checkOrgConnection({ ...options, jwtPrivateKey: '' }),
    /private key secret inputs/
  );
  await assert.rejects(
    () => checkOrgConnection({ ...options, jwtPrivateKey: 'not-a-key' }),
    /RSA PEM/
  );
});

test('org connection workflow is manual-only, environment-scoped, and read-only on GitHub', () => {
  const repository = path.resolve(__dirname, '..', '..');
  const document = parseDocument(
    readFileSync(
      path.join(
        repository,
        '.github',
        'workflows',
        'check-org-connections.yml'
      ),
      'utf8'
    ),
    { uniqueKeys: true }
  );
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS() as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        needs?: string;
        environment?: string;
        strategy?: { 'fail-fast': boolean; matrix: string };
        steps: {
          uses?: string;
          run?: string;
          with?: Record<string, string | boolean>;
        }[];
      }
    >;
  };
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['prepare', 'check']);
  const prepare = workflow.jobs.prepare.steps.find((step) =>
    step.uses?.endsWith('/check-org-connection')
  );
  assert.equal(prepare?.with?.['orgs-config'], '${{ vars.SF_ORGS_CONFIG }}');
  assert.equal(prepare?.with?.['prepare-only'], 'true');
  assert.ok(!JSON.stringify(workflow.jobs.prepare).includes('secrets['));
  const check = workflow.jobs.check;
  assert.equal(check.needs, 'prepare');
  assert.equal(check.environment, '${{ matrix.environment }}');
  assert.equal(check.strategy?.['fail-fast'], false);
  assert.equal(
    check.strategy?.matrix,
    '${{ fromJSON(needs.prepare.outputs.matrix) }}'
  );
  const step = check.steps.find((candidate) =>
    candidate.uses?.endsWith('/check-org-connection')
  );
  assert.equal(
    step?.with?.['orgs-config'],
    '${{ needs.prepare.outputs.orgs-config }}'
  );
  assert.equal(
    step?.with?.['jwt-private-key'],
    '${{ secrets[matrix.jwtKeySecret] }}'
  );
  assert.ok(
    check.steps.some(
      (candidate) => candidate.run === 'npm install --global @salesforce/cli'
    )
  );
  for (const job of Object.values(workflow.jobs)) {
    for (const candidate of job.steps) {
      if (candidate.uses === 'actions/checkout@v5')
        assert.equal(candidate.with?.['persist-credentials'], false);
    }
  }
  const tooling = parseDocument(
    readFileSync(
      path.join(repository, '.github', 'workflows', 'github-actions-ci.yml'),
      'utf8'
    )
  ).toJS() as { on: Record<string, { paths: string[] }> };
  for (const event of ['push', 'pull_request'])
    assert.ok(
      tooling.on[event].paths.includes(
        '.github/workflows/check-org-connections.yml'
      )
    );
});

test('compiled connection action plans without secrets, checks API access, and rejects non-manual events', (context) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'compiled-org-connection-')
  );
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
        'check-org-connection',
        'src',
        'index.ts'
      ),
      '--out',
      bundleDirectory
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'sf'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs'); const args = process.argv.slice(2);",
      "if (process.env.GITHUB_TOKEN || process.env['INPUT_JWT-PRIVATE-KEY']) throw new Error('Credential environment leaked');",
      "fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify({ command: args[0], home: process.env.HOME }) + '\\n');",
      "if (args[0] === 'org') {",
      "  const key = args[args.indexOf('--jwt-key-file') + 1];",
      '  if ((fs.statSync(key).mode & 0o777) !== 0o600) process.exit(8);',
      "  if (process.env.FAKE_MODE === 'auth-failure') { console.log('RAW-SECRET-AUTH-ERROR'); process.exit(1); }",
      "  console.log(JSON.stringify({ status: 0, result: { accessToken: 'RAW-SECRET-LOGIN-TOKEN' } }));",
      '} else {',
      "  if (args[0] !== 'data' || args[1] !== 'query' || args.includes('deploy')) process.exit(8);",
      "  if (process.env.FAKE_MODE === 'api-failure') { console.log('RAW-SECRET-API-ERROR'); process.exit(1); }",
      "  if (process.env.FAKE_MODE === 'invalid-json') { console.log('RAW-SECRET-API-RESPONSE'); process.exit(0); }",
      "  console.log(JSON.stringify({ status: 0, result: { done: true, totalSize: 1, records: [{ Id: '00D000000000001AAA' }] } }));",
      '}'
    ].join('\n'),
    { mode: 0o755 }
  );
  let counter = 0;
  const runAction = (
    options: {
      prepare?: boolean;
      org?: string;
      mode?: string;
      event?: string;
      key?: string;
      orgs?: string;
    } = {}
  ) => {
    const prefix = path.join(directory, 'run-' + counter++);
    const output = prefix + '-output';
    const summary = prefix + '-summary';
    const trace = prefix + '-trace';
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const result = spawnSync(
      process.execPath,
      [path.join(bundleDirectory, 'index.js')],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          'INPUT_ORGS-CONFIG': options.orgs ?? JSON.stringify(profiles),
          INPUT_ORG: options.org ?? 'qa',
          'INPUT_PREPARE-ONLY': String(options.prepare ?? false),
          INPUT_USERNAME: 'integration@example.com',
          'INPUT_CLIENT-ID': 'test-client-id',
          'INPUT_JWT-PRIVATE-KEY': options.key ?? privateKey,
          GITHUB_TOKEN: 'github-token-must-not-reach-sf',
          GITHUB_EVENT_NAME: options.event ?? 'workflow_dispatch',
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          RUNNER_TEMP: directory,
          FAKE_MODE: options.mode ?? 'success',
          FAKE_TRACE: trace
        }
      }
    );
    assert.ifError(result.error);
    assert.ok(!result.stdout.includes('RAW-SECRET-'));
    const text = readFileSync(output, 'utf8').trimEnd();
    const lines = text ? text.split(/\r?\n/) : [];
    const outputs: Record<string, string> = {};
    for (let index = 0; index < lines.length; index += 3) {
      const [name, delimiter] = lines[index].split('<<');
      assert.equal(lines[index + 2], delimiter);
      outputs[name] = lines[index + 1];
    }
    if (existsSync(trace))
      for (const line of readFileSync(trace, 'utf8').trim().split('\n'))
        assert.equal(
          existsSync((JSON.parse(line) as { home: string }).home),
          false
        );
    const markdown = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
    assert.ok(!markdown.includes('PRIVATE KEY'));
    assert.ok(!markdown.includes('integration@example.com'));
    assert.ok(!markdown.includes('RAW-SECRET-'));
    return { ...result, outputs, markdown, trace };
  };

  const plan = runAction({ prepare: true, org: '', key: '' });
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.equal(JSON.parse(plan.outputs.matrix).include.length, 2);
  assert.deepEqual(JSON.parse(plan.outputs['orgs-config']), profiles);
  assert.equal(existsSync(plan.trace), false);
  assert.match(plan.markdown, /Preparation only/);

  const selected = runAction({ prepare: true, org: 'uat', key: '' });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(JSON.parse(selected.outputs.matrix).include[0].org, 'uat');

  const success = runAction();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.outputs.connected, 'true');
  assert.equal(success.outputs['org-id'], '00D000000000001AAA');
  assert.match(success.markdown, /Connected/);

  for (const mode of ['auth-failure', 'api-failure', 'invalid-json']) {
    const failed = runAction({ mode });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.outputs.connected, 'false');
    assert.equal(failed.outputs['org-id'], '');
    assert.match(failed.markdown, /failed/);
  }
  for (const options of [
    { event: 'pull_request' },
    { event: 'push', prepare: true },
    { org: 'missing', prepare: true },
    { org: '' },
    { key: '' },
    { orgs: '{"private":"DO-NOT-LOG-THIS-VALUE"' }
  ]) {
    const failed = runAction(options);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.outputs.connected, 'false');
    assert.equal(existsSync(failed.trace), false);
    assert.ok(!failed.stdout.includes('DO-NOT-LOG-THIS-VALUE'));
  }
});
