import { z } from 'zod';
import {
  withJwtOrg,
  type JwtOptions,
  type SalesforceCliResult
} from '../../../shared/jwt';
import {
  dryRunArgs,
  redactReport
} from '../../validate-deployment/src/validation';
import {
  assertSettled,
  baseline,
  jobIdSchema,
  savedValidation,
  type ReleaseEntry,
  type ReleaseHistory,
  type Receipt
} from './history';
import type { ReleaseOperation, releasePlan } from './plan';
import { assertAncestor, releaseSources } from './source';
import { verifyOrgApi } from '../../../shared/org-api';

export interface ReleaseOptions extends JwtOptions {
  plan: ReturnType<typeof releasePlan>;
  operation: ReleaseOperation;
  history: ReleaseHistory;
  headSha: string;
  branchSha: string;
  recordId?: number;
  onRecord?: (entry: ReleaseEntry) => void;
  onReport?: (report: unknown) => void;
}

function json(response: SalesforceCliResult): Record<string, unknown> {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(response.stdout));
  } catch {
    throw new Error(
      'Salesforce returned an invalid JSON response. No deployment success has been recorded.'
    );
  }
}

export function deploymentReport(
  response: SalesforceCliResult,
  jobId: string,
  checkOnly: boolean
) {
  const report = z
    .object({
      status: z.number(),
      result: z
        .object({
          id: jobIdSchema,
          done: z.boolean(),
          checkOnly: z.boolean(),
          success: z.boolean(),
          status: z.string()
        })
        .passthrough()
    })
    .parse(json(response));
  if (report.result.id !== jobId || report.result.checkOnly !== checkOnly) {
    throw new Error(
      'Salesforce report does not match the recorded job and validation/deployment operation.'
    );
  }
  const succeeded =
    response.exitCode === 0 &&
    report.status === 0 &&
    report.result.done &&
    report.result.success &&
    report.result.status === 'Succeeded';
  const failed =
    report.result.done &&
    report.result.success === false &&
    ['Failed', 'Canceled', 'FinalizingDeployFailed'].includes(
      report.result.status
    );
  return { report, succeeded, failed };
}

export async function runRelease(options: ReleaseOptions): Promise<{
  outcome: 'Succeeded' | 'Skipped';
  entry?: ReleaseEntry;
}> {
  return withJwtOrg(options, async ({ alias, run }) => {
    const { orgId } = await verifyOrgApi({ alias, run });
    const entries = await options.history.list();
    const current = baseline(entries, orgId);
    const plan = options.plan;
    const readReport = async (entry: ReleaseEntry) => {
      if (!entry.jobId)
        throw new Error(
          'This release has no recorded Salesforce job ID. Inspect Salesforce and GitHub history manually; do not submit a duplicate.'
        );
      const response = await run([
        'project',
        'deploy',
        'report',
        '--job-id',
        entry.jobId,
        '--target-org',
        alias,
        '--wait',
        String(entry.receipt.settings.waitMinutes),
        '--json'
      ]);
      options.onReport?.(
        redactReport(json(response), [
          options.username,
          options.clientId,
          options.jwtPrivateKey
        ])
      );
      return deploymentReport(
        response,
        entry.jobId,
        entry.receipt.operation === 'validate'
      );
    };
    const finish = async (entry: ReleaseEntry) => {
      options.onRecord?.(entry);
      const result = await readReport(entry);
      if (result.succeeded) {
        await options.history.status(entry, 'success');
        return { outcome: 'Succeeded' as const, entry };
      }
      if (result.failed) {
        await options.history.status(entry, 'failure');
        throw new Error(
          'Salesforce deployment/validation failed or was canceled. See the sanitized report.'
        );
      }
      throw new Error(
        'Salesforce has not confirmed complete success. Reconcile this release record; do not resubmit it.'
      );
    };

    if (options.operation === 'reconcile') {
      const entry = entries.find(
        (candidate) => candidate.id === options.recordId
      );
      if (
        !entry ||
        entry.receipt.branch !== plan.branch ||
        entry.receipt.environment !== plan.environment ||
        entry.receipt.headSha !== options.headSha
      ) {
        throw new Error(
          'Reconciliation requires an existing release record for this branch and pinned commit.'
        );
      }
      assertSettled(entries, entry.id);
      if (
        entry.receipt.operation !== 'validate' &&
        entry.id !== current?.id &&
        entry.receipt.baselineId !== (current?.id ?? null)
      ) {
        throw new Error(
          'A later deployment changed the baseline. This older record cannot advance it.'
        );
      }
      return finish(entry);
    }

    assertSettled(entries);
    let receipt: Receipt;
    let args: string[];
    if (options.operation === 'quick-deploy') {
      const validation = savedValidation(
        entries,
        options.recordId ?? 0,
        current
      );
      if (
        validation.receipt.branch !== plan.branch ||
        validation.receipt.environment !== plan.environment ||
        validation.receipt.headSha !== options.headSha ||
        JSON.stringify(validation.receipt.settings) !==
          JSON.stringify({
            ...plan.settings,
            mode: validation.receipt.settings.mode
          })
      ) {
        throw new Error(
          'Quick Deploy branch, commit, or deployment policy differs from the saved validation.'
        );
      }
      assertAncestor(options.workspace, options.headSha, options.branchSha);
      if (current)
        assertAncestor(
          options.workspace,
          current.receipt.headSha,
          options.headSha
        );
      if (!(await readReport(validation)).succeeded)
        throw new Error(
          'The recorded validation is no longer confirmed successful.'
        );
      receipt = {
        ...validation.receipt,
        operation: 'quick-deploy',
        validationRecordId: validation.id
      };
      args = [
        'project',
        'deploy',
        'quick',
        '--job-id',
        validation.jobId!,
        '--target-org',
        alias,
        '--async',
        '--json'
      ];
    } else {
      if (
        current &&
        plan.settings.mode === 'delta' &&
        JSON.stringify(plan.settings.sourceDirs) !==
          JSON.stringify(current.receipt.settings.sourceDirs)
      ) {
        throw new Error(
          'Configured source directories changed since the baseline. Select full mode.'
        );
      }
      const payload = releaseSources(
        options.workspace,
        options.headSha,
        options.branchSha,
        plan.settings,
        current?.receipt.headSha
      );
      if (!payload.sources.length) return { outcome: 'Skipped' };
      receipt = {
        schema: 1,
        kind: 'sf-metadata-release',
        org: plan.org,
        orgId,
        environment: plan.environment,
        branch: plan.branch,
        headSha: options.headSha,
        baseSha: current?.receipt.headSha,
        baselineId: current?.id ?? null,
        operation: options.operation,
        settings: plan.settings,
        payloadHash: payload.payloadHash
      };
      args = dryRunArgs(plan.settings, payload.sources, alias);
      args.splice(args.indexOf('--wait'), 2);
      if (options.operation === 'deploy')
        args.splice(args.indexOf('--dry-run'), 1);
      args.push('--async');
    }

    const entry = await options.history.create(receipt);
    options.onRecord?.(entry);
    await options.history.status(entry, 'in_progress');
    const response = await run(args);
    const submitted = json(response);
    options.onReport?.(
      redactReport(submitted, [
        options.username,
        options.clientId,
        options.jwtPrivateKey
      ])
    );
    const result = z.object({ id: jobIdSchema }).safeParse(submitted.result);
    if (!result.success) {
      if (
        submitted.name === 'NothingToDeploy' ||
        submitted.code === 'NothingToDeploy'
      ) {
        await options.history.status(entry, 'failure');
        return { outcome: 'Skipped', entry };
      }
      if (
        response.exitCode !== 0 &&
        ['INVALID_OPERATION', 'INVALID_ID_FIELD'].includes(
          String(submitted.name)
        )
      ) {
        await options.history.status(entry, 'failure');
        throw new Error(
          'Salesforce rejected the request. Quick Deploy eligibility is not guaranteed; choose a normal Deploy explicitly if appropriate.'
        );
      }
      throw new Error(
        'Salesforce did not return a deployment job ID. Submission is unresolved; inspect the org before retrying.'
      );
    }
    entry.jobId = result.data.id;
    await options.history.status(entry, 'in_progress');
    return finish(entry);
  });
}
