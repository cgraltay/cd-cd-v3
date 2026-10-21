import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  readConfig,
  readMergedPullRequest,
  resolveConfig
} from '../actions/config-reader/src/config';
import { buildActions } from '../scripts/build';

const mergedPullRequest = {
  number: 42,
  mergeCommitSha: 'a'.repeat(40),
  targetBranch: 'main'
};

test('merged PR event reader accepts only closed merged PRs', () => {
  const pullRequest = {
    number: 42,
    merged: true,
    merge_commit_sha: mergedPullRequest.mergeCommitSha,
    base: { ref: 'main' }
  };

  assert.deepEqual(
    readMergedPullRequest(
      JSON.stringify({ action: 'closed', pull_request: pullRequest })
    ),
    mergedPullRequest
  );
  assert.equal(
    readMergedPullRequest(
      JSON.stringify({ action: 'synchronize', pull_request: pullRequest })
    ),
    undefined
  );
  assert.equal(
    readMergedPullRequest(
      JSON.stringify({
        action: 'closed',
        pull_request: { ...pullRequest, merged: false }
      })
    ),
    undefined
  );
  assert.throws(() => readMergedPullRequest('{'), /valid JSON/);
  assert.throws(
    () =>
      readMergedPullRequest(
        JSON.stringify({ action: 'closed', pull_request: { merged: true } })
      ),
    /merge commit SHA/
  );
});

for (const method of ['merge', 'squash']) {
  test(`${method} deployment delta excludes later commits and includes new PR classes`, (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pr-only-delta-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    const commit = (message: string) => {
      git('add', '.');
      git(
        '-c',
        'user.name=Action Test',
        '-c',
        'user.email=action-test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        message
      );
    };

    git('init', '--initial-branch=develop');
    writeFileSync(path.join(directory, 'README.md'), 'Initial target branch\n');
    commit('Initial');
    git('checkout', '-b', 'feature/x');
    writeFileSync(path.join(directory, 'x.cls'), 'public class X {}\n');
    writeFileSync(path.join(directory, 'y.cls'), 'public class Y {}\n');
    commit('PR classes');
    git('checkout', 'develop');

    if (method === 'merge') {
      git(
        '-c',
        'user.name=Action Test',
        '-c',
        'user.email=action-test@example.com',
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        'feature/x',
        '-m',
        'Merge PR'
      );
    } else {
      git('merge', '--squash', 'feature/x');
      commit('Squash PR');
    }

    const sha = git('rev-parse', 'HEAD');
    writeFileSync(path.join(directory, 'z.cls'), 'public class Z {}\n');
    commit('Later unrelated PR');
    const plan = resolveConfig(
      {
        version: 1,
        branches: {
          develop: {
            deployment: { enabled: true, mode: 'delta', orgs: ['development'] }
          }
        }
      },
      'develop',
      'develop',
      { number: 42, mergeCommitSha: sha, targetBranch: 'develop' }
    );
    const entry = plan.deploymentMatrix.include[0];

    assert.deepEqual(
      git('diff', '--name-only', entry.baseRef!, entry.headRef).split('\n'),
      ['x.cls', 'y.cls']
    );
  });
}

function readOutputs(file: string): Record<string, string> {
  const lines = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
  const entries: [string, string][] = [];

  for (let index = 0; index < lines.length; index += 3) {
    const [name, delimiter] = lines[index].split('<<');
    assert.ok(delimiter);
    assert.equal(lines[index + 2], delimiter);
    entries.push([name, lines[index + 1]]);
  }

  return Object.fromEntries(entries);
}

for (const branch of ['develop', 'qa', 'uat', 'main', 'release/next']) {
  test(`delta validation defaults to origin/${branch} for every org`, () => {
    const config = {
      version: 1,
      branches: {
        '**': {
          validation: { enabled: true, mode: 'delta', orgs: ['qa', 'uat'] }
        }
      }
    };
    const original = JSON.stringify(config);
    const plan = resolveConfig(config, branch);

    assert.equal(plan.matchedBranch, '**');
    assert.deepEqual(
      plan.validationMatrix.include.map((entry) => entry.baseRef),
      [`origin/${branch}`, `origin/${branch}`]
    );
    assert.equal(
      (plan.branchConfig.validation as { baseRef: string }).baseRef,
      `origin/${branch}`
    );
    assert.equal(JSON.stringify(config), original);
  });
}

test('delta validation uses the PR target even when selecting a source branch policy', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        'feature/**': {
          validation: { enabled: true, mode: 'delta', orgs: ['qa'] }
        }
      }
    },
    'feature/change',
    'develop'
  );

  assert.equal(plan.validationMatrix.include[0].baseRef, 'origin/develop');
});

test('delta deployment uses only the merged PR range for every target org', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        main: {
          deployment: { enabled: true, mode: 'delta', orgs: ['qa', 'uat'] }
        }
      }
    },
    'main',
    'main',
    mergedPullRequest
  );

  assert.equal(plan.deploymentEnabled, true);
  assert.deepEqual(
    plan.deploymentMatrix.include,
    ['qa', 'uat'].map((org) => ({
      org,
      mode: 'delta',
      sourceDirs: ['force-app'],
      baseRef: mergedPullRequest.mergeCommitSha + '^1',
      headRef: mergedPullRequest.mergeCommitSha,
      pullRequest: 42
    }))
  );
});

test('deployment is not planned without a merged PR, even if enabled in config', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        main: { deployment: { enabled: true, mode: 'delta', orgs: ['qa'] } }
      }
    },
    'main'
  );

  assert.equal(plan.deploymentEnabled, false);
  assert.deepEqual(plan.deploymentMatrix, { include: [] });
});

test('merged PR range overrides stale deployment config refs', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        main: {
          deployment: {
            enabled: true,
            mode: 'delta',
            orgs: ['qa'],
            baseRef: 'old-tag',
            headRef: 'origin/main'
          }
        }
      }
    },
    'main',
    'main',
    mergedPullRequest
  );

  assert.equal(
    plan.deploymentMatrix.include[0].baseRef,
    mergedPullRequest.mergeCommitSha + '^1'
  );
  assert.equal(
    plan.deploymentMatrix.include[0].headRef,
    mergedPullRequest.mergeCommitSha
  );
});

test('branch config produces independent full and delta matrices for multiple orgs', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        main: {
          validation: {
            enabled: true,
            mode: 'delta',
            baseRef: 'HEAD~1',
            orgs: ['qa', 'uat']
          },
          deployment: { enabled: true, mode: 'full', orgs: ['production'] }
        }
      }
    },
    'main',
    'main',
    mergedPullRequest
  );

  assert.equal(plan.matchedBranch, 'main');
  assert.equal(plan.validationEnabled, true);
  assert.equal(plan.deploymentEnabled, true);
  assert.deepEqual(plan.validationMatrix, {
    include: ['qa', 'uat'].map((org) => ({
      org,
      mode: 'delta',
      sourceDirs: ['force-app'],
      baseRef: 'HEAD~1',
      headRef: 'HEAD'
    }))
  });
  assert.deepEqual(plan.deploymentMatrix.include, [
    {
      org: 'production',
      mode: 'full',
      sourceDirs: ['force-app'],
      baseRef: mergedPullRequest.mergeCommitSha + '^1',
      headRef: mergedPullRequest.mergeCommitSha,
      pullRequest: 42
    }
  ]);
});

test('exact branch rules take priority over wildcard rules', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        '**': { validation: { enabled: true, orgs: ['fallback'] } },
        main: { validation: { enabled: true, orgs: ['qa'] } }
      }
    },
    'main'
  );

  assert.equal(plan.matchedBranch, 'main');
  assert.equal(plan.validationMatrix.include[0].org, 'qa');
});

test('wildcards support nested branches and use the first matching rule', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        'feature/**': { validation: { enabled: true, orgs: ['qa'] } },
        '**': { deployment: { enabled: true, orgs: ['production'] } }
      }
    },
    'feature/team/change'
  );

  assert.equal(plan.matchedBranch, 'feature/**');
  assert.equal(plan.validationEnabled, true);
  assert.equal(plan.deploymentEnabled, false);
});

test('unmatched branches and legacy JSON objects do not schedule operations', () => {
  for (const config of [{}, { version: 1, branches: { main: {} } }]) {
    const plan = resolveConfig(config, 'unconfigured');
    assert.equal(plan.matchedBranch, null);
    assert.equal(plan.validationEnabled, false);
    assert.equal(plan.deploymentEnabled, false);
    assert.deepEqual(plan.validationMatrix, { include: [] });
    assert.deepEqual(plan.deploymentMatrix, { include: [] });
  }
});

test('disabled operations produce no matrix entries and missing flags default to disabled', () => {
  const plan = resolveConfig(
    {
      version: 1,
      branches: {
        main: {
          validation: { enabled: false, orgs: ['qa'] },
          deployment: { orgs: ['production'] }
        }
      }
    },
    'main'
  );

  assert.equal(plan.validationEnabled, false);
  assert.equal(plan.deploymentEnabled, false);
});

test('branch configuration requires a branch name', () => {
  assert.throws(
    () => resolveConfig({ version: 1, branches: {} }, ''),
    /branch input is required/
  );
});

for (const operation of [
  { enabled: 'true', orgs: ['qa'] },
  { enabled: true, mode: 'invalid', orgs: ['qa'] },
  { enabled: true, orgs: [] },
  { enabled: true, orgs: ['qa', 'QA'] },
  { enabled: true, orgs: [''] },
  { enabled: true, orgs: ['qa'], mode: 'delta', baseRef: ' ' },
  { enabled: true, orgs: ['qa'], sourceDirs: [] },
  {
    enabled: true,
    orgs: Array.from({ length: 257 }, (_, index) => `org-${index}`)
  }
]) {
  test(`branch config rejects unsafe operation ${JSON.stringify(operation).slice(0, 120)}`, () => {
    assert.throws(
      () =>
        resolveConfig(
          { version: 1, branches: { main: { validation: operation } } },
          'main'
        ),
      /Invalid branch configuration/
    );
  });
}

test('branch config rejects unsupported schema versions', () => {
  assert.throws(
    () => resolveConfig({ version: 2, branches: {} }, 'main'),
    /Invalid branch configuration/
  );
});

test('config reader preserves nested JSON configuration values', () => {
  const config = {
    validation: { testLevel: 'RunLocalTests', waitMinutes: 30 },
    deployment: { sourceDirs: ['force-app'], enabled: false },
    optional: null
  };

  assert.deepEqual(readConfig(JSON.stringify(config, null, 2)), config);
});

test('config reader accepts an empty object without inventing defaults', () => {
  assert.deepEqual(readConfig(' {}\n'), {});
});

for (const input of ['', ' ', '\n\t']) {
  test(`config reader rejects empty input ${JSON.stringify(input)}`, () => {
    assert.throws(() => readConfig(input), /required.*empty/);
  });
}

test('config reader rejects malformed JSON without exposing its contents', () => {
  const sensitiveValue = 'do-not-log-this-value';
  assert.throws(
    () => readConfig(`{"value":"${sensitiveValue}"`),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The config input must contain valid JSON.');
      assert.ok(!error.message.includes(sensitiveValue));
      return true;
    }
  );
});

for (const input of ['null', '[]', '[{}]', '"value"', 'true', '42']) {
  test(`config reader rejects non-object JSON ${input}`, () => {
    assert.throws(() => readConfig(input), /must be a JSON object/);
  });
}

test('compiled config reader handles GitHub inputs and outputs', async (context) => {
  const projectRoot = path.resolve(__dirname, '..');
  buildActions(projectRoot);
  const directory = mkdtempSync(path.join(tmpdir(), 'config-reader-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = path.join(
    projectRoot,
    'actions',
    'config-reader',
    'dist',
    'index.js'
  );
  const marker = 'must-not-appear-in-action-logs';
  const config = { validation: { testLevel: 'RunLocalTests' }, label: marker };
  const openEvent = path.join(directory, 'open-pr-event.json');
  writeFileSync(
    openEvent,
    JSON.stringify({ action: 'synchronize', pull_request: { merged: false } })
  );

  await context.test(
    'valid config becomes a JSON step output without logging values',
    () => {
      const output = path.join(directory, 'success-output');
      writeFileSync(output, '');
      const result = spawnSync(process.execPath, [bundle], {
        encoding: 'utf8',
        env: {
          ...process.env,
          INPUT_CONFIG: JSON.stringify(config, null, 2),
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: '',
          GITHUB_OUTPUT: output
        }
      });

      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const outputs = readOutputs(output);
      assert.deepEqual(JSON.parse(outputs.config), config);
      assert.equal(outputs['validation-enabled'], 'false');
      assert.equal(outputs['deployment-enabled'], 'false');
      assert.deepEqual(JSON.parse(outputs['validation-matrix']), {
        include: []
      });
      assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
    }
  );

  const pipeline = {
    version: 1,
    branches: {
      main: {
        validation: {
          enabled: true,
          mode: 'delta',
          orgs: ['qa', 'uat']
        },
        deployment: { enabled: true, mode: 'delta', orgs: ['production'] }
      },
      develop: {
        validation: { enabled: true, mode: 'delta', orgs: ['development'] }
      },
      'feature/**': {
        validation: { enabled: true, mode: 'delta', orgs: ['development'] }
      }
    },
    label: marker
  };

  for (const scenario of [
    {
      name: 'PR target branch',
      branch: '',
      base: 'main',
      ref: '42/merge',
      expected: 'main',
      matched: 'main'
    },
    {
      name: 'PR target develop',
      branch: '',
      base: 'develop',
      ref: '42/merge',
      expected: 'develop',
      matched: 'develop'
    },
    {
      name: 'push branch',
      branch: '',
      base: '',
      ref: 'main',
      expected: 'main',
      matched: 'main'
    },
    {
      name: 'explicit source branch',
      branch: 'feature/change',
      base: 'main',
      ref: '42/merge',
      expected: 'feature/change',
      matched: 'feature/**'
    },
    {
      name: 'unmatched branch',
      branch: 'unconfigured',
      base: 'main',
      ref: '42/merge',
      expected: 'unconfigured',
      matched: ''
    }
  ]) {
    await context.test(`compiled action resolves ${scenario.name}`, () => {
      const output = path.join(
        directory,
        `${scenario.name.replaceAll(' ', '-')}-output`
      );
      writeFileSync(output, '');
      const result = spawnSync(process.execPath, [bundle], {
        encoding: 'utf8',
        env: {
          ...process.env,
          INPUT_CONFIG: JSON.stringify(pipeline),
          INPUT_BRANCH: scenario.branch,
          GITHUB_EVENT_NAME:
            scenario.name === 'push branch' ? 'push' : 'pull_request',
          GITHUB_EVENT_PATH: openEvent,
          GITHUB_BASE_REF: scenario.base,
          GITHUB_REF_NAME: scenario.ref,
          GITHUB_OUTPUT: output
        }
      });

      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const outputs = readOutputs(output);
      assert.equal(outputs.branch, scenario.expected);
      assert.equal(outputs['matched-branch'], scenario.matched);
      assert.deepEqual(JSON.parse(outputs.config), pipeline);
      assert.equal(
        outputs['validation-enabled'],
        scenario.matched ? 'true' : 'false'
      );
      assert.equal(outputs['deployment-enabled'], 'false');
      const validationMatrix = JSON.parse(outputs['validation-matrix']);
      const deploymentMatrix = JSON.parse(outputs['deployment-matrix']);

      if (scenario.matched === 'main') {
        assert.deepEqual(
          validationMatrix.include.map((entry: { org: string }) => entry.org),
          ['qa', 'uat']
        );
        assert.equal(validationMatrix.include[0].mode, 'delta');
        assert.equal(validationMatrix.include[0].baseRef, 'origin/main');
        assert.equal(
          JSON.parse(outputs['branch-config']).validation.baseRef,
          'origin/main'
        );
      } else if (scenario.matched === 'develop') {
        assert.equal(validationMatrix.include[0].baseRef, 'origin/develop');
      } else if (scenario.matched === 'feature/**') {
        assert.equal(validationMatrix.include[0].baseRef, 'origin/main');
      } else if (!scenario.matched) {
        assert.deepEqual(validationMatrix, { include: [] });
        assert.deepEqual(deploymentMatrix, { include: [] });
      }

      assert.deepEqual(deploymentMatrix, { include: [] });

      assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
    });
  }

  for (const merged of [true, false]) {
    await context.test(
      `closed PR merged=${merged} controls deployment plans`,
      () => {
        const output = path.join(directory, `closed-${merged}-output`);
        const event = path.join(directory, `closed-${merged}-event.json`);
        writeFileSync(output, '');
        writeFileSync(
          event,
          JSON.stringify({
            action: 'closed',
            pull_request: {
              merged,
              number: 42,
              merge_commit_sha: mergedPullRequest.mergeCommitSha,
              base: { ref: 'main' }
            }
          })
        );
        const result = spawnSync(process.execPath, [bundle], {
          encoding: 'utf8',
          env: {
            ...process.env,
            INPUT_CONFIG: JSON.stringify(pipeline),
            INPUT_BRANCH: '',
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: event,
            GITHUB_BASE_REF: 'main',
            GITHUB_REF_NAME: 'main',
            GITHUB_OUTPUT: output
          }
        });

        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const outputs = readOutputs(output);
        assert.equal(outputs['deployment-enabled'], String(merged));
        const matrix = JSON.parse(outputs['deployment-matrix']);

        if (merged) {
          assert.equal(
            matrix.include[0].baseRef,
            mergedPullRequest.mergeCommitSha + '^1'
          );
          assert.equal(
            matrix.include[0].headRef,
            mergedPullRequest.mergeCommitSha
          );
          assert.equal(matrix.include[0].pullRequest, 42);
        } else {
          assert.deepEqual(matrix, { include: [] });
        }

        assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
      }
    );
  }

  const invalidInputs = [
    { name: 'missing variable', input: '', message: /Input required.*config/ },
    {
      name: 'malformed JSON',
      input: `{"value":"${marker}"`,
      message: /must contain valid JSON/
    },
    { name: 'non-object JSON', input: '[]', message: /must be a JSON object/ },
    {
      name: 'invalid branch schema',
      input: JSON.stringify({ version: 2, branches: {} }),
      message: /Invalid branch configuration/
    }
  ];

  for (const { name, input, message } of invalidInputs) {
    await context.test(`${name} fails without producing config output`, () => {
      const output = path.join(
        directory,
        `${name.replaceAll(' ', '-')}-output`
      );
      writeFileSync(output, '');
      const result = spawnSync(process.execPath, [bundle], {
        encoding: 'utf8',
        env: {
          ...process.env,
          INPUT_CONFIG: input,
          INPUT_BRANCH: 'main',
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: '',
          GITHUB_OUTPUT: output
        }
      });

      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(readFileSync(output, 'utf8'), '');
      const logs = `${result.stdout}${result.stderr}`;
      assert.match(logs, message);
      assert.ok(!logs.includes(marker));
    });
  }
});
