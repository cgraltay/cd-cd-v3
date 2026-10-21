import { createPrivateKey, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OrgsConfig } from './orgs';

export interface SalesforceCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SalesforceExecutor = (
  args: string[],
  options: { cwd: string; env: Record<string, string> }
) => Promise<SalesforceCliResult>;

export interface JwtOptions {
  profile: OrgsConfig['orgs'][string];
  workspace: string;
  username: string;
  clientId: string;
  jwtPrivateKey: string;
  tempDirectory?: string;
  execute?: SalesforceExecutor;
}

const execute: SalesforceExecutor = async (args, options) => {
  const { getExecOutput } = await import('@actions/exec');
  try {
    return await getExecOutput('sf', args, {
      ...options,
      silent: true,
      ignoreReturnCode: true
    });
  } catch {
    throw new Error(
      'Unable to execute Salesforce CLI. Ensure sf is installed and available.'
    );
  }
};

export async function withJwtOrg<Result>(
  options: JwtOptions,
  operation: (session: {
    alias: string;
    run: (args: string[]) => Promise<SalesforceCliResult>;
  }) => Promise<Result>
): Promise<Result> {
  if (!options.username || !options.clientId || !options.jwtPrivateKey) {
    throw new Error(
      'JWT authentication requires username, client ID, and private key secret inputs.'
    );
  }
  try {
    const key = createPrivateKey(options.jwtPrivateKey);
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error('Invalid RSA key');
    }
  } catch {
    throw new Error(
      'The JWT private key must be an unencrypted RSA PEM key of at least 2048 bits.'
    );
  }

  const temp = options.tempDirectory ?? process.env.RUNNER_TEMP ?? tmpdir();
  const authDirectory = mkdtempSync(path.join(temp, 'sf-jwt-auth-'));
  const alias = 'ci-org-' + randomUUID();
  const keyFile = path.join(authDirectory, 'jwt.key');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        !name.startsWith('INPUT_') &&
        !name.startsWith('SF_') &&
        !name.startsWith('SFDX_') &&
        ![
          'GITHUB_TOKEN',
          'GH_TOKEN',
          'ACTIONS_RUNTIME_TOKEN',
          'ACTIONS_ID_TOKEN_REQUEST_TOKEN'
        ].includes(name)
    )
  ) as Record<string, string>;
  Object.assign(env, {
    HOME: authDirectory,
    USERPROFILE: authDirectory,
    XDG_CONFIG_HOME: path.join(authDirectory, 'config'),
    XDG_DATA_HOME: path.join(authDirectory, 'data'),
    XDG_CACHE_HOME: path.join(authDirectory, 'cache'),
    SF_USE_GENERIC_UNIX_KEYCHAIN: 'true',
    SF_LOG_LEVEL: 'fatal'
  });
  const runner = options.execute ?? execute;
  const run = (args: string[]) => runner(args, { cwd: options.workspace, env });
  try {
    writeFileSync(keyFile, options.jwtPrivateKey, { mode: 0o600 });
    const login = await run([
      'org',
      'login',
      'jwt',
      '--username',
      options.username,
      '--client-id',
      options.clientId,
      '--jwt-key-file',
      keyFile,
      '--instance-url',
      options.profile.instanceUrl,
      '--alias',
      alias,
      '--json'
    ]);
    if (login.exitCode !== 0) {
      throw new Error(
        'Salesforce JWT authentication failed. Check the integration user, app approval, certificate, and login URL.'
      );
    }
    return await operation({ alias, run });
  } finally {
    rmSync(authDirectory, { recursive: true, force: true });
  }
}
