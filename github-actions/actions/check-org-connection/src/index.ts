import * as core from '@actions/core';
import { orgConnection, readOrgsConfig } from '../../../shared/orgs';
import { checkOrgConnection, connectionMatrix } from './check';

function display(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function run(): Promise<void> {
  let org = '';
  let environment = '';
  let prepared = false;
  try {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
      throw new Error(
        'Org connection checks are restricted to manually dispatched workflows.'
      );
    }
    const config = readOrgsConfig(
      core.getInput('orgs-config', { required: true })
    );
    org = core.getInput('org');
    const prepareOnly = core.getBooleanInput('prepare-only');
    if (!prepareOnly && !org)
      throw new Error(
        'A single org profile key is required for connection checking.'
      );
    const matrix = connectionMatrix(config, org);
    core.setOutput('matrix', JSON.stringify(matrix));
    core.setOutput('orgs-config', JSON.stringify(config));
    if (prepareOnly) {
      prepared = true;
      await core.summary
        .addHeading('Org connection check plan')
        .addTable([
          [
            { data: 'Org', header: true },
            { data: 'Environment', header: true }
          ],
          ...matrix.include.map((row) => [
            display(row.org),
            display(row.environment)
          ])
        ])
        .addRaw(
          'Preparation only: no credentials or Salesforce commands were used.'
        )
        .write();
      core.info(`Prepared ${matrix.include.length} org connection check(s).`);
      return;
    }

    core.setOutput('connected', false);
    core.setOutput('org-id', '');
    const profile = orgConnection(config, org);
    environment = profile.environment;
    const username = core.getInput('username');
    const clientId = core.getInput('client-id');
    const jwtPrivateKey = core.getInput('jwt-private-key', {
      trimWhitespace: false
    });
    for (const secret of [username, clientId, jwtPrivateKey])
      if (secret) core.setSecret(secret);
    const result = await checkOrgConnection({
      profile,
      workspace: process.cwd(),
      username,
      clientId,
      jwtPrivateKey
    });
    core.setOutput('connected', true);
    core.setOutput('org-id', result.orgId);
    await core.summary
      .addHeading('Salesforce org connection')
      .addTable([
        [
          { data: 'Org', header: true },
          { data: 'Environment', header: true },
          { data: 'Result', header: true },
          { data: 'Org ID', header: true }
        ],
        [display(org), display(environment), 'Connected', result.orgId]
      ])
      .addRaw(
        'JWT authentication and a read-only API request succeeded. No metadata was changed.'
      )
      .write();
    core.info(
      'Salesforce JWT authentication and API connection check succeeded.'
    );
  } catch (error) {
    if (!prepared) {
      core.setOutput('connected', false);
      core.setOutput('org-id', '');
    }
    core.setFailed(
      error instanceof Error
        ? error.message
        : 'Unable to check the Salesforce org connection.'
    );
    try {
      await core.summary
        .addHeading('Salesforce org connection failed')
        .addTable([
          [
            { data: 'Org', header: true },
            { data: 'Environment', header: true },
            { data: 'Result', header: true }
          ],
          [
            display(org || '(not selected)'),
            display(environment || '(not resolved)'),
            'Failed'
          ]
        ])
        .addRaw(
          'Check the step error, environment secrets, OAuth app approval/certificate, and Salesforce API access. Raw authentication/API responses are not published.'
        )
        .write();
    } catch {
      core.warning(
        'Unable to write the connection check summary. The check remains failed.'
      );
    }
  }
}

void run();
