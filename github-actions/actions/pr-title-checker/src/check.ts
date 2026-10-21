import { prTitlePolicySchema } from '../../../shared/pr-title';
import { matchFullRegex } from '../../../shared/regex';
import { resolveConfig } from '../../config-reader/src/config';

export interface TitleCheckResult {
  checked: boolean;
  valid: boolean;
  title: string;
  targetBranch: string;
  matchedBranch: string;
  matchedPattern: string | null;
}

export async function checkPullRequestTitle(
  config: Record<string, unknown>,
  title: string,
  targetBranch: string
): Promise<TitleCheckResult> {
  if (!title.trim() || !targetBranch.trim()) {
    throw new Error('PR title and target branch are required.');
  }
  if (title.length > 1024) {
    throw new Error('PR titles must not exceed 1024 characters.');
  }

  const plan = resolveConfig(config, targetBranch);
  if (plan.matchedBranch === null) {
    throw new Error('No branch rule matches the PR target branch.');
  }

  const policy = prTitlePolicySchema
    .optional()
    .parse(plan.branchConfig.prTitle);
  const result: TitleCheckResult = {
    checked: false,
    valid: true,
    title,
    targetBranch,
    matchedBranch: plan.matchedBranch,
    matchedPattern: null
  };
  if (!policy?.enabled) {
    return result;
  }

  const matchedPattern = await matchFullRegex(
    policy.allowedPatterns,
    title,
    'PR title'
  );
  return {
    ...result,
    checked: true,
    valid: matchedPattern !== undefined,
    matchedPattern: matchedPattern ?? null
  };
}
