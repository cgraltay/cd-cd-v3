import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { readOrgsConfig } from '../shared/orgs';
import { resolveConfig } from '../actions/config-reader/src/config';

interface Step {
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name: string;
  outputs?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: string | { name: string; deployment: boolean };
  steps: Step[];
  strategy?: { 'fail-fast': boolean; matrix: string };
}
interface Workflow {
  name: string;
  'run-name': string;
  on: Record<string, { types?: string[]; inputs?: Record<string, unknown> }>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const repository = path.resolve(__dirname, '..', '..');
const document = parseDocument(
  readFileSync(
    path.join(repository, '.github', 'workflows', 'salesforce-pr-review.yml'),
    'utf8'
  ),
  { uniqueKeys: true }
);
const workflow = document.toJS() as Workflow;

test('Salesforce workflow has valid YAML, expected jobs, and known dependencies', () => {
  assert.deepEqual(document.errors, []);
  assert.equal(workflow.name, 'Salesforce PR Review');
  assert.ok(workflow['run-name'].startsWith('Salesforce PR Review |'));
  assert.deepEqual(Object.keys(workflow.jobs), [
    'configuration',
    'branch-name',
    'title',
    'code-analyzer',
    'validation',
    'status'
  ]);
  for (const job of Object.values(workflow.jobs)) {
    for (const dependency of [job.needs ?? []].flat())
      assert.ok(workflow.jobs[dependency]);
  }
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

test('Salesforce workflow rechecks edited/ready PRs and supports safe manual planning', () => {
  for (const activity of ['edited', 'ready_for_review'])
    assert.ok(workflow.on.pull_request.types?.includes(activity));
  assert.ok(!workflow.on.pull_request.types?.includes('closed'));
  assert.ok(workflow.on.workflow_dispatch.inputs?.['target-branch']);
  assert.ok(!workflow.on.push);
  assert.ok(!workflow.on.pull_request_target);
  for (const name of ['branch-name', 'title', 'code-analyzer', 'validation']) {
    assert.ok(
      workflow.jobs[name].if?.includes("github.event_name == 'pull_request'")
    );
  }
});

test('workflow local action inputs match actual action manifests', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.uses?.startsWith('./.ci/')) continue;
      const actionPath = step.uses.replace('./.ci/', '');
      const action = parseDocument(
        readFileSync(path.join(repository, actionPath, 'action.yml'), 'utf8')
      ).toJS() as {
        inputs: Record<string, { required?: boolean; default?: unknown }>;
      };
      for (const name of Object.keys(step.with ?? {}))
        assert.ok(
          Object.hasOwn(action.inputs, name),
          `Unknown ${actionPath} input: ${name}`
        );
      for (const [name, input] of Object.entries(action.inputs)) {
        if (input.required && input.default === undefined)
          assert.ok(
            Object.hasOwn(step.with ?? {}, name),
            `Missing ${actionPath} input: ${name}`
          );
      }
    }
  }
});

test('title and branch checks run independently to preserve feedback cleanup', () => {
  assert.equal(workflow.jobs.title.needs, 'configuration');
  assert.equal(workflow.jobs['branch-name'].needs, 'configuration');
  assert.ok(!workflow.jobs.title.if?.includes('branch-name'));
});

test('Code Analyzer waits for successful branch-name and PR-title checks', () => {
  const job = workflow.jobs['code-analyzer'];
  assert.deepEqual(job.needs, ['configuration', 'branch-name', 'title']);
  assert.ok(job.if?.includes("needs.branch-name.result == 'success'"));
  assert.ok(job.if?.includes("needs.title.result == 'success'"));
});

test('deployment validation permits a skipped analyzer only when analysis is disabled', () => {
  const job = workflow.jobs.validation;
  assert.ok([job.needs ?? []].flat().includes('code-analyzer'));
  assert.ok(job.if?.includes('!cancelled()'));
  assert.ok(job.if?.includes("needs.code-analyzer.result == 'success'"));
  assert.match(
    job.if ?? '',
    /needs\.configuration\.outputs\.analyzer-enabled != 'true' && needs\.code-analyzer\.result == 'skipped'/
  );
});

test('parallel validation binds profile environments and passes secrets only as action inputs', () => {
  const job = workflow.jobs.validation;
  assert.equal(job.strategy?.['fail-fast'], false);
  assert.deepEqual(job.environment, {
    name: '${{ matrix.environment }}',
    deployment: false
  });
  assert.ok(job.if?.includes('head.repo.full_name == github.repository'));
  assert.ok(job.if?.includes('draft == false'));
  assert.ok(job.if?.includes("needs.branch-name.result == 'success'"));
  assert.ok(job.if?.includes("needs.title.result == 'success'"));
  const step = job.steps.find((candidate) => candidate.id === 'validation');
  assert.equal(step?.with?.config, '${{ needs.configuration.outputs.config }}');
  assert.equal(
    step?.with?.['orgs-config'],
    '${{ needs.configuration.outputs.orgs-config }}'
  );
  assert.ok(!Object.hasOwn(step?.with ?? {}, 'orgs-config-path'));
  assert.equal(step?.with?.username, '${{ secrets[matrix.usernameSecret] }}');
  assert.equal(
    step?.with?.['client-id'],
    '${{ secrets[matrix.clientIdSecret] }}'
  );
  assert.equal(
    step?.with?.['jwt-private-key'],
    '${{ secrets[matrix.jwtKeySecret] }}'
  );
  for (const [name, other] of Object.entries(workflow.jobs)) {
    if (name !== 'validation')
      assert.ok(!JSON.stringify(other).includes('secrets['));
  }
});

test('org profile variables are captured by the reader and passed as a job snapshot', () => {
  const job = workflow.jobs.configuration;
  const step = job.steps.find((candidate) => candidate.id === 'config');
  assert.equal(step?.with?.['orgs-config'], '${{ vars.SF_ORGS_CONFIG }}');
  assert.ok(!Object.hasOwn(step?.with ?? {}, 'orgs-config-path'));
  assert.equal(
    job.outputs?.['orgs-config'],
    '${{ steps.config.outputs.orgs-config }}'
  );
  const summary = job.steps.find((candidate) => candidate.id === 'plan');
  assert.match(summary?.run ?? '', /Set SF_ORGS_CONFIG/);
});

test('local actions load the PR source commit and never persist checkout credentials', () => {
  let actionCheckouts = 0;
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses !== 'actions/checkout@v5') continue;
      assert.equal(step.with?.['persist-credentials'], false);
      if (step.with?.path === '.ci') {
        actionCheckouts += 1;
        assert.ok(
          String(step.with.ref).includes('github.event.pull_request.head.sha')
        );
        assert.ok(!String(step.with.ref).includes('base.sha'));
      }
    }
  }
  assert.equal(actionCheckouts, 5);
  const configurationCheckout = workflow.jobs.configuration.steps.find(
    (step) => step.with?.path === '.ci'
  );
  assert.equal(
    configurationCheckout?.with?.ref,
    '${{ github.event.pull_request.head.sha || github.sha }}'
  );
  const validationSource = workflow.jobs.validation.steps.find(
    (step) => step.with?.path === 'source'
  );
  assert.equal(
    validationSource?.with?.ref,
    '${{ github.event.pull_request.merge_commit_sha || github.sha }}'
  );
});

test('analyzer uses the PR checkout and leaves proposed YAML and PMD rules unchanged', () => {
  const job = workflow.jobs['code-analyzer'];
  const source = job.steps.find(
    (step) =>
      step.uses === 'actions/checkout@v5' && step.with?.path === 'source'
  );
  assert.equal(source?.with?.ref, '${{ github.event.pull_request.head.sha }}');
  const analyzer = job.steps.find((step) => step.id === 'analyzer');
  assert.equal(analyzer?.with?.['working-directory'], 'source');
  assert.equal(
    analyzer?.uses,
    './.ci/github-actions/actions/run-code-analyzer'
  );
  assert.ok(job.if?.includes('head.repo.full_name == github.repository'));
  for (const step of job.steps) {
    assert.ok(!step.run?.includes('source/code-analyzer.yml'));
    assert.ok(!step.run?.includes('source/pmd-ruleset.xml'));
  }
});

test('Salesforce CLI installs use the unversioned package requested by the workflow', () => {
  for (const name of ['code-analyzer', 'validation']) {
    const step = workflow.jobs[name].steps.find((candidate) =>
      candidate.run?.includes('npm install --global @salesforce/cli')
    );
    assert.ok(step?.run);
    assert.ok(
      step.run.split('\n').includes('npm install --global @salesforce/cli')
    );
    assert.ok(!step.run.includes('@salesforce/cli@'));
  }
});

test('failed validation and analyzer runs still expose report artifacts', () => {
  for (const name of ['validation', 'code-analyzer']) {
    const step = workflow.jobs[name].steps.find(
      (candidate) => candidate.uses === 'actions/upload-artifact@v4'
    );
    assert.ok(step?.if?.includes('!cancelled()'));
    assert.ok(step?.if?.includes('report-path'));
  }
  assert.ok(!Object.hasOwn(workflow.jobs, 'deployment-plan'));
});

test('aggregate status is stable and prevents silent skipped required checks', () => {
  assert.equal(workflow.jobs.status.name, 'Salesforce CI Status');
  assert.equal(workflow.jobs.status.if, 'always()');
  assert.deepEqual(workflow.jobs.status.needs, [
    'configuration',
    'branch-name',
    'title',
    'code-analyzer',
    'validation'
  ]);
});

test('manual observation summary shows selected orgs without exposing connection secrets', (context) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'salesforce-plan-summary-')
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = JSON.parse(
    readFileSync(
      path.join(
        repository,
        'github-actions',
        'actions',
        'config-reader',
        'ci-cd-config.example.json'
      ),
      'utf8'
    )
  );
  const orgs = readOrgsConfig(
    readFileSync(
      path.join(
        repository,
        'github-actions',
        'actions',
        'config-reader',
        'orgs-connections-config.example.json'
      ),
      'utf8'
    )
  );
  const plan = resolveConfig(config, 'develop', 'develop', undefined, orgs);
  const step = workflow.jobs.configuration.steps.find(
    (candidate) => candidate.id === 'plan'
  );
  const match = step?.run?.match(/^node <<'NODE'\n([\s\S]*?)\nNODE\s*$/);
  assert.ok(match);
  const summary = path.join(directory, 'summary.md');
  const output = path.join(directory, 'output.txt');
  const result = spawnSync(process.execPath, ['-e', match[1]], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRANCH: plan.branch,
      MATCHED_BRANCH: plan.matchedBranch ?? '',
      BRANCH_CONFIG: JSON.stringify(plan.branchConfig),
      VALIDATION_MATRIX: JSON.stringify(plan.validationMatrix),
      EVENT_NAME: 'workflow_dispatch',
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output
    }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const markdown = readFileSync(summary, 'utf8');
  assert.match(markdown, /Manual observation run/);
  assert.ok(markdown.includes('`development`'));
  assert.ok(markdown.includes('`qa`'));
  assert.ok(!markdown.includes('SF_JWT_PRIVATE_KEY'));
  assert.match(readFileSync(output, 'utf8'), /analyzer-enabled=true/);
});

test('aggregate status script handles enabled, skipped, failed, cancelled, and manual runs', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'salesforce-workflow-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = workflow.jobs.status.steps[0].run ?? '';
  const match = run.match(/^node <<'NODE'\n([\s\S]*?)\nNODE\s*$/);
  assert.ok(match, 'Expected the workflow summary Node script.');
  const base = {
    configuration: 'success',
    'branch-name': 'success',
    title: 'success',
    'code-analyzer': 'skipped',
    validation: 'skipped'
  };
  const cases = [
    {
      name: 'disabled operations',
      results: base,
      analyzer: 'false',
      validation: 'false',
      event: 'pull_request',
      action: 'synchronize',
      code: 0
    },
    {
      name: 'all enabled succeeded',
      results: { ...base, 'code-analyzer': 'success', validation: 'success' },
      analyzer: 'true',
      validation: 'true',
      event: 'pull_request',
      action: 'synchronize',
      code: 0
    },
    {
      name: 'required validation skipped',
      results: base,
      analyzer: 'false',
      validation: 'true',
      event: 'pull_request',
      action: 'synchronize',
      code: 1
    },
    {
      name: 'required analyzer skipped',
      results: base,
      analyzer: 'true',
      validation: 'false',
      event: 'pull_request',
      action: 'synchronize',
      code: 1
    },
    {
      name: 'bad branch',
      results: { ...base, 'branch-name': 'failure' },
      analyzer: 'false',
      validation: 'false',
      event: 'pull_request',
      action: 'edited',
      code: 1
    },
    {
      name: 'validation failed',
      results: { ...base, validation: 'failure' },
      analyzer: 'false',
      validation: 'true',
      event: 'pull_request',
      action: 'synchronize',
      code: 1
    },
    {
      name: 'validation cancelled',
      results: { ...base, validation: 'cancelled' },
      analyzer: 'false',
      validation: 'true',
      event: 'pull_request',
      action: 'synchronize',
      code: 1
    },
    {
      name: 'manual observation',
      results: { ...base, 'branch-name': 'skipped', title: 'skipped' },
      analyzer: 'true',
      validation: 'true',
      event: 'workflow_dispatch',
      action: '',
      code: 0
    }
  ];
  for (const scenario of cases) {
    const summary = path.join(
      directory,
      scenario.name.replaceAll(' ', '-') + '.md'
    );
    const results = Object.fromEntries(
      Object.entries(scenario.results).map(([name, result]) => [
        name,
        { result }
      ])
    );
    const execution: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      ['-e', match[1]],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          JOB_RESULTS: JSON.stringify(results),
          EVENT_NAME: scenario.event,
          EVENT_ACTION: scenario.action,
          ANALYZER_ENABLED: scenario.analyzer,
          VALIDATION_ENABLED: scenario.validation,
          GITHUB_STEP_SUMMARY: summary
        }
      }
    );
    assert.ifError(execution.error);
    assert.equal(
      execution.status,
      scenario.code,
      scenario.name + ': ' + execution.stderr
    );
    assert.match(readFileSync(summary, 'utf8'), /Salesforce CI results/);
  }
});

test('tooling CI checks PR workflow changes and supports manual runs without push runs', () => {
  const tooling = parseDocument(
    readFileSync(
      path.join(repository, '.github', 'workflows', 'github-actions-ci.yml'),
      'utf8'
    )
  ).toJS() as { on: Record<string, { paths: string[] }> };
  assert.deepEqual(Object.keys(tooling.on).sort(), [
    'pull_request',
    'workflow_dispatch'
  ]);
  assert.ok(
    tooling.on.pull_request.paths.includes(
      '.github/workflows/salesforce-pr-review.yml'
    )
  );
});
