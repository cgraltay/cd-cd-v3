import { readFileSync } from 'node:fs';
import { z } from 'zod';

const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const orgProfileSchema = z
  .object({
    environment: z.string().trim().min(1),
    auth: z.literal('jwt'),
    instanceUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.pathname === '/' || url.pathname === '')
        );
      }),
    usernameSecret: secretName,
    clientIdSecret: secretName,
    jwtKeySecret: secretName
  })
  .strict();

const orgsConfigSchema = z
  .object({
    version: z.literal(1),
    orgs: z.record(z.string().trim().min(1), orgProfileSchema)
  })
  .strict();

export type OrgsConfig = z.infer<typeof orgsConfigSchema>;

export function readOrgsConfig(input: string): OrgsConfig {
  try {
    return orgsConfigSchema.parse(JSON.parse(input));
  } catch {
    throw new Error(
      'Invalid orgs configuration. Use version 1, JWT profiles with HTTPS instance URLs, environments, and GitHub secret names only; do not store credentials or private keys in this JSON.'
    );
  }
}

export function loadOrgsConfig(
  input: string,
  filePath?: string
): OrgsConfig | undefined {
  if (input.trim()) {
    return readOrgsConfig(input);
  }
  if (!filePath?.trim()) {
    return undefined;
  }
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error('Unable to read the orgs configuration file.');
  }
  return readOrgsConfig(contents);
}

export function orgConnection(config: OrgsConfig, org: string) {
  if (!Object.hasOwn(config.orgs, org)) {
    throw new Error('A selected org is missing from the orgs configuration.');
  }
  return config.orgs[org];
}
