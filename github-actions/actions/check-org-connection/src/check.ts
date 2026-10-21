import { z } from 'zod';
import { withJwtOrg, type JwtOptions } from '../../../shared/jwt';
import { orgConnection, type OrgsConfig } from '../../../shared/orgs';

export function connectionMatrix(config: OrgsConfig, selectedOrg: string) {
  const selection = selectedOrg.trim();
  const names = selection ? [selection] : Object.keys(config.orgs);
  if (names.length === 0 || names.length > 256) {
    throw new Error(
      'Select between one and 256 configured orgs for a connection check.'
    );
  }
  return {
    include: names.map((org) => ({ org, ...orgConnection(config, org) }))
  };
}

export async function checkOrgConnection(
  options: JwtOptions
): Promise<{ orgId: string }> {
  return withJwtOrg(options, async ({ alias, run }) => {
    const response = await run([
      'data',
      'query',
      '--query',
      'SELECT Id FROM Organization LIMIT 1',
      '--target-org',
      alias,
      '--json'
    ]);
    if (response.exitCode !== 0) {
      throw new Error(
        'JWT login completed, but the Salesforce API connection check failed. Check API access and org availability.'
      );
    }
    try {
      const report = z
        .object({
          status: z.literal(0),
          result: z.object({
            done: z.literal(true),
            totalSize: z.literal(1),
            records: z
              .array(
                z.object({
                  Id: z
                    .string()
                    .regex(/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/)
                })
              )
              .length(1)
          })
        })
        .parse(JSON.parse(response.stdout));
      return { orgId: report.result.records[0].Id };
    } catch {
      throw new Error(
        'The Salesforce API connection check did not return a valid organization result.'
      );
    }
  });
}
