import * as core from '@actions/core';
import { branchNamePolicySchema } from '../../../shared/branch-name';
import { readConfig, resolveConfig } from '../../config-reader/src/config';
import { checkBranchName, type BranchNameResult } from './check';
import { upsertBranchNameComment } from './comment';

async function commentOnRejection(
  config: Record<string, unknown>,
  result: BranchNameResult
): Promise<void> {
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';

  if (!token) {
    core.warning(
      'PR feedback was not posted because no GitHub token was provided. The branch-name check remains failed.'
    );
    return;
  }

  core.setSecret(token);

  try {
    const { context, getOctokit } = await import('@actions/github');
    const number = context.payload.pull_request?.number;

    if (!Number.isInteger(number) || !number || number < 1) {
      core.warning(
        'PR feedback was not posted because pull request context is unavailable. The branch-name check remains failed.'
      );
      return;
    }

    const policy = branchNamePolicySchema.parse(
      resolveConfig(config, result.targetBranch).branchConfig.branchName
    );

    await upsertBranchNameComment(
      getOctokit(token),
      { ...context.repo, number },
      result,
      policy.allowedSourcePatterns
    );
  } catch {
    core.warning(
      'Unable to post PR feedback. Grant pull-requests: write; fork PR tokens may be read-only. The branch-name check remains failed.'
    );
  }
}

async function run(): Promise<void> {
  try {
    const config = readConfig(core.getInput('config', { required: true }));
    const sourceBranch =
      core.getInput('source-branch') || process.env.GITHUB_HEAD_REF || '';
    const targetBranch =
      core.getInput('target-branch') || process.env.GITHUB_BASE_REF || '';
    const result = await checkBranchName(config, sourceBranch, targetBranch);

    core.setOutput('checked', result.checked);
    core.setOutput('valid', result.valid);
    core.setOutput('source-branch', result.sourceBranch);
    core.setOutput('target-branch', result.targetBranch);
    core.setOutput('matched-branch', result.matchedBranch);
    core.setOutput('matched-pattern', result.matchedPattern ?? '');

    if (!result.valid) {
      core.setFailed(
        'The PR source branch does not match the allowed patterns for its target branch.'
      );
      await commentOnRejection(config, result);
    } else if (result.checked) {
      core.info('PR branch name accepted.');
    } else {
      core.info(
        'Branch name checking is disabled for the matched target rule.'
      );
    }
  } catch (error) {
    core.setFailed(
      error instanceof Error
        ? error.message
        : 'Unable to check the PR branch name.'
    );
  }
}

void run();
