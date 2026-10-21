import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OrgsConfig } from '../../../shared/orgs';
import {
  withJwtOrg,
  type SalesforceCliResult,
  type SalesforceExecutor
} from '../../../shared/jwt';
import {
  dryRunArgs,
  parseDryRun,
  redactReport,
  sourcePaths,
  type ChangedFile,
  type DryRunResult,
  type ValidationSettings
} from './validation';

export type CliResult = SalesforceCliResult;
interface ValidationOptions {
  org: string;
  profile: OrgsConfig['orgs'][string];
  settings: ValidationSettings;
  files: ChangedFile[];
  workspace: string;
  username: string;
  clientId: string;
  jwtPrivateKey: string;
  tempDirectory?: string;
  execute?: SalesforceExecutor;
}

export async function validateSources(
  options: ValidationOptions
): Promise<DryRunResult & { reportPath: string; sourcePaths: string[] }> {
  const workspace = realpathSync(options.workspace);
  let project: unknown;
  try {
    project = JSON.parse(
      readFileSync(path.join(workspace, 'sfdx-project.json'), 'utf8')
    );
  } catch {
    throw new Error(
      'Unable to read a valid sfdx-project.json from the validation workspace.'
    );
  }
  const sources = sourcePaths(options.settings, project, options.files);
  if (sources.length === 0) {
    return {
      outcome: 'Skipped',
      exitCode: 0,
      reportPath: '',
      sourcePaths: [],
      report: {
        name: 'NothingToDeploy',
        message:
          'No non-deleted PR files matched the configured package directories.'
      }
    };
  }
  for (const source of sources) {
    const resolved = realpathSync(path.resolve(workspace, source));
    if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
      throw new Error(
        'Validation source symlinks must not escape the project.'
      );
    }
  }
  const temp = options.tempDirectory ?? process.env.RUNNER_TEMP ?? tmpdir();
  return withJwtOrg({ ...options, workspace }, async ({ alias, run }) => {
    const response = await run(dryRunArgs(options.settings, sources, alias));
    const parsed = parseDryRun(response.stdout, response.exitCode);
    const report = redactReport(parsed.report, [
      options.jwtPrivateKey,
      options.username,
      options.clientId
    ]) as DryRunResult['report'];
    const resultDirectory = mkdtempSync(
      path.join(temp, 'sf-validation-report-')
    );
    const reportPath = path.join(resultDirectory, 'validation-result.json');
    writeFileSync(
      reportPath,
      JSON.stringify(
        { ...report, outcome: parsed.outcome, exitCode: parsed.exitCode },
        null,
        2
      ),
      { mode: 0o600 }
    );
    return { ...parsed, report, reportPath, sourcePaths: sources };
  });
}
