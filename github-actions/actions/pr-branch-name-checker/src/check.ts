import { branchNamePolicySchema } from '../../../shared/branch-name';
import { matchFullRegex } from '../../../shared/regex';
import { resolveConfig } from '../../config-reader/src/config';

export interface BranchNameResult {
  checked: boolean;
  valid: boolean;
  sourceBranch: string;
  targetBranch: string;
  matchedBranch: string;
  matchedPattern: string | null;
}

export async function checkBranchName(
  config: Record<string, unknown>,
  sourceBranch: string,
  targetBranch: string
): Promise<BranchNameResult> {
  if (!sourceBranch.trim() || !targetBranch.trim()) {
    throw new Error('PR source and target branch names are required.');
  }

  if (sourceBranch.length > 1024) {
    throw new Error('PR source branch names must not exceed 1024 characters.');
  }

  const plan = resolveConfig(config, targetBranch);

  if (plan.matchedBranch === null) {
    throw new Error('No branch rule matches the PR target branch.');
  }

  const policy = branchNamePolicySchema
    .optional()
    .parse(plan.branchConfig.branchName);
  const result: BranchNameResult = {
    checked: false,
    valid: true,
    sourceBranch,
    targetBranch,
    matchedBranch: plan.matchedBranch,
    matchedPattern: null
  };

  if (!policy?.enabled) {
    return result;
  }

  const matchedPattern = await matchFullRegex(
    policy.allowedSourcePatterns,
    sourceBranch,
    'Branch name'
  );

  return {
    ...result,
    checked: true,
    valid: matchedPattern !== undefined,
    matchedPattern: matchedPattern ?? null
  };
}
