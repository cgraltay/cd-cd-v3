import type { getOctokit } from '@actions/github';
import { z } from 'zod';
import { validationSettingsSchema } from '../../validate-deployment/src/validation';

export const releaseTask = 'sf-metadata-release-v1';
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const jobIdSchema = z
  .string()
  .regex(/^0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/);
export const receiptSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('sf-metadata-release'),
    org: z.string().min(1),
    orgId: z.string().regex(/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/),
    environment: z.string().min(1),
    branch: z.string().min(1),
    headSha: shaSchema,
    baseSha: shaSchema.optional(),
    baselineId: z.number().int().positive().nullable().optional(),
    selection: z
      .enum(['full-branch', 'commit-range', 'branch-changes'])
      .optional(),
    branchSha: shaSchema.optional(),
    startSha: shaSchema.optional(),
    comparisonSha: shaSchema.optional(),
    comparisonBranch: z.string().optional(),
    operation: z.enum(['validate', 'deploy', 'quick-deploy']),
    settings: validationSettingsSchema,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    validationRecordId: z.number().int().positive().optional()
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;
export interface ReleaseEntry {
  id: number;
  kind?: 'validation' | 'deployment';
  receipt: Receipt;
  state: string;
  jobId?: string;
}
export interface ReleaseHistory {
  list(): Promise<ReleaseEntry[]>;
  get(id: number, kind: 'validation' | 'deployment'): Promise<ReleaseEntry>;
  create(receipt: Receipt): Promise<ReleaseEntry>;
  status(
    entry: ReleaseEntry,
    state: 'in_progress' | 'success' | 'failure'
  ): Promise<void>;
}

export function savedValidation(
  entries: ReleaseEntry[],
  id: number
): ReleaseEntry {
  const entry = entries.find((candidate) => candidate.id === id);
  if (
    !entry ||
    entry.receipt.operation !== 'validate' ||
    entry.state !== 'success' ||
    !entry.jobId
  ) {
    throw new Error(
      'Quick Deploy requires a successful recorded validation with a Salesforce job ID.'
    );
  }
  return entry;
}

export function githubHistory(
  client: ReturnType<typeof getOctokit>,
  repo: { owner: string; repo: string },
  org: string,
  logUrl: string
): ReleaseHistory {
  return {
    async get(id, kind) {
      if (kind === 'validation') {
        const { data } = await client.rest.checks.get({
          ...repo,
          check_run_id: id
        });
        const receipt = receiptSchema.parse(JSON.parse(data.output.text ?? ''));
        if (
          data.name !== 'Release validation' ||
          receipt.org !== org ||
          receipt.headSha !== data.head_sha ||
          receipt.operation !== 'validate'
        ) {
          throw new Error(
            'The validation record does not belong to this org and commit.'
          );
        }
        return {
          id,
          kind,
          receipt,
          state:
            data.status === 'completed'
              ? data.conclusion === 'success'
                ? 'success'
                : 'failure'
              : 'in_progress',
          jobId: data.external_id?.startsWith('sf-job:')
            ? jobIdSchema.parse(data.external_id.slice(7))
            : undefined
        };
      }
      const { data } = await client.rest.repos.getDeployment({
        ...repo,
        deployment_id: id
      });
      const receipt = receiptSchema.parse(
        typeof data.payload === 'string'
          ? JSON.parse(data.payload)
          : data.payload
      );
      if (
        data.task !== releaseTask ||
        receipt.org !== org ||
        receipt.headSha !== data.sha ||
        receipt.environment !== data.environment
      ) {
        throw new Error(
          'The deployment record does not belong to this org, environment, and commit.'
        );
      }
      const statuses = await client.paginate(
        client.rest.repos.listDeploymentStatuses,
        { ...repo, deployment_id: id, per_page: 100 }
      );
      const managed = statuses.filter(
        (status) =>
          status.description === 'Salesforce job ID not yet recorded' ||
          /^sf-job:0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(
            status.description ?? ''
          )
      );
      const jobIds = [
        ...new Set(
          managed
            .map(
              (status) =>
                status.description?.match(
                  /^sf-job:(0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)$/
                )?.[1]
            )
            .filter(Boolean)
        )
      ];
      if (jobIds.length > 1)
        throw new Error('Release history has conflicting Salesforce job IDs.');
      return {
        id,
        kind,
        receipt,
        state: managed[0]?.state ?? 'pending',
        jobId: jobIds[0]
      };
    },
    async list() {
      const deployments = await client.paginate(
        client.rest.repos.listDeployments,
        {
          ...repo,
          task: releaseTask,
          per_page: 100
        }
      );
      const entries: ReleaseEntry[] = [];
      for (const deployment of deployments) {
        if (deployment.task !== releaseTask) continue;
        let payload: unknown = deployment.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            throw new Error('Malformed release history payload.');
          }
        }
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('org' in payload) ||
          payload.org !== org
        )
          continue;
        const receipt = receiptSchema.parse(payload);
        if (
          receipt.headSha !== deployment.sha ||
          receipt.environment !== deployment.environment
        ) {
          throw new Error(
            'Release history commit/environment does not match its receipt.'
          );
        }
        const statuses = await client.paginate(
          client.rest.repos.listDeploymentStatuses,
          {
            ...repo,
            deployment_id: deployment.id,
            per_page: 100
          }
        );
        const managed = statuses.filter(
          (status) =>
            status.description === 'Salesforce job ID not yet recorded' ||
            /^sf-job:0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(
              status.description ?? ''
            )
        );
        const jobIds = [
          ...new Set(
            managed
              .map(
                (status) =>
                  status.description?.match(
                    /^sf-job:(0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)$/
                  )?.[1]
              )
              .filter(Boolean)
          )
        ];
        if (jobIds.length > 1)
          throw new Error(
            'Release history has conflicting Salesforce job IDs.'
          );
        entries.push({
          id: deployment.id,
          receipt,
          state: managed[0]?.state ?? 'pending',
          jobId: jobIds[0]
        });
      }
      return entries;
    },
    async create(receipt) {
      receiptSchema.parse(receipt);
      if (receipt.operation === 'validate') {
        const response = await client.rest.checks.create({
          ...repo,
          name: 'Release validation',
          head_sha: receipt.headSha,
          status: 'in_progress',
          details_url: logUrl,
          output: {
            title: 'Release validation',
            summary: 'Validation only. No metadata deployment was committed.',
            text: JSON.stringify(receipt)
          }
        });
        return {
          id: response.data.id,
          kind: 'validation',
          receipt,
          state: 'in_progress'
        };
      }
      const response = await client.rest.repos.createDeployment({
        ...repo,
        ref: receipt.headSha,
        task: releaseTask,
        environment: receipt.environment,
        auto_merge: false,
        required_contexts: [],
        payload: receipt,
        description: `Salesforce ${receipt.operation}: ${receipt.org}`.slice(
          0,
          140
        ),
        transient_environment: false
      });
      if (!('id' in response.data))
        throw new Error('GitHub did not create a release history record.');
      return {
        id: response.data.id,
        kind: 'deployment',
        receipt,
        state: 'pending'
      };
    },
    async status(entry, state) {
      if (entry.kind === 'validation') {
        await client.rest.checks.update({
          ...repo,
          check_run_id: entry.id,
          status: state === 'in_progress' ? 'in_progress' : 'completed',
          ...(state === 'in_progress' ? {} : { conclusion: state }),
          external_id: entry.jobId
            ? `sf-job:${jobIdSchema.parse(entry.jobId)}`
            : ''
        });
        entry.state = state;
        return;
      }
      await client.rest.repos.createDeploymentStatus({
        ...repo,
        deployment_id: entry.id,
        state,
        auto_inactive: false,
        log_url: logUrl,
        description: entry.jobId
          ? `sf-job:${jobIdSchema.parse(entry.jobId)}`
          : 'Salesforce job ID not yet recorded'
      });
      entry.state = state;
    }
  };
}
