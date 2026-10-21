import { withJwtOrg, type JwtOptions } from '../../../shared/jwt';
import { orgConnection, type OrgsConfig } from '../../../shared/orgs';
import { verifyOrgApi } from '../../../shared/org-api';

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
  return withJwtOrg(options, verifyOrgApi);
}
