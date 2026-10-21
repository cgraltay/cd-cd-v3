import * as core from '@actions/core';
import { createHash } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readConfig } from '../../config-reader/src/config';
import { readOrgsConfig } from '../../../shared/orgs';
import { githubHistory, shaSchema, type ReleaseEntry } from './history';
import {
  environmentOrg,
  recordReference,
  releasePlan,
  type ReleaseOperation
} from './plan';
import { selectSourceRange, type SourceSelection } from './source';
import { runRelease } from './run';

const operationSchema = z.enum([
  'validate',
  'deploy',
  'quick-deploy',
  'reconcile'
]);
const selectionSchema = z.enum([
  'full-branch',
  'commit-range',
  'branch-changes'
]);
const rangeSchema = z
  .object({
    selection: selectionSchema,
    branchSha: shaSchema,
    headSha: shaSchema,
    baseSha: shaSchema.optional(),
    startSha: shaSchema.optional(),
    comparisonSha: shaSchema.optional()
  })
  .strict();
const preparedSchema = z
  .object({
    branch: z.string().min(1),
    environment: z.string().min(1),
    operation: operationSchema,
    range: rangeSchema,
    comparisonBranch: z.string().optional(),
    recordId: z.number().int().positive().safe().optional(),
    recordKind: z.enum(['validation', 'deployment']).optional()
  })
  .strict();

function display(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export async function runReleaseAction(
  fixed: {
    selection?: SourceSelection;
    operation?: ReleaseOperation;
    prepare?: boolean;
  } = {}
): Promise<void> {
  let reference = '';
  let deploymentId = '';
  try {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
      throw new Error('Releases require a manually dispatched workflow.');
    const operation =
      fixed.operation ??
      operationSchema.parse(core.getInput('operation') || 'validate');
    if (fixed.selection && !['validate', 'deploy'].includes(operation))
      throw new Error(
        'Source-selection actions support only validate or deploy.'
      );
    if (
      ['quick-deploy', 'reconcile'].includes(operation) &&
      core.getInput('selection')
    )
      throw new Error(
        'Saved-job utilities do not accept a new source selection.'
      );
    const config = readConfig(core.getInput('config', { required: true }));
    const orgs = readOrgsConfig(
      core.getInput('orgs-config', { required: true })
    );
    const environment = core.getInput('environment', { required: true });
    const org = environmentOrg(orgs, environment);
    const workspace = realpathSync(
      path.resolve(
        process.env.GITHUB_WORKSPACE ?? process.cwd(),
        core.getInput('working-directory') || '.'
      )
    );
    const { getOctokit, context } = await import('@actions/github');
    const client = getOctokit(
      core.getInput('github-token', { required: true })
    );
    const logUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
    const history = githubHistory(client, context.repo, org, logUrl);
    const prepareOnly =
      fixed.prepare ??
      (core.getInput('prepare-only')
        ? core.getBooleanInput('prepare-only')
        : false);
    if (prepareOnly) {
      let branch = core.getInput('source-branch');
      let prepared: z.infer<typeof preparedSchema>;
      let saved: ReleaseEntry | undefined;
      if (operation === 'quick-deploy' || operation === 'reconcile') {
        const selected = recordReference(
          core.getInput('release-record-id', { required: true }),
          operation
        );
        saved = await history.get(selected.recordId, selected.recordKind);
        if (
          saved.receipt.environment !== environment ||
          (operation === 'quick-deploy' && saved.state !== 'success')
        ) {
          throw new Error(
            'Select a successful validation for this environment, or an existing job to reconcile.'
          );
        }
        branch = saved.receipt.branch;
        prepared = {
          branch,
          environment,
          operation,
          ...selected,
          range: {
            selection:
              saved.receipt.selection ??
              (saved.receipt.settings.mode === 'full'
                ? 'full-branch'
                : 'commit-range'),
            headSha: saved.receipt.headSha,
            branchSha: saved.receipt.branchSha ?? saved.receipt.headSha,
            baseSha: saved.receipt.baseSha,
            startSha: saved.receipt.startSha,
            comparisonSha: saved.receipt.comparisonSha
          }
        };
      } else {
        if (!branch) throw new Error('A source branch is required.');
        if (core.getInput('release-record-id') || core.getInput('to-sha'))
          throw new Error(
            'Source selection does not accept saved records or a separate target commit.'
          );
        const selection =
          fixed.selection ?? selectionSchema.parse(core.getInput('selection'));
        const tip = await client.rest.repos.getBranch({
          ...context.repo,
          branch
        });
        const comparisonBranch = core.getInput('comparison-branch');
        if ((selection === 'branch-changes') !== Boolean(comparisonBranch))
          throw new Error('Only Branch Changes requires a comparison branch.');
        const comparison = comparisonBranch
          ? await client.rest.repos.getBranch({
              ...context.repo,
              branch: comparisonBranch
            })
          : undefined;
        const range = selectSourceRange(
          workspace,
          selection,
          tip.data.commit.sha,
          {
            startSha: core.getInput('start-commit') || undefined,
            endSha: core.getInput('end-commit') || undefined,
            comparisonSha: comparison?.data.commit.sha
          }
        );
        prepared = {
          branch,
          environment,
          operation,
          range,
          ...(comparisonBranch ? { comparisonBranch } : {})
        };
      }
      preparedSchema.parse(prepared);
      const plan = releasePlan(
        config,
        orgs,
        branch,
        environment,
        saved?.receipt.settings.mode ??
          (prepared.range.selection === 'full-branch' ? 'full' : 'delta')
      );
      core.setOutput('config', JSON.stringify(config));
      core.setOutput('orgs-config', JSON.stringify(orgs));
      core.setOutput('profile', JSON.stringify({ org, ...plan.profile }));
      core.setOutput('plan', JSON.stringify(prepared));
      core.setOutput('head-sha', prepared.range.headSha);
      core.setOutput('branch-sha', prepared.range.branchSha);
      await core.summary
        .addHeading('Release plan')
        .addTable([
          [
            { data: 'Branch', header: true },
            { data: 'Commit', header: true },
            { data: 'Environment', header: true },
            { data: 'Selection', header: true },
            { data: 'Operation', header: true }
          ],
          [
            display(branch),
            prepared.range.headSha,
            display(environment),
            prepared.range.selection,
            operation
          ]
        ])
        .addRaw(
          'Pinned inputs only. No credentials were used and no Salesforce operation was submitted. History does not select the payload.'
        )
        .write();
      return;
    }

    const prepared = preparedSchema.parse(
      JSON.parse(core.getInput('plan', { required: true }))
    );
    if (
      prepared.operation !== operation ||
      prepared.environment !== environment ||
      (fixed.selection && fixed.selection !== prepared.range.selection)
    ) {
      throw new Error(
        'The prepared plan does not match this action, operation, and environment.'
      );
    }
    const plan = releasePlan(
      config,
      orgs,
      prepared.branch,
      environment,
      prepared.range.selection === 'full-branch' ? 'full' : 'delta'
    );
    const username = core.getInput('username');
    const clientId = core.getInput('client-id');
    const jwtPrivateKey = core.getInput('jwt-private-key', {
      trimWhitespace: false
    });
    for (const secret of [username, clientId, jwtPrivateKey])
      if (secret) core.setSecret(secret);
    const artifactName =
      'release-' + createHash('sha256').update(org).digest('hex').slice(0, 12);
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
      headSha: prepared.range.headSha,
      branchSha: prepared.range.branchSha,
      range: prepared.range,
      recordId: prepared.recordId,
      recordKind: prepared.recordKind,
      onAuditWarning: core.warning,
      onRecord(entry) {
        reference = entry.id
          ? `${entry.kind ?? (entry.receipt.operation === 'validate' ? 'validation' : 'deployment')}:${entry.id}`
          : '';
        deploymentId = entry.jobId ?? '';
        core.setOutput('release-record-id', reference);
        core.setOutput('deployment-id', deploymentId);
        core.info(
          `Saved reference: ${reference || '(audit unavailable)'}; Salesforce job ID: ${deploymentId || '(not submitted yet)'}`
        );
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
      .addHeading('Release result')
      .addTable([
        [
          { data: 'Branch', header: true },
          { data: 'Commit', header: true },
          { data: 'Operation', header: true },
          { data: 'Result', header: true },
          { data: 'Saved reference', header: true },
          { data: 'Salesforce job ID', header: true }
        ],
        [
          display(prepared.branch),
          prepared.range.headSha,
          operation,
          result.outcome,
          reference,
          deploymentId
        ]
      ])
      .addRaw(
        operation === 'validate'
          ? 'Validation only. No actual deployment record was created.'
          : 'Recorded for audit only. No future payload or commit range is chosen from this history.'
      )
      .write();
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : 'Release failed.');
    try {
      await core.summary
        .addHeading('Release failed')
        .addTable([
          [
            { data: 'Saved reference', header: true },
            { data: 'Salesforce job ID', header: true }
          ],
          [reference, deploymentId]
        ])
        .addRaw(
          'Inspect the sanitized report. A timeout is not success; report the existing job before submitting another operation.'
        )
        .write();
    } catch {
      core.warning('Unable to write the release summary.');
    }
  }
}
