import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOrgsConfig } from '../shared/orgs';
import {
  releasePlan,
  releaseTarget
} from '../actions/deploy-metadata/src/plan';
import {
  assertSettled,
  baseline,
  savedValidation,
  githubHistory,
  releaseTask,
  type ReleaseEntry
} from '../actions/deploy-metadata/src/history';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseSources } from '../actions/deploy-metadata/src/source';
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

test('only successful actual releases advance baseline, with org identity protection', () => {
  const entries = [
    entry(1),
    entry(2, 'validate'),
    entry(3, 'deploy', 'failure')
  ];
  assert.equal(baseline(entries, orgId)?.id, 1);
  assert.equal(baseline([entry(2, 'validate')], orgId), undefined);
  assert.throws(
    () => baseline(entries, '00D000000000002AAA'),
    /different Salesforce org/
  );
  assert.throws(
    () => assertSettled([...entries, entry(4, 'deploy', 'in_progress')]),
    /unresolved/
  );
  assert.doesNotThrow(() =>
    assertSettled([entry(1, 'validate', 'in_progress')])
  );
  assert.doesNotThrow(() =>
    assertSettled([entry(4, 'deploy', 'in_progress')], 4)
  );
});

test('quick deployment requires a saved successful validation against the current baseline', () => {
  const validation = entry(2, 'validate');
  assert.equal(savedValidation([validation], 2, undefined), validation);
  assert.throws(
    () => savedValidation([validation], 2, entry(3)),
    /baseline changed/
  );
  assert.throws(
    () => savedValidation([entry(2, 'validate', 'failure')], 2, undefined),
    /successful recorded validation/
  );
  assert.throws(
    () => savedValidation([entry(2)], 2, undefined),
    /successful recorded validation/
  );
  assert.throws(
    () => savedValidation([{ ...validation, jobId: undefined }], 2, undefined),
    /job ID/
  );
});

test('preparation pins source branch tip or explicit commit and reuses the saved validation commit', () => {
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
  const tip = 'c'.repeat(40);
  const validation = entry(1, 'validate');
  assert.equal(releaseTarget(plan, 'validate', tip, '', []).headSha, tip);
  assert.equal(
    releaseTarget(plan, 'validate', tip, 'a'.repeat(40), []).headSha,
    'a'.repeat(40)
  );
  assert.equal(
    releaseTarget(plan, 'quick-deploy', tip, '', [validation], 1).headSha,
    validation.receipt.headSha
  );
  assert.throws(
    () => releaseTarget(plan, 'quick-deploy', tip, tip, [validation], 1),
    /differs/
  );
  assert.throws(
    () => releaseTarget(plan, 'quick-deploy', tip, '', [], 1),
    /matching/
  );
  assert.throws(
    () => releaseTarget(plan, 'deploy', tip, '', [], 1),
    /only used/
  );
  assert.throws(() => releaseTarget(plan, 'validate', tip, 'HEAD', []));
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

test('cumulative delta includes multiple commits and requires a real baseline', (context) => {
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
    /Bootstrap/
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
      return entries;
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

test('manual validation, deploy, quick deploy, and recovery preserve baseline and never silently fall back', async (context) => {
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
    if (args[0] === 'org') return response({ status: 0 });
    if (args[0] === 'data')
      return response({
        status: 0,
        result: { done: true, totalSize: 1, records: [{ Id: orgId }] }
      });
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
  assert.equal(baseline(entries, orgId), undefined);
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
  assert.equal(baseline(entries, orgId), undefined);

  quickRejected = false;
  actual = false;
  await runRelease({ ...options, operation: 'quick-deploy', recordId: 1 });
  assert.equal(baseline(entries, orgId)?.id, 3);
  await assert.rejects(
    runRelease({ ...options, operation: 'quick-deploy', recordId: 1 }),
    /baseline changed/
  );

  actualInProgress = true;
  await assert.rejects(
    runRelease({ ...options, operation: 'deploy' }),
    /not confirmed complete/
  );
  const unresolved = entries.at(-1)!;
  assert.equal(unresolved.state, 'in_progress');
  assert.equal(unresolved.jobId, jobId);
  await assert.rejects(
    runRelease({ ...options, operation: 'deploy' }),
    /unresolved/
  );
  actualInProgress = false;
  const startsBeforeRecovery = commands.filter(
    (args) => args[2] === 'start'
  ).length;
  await runRelease({
    ...options,
    operation: 'reconcile',
    recordId: unresolved.id
  });
  assert.equal(baseline(entries, orgId)?.id, unresolved.id);
  assert.equal(
    commands.filter((args) => args[2] === 'start').length,
    startsBeforeRecovery
  );
  assert.equal(existsSync(authHome), false);
});

test('manual release workflow separates branch/environment, snapshots config, pins sources, and serializes org releases', () => {
  const root = path.resolve(__dirname, '../..');
  const workflow = parse(
    readFileSync(
      path.join(root, '.github/workflows/salesforce-release.yml'),
      'utf8'
    )
  );
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs['source-branch'].type, 'string');
  assert.equal(inputs.environment.type, 'environment');
  assert.equal(inputs.operation.default, 'validate');
  assert.deepEqual(inputs.operation.options, [
    'validate',
    'deploy',
    'quick-deploy',
    'reconcile'
  ]);
  assert.equal(workflow.jobs.prepare.permissions.deployments, 'read');
  const release = workflow.jobs.release;
  assert.equal(release.permissions.deployments, 'write');
  assert.equal(release.environment, '${{ inputs.environment }}');
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
  const metadata = parse(
    readFileSync(
      path.join(root, 'github-actions/actions/deploy-metadata/action.yml'),
      'utf8'
    )
  );
  for (const job of [workflow.jobs.prepare, release]) {
    for (const step of job.steps) {
      if (step.uses === './.ci/github-actions/actions/deploy-metadata') {
        for (const input of Object.keys(step.with))
          assert.ok(input in metadata.inputs, `Undeclared input ${input}`);
      }
    }
  }
  const execute = release.steps.find(
    (step: { id?: string }) => step.id === 'release'
  );
  assert.equal(execute.with.config, '${{ needs.prepare.outputs.config }}');
  assert.equal(execute.with['source-branch'], '${{ inputs.source-branch }}');
  assert.match(execute.with.username, /secrets\[fromJSON/);
  assert.ok(
    release.steps.some(
      (step: { run?: string }) =>
        step.run === 'npm install --global @salesforce/cli'
    )
  );
  assert.match(release.steps.at(-1).if, /always\(\)/);
  assert.equal(metadata.runs.using, 'node24');
  const tooling = parse(
    readFileSync(
      path.join(root, '.github/workflows/github-actions-ci.yml'),
      'utf8'
    )
  );
  for (const event of ['push', 'pull_request'])
    assert.ok(
      tooling.on[event].paths.includes(
        '.github/workflows/salesforce-release.yml'
      )
    );
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
  assert.equal(baseline(listed, orgId)?.id, 2);
  assert.ok(
    listed.every((item) => item.state === 'success' && item.jobId === jobId)
  );
  assert.ok(requests.some((url) => url.includes('/statuses?page=2')));
  const created = await history.create(entry(99, 'validate').receipt);
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
