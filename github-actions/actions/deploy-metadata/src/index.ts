import * as core from '@actions/core';
import { createHash } from 'node:crypto';
import { writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readConfig } from '../../config-reader/src/config';
import { readOrgsConfig } from '../../../shared/orgs';
import { githubHistory, shaSchema } from './history';
import { releasePlan, releaseTarget } from './plan';
import { runRelease } from './run';

function display(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function run(): Promise<void> {
  let releaseRecordId = '';
  let deploymentId = '';
  try {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
      throw new Error(
        'Metadata releases require a manually dispatched workflow.'
      );
    const operation = z
      .enum(['validate', 'deploy', 'quick-deploy', 'reconcile'])
      .parse(core.getInput('operation'));
    const config = readConfig(core.getInput('config', { required: true }));
    const orgs = readOrgsConfig(
      core.getInput('orgs-config', { required: true })
    );
    const plan = releasePlan(
      config,
      orgs,
      core.getInput('source-branch', { required: true }),
      core.getInput('environment', { required: true }),
      core.getInput('mode')
    );
    const recordInput = core.getInput('release-record-id');
    const recordId = recordInput
      ? z.coerce.number().int().positive().safe().parse(recordInput)
      : undefined;
    const { getOctokit, context } = await import('@actions/github');
    const client = getOctokit(
      core.getInput('github-token', { required: true })
    );
    const logUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
    const history = githubHistory(client, context.repo, plan.org, logUrl);
    if (core.getBooleanInput('prepare-only')) {
      const branch = await client.rest.repos.getBranch({
        ...context.repo,
        branch: plan.branch
      });
      const entries =
        operation === 'quick-deploy' || operation === 'reconcile'
          ? await history.list()
          : [];
      const target = releaseTarget(
        plan,
        operation,
        branch.data.commit.sha,
        core.getInput('to-sha'),
        entries,
        recordId
      );
      if (target.headSha !== target.branchSha) {
        const comparison = await client.rest.repos.compareCommitsWithBasehead({
          ...context.repo,
          basehead: `${target.headSha}...${target.branchSha}`
        });
        if (!['ahead', 'identical'].includes(comparison.data.status)) {
          throw new Error(
            'The selected commit is not an ancestor of the selected source branch.'
          );
        }
      }
      core.setOutput('config', JSON.stringify(config));
      core.setOutput('orgs-config', JSON.stringify(orgs));
      core.setOutput(
        'profile',
        JSON.stringify({ org: plan.org, ...plan.profile })
      );
      core.setOutput('head-sha', target.headSha);
      core.setOutput('branch-sha', target.branchSha);
      await core.summary
        .addHeading('Manual Salesforce release plan')
        .addTable([
          [
            { data: 'Source branch', header: true },
            { data: 'Pinned commit', header: true },
            { data: 'Environment', header: true },
            { data: 'Operation', header: true }
          ],
          [
            display(plan.branch),
            target.headSha,
            display(plan.environment),
            operation
          ]
        ])
        .addRaw(
          'Preparation only. No Salesforce authentication or metadata operation was performed.'
        )
        .write();
      return;
    }
    const headSha = shaSchema.parse(
      core.getInput('head-sha', { required: true })
    );
    const branchSha = shaSchema.parse(
      core.getInput('branch-sha', { required: true })
    );
    const workspace = realpathSync(
      path.resolve(
        process.env.GITHUB_WORKSPACE ?? process.cwd(),
        core.getInput('working-directory')
      )
    );
    const username = core.getInput('username');
    const clientId = core.getInput('client-id');
    const jwtPrivateKey = core.getInput('jwt-private-key', {
      trimWhitespace: false
    });
    for (const secret of [username, clientId, jwtPrivateKey])
      if (secret) core.setSecret(secret);
    const artifactName =
      'sf-release-' +
      createHash('sha256').update(plan.org).digest('hex').slice(0, 12);
    const reportPath = path.join(
      process.env.RUNNER_TEMP ?? workspace,
      artifactName + '.json'
    );
    core.setOutput('artifact-name', artifactName);
    core.setOutput('outcome', 'Failed');
    const result = await runRelease({
      profile: plan.profile,
      workspace,
      username,
      clientId,
      jwtPrivateKey,
      plan,
      operation,
      history,
      headSha,
      branchSha,
      recordId,
      onRecord(entry) {
        releaseRecordId = String(entry.id);
        deploymentId = entry.jobId ?? '';
        core.info(
          `GitHub release record ID: ${releaseRecordId}; Salesforce job ID: ${deploymentId || '(not recorded yet)'}`
        );
        core.setOutput('release-record-id', entry.id);
        core.setOutput('deployment-id', entry.jobId ?? '');
      },
      onReport(report) {
        writeFileSync(reportPath, JSON.stringify(report, null, 2), {
          mode: 0o600
        });
        core.setOutput('report-path', reportPath);
      }
    });
    core.setOutput('outcome', result.outcome);
    await core.summary
      .addHeading('Manual Salesforce release result')
      .addTable([
        [
          { data: 'Branch', header: true },
          { data: 'Commit', header: true },
          { data: 'Operation', header: true },
          { data: 'Result', header: true },
          { data: 'Release record ID', header: true },
          { data: 'Salesforce job ID', header: true }
        ],
        [
          display(plan.branch),
          headSha,
          operation,
          result.outcome,
          String(result.entry?.id ?? ''),
          result.entry?.jobId ?? ''
        ]
      ])
      .addRaw(
        operation === 'validate'
          ? 'Validation only. The actual deployment baseline was not advanced.'
          : 'Only a completed, successful actual deployment advances the org baseline.'
      )
      .write();
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : 'Salesforce release failed.'
    );
    try {
      await core.summary
        .addHeading('Salesforce release failed')
        .addTable([
          [
            { data: 'Release record ID', header: true },
            { data: 'Salesforce job ID', header: true }
          ],
          [releaseRecordId, deploymentId]
        ])
        .addRaw(
          'Review the step error and available sanitized report. No success is assumed from a timeout. Use the release record ID for reconciliation.'
        )
        .write();
    } catch {
      core.warning('Unable to write the release summary.');
    }
  }
}

void run();
