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
  jobIdSchema,
  savedValidation,
  type ReleaseEntry,
  type ReleaseHistory,
  type Receipt
} from './history';
import type { ReleaseOperation, releasePlan } from './plan';
import {
  assertAncestor,
  releaseSources,
  selectSourceRange,
  type SourceRange
} from './source';
import { verifyOrgApi } from '../../../shared/org-api';

export interface ReleaseOptions extends JwtOptions {
  plan: ReturnType<typeof releasePlan>;
  operation: ReleaseOperation;
  history: ReleaseHistory;
  headSha: string;
  branchSha: string;
  range?: SourceRange;
  recordId?: number;
  recordKind?: 'validation' | 'deployment';
  onAuditWarning?: (message: string) => void;
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
    const plan = options.plan;
    const auditStatus = async (
      entry: ReleaseEntry,
      state: 'in_progress' | 'success' | 'failure'
    ) => {
      if (!entry.id) return;
      try {
        await options.history.status(entry, state);
      } catch {
        options.onAuditWarning?.(
          'Unable to update the audit record. Salesforce outcome and submitted job ID remain authoritative.'
        );
      }
    };
    const selectedRecord = async (kind: 'validation' | 'deployment') => {
      if (!options.recordId)
        throw new Error('A saved validation/deployment reference is required.');
      const entry = await options.history.get(options.recordId, kind);
      if (
        entry.receipt.orgId !== orgId ||
        entry.receipt.org !== plan.org ||
        entry.receipt.environment !== plan.environment ||
        entry.receipt.branch !== plan.branch ||
        entry.receipt.headSha !== options.headSha
      ) {
        throw new Error(
          'Saved release identity does not match the authenticated org, environment, branch, and commit.'
        );
      }
      return entry;
    };
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
        await auditStatus(entry, 'success');
        return { outcome: 'Succeeded' as const, entry };
      }
      if (result.failed) {
        await auditStatus(entry, 'failure');
        throw new Error(
          'Salesforce deployment/validation failed or was canceled. See the sanitized report.'
        );
      }
      throw new Error(
        'Salesforce has not confirmed complete success. Reconcile this release record; do not resubmit it.'
      );
    };

    if (options.operation === 'reconcile') {
      const entry = await selectedRecord(options.recordKind ?? 'deployment');
      return finish(entry);
    }

    let receipt: Receipt;
    let args: string[];
    if (options.operation === 'quick-deploy') {
      const selected = await selectedRecord('validation');
      const validation = savedValidation([selected], selected.id);
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
      const requested =
        options.range ??
        selectSourceRange(options.workspace, 'full-branch', options.branchSha);
      const range = selectSourceRange(
        options.workspace,
        requested.selection,
        options.branchSha,
        {
          startSha: requested.startSha,
          endSha:
            requested.selection === 'commit-range'
              ? requested.headSha
              : undefined,
          comparisonSha: requested.comparisonSha
        }
      );
      if (
        range.headSha !== options.headSha ||
        plan.settings.mode !==
          (range.selection === 'full-branch' ? 'full' : 'delta')
      ) {
        throw new Error(
          'Pinned source selection does not match the release payload mode and commit.'
        );
      }
      const payload = releaseSources(
        options.workspace,
        options.headSha,
        options.branchSha,
        plan.settings,
        range.baseSha,
        range.selection === 'commit-range' && !range.baseSha
      );
      if (!payload.sources.length) return { outcome: 'Skipped' };
      receipt = {
        schema: 1,
        kind: 'sf-metadata-release',
        org: plan.org,
        orgId,
        environment: plan.environment,
        branch: plan.branch,
        ...range,
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

    let entry: ReleaseEntry;
    try {
      entry = await options.history.create(receipt);
    } catch {
      options.onAuditWarning?.(
        'Unable to create the audit record. Continuing with the explicitly selected payload; preserve the Salesforce job ID/report for recovery.'
      );
      entry = {
        id: 0,
        kind: receipt.operation === 'validate' ? 'validation' : 'deployment',
        receipt,
        state: 'in_progress'
      };
    }
    options.onRecord?.(entry);
    await auditStatus(entry, 'in_progress');
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
        await auditStatus(entry, 'failure');
        return { outcome: 'Skipped', entry };
      }
      if (
        response.exitCode !== 0 &&
        ['INVALID_OPERATION', 'INVALID_ID_FIELD'].includes(
          String(submitted.name)
        )
      ) {
        await auditStatus(entry, 'failure');
        throw new Error(
          'Salesforce rejected the request. Quick Deploy eligibility is not guaranteed; choose a normal Deploy explicitly if appropriate.'
        );
      }
      throw new Error(
        'Salesforce did not return a deployment job ID. Submission is unresolved; inspect the org before retrying.'
      );
    }
    entry.jobId = result.data.id;
    await auditStatus(entry, 'in_progress');
    return finish(entry);
  });
}
