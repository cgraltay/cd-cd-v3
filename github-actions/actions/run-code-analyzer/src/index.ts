import * as core from '@actions/core';
import path from 'node:path';
import { codeAnalyzerPolicySchema } from '../../../shared/code-analyzer';
import { readConfig, resolveConfig } from '../../config-reader/src/config';
import { analyzePullRequest } from './run';

async function run(): Promise<void> {
  try {
    const config = readConfig(core.getInput('config', { required: true }));
    const { context, getOctokit } = await import('@actions/github');
    const pullRequest = context.payload.pull_request;
    if (
      !pullRequest?.number ||
      !pullRequest.base?.ref ||
      !pullRequest.head?.sha
    ) {
      throw new Error(
        'The Code Analyzer action requires a pull request event with target branch and head commit.'
      );
    }
    const plan = resolveConfig(config, pullRequest.base.ref);
    if (!plan.matchedBranch) {
      throw new Error('No branch rule matches the PR target branch.');
    }
    const policy = codeAnalyzerPolicySchema.parse(
      plan.branchConfig.codeAnalyzer ?? {}
    );
    if (!policy.enabled) {
      core.setOutput('skipped', true);
      core.setOutput('files-analyzed', 0);
      core.setOutput('violations', 0);
      core.setOutput('blocking-violations', 0);
      core.setOutput('inline-comments', 0);
      core.setOutput('report-path', '');
      core.info('Salesforce Code Analyzer is disabled for the PR target.');
      return;
    }
    const token =
      core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    if (!token) {
      throw new Error('A GitHub token is required to list changed PR files.');
    }
    core.setSecret(token);
    const result = await analyzePullRequest({
      client: getOctokit(token),
      ...context.repo,
      number: pullRequest.number,
      headSha: pullRequest.head.sha,
      workspace: path.resolve(
        process.env.GITHUB_WORKSPACE ?? process.cwd(),
        core.getInput('working-directory') || '.'
      ),
      policy,
      warn: (message) => core.warning(message)
    });
    core.setOutput('skipped', result.skipped);
    core.setOutput('files-analyzed', result.filesAnalyzed);
    core.setOutput('violations', result.violations);
    core.setOutput('blocking-violations', result.blockingViolations);
    core.setOutput('inline-comments', result.inlineComments);
    core.setOutput('report-path', result.reportPath);
    if (result.blockingViolations > 0) {
      core.setFailed(
        `Salesforce Code Analyzer found ${result.blockingViolations} blocking violation(s).`
      );
    }
  } catch (error) {
    core.setFailed(
      error instanceof Error
        ? error.message
        : 'Unable to run Salesforce Code Analyzer.'
    );
  }
}

void run();
