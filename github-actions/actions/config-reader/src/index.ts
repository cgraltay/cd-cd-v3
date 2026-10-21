import * as core from '@actions/core';
import { readFileSync } from 'node:fs';
import { loadOrgsConfig } from '../../../shared/orgs';
import { readConfig, readMergedPullRequest, resolveConfig } from './config';

function mergedPullRequestContext() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    return undefined;
  }

  let payload: string;

  try {
    payload = readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8');
  } catch {
    throw new Error('Unable to read the pull request event payload.');
  }

  return readMergedPullRequest(payload);
}

try {
  const config = readConfig(core.getInput('config', { required: true }));
  const orgsConfig = loadOrgsConfig(
    core.getInput('orgs-config'),
    core.getInput('orgs-config-path')
  );
  const mergedPullRequest = mergedPullRequestContext();
  const branch =
    core.getInput('branch') ||
    mergedPullRequest?.targetBranch ||
    process.env.GITHUB_BASE_REF ||
    process.env.GITHUB_REF_NAME ||
    '';
  const plan = resolveConfig(
    config,
    branch,
    mergedPullRequest?.targetBranch || process.env.GITHUB_BASE_REF || branch,
    mergedPullRequest,
    orgsConfig
  );

  core.setOutput('config', JSON.stringify(config));
  core.setOutput('orgs-config', orgsConfig ? JSON.stringify(orgsConfig) : '');
  core.setOutput('branch', plan.branch);
  core.setOutput('matched-branch', plan.matchedBranch ?? '');
  core.setOutput('branch-config', JSON.stringify(plan.branchConfig));
  core.setOutput('validation-enabled', plan.validationEnabled);
  core.setOutput('deployment-enabled', plan.deploymentEnabled);
  core.setOutput('validation-matrix', JSON.stringify(plan.validationMatrix));
  core.setOutput('deployment-matrix', JSON.stringify(plan.deploymentMatrix));
  core.info('Configuration loaded successfully.');
} catch (error) {
  core.setFailed(
    error instanceof Error ? error.message : 'Unable to read configuration.'
  );
}
