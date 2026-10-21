import * as core from '@actions/core';
import { prTitlePolicySchema } from '../../../shared/pr-title';
import { readConfig, resolveConfig } from '../../config-reader/src/config';
import { checkPullRequestTitle } from './check';
import { syncTitleComment } from './comment';

async function run(): Promise<void> {
  try {
    const config = readConfig(core.getInput('config', { required: true }));
    const { context, getOctokit } = await import('@actions/github');
    const title =
      core.getInput('title', { trimWhitespace: false }) ||
      context.payload.pull_request?.title ||
      '';
    const targetBranch =
      core.getInput('target-branch') ||
      context.payload.pull_request?.base?.ref ||
      process.env.GITHUB_BASE_REF ||
      '';
    const result = await checkPullRequestTitle(config, title, targetBranch);

    core.setOutput('checked', result.checked);
    core.setOutput('valid', result.valid);
    core.setOutput('title', result.title);
    core.setOutput('target-branch', result.targetBranch);
    core.setOutput('matched-branch', result.matchedBranch);
    core.setOutput('matched-pattern', result.matchedPattern ?? '');

    if (!result.checked) {
      core.info('PR title checking is disabled for the matched target rule.');
      return;
    }
    if (result.valid) {
      core.info('PR title accepted.');
    } else {
      core.setFailed(
        'The PR title does not match the allowed patterns for its target branch.'
      );
    }

    const token =
      core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    if (!token) {
      core.warning(
        'PR title feedback was not synchronized because no GitHub token was provided. The title check result is unchanged.'
      );
      return;
    }
    core.setSecret(token);

    const number = context.payload.pull_request?.number;
    if (!Number.isInteger(number) || !number || number < 1) {
      core.warning(
        'PR title feedback was not synchronized because PR context is unavailable. The title check result is unchanged.'
      );
      return;
    }

    try {
      const policy = prTitlePolicySchema.parse(
        resolveConfig(config, targetBranch).branchConfig.prTitle
      );
      await syncTitleComment(
        getOctokit(token),
        { ...context.repo, number },
        result,
        policy.allowedPatterns
      );
    } catch {
      core.warning(
        'Unable to create, update, or delete PR title feedback. Grant pull-requests: write; fork PR tokens may be read-only. The title check result is unchanged.'
      );
    }
  } catch (error) {
    core.setFailed(
      error instanceof Error ? error.message : 'Unable to check the PR title.'
    );
  }
}

void run();
