import { z } from 'zod';
import type { SalesforceCliResult } from './jwt';

export async function verifyOrgApi(session: {
  alias: string;
  run: (args: string[]) => Promise<SalesforceCliResult>;
}): Promise<{ orgId: string }> {
  const identity = await session.run([
    'org',
    'display',
    '--target-org',
    session.alias,
    '--json'
  ]);
  let orgId: string;
  try {
    if (identity.exitCode !== 0) throw new Error('Identity failed');
    const report = z
      .object({
        status: z.literal(0),
        result: z.object({
          id: z.string().regex(/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/)
        })
      })
      .parse(JSON.parse(identity.stdout));
    orgId = report.result.id;
  } catch {
    throw new Error(
      'The Salesforce API connection check could not verify the authenticated org ID.'
    );
  }
  const response = await session.run([
    'api',
    'request',
    'rest',
    '/services/data/v66.0/',
    '--target-org',
    session.alias
  ]);
  try {
    if (response.exitCode !== 0) throw new Error('API request failed');
    z.object({
      query: z.literal('/services/data/v66.0/query'),
      sobjects: z.literal('/services/data/v66.0/sobjects')
    }).parse(JSON.parse(response.stdout));
  } catch {
    throw new Error(
      'JWT login completed, but the Salesforce API connection check failed. Check API access and org availability.'
    );
  }
  return { orgId };
}
