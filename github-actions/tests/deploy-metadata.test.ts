import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOrgsConfig } from '../shared/orgs';
import {
  releasePlan,
  recordReference
} from '../actions/deploy-metadata/src/plan';
import {
  savedValidation,
  githubHistory,
  releaseTask,
  type ReleaseEntry
} from '../actions/deploy-metadata/src/history';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  releaseSources,
  selectSourceRange
} from '../actions/deploy-metadata/src/source';
import {
  deploymentReport,
  runRelease
} from '../actions/deploy-metadata/src/run';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { SalesforceExecutor } from '../shared/jwt';
import type { ReleaseHistory } from '../actions/deploy-metadata/src/history';
import { parse } from 'yaml';

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
      production: {
        environment: 'production',
        auth: 'jwt',
        instanceUrl: 'https://login.salesforce.com',
        usernameSecret: 'SF_USERNAME',
        clientIdSecret: 'SF_CLIENT_ID',
        jwtKeySecret: 'SF_JWT_PRIVATE_KEY'
      }
    }
  })
);
const config = {
  version: 1,
  branches: {
    develop: {
      deployment: {
        enabled: true,
        mode: 'delta',
        orgs: ['qa'],
        sourceDirs: ['force-app'],
        testLevel: 'RunRelevantTests',
        waitMinutes: 180
      }
    },
    main: { deployment: { enabled: true, mode: 'full', orgs: ['production'] } }
  }
};

test('manual release environment resolves one allowed org and configured deployment settings', () => {
  const plan = releasePlan(
    config,
    profiles,
    'develop',
    'salesforce-qa',
    'configured'
  );
  assert.equal(plan.org, 'qa');
  assert.equal(plan.settings.mode, 'delta');
  assert.equal(plan.settings.testLevel, 'RunRelevantTests');
  assert.equal(plan.profile.jwtKeySecret, 'SF_JWT_PRIVATE_KEY');
  assert.equal(
    releasePlan(config, profiles, 'develop', 'salesforce-qa', 'full').settings
      .mode,
    'full'
  );
});

test('saved references distinguish validation checks from deployment audits without extra form inputs', () => {
  assert.deepEqual(recordReference('validation:123', 'quick-deploy'), {
    recordKind: 'validation',
    recordId: 123
  });
  assert.deepEqual(recordReference('deployment:456', 'reconcile'), {
    recordKind: 'deployment',
    recordId: 456
  });
  assert.throws(
    () => recordReference('deployment:123', 'quick-deploy'),
    /validation reference/
  );
  assert.throws(
    () => recordReference('0Af000000000001AAA', 'reconcile'),
    /saved reference/
  );
});

test('release source branch is independent of environment and supports release branch policies', () => {
  const releaseConfig = {
    version: 1,
    branches: {
      'release-*': {
        deployment: { enabled: true, mode: 'full', orgs: ['production'] }
      }
    }
  };
  const plan = releasePlan(
    releaseConfig,
    profiles,
    'release-x',
    'production',
    'configured'
  );
  assert.equal(plan.branch, 'release-x');
  assert.equal(plan.org, 'production');
  assert.equal(plan.settings.testLevel, 'RunRelevantTests');
  assert.throws(
    () =>
      releasePlan(
        releaseConfig,
        profiles,
        'develop',
        'production',
        'configured'
      ),
    /not enabled/
  );
});

test('release planning refuses unknown, ambiguous, disabled, or disallowed mappings', () => {
  assert.throws(
    () => releasePlan(config, profiles, 'develop', 'missing', 'configured'),
    /exactly one/
  );
  assert.throws(
    () => releasePlan(config, profiles, 'develop', 'production', 'configured'),
    /not enabled/
  );
  assert.throws(
    () =>
      releasePlan(config, profiles, 'feature/x', 'salesforce-qa', 'configured'),
    /not enabled/
  );
  assert.throws(
    () =>
      releasePlan(
        {
          version: 1,
          branches: {
            develop: { deployment: { enabled: false, orgs: ['qa'] } }
          }
        },
        profiles,
        'develop',
        'salesforce-qa',
        'configured'
      ),
    /not enabled/
  );
  assert.throws(
    () =>
      releasePlan(
        config,
        {
          ...profiles,
          orgs: { ...profiles.orgs, duplicate: profiles.orgs.qa }
        },
        'develop',
        'salesforce-qa',
        'configured'
      ),
    /exactly one/
  );
  assert.throws(
    () => releasePlan(config, profiles, 'develop', 'salesforce-qa', 'invalid'),
    /Invalid/
  );
});

const orgId = '00D000000000001AAA';
function entry(
  id: number,
  operation: 'validate' | 'deploy' = 'deploy',
  state = 'success'
): ReleaseEntry {
  return {
    id,
    state,
    jobId: '0Af000000000001AAA',
    receipt: {
      schema: 1,
      kind: 'sf-metadata-release',
      org: 'production',
      orgId,
      environment: 'production',
      branch: 'release-x',
      headSha: 'a'.repeat(40),
      baselineId: null,
      operation,
      settings: releasePlan(config, profiles, 'main', 'production', 'full')
        .settings,
      payloadHash: 'b'.repeat(64)
    }
  };
}

test('quick deployment requires a saved successful validation, not a last-deployment baseline', () => {
  const validation = entry(2, 'validate');
  assert.equal(savedValidation([validation, entry(3)], 2), validation);
  assert.throws(
    () => savedValidation([entry(2, 'validate', 'failure')], 2),
    /successful recorded validation/
  );
  assert.throws(
    () => savedValidation([entry(2)], 2),
    /successful recorded validation/
  );
  assert.throws(
    () => savedValidation([{ ...validation, jobId: undefined }], 2),
    /job ID/
  );
});

function repository() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'sf-release-test-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  git('init', '-b', 'release-x');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Release Test');
  mkdirSync(path.join(workspace, 'force-app/classes'), { recursive: true });
  writeFileSync(
    path.join(workspace, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app' }] })
  );
  writeFileSync(
    path.join(workspace, 'force-app/classes/First.cls'),
    'public class First {}'
  );
  const commit = () => {
    git('add', '.');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { workspace, git, commit, base: commit() };
}

test('explicit source ranges pin full branches, include both commit endpoints, and use branch merge bases', (context) => {
  const repo = repository();
  context.after(() => rmSync(repo.workspace, { recursive: true, force: true }));
  writeFileSync(
    path.join(repo.workspace, 'force-app/classes/Second.cls'),
    'public class Second {}'
  );
  const start = repo.commit();
  writeFileSync(
    path.join(repo.workspace, 'force-app/classes/Third.cls'),
    'public class Third {}'
  );
  const end = repo.commit();
  assert.deepEqual(selectSourceRange(repo.workspace, 'full-branch', end), {
    selection: 'full-branch',
    branchSha: end,
    headSha: end
  });
  const range = selectSourceRange(repo.workspace, 'commit-range', end, {
    startSha: start,
    endSha: end
  });
  assert.equal(range.baseSha, repo.base);
  assert.deepEqual(
    releaseSources(
      repo.workspace,
      end,
      end,
      releasePlan(config, profiles, 'develop', 'salesforce-qa', 'delta')
        .settings,
      range.baseSha
    ).sources,
    ['force-app/classes/Second.cls', 'force-app/classes/Third.cls']
  );
  assert.equal(
    selectSourceRange(repo.workspace, 'commit-range', end, {
      startSha: repo.base,
      endSha: end
    }).baseSha,
    undefined
  );
  assert.deepEqual(
    releaseSources(
      repo.workspace,
      end,
      end,
      releasePlan(config, profiles, 'develop', 'salesforce-qa', 'delta')
        .settings,
      undefined,
      true
    ).sources,
    [
      'force-app/classes/First.cls',
      'force-app/classes/Second.cls',
      'force-app/classes/Third.cls'
    ]
  );
  repo.git('checkout', '-b', 'comparison', repo.base);
  writeFileSync(
    path.join(repo.workspace, 'force-app/classes/OnlyComparison.cls'),
    'public class OnlyComparison {}'
  );
  const comparisonSha = repo.commit();
  const comparison = selectSourceRange(repo.workspace, 'branch-changes', end, {
    comparisonSha
  });
  assert.equal(comparison.baseSha, repo.base);
  assert.equal(comparison.headSha, end);
  repo.git('checkout', 'release-x');
  assert.deepEqual(
    releaseSources(
      repo.workspace,
      end,
      end,
      releasePlan(config, profiles, 'develop', 'salesforce-qa', 'delta')
        .settings,
      comparison.baseSha
    ).sources,
    ['force-app/classes/Second.cls', 'force-app/classes/Third.cls']
  );
  assert.throws(
    () =>
      selectSourceRange(repo.workspace, 'full-branch', end, { endSha: end }),
    /only a source branch/
  );
  assert.throws(
    () =>
      selectSourceRange(repo.workspace, 'commit-range', end, {
        startSha: end,
        endSha: start
      }),
    /ancestry/
  );
  assert.throws(
    () =>
      selectSourceRange(repo.workspace, 'commit-range', end, {
        startSha: repo.base,
        endSha: comparisonSha
      }),
    /ancestry/
  );
  assert.throws(
    () => selectSourceRange(repo.workspace, 'branch-changes', end),
    /comparison branch/
  );
});

test('explicit delta includes multiple commits and requires a comparison base', (context) => {
  const repo = repository();
  context.after(() => rmSync(repo.workspace, { recursive: true, force: true }));
  const settings = releasePlan(
    config,
    profiles,
    'develop',
    'salesforce-qa',
    'configured'
  ).settings;
  writeFileSync(
    path.join(repo.workspace, 'force-app/classes/Second.cls'),
    'public class Second {}'
  );
  repo.commit();
  writeFileSync(
    path.join(repo.workspace, 'force-app/classes/First.cls'),
    'public class First { public Integer count; }'
  );
  const head = repo.commit();
  const payload = releaseSources(
    repo.workspace,
    head,
    head,
    settings,
    repo.base
  );
  assert.deepEqual(payload.sources, [
    'force-app/classes/First.cls',
    'force-app/classes/Second.cls'
  ]);
  assert.equal(payload.payloadHash.length, 64);
  assert.throws(
    () => releaseSources(repo.workspace, head, head, settings),
    /explicit comparison base/
  );
  assert.deepEqual(
    releaseSources(repo.workspace, head, head, { ...settings, mode: 'full' })
      .sources,
    ['force-app']
  );
  assert.throws(
    () => releaseSources(repo.workspace, head, repo.base, settings, repo.base),
    /ancestry/
  );
  assert.throws(
    () => releaseSources(repo.workspace, head, head, settings, 'a'.repeat(40)),
    /ancestry/
  );
  writeFileSync(path.join(repo.workspace, 'dirty.txt'), 'untracked');
  assert.throws(
    () => releaseSources(repo.workspace, head, head, settings, repo.base),
    /clean/
  );
});

test('release selection rejects removals, delta configuration changes, and symlinks', (context) => {
  const repo = repository();
  context.after(() => rmSync(repo.workspace, { recursive: true, force: true }));
  const settings = releasePlan(
    config,
    profiles,
    'develop',
    'salesforce-qa',
    'configured'
  ).settings;
  writeFileSync(path.join(repo.workspace, '.forceignore'), '**/ignored');
  let head = repo.commit();
  assert.throws(
    () => releaseSources(repo.workspace, head, head, settings, repo.base),
    /Select full/
  );
  const previous = head;
  rmSync(path.join(repo.workspace, 'force-app/classes/First.cls'));
  head = repo.commit();
  assert.throws(
    () => releaseSources(repo.workspace, head, head, settings, previous),
    /destructive/
  );
  assert.throws(
    () =>
      releaseSources(
        repo.workspace,
        head,
        head,
        { ...settings, mode: 'full' },
        previous
      ),
    /destructive/
  );
  symlinkSync('/tmp', path.join(repo.workspace, 'force-app/external'));
  head = repo.commit();
  assert.throws(
    () =>
      releaseSources(repo.workspace, head, head, { ...settings, mode: 'full' }),
    /symlink/
  );
});

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const jobId = '0Af000000000001AAA';
function report(checkOnly: boolean, overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    result: {
      id: jobId,
      done: true,
      checkOnly,
      success: true,
      status: 'Succeeded',
      ...overrides
    }
  };
}

test('report parser refuses dry runs as actual deploys, wrong IDs, partial, and incomplete success', () => {
  const response = (body: unknown, exitCode = 0) => ({
    exitCode,
    stdout: JSON.stringify(body),
    stderr: ''
  });
  assert.equal(
    deploymentReport(response(report(false)), jobId, false).succeeded,
    true
  );
  assert.throws(
    () => deploymentReport(response(report(true)), jobId, false),
    /does not match/
  );
  assert.throws(
    () =>
      deploymentReport(
        response(report(false, { id: '0Af000000000002AAA' })),
        jobId,
        false
      ),
    /does not match/
  );
  assert.equal(
    deploymentReport(response(report(false, { done: false })), jobId, false)
      .succeeded,
    false
  );
  assert.equal(
    deploymentReport(
      response(report(false, { status: 'SucceededPartial' })),
      jobId,
      false
    ).succeeded,
    false
  );
  assert.equal(
    deploymentReport(response(report(false), 1), jobId, false).succeeded,
    false
  );
});

function memoryHistory(entries: ReleaseEntry[] = []): ReleaseHistory {
  return {
    async list() {
      throw new Error('Ordinary execution must not read deployment history.');
    },
    async get(id) {
      const found = entries.find((item) => item.id === id);
      if (!found) throw new Error('Missing saved release');
      return found;
    },
    async create(receipt) {
      const created = {
        id: Math.max(0, ...entries.map((item) => item.id)) + 1,
        receipt,
        state: 'pending'
      };
      entries.push(created);
      return created;
    },
    async status(entry, state) {
      entry.state = state;
    }
  };
}

test('explicit releases ignore unrelated history and never silently fall back, while recovery only reports', async (context) => {
  const repo = repository();
  context.after(() => rmSync(repo.workspace, { recursive: true, force: true }));
  const entries: ReleaseEntry[] = [];
  const history = memoryHistory(entries);
  let authHome = '';
  let quickRejected = false;
  let actualInProgress = false;
  let actual = false;
  const commands: string[][] = [];
  const execute: SalesforceExecutor = async (args, options) => {
    commands.push(args);
    authHome = options.env.HOME;
    assert.ok(existsSync(authHome));
    const response = (body: unknown, exitCode = 0) => ({
      exitCode,
      stdout: JSON.stringify(body),
      stderr: ''
    });
    if (args[0] === 'org' && args[1] === 'login')
      return response({ status: 0 });
    if (args[0] === 'org' && args[1] === 'display')
      return response({
        status: 0,
        result: { id: orgId, accessToken: 'DO-NOT-LOG' }
      });
    if (args[0] === 'api')
      return response({
        query: '/services/data/v66.0/query',
        sobjects: '/services/data/v66.0/sobjects'
      });
    assert.notEqual(
      args[0],
      'data',
      'Release identity must not require Organization SOQL access.'
    );
    if (args[2] === 'report')
      return response(
        report(
          !actual,
          actualInProgress ? { done: false, status: 'InProgress' } : {}
        )
      );
    if (args[2] === 'quick' && quickRejected)
      return response({ status: 1, name: 'INVALID_OPERATION' }, 1);
    actual = !args.includes('--dry-run');
    return response({ status: 0, result: { id: jobId } });
  };
  const options = {
    profile: profiles.orgs.production,
    workspace: repo.workspace,
    username: 'secret-user',
    clientId: 'secret-client',
    jwtPrivateKey: privateKey,
    execute,
    plan: releasePlan(config, profiles, 'main', 'production', 'full'),
    history,
    headSha: repo.base,
    branchSha: repo.base
  };
  actual = false;
  await runRelease({ ...options, operation: 'validate' });
  assert.equal(entries[0].state, 'success');
  assert.equal(entries[0].receipt.operation, 'validate');
  assert.ok(
    commands.some(
      (args) =>
        args[2] === 'start' &&
        args.includes('--dry-run') &&
        args.includes('--async') &&
        args.includes('RunRelevantTests')
    )
  );
  assert.equal(existsSync(authHome), false);

  quickRejected = true;
  const startsBeforeQuick = commands.filter(
    (args) => args[2] === 'start'
  ).length;
  await assert.rejects(
    runRelease({ ...options, operation: 'quick-deploy', recordId: 1 }),
    /rejected/
  );
  assert.equal(entries[1].state, 'failure');
  assert.equal(
    commands.filter((args) => args[2] === 'start').length,
    startsBeforeQuick
  );
  assert.equal(
    entries.filter(
      (item) =>
        item.receipt.operation !== 'validate' && item.state === 'success'
    ).length,
    0
  );

  quickRejected = false;
  actual = false;
  await runRelease({ ...options, operation: 'quick-deploy', recordId: 1 });
  assert.equal(entries[2].state, 'success');
  actual = false;
  await runRelease({ ...options, operation: 'quick-deploy', recordId: 1 });

  actualInProgress = true;
  await assert.rejects(
    runRelease({ ...options, operation: 'deploy' }),
    /not confirmed complete/
  );
  const unresolved = entries.at(-1)!;
  assert.equal(unresolved.state, 'in_progress');
  assert.equal(unresolved.jobId, jobId);
  actualInProgress = false;
  const startsBeforeRecovery = commands.filter(
    (args) => args[2] === 'start'
  ).length;
  await runRelease({
    ...options,
    operation: 'reconcile',
    recordId: unresolved.id
  });
  assert.equal(unresolved.state, 'success');
  assert.equal(
    commands.filter((args) => args[2] === 'start').length,
    startsBeforeRecovery
  );
  assert.equal(existsSync(authHome), false);

  const warnings: string[] = [];
  const noAudit: ReleaseHistory = {
    async list() {
      throw new Error('History is not a payload selector.');
    },
    async get() {
      throw new Error('No saved job requested.');
    },
    async create() {
      throw new Error('Audit unavailable.');
    },
    async status() {
      throw new Error('Audit unavailable.');
    }
  };
  const independent = await runRelease({
    ...options,
    operation: 'deploy',
    history: noAudit,
    onAuditWarning: (message) => warnings.push(message)
  });
  assert.equal(independent.outcome, 'Succeeded');
  assert.equal(independent.entry?.id, 0);
  assert.equal(warnings.length, 1);

  const saved = entries[0];
  saved.receipt.orgId = '00D000000000002AAA';
  await assert.rejects(
    runRelease({ ...options, operation: 'quick-deploy', recordId: saved.id }),
    /identity does not match/
  );
  saved.receipt.orgId = orgId;
});

test('focused release actions fix source selection or operation and share one implementation', () => {
  const root = path.resolve(__dirname, '..');
  for (const [name, fixed] of [
    ['validate-deploy-full-branch', "selection: 'full-branch'"],
    ['validate-deploy-commit-range', "selection: 'commit-range'"],
    ['validate-deploy-branch-changes', "selection: 'branch-changes'"],
    ['quick-deploy-release', "operation: 'quick-deploy'"],
    ['reconcile-release', "operation: 'reconcile'"],
    ['prepare-release', 'prepare: true']
  ]) {
    const manifest = parse(
      readFileSync(path.join(root, 'actions', name, 'action.yml'), 'utf8')
    );
    const source = readFileSync(
      path.join(root, 'actions', name, 'src/index.ts'),
      'utf8'
    );
    assert.equal(manifest.runs.using, 'node24');
    assert.equal(manifest.runs.main, 'dist/index.js');
    assert.ok(source.includes('../../deploy-metadata/src/action'));
    assert.ok(source.includes(fixed));
    assert.ok(!manifest.inputs.mode);
    if (name.startsWith('validate-deploy')) {
      assert.equal(manifest.inputs.operation.default, 'validate');
      assert.ok(!manifest.inputs['to-sha']);
    }
  }
});

test('focused manual workflows expose only relevant inputs and share pinned environment-scoped execution', () => {
  const root = path.resolve(__dirname, '../..');
  const workflow = parse(
    readFileSync(
      path.join(root, '.github/workflows/release-execution.yml'),
      'utf8'
    )
  );
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  const specifications = [
    [
      'validate-deploy-full-branch',
      ['source-branch', 'environment', 'operation']
    ],
    [
      'validate-deploy-commit-range',
      [
        'source-branch',
        'start-commit',
        'end-commit',
        'environment',
        'operation'
      ]
    ],
    [
      'validate-deploy-branch-changes',
      ['source-branch', 'comparison-branch', 'environment', 'operation']
    ],
    ['quick-deploy-release', ['environment', 'release-record-id']],
    ['reconcile-release', ['environment', 'release-record-id']]
  ] as const;
  for (const [name, expected] of specifications) {
    const entry = parse(
      readFileSync(path.join(root, '.github/workflows', name + '.yml'), 'utf8')
    );
    assert.deepEqual(Object.keys(entry.on), ['workflow_dispatch']);
    const inputs = entry.on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(inputs), [...expected]);
    assert.equal(inputs.environment.type, 'environment');
    assert.ok(!entry.name.includes('Salesforce'));
    if (inputs.operation) {
      assert.equal(inputs.operation.default, 'validate');
      assert.deepEqual(inputs.operation.options, ['validate', 'deploy']);
    }
    assert.equal(
      entry.jobs.release.uses,
      './.github/workflows/release-execution.yml'
    );
  }
  assert.equal(workflow.jobs.prepare.permissions.deployments, 'read');
  const release = workflow.jobs.release;
  assert.equal(workflow.permissions.deployments, 'write');
  assert.equal(workflow.permissions.checks, 'write');
  assert.deepEqual(release.environment, {
    name: '${{ inputs.environment }}',
    deployment: false
  });
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.match(release.concurrency.group, /outputs.profile\).org/);
  assert.doesNotMatch(release.concurrency.group, /source-branch|operation/);
  assert.ok(
    release.steps.some(
      (step: { with?: Record<string, unknown> }) =>
        step.with?.ref === '${{ needs.prepare.outputs.head-sha }}' &&
        step.with['fetch-depth'] === 0
    )
  );
  for (const job of [workflow.jobs.prepare, release]) {
    for (const step of job.steps) {
      if (step.uses?.startsWith('./.ci/github-actions/actions/')) {
        const metadata = parse(
          readFileSync(
            path.join(root, step.uses.replace('./.ci/', ''), 'action.yml'),
            'utf8'
          )
        );
        for (const input of Object.keys(step.with))
          assert.ok(input in metadata.inputs, `Undeclared input ${input}`);
      }
    }
  }
  const execute = release.steps.find(
    (step: { id?: string }) => step.id === 'full'
  );
  assert.equal(execute.with.config, '${{ needs.prepare.outputs.config }}');
  assert.equal(execute.with.plan, '${{ needs.prepare.outputs.plan }}');
  assert.match(execute.with.username, /secrets\[fromJSON/);
  assert.ok(
    release.steps.some(
      (step: { run?: string }) =>
        step.run === 'npm install --global @salesforce/cli'
    )
  );
  assert.match(release.steps.at(-1).if, /always\(\)/);
  const tooling = parse(
    readFileSync(
      path.join(root, '.github/workflows/github-actions-ci.yml'),
      'utf8'
    )
  );
  assert.ok(
    tooling.on.pull_request.paths.includes(
      '.github/workflows/release-execution.yml'
    )
  );
});

test('compiled focused release rejects invalid routing and reaches isolated JWT execution without a prepare-only input', (context) => {
  const repo = repository();
  const temporary = mkdtempSync(path.join(tmpdir(), 'compiled-release-test-'));
  context.after(() => {
    rmSync(repo.workspace, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  });
  const project = path.resolve(__dirname, '..');
  const output = path.join(temporary, 'dist');
  execFileSync(
    process.execPath,
    [
      require.resolve('@vercel/ncc/dist/ncc/cli.js'),
      'build',
      path.join(project, 'actions/validate-deploy-full-branch/src/index.ts'),
      '--out',
      output
    ],
    { cwd: project, stdio: 'inherit' }
  );
  const summary = path.join(temporary, 'summary');
  const githubOutput = path.join(temporary, 'output');
  writeFileSync(summary, '');
  writeFileSync(githubOutput, '');
  const plan = {
    branch: 'main',
    environment: 'production',
    operation: 'validate',
    range: {
      selection: 'full-branch',
      branchSha: repo.base,
      headSha: repo.base
    }
  };
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'example/salesforce',
    GITHUB_WORKSPACE: repo.workspace,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: githubOutput,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    INPUT_CONFIG: JSON.stringify(config),
    'INPUT_ORGS-CONFIG': JSON.stringify(profiles),
    INPUT_ENVIRONMENT: 'production',
    INPUT_OPERATION: 'validate',
    INPUT_PLAN: JSON.stringify(plan),
    'INPUT_GITHUB-TOKEN': 'fake-test-token',
    INPUT_USERNAME: '',
    'INPUT_CLIENT-ID': '',
    'INPUT_JWT-PRIVATE-KEY': '',
    'INPUT_WORKING-DIRECTORY': '.',
    'INPUT_PREPARE-ONLY': ''
  };
  for (const [overrides, expected] of [
    [{ GITHUB_EVENT_NAME: 'pull_request' }, /manually dispatched/],
    [{ INPUT_OPERATION: 'quick-deploy' }, /only validate or deploy/],
    [
      { INPUT_PLAN: JSON.stringify({ ...plan, operation: 'deploy' }) },
      /prepared plan does not match/
    ],
    [{}, /JWT authentication requires username/]
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [path.join(output, 'index.js')],
      { cwd: repo.workspace, encoding: 'utf8', env: { ...env, ...overrides } }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stdout, expected);
    assert.ok(!result.stdout.includes('Input does not meet YAML'));
  }
});

test('compiled preparation pins all source plans and derives Quick Deploy context without credentials or live branch lookup', async (context) => {
  const repo = repository();
  const temporary = mkdtempSync(path.join(tmpdir(), 'compiled-prepare-test-'));
  context.after(() => {
    rmSync(repo.workspace, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(repo.workspace, 'force-app/classes/Second.cls'),
    'public class Second {}'
  );
  const start = repo.commit();
  writeFileSync(
    path.join(repo.workspace, 'force-app/classes/Third.cls'),
    'public class Third {}'
  );
  const end = repo.commit();
  const project = path.resolve(__dirname, '..');
  const output = path.join(temporary, 'dist');
  execFileSync(
    process.execPath,
    [
      require.resolve('@vercel/ncc/dist/ncc/cli.js'),
      'build',
      path.join(project, 'actions/prepare-release/src/index.ts'),
      '--out',
      output
    ],
    { cwd: project, stdio: 'inherit' }
  );
  let branchesAllowed = true;
  const receipt = {
    ...entry(12, 'validate').receipt,
    headSha: start,
    branchSha: start,
    selection: 'full-branch'
  };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname.endsWith('/check-runs/12')) {
      response.end(
        JSON.stringify({
          id: 12,
          name: 'Release validation',
          head_sha: start,
          status: 'completed',
          conclusion: 'success',
          external_id: `sf-job:${jobId}`,
          output: { text: JSON.stringify(receipt) }
        })
      );
      return;
    }
    assert.ok(
      branchesAllowed,
      'Utilities must derive source context from the saved validation, not live branch tips.'
    );
    if (pathname.endsWith('/branches/release-x'))
      response.end(JSON.stringify({ commit: { sha: end } }));
    else if (pathname.endsWith('/branches/main'))
      response.end(JSON.stringify({ commit: { sha: repo.base } }));
    else {
      response.statusCode = 404;
      response.end('{}');
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
  const policy = {
    version: 1,
    branches: {
      'release-*': { deployment: { enabled: true, orgs: ['production'] } }
    }
  };
  let count = 0;
  const prepare = async (inputs: Record<string, string>) => {
    const summary = path.join(temporary, `summary-${count}`);
    const githubOutput = path.join(temporary, `output-${count++}`);
    writeFileSync(summary, '');
    writeFileSync(githubOutput, '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_REPOSITORY: 'example/salesforce',
      GITHUB_WORKSPACE: repo.workspace,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: githubOutput,
      INPUT_CONFIG: JSON.stringify(policy),
      'INPUT_ORGS-CONFIG': JSON.stringify(profiles),
      INPUT_ENVIRONMENT: 'production',
      INPUT_OPERATION: 'validate',
      INPUT_SELECTION: 'full-branch',
      'INPUT_SOURCE-BRANCH': 'release-x',
      'INPUT_COMPARISON-BRANCH': '',
      'INPUT_START-COMMIT': '',
      'INPUT_END-COMMIT': '',
      'INPUT_RELEASE-RECORD-ID': '',
      'INPUT_GITHUB-TOKEN': 'fake-test-token',
      'INPUT_WORKING-DIRECTORY': '.',
      INPUT_USERNAME: '',
      'INPUT_CLIENT-ID': '',
      'INPUT_JWT-PRIVATE-KEY': '',
      ...inputs
    };
    const result = await new Promise<{ code: number | null; text: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [path.join(output, 'index.js')], {
          cwd: repo.workspace,
          env
        });
        let text = '';
        child.stdout.on('data', (chunk) => (text += String(chunk)));
        child.stderr.on('data', (chunk) => (text += String(chunk)));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, text }));
      }
    );
    assert.equal(result.code, 0, result.text);
    const lines = readFileSync(githubOutput, 'utf8').trimEnd().split(/\r?\n/);
    const outputs: Record<string, string> = {};
    for (let index = 0; index < lines.length; index += 3)
      outputs[lines[index].split('<<')[0]] = lines[index + 1];
    assert.deepEqual(JSON.parse(outputs.config), policy);
    assert.deepEqual(JSON.parse(outputs['orgs-config']), profiles);
    return JSON.parse(outputs.plan);
  };
  assert.equal((await prepare({})).range.headSha, end);
  const commits = await prepare({
    INPUT_SELECTION: 'commit-range',
    'INPUT_START-COMMIT': start,
    'INPUT_END-COMMIT': end
  });
  assert.equal(commits.range.startSha, start);
  assert.equal(commits.range.baseSha, repo.base);
  assert.equal(commits.range.headSha, end);
  const branches = await prepare({
    INPUT_SELECTION: 'branch-changes',
    'INPUT_COMPARISON-BRANCH': 'main'
  });
  assert.equal(branches.range.baseSha, repo.base);
  assert.equal(branches.range.headSha, end);
  branchesAllowed = false;
  const quick = await prepare({
    INPUT_SELECTION: '',
    INPUT_OPERATION: 'quick-deploy',
    'INPUT_SOURCE-BRANCH': '',
    'INPUT_RELEASE-RECORD-ID': 'validation:12'
  });
  assert.equal(quick.branch, 'release-x');
  assert.equal(quick.range.headSha, start);
  assert.equal(quick.recordKind, 'validation');
});

test('GitHub history filters task/org, paginates records and statuses, and ignores automatic environment inactivation', async () => {
  const { getOctokit } = await import('@actions/github');
  const requests: string[] = [];
  const writes: Record<string, unknown>[] = [];
  let conflicting = false;
  const deployment = (id: number) => ({
    id,
    task: releaseTask,
    sha: 'a'.repeat(40),
    environment: 'production',
    payload: entry(id).receipt
  });
  const client = getOctokit('test-token-not-a-secret', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push(url.pathname + url.search);
        if (request.method === 'POST') {
          const payload = (await request.json()) as Record<string, unknown>;
          writes.push(payload);
          return Response.json(
            url.pathname.endsWith('/statuses') ? {} : { ...deployment(99) }
          );
        }
        if (url.pathname.endsWith('/statuses')) {
          if (url.searchParams.get('page') === '2') {
            return Response.json([
              {
                state: 'in_progress',
                description: `sf-job:${conflicting ? '0Af000000000002AAA' : jobId}`
              }
            ]);
          }
          return Response.json(
            [
              {
                state: 'inactive',
                description: 'This deployment has been marked as inactive.'
              },
              { state: 'success', description: `sf-job:${jobId}` }
            ],
            {
              headers: {
                link: `<${url.origin}${url.pathname}?page=2>; rel="next"`
              }
            }
          );
        }
        assert.equal(url.searchParams.get('task'), releaseTask);
        if (url.searchParams.get('page') === '2')
          return Response.json([deployment(2)]);
        return Response.json(
          [
            deployment(1),
            { ...deployment(3), task: 'deploy', payload: {} },
            {
              ...deployment(4),
              payload: { ...entry(4).receipt, org: 'another-org' }
            }
          ],
          {
            headers: {
              link: `<${url.origin}${url.pathname}?task=${releaseTask}&page=2>; rel="next"`
            }
          }
        );
      }
    }
  });
  const history = githubHistory(
    client,
    { owner: 'example', repo: 'salesforce' },
    'production',
    'https://github.com/example/salesforce/actions/runs/1'
  );
  const listed = await history.list();
  assert.deepEqual(
    listed.map((item) => item.id),
    [1, 2]
  );
  assert.equal(listed[1].id, 2);
  assert.ok(
    listed.every((item) => item.state === 'success' && item.jobId === jobId)
  );
  assert.ok(requests.some((url) => url.includes('/statuses?page=2')));
  const created = await history.create(entry(99, 'deploy').receipt);
  created.jobId = jobId;
  await history.status(created, 'success');
  assert.equal(writes[0].auto_merge, false);
  assert.deepEqual(writes[0].required_contexts, []);
  assert.equal(writes[0].task, releaseTask);
  assert.equal(writes[1].auto_inactive, false);
  assert.equal(writes[1].description, `sf-job:${jobId}`);
  conflicting = true;
  await assert.rejects(history.list(), /conflicting/);
});

test('validation records use checks, not deployment objects, and retain exact job context for utilities', async () => {
  const { getOctokit } = await import('@actions/github');
  const receipt = entry(1, 'validate').receipt;
  let stored: Record<string, unknown> = {};
  const methods: string[] = [];
  const client = getOctokit('test-token-not-a-secret', {
    request: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        methods.push(request.method);
        assert.match(url.pathname, /check-runs/);
        assert.ok(!url.pathname.includes('deployments'));
        if (request.method !== 'GET')
          stored = {
            ...stored,
            ...((await request.json()) as Record<string, unknown>)
          };
        return Response.json({ id: 12, ...stored, head_sha: receipt.headSha });
      }
    }
  });
  const history = githubHistory(
    client,
    { owner: 'example', repo: 'salesforce' },
    'production',
    'https://github.com/example/salesforce/actions/runs/1'
  );
  const created = await history.create(receipt);
  assert.equal(created.kind, 'validation');
  created.jobId = jobId;
  await history.status(created, 'success');
  const saved = await history.get(12, 'validation');
  assert.equal(saved.jobId, jobId);
  assert.equal(saved.state, 'success');
  assert.deepEqual(saved.receipt, receipt);
  assert.deepEqual(methods, ['POST', 'PATCH', 'GET']);
});
