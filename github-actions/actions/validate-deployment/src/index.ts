import * as core from '@actions/core';
import path from 'node:path';
import { loadOrgsConfig, orgConnection } from '../../../shared/orgs';
import { readConfig, resolveConfig } from '../../config-reader/src/config';
import { publishValidationComment, validationCommentKey } from './comment';
import { validateSources } from './run';
import { validationSettingsSchema } from './validation';

async function run(): Promise<void> {
  try {
    const config = readConfig(core.getInput('config', { required: true }));
    const org = core.getInput('org', { required: true });
    const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const orgsPath = core.getInput('orgs-config-path');
    const orgs = loadOrgsConfig(
      core.getInput('orgs-config'),
      orgsPath ? path.resolve(root, orgsPath) : undefined
    );
    if (!orgs)
      throw new Error(
        'Org profile configuration is required for deployment validation.'
      );
    const { context, getOctokit } = await import('@actions/github');
    const pullRequest = context.payload.pull_request;
    if (!pullRequest?.number || !pullRequest.base?.ref)
      throw new Error('Deployment validation requires a pull request event.');
    if (
      context.eventName !== 'pull_request' ||
      pullRequest.head?.repo?.full_name !==
        `${context.repo.owner}/${context.repo.repo}`
    ) {
      throw new Error(
        'Authenticated validation is restricted to same-repository pull_request events; fork PRs and pull_request_target are not supported.'
      );
    }
    if (context.payload.action === 'closed')
      throw new Error(
        'Deployment validation must run before the PR is closed.'
      );
    const plan = resolveConfig(
      config,
      pullRequest.base.ref,
      pullRequest.base.ref,
      undefined,
      orgs
    );
    const entry = plan.validationMatrix.include.find(
      (candidate) => candidate.org === org
    );
    if (!entry)
      throw new Error(
        'This org is not enabled for validation on the PR target branch.'
      );
    const profile = orgConnection(orgs, org);
    if (
      process.env.GITHUB_ENVIRONMENT &&
      process.env.GITHUB_ENVIRONMENT !== profile.environment
    ) {
      throw new Error(
        'The validation job environment does not match its org profile.'
      );
    }
    const settings = validationSettingsSchema.parse(entry);
    const token =
      core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    const username = core.getInput('username');
    const clientId = core.getInput('client-id');
    const jwtPrivateKey = core.getInput('jwt-private-key', {
      trimWhitespace: false
    });
    for (const secret of [token, username, clientId, jwtPrivateKey])
      if (secret) core.setSecret(secret);
    if (!token)
      throw new Error(
        'A GitHub token is required for PR files and validation feedback.'
      );
    const client = getOctokit(token);
    const files =
      settings.mode === 'delta'
        ? await client.paginate(client.rest.pulls.listFiles, {
            ...context.repo,
            pull_number: pullRequest.number,
            per_page: 100
          })
        : [];
    const result = await validateSources({
      org,
      profile,
      settings,
      files,
      workspace: path.resolve(root, core.getInput('working-directory') || '.'),
      username,
      clientId,
      jwtPrivateKey
    });
    core.setOutput('outcome', result.outcome);
    core.setOutput('deployment-id', result.report.result?.id ?? '');
    core.setOutput('report-path', result.reportPath);
    core.setOutput('artifact-name', validationCommentKey(org));
    core.setOutput('sources-count', result.sourcePaths.length);
    try {
      const runUrl = context.runId
        ? `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`
        : undefined;
      await publishValidationComment(
        client,
        { ...context.repo, number: pullRequest.number },
        {
          org,
          environment: profile.environment,
          testLevel: settings.testLevel,
          sources: settings.sourceDirs,
          sourceCount: result.sourcePaths.length,
          result,
          runUrl
        }
      );
    } catch {
      core.warning(
        'Unable to publish validation feedback. Grant pull-requests: write; the validation result is unchanged.'
      );
    }
    if (result.outcome === 'Failed')
      core.setFailed(
        'Salesforce deployment dry run failed. See the per-org PR comment and JSON report.'
      );
    else
      core.info(
        `Salesforce deployment dry run ${result.outcome.toLowerCase()}.`
      );
  } catch (error) {
    core.setFailed(
      error instanceof Error
        ? error.message
        : 'Unable to validate the Salesforce deployment.'
    );
  }
}

void run();
