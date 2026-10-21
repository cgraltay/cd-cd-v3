import { resolveConfig } from '../../config-reader/src/config';
import { orgConnection, type OrgsConfig } from '../../../shared/orgs';
import { validationSettingsSchema } from '../../validate-deployment/src/validation';
import { shaSchema, type ReleaseEntry } from './history';

export type ReleaseOperation =
  'validate' | 'deploy' | 'quick-deploy' | 'reconcile';

export function releasePlan(
  config: Record<string, unknown>,
  orgs: OrgsConfig,
  branch: string,
  environment: string,
  mode: string
) {
  if (!branch.trim() || !environment.trim()) {
    throw new Error('A target branch and GitHub environment are required.');
  }
  const selected = Object.keys(orgs.orgs).filter(
    (org) => orgs.orgs[org].environment === environment
  );
  if (selected.length !== 1) {
    throw new Error(
      'The selected GitHub environment must map to exactly one org profile.'
    );
  }
  const plan = resolveConfig(config, branch);
  const deployment = plan.branchConfig.deployment as
    Record<string, unknown> | undefined;
  if (
    !plan.matchedBranch ||
    !deployment ||
    deployment.enabled !== true ||
    !Array.isArray(deployment.orgs) ||
    !deployment.orgs.includes(selected[0])
  ) {
    throw new Error(
      'Deployment is not enabled for this branch and selected environment/org.'
    );
  }
  const settings = validationSettingsSchema.parse({
    ...deployment,
    mode: mode === 'configured' ? deployment.mode : mode
  });
  return {
    org: selected[0],
    profile: orgConnection(orgs, selected[0]),
    branch,
    environment,
    settings
  };
}

export function releaseTarget(
  plan: ReturnType<typeof releasePlan>,
  operation: ReleaseOperation,
  branchSha: string,
  toSha: string,
  entries: ReleaseEntry[],
  recordId?: number
) {
  shaSchema.parse(branchSha);
  if (operation === 'quick-deploy' || operation === 'reconcile') {
    const entry = entries.find((candidate) => candidate.id === recordId);
    if (
      !entry ||
      entry.receipt.branch !== plan.branch ||
      entry.receipt.environment !== plan.environment ||
      (operation === 'quick-deploy' &&
        (entry.receipt.operation !== 'validate' || entry.state !== 'success'))
    ) {
      throw new Error(
        'Select a matching recorded validation/release for this source branch and environment.'
      );
    }
    if (toSha && toSha !== entry.receipt.headSha)
      throw new Error('The selected commit differs from the saved release.');
    return { headSha: entry.receipt.headSha, branchSha };
  }
  if (recordId)
    throw new Error(
      'Release record ID is only used for Quick Deploy or reconciliation.'
    );
  return { headSha: shaSchema.parse(toSha || branchSha), branchSha };
}
