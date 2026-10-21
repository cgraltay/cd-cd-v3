import { minimatch } from 'minimatch';
import { z } from 'zod';
import { branchNamePolicySchema } from '../../../shared/branch-name';
import { prTitlePolicySchema } from '../../../shared/pr-title';
import { codeAnalyzerPolicySchema } from '../../../shared/code-analyzer';
import { orgConnection, type OrgsConfig } from '../../../shared/orgs';

const nonEmptyString = z.string().trim().min(1);

const operationSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['full', 'delta']).default('full'),
    orgs: z.array(nonEmptyString).max(256).default([]),
    sourceDirs: z.array(nonEmptyString).min(1).default(['force-app']),
    baseRef: nonEmptyString.optional(),
    headRef: nonEmptyString.default('HEAD'),
    testLevel: z
      .enum([
        'RunRelevantTests',
        'RunLocalTests',
        'RunAllTestsInOrg',
        'RunSpecifiedTests'
      ])
      .optional(),
    tests: z.array(nonEmptyString).min(1).optional(),
    waitMinutes: z.number().int().min(1).max(1440).optional()
  })
  .passthrough()
  .superRefine((operation, context) => {
    if (operation.enabled && operation.orgs.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enabled operations need at least one org.'
      });
    }

    if (
      new Set(operation.orgs.map((org) => org.toLowerCase())).size !==
      operation.orgs.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Org environment names must be unique within an operation.'
      });
    }
    if (
      operation.enabled &&
      operation.testLevel === 'RunSpecifiedTests' &&
      !operation.tests?.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'RunSpecifiedTests requires test names.'
      });
    }
  });

const branchSchema = z
  .object({
    branchName: branchNamePolicySchema.optional(),
    prTitle: prTitlePolicySchema.optional(),
    codeAnalyzer: codeAnalyzerPolicySchema.optional(),
    validation: operationSchema.optional(),
    deployment: operationSchema.optional()
  })
  .passthrough();

const pipelineSchema = z
  .object({
    version: z.literal(1),
    branches: z.record(nonEmptyString, branchSchema)
  })
  .passthrough();

type Operation = z.infer<typeof operationSchema>;

export interface MatrixEntry {
  org: string;
  mode: Operation['mode'];
  sourceDirs: string[];
  baseRef?: string;
  headRef: string;
  pullRequest?: number;
  environment?: string;
  instanceUrl?: string;
  usernameSecret?: string;
  clientIdSecret?: string;
  jwtKeySecret?: string;
  testLevel?: Operation['testLevel'];
  tests?: string[];
  waitMinutes?: number;
}

export interface MergedPullRequest {
  number: number;
  mergeCommitSha: string;
  targetBranch: string;
}

export function readMergedPullRequest(
  input: string
): MergedPullRequest | undefined {
  let event: unknown;

  try {
    event = JSON.parse(input);
  } catch {
    throw new Error('The pull request event must contain valid JSON.');
  }

  const mergedEvent = z.object({
    action: z.literal('closed'),
    pull_request: z.object({ merged: z.literal(true) })
  });

  if (!mergedEvent.safeParse(event).success) {
    return undefined;
  }

  const parsed = z
    .object({
      pull_request: z.object({
        number: z.number().int().positive(),
        merge_commit_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
        base: z.object({ ref: nonEmptyString })
      })
    })
    .safeParse(event);

  if (!parsed.success) {
    throw new Error(
      'A merged PR event needs a PR number, target branch, and merge commit SHA.'
    );
  }

  return {
    number: parsed.data.pull_request.number,
    mergeCommitSha: parsed.data.pull_request.merge_commit_sha,
    targetBranch: parsed.data.pull_request.base.ref
  };
}

export interface PipelinePlan {
  branch: string;
  matchedBranch: string | null;
  branchConfig: Record<string, unknown>;
  validationEnabled: boolean;
  deploymentEnabled: boolean;
  validationMatrix: { include: MatrixEntry[] };
  deploymentMatrix: { include: MatrixEntry[] };
}

function operationMatrix(operation: Operation | undefined): MatrixEntry[] {
  if (!operation?.enabled) {
    return [];
  }

  return operation.orgs.map((org) => ({
    org,
    mode: operation.mode,
    sourceDirs: operation.sourceDirs,
    ...(operation.baseRef ? { baseRef: operation.baseRef } : {}),
    headRef: operation.headRef,
    ...(operation.testLevel ? { testLevel: operation.testLevel } : {}),
    ...(operation.tests ? { tests: operation.tests } : {}),
    ...(operation.waitMinutes ? { waitMinutes: operation.waitMinutes } : {})
  }));
}

export function resolveConfig(
  config: Record<string, unknown>,
  branch: string,
  targetBranch = branch,
  mergedPullRequest?: MergedPullRequest,
  orgsConfig?: OrgsConfig
): PipelinePlan {
  const emptyPlan: PipelinePlan = {
    branch,
    matchedBranch: null,
    branchConfig: {},
    validationEnabled: false,
    deploymentEnabled: false,
    validationMatrix: { include: [] },
    deploymentMatrix: { include: [] }
  };

  if (!Object.hasOwn(config, 'branches')) {
    return emptyPlan;
  }

  if (branch.trim().length === 0) {
    throw new Error(
      'A branch input is required for branch-based configuration.'
    );
  }

  const parsed = pipelineSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(
      'Invalid branch configuration. Require version 1, valid enabled flags, valid regex patterns for enabled branch name and PR title checks, valid codeAnalyzer settings, full/delta modes, unique orgs, and sourceDirs.'
    );
  }

  const { branches } = parsed.data;
  const matchedBranch = Object.hasOwn(branches, branch)
    ? branch
    : Object.keys(branches).find((pattern) =>
        minimatch(branch, pattern, {
          dot: true,
          nonegate: true,
          nocomment: true
        })
      );

  if (matchedBranch === undefined) {
    return emptyPlan;
  }

  const branchConfig = branches[matchedBranch];
  const validationConfig = branchConfig.validation;

  if (
    validationConfig?.enabled &&
    validationConfig.mode === 'delta' &&
    !validationConfig.baseRef
  ) {
    branchConfig.validation = {
      ...validationConfig,
      baseRef: `origin/${targetBranch.trim() || branch}`
    };
  }

  if (branchConfig.deployment?.enabled && mergedPullRequest) {
    branchConfig.deployment = {
      ...branchConfig.deployment,
      baseRef: mergedPullRequest.mergeCommitSha + '^1',
      headRef: mergedPullRequest.mergeCommitSha
    };
  }

  const validation = operationMatrix(branchConfig.validation);
  const deployment = mergedPullRequest
    ? operationMatrix(branchConfig.deployment).map((entry) => ({
        ...entry,
        pullRequest: mergedPullRequest.number
      }))
    : [];

  const withConnection = (entry: MatrixEntry) =>
    orgsConfig ? { ...entry, ...orgConnection(orgsConfig, entry.org) } : entry;

  return {
    branch,
    matchedBranch,
    branchConfig,
    validationEnabled: validation.length > 0,
    deploymentEnabled: deployment.length > 0,
    validationMatrix: { include: validation.map(withConnection) },
    deploymentMatrix: { include: deployment.map(withConnection) }
  };
}

export function readConfig(input: string): Record<string, unknown> {
  if (input.trim().length === 0) {
    throw new Error('The config input is required and must not be empty.');
  }

  let config: unknown;

  try {
    config = JSON.parse(input);
  } catch {
    throw new Error('The config input must contain valid JSON.');
  }

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The config input must be a JSON object.');
  }

  return config as Record<string, unknown>;
}
