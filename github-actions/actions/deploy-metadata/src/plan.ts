import { resolveConfig } from '../../config-reader/src/config';
import { orgConnection, type OrgsConfig } from '../../../shared/orgs';
import { validationSettingsSchema } from '../../validate-deployment/src/validation';

export type ReleaseOperation =
  'validate' | 'deploy' | 'quick-deploy' | 'reconcile';

export function environmentOrg(orgs: OrgsConfig, environment: string): string {
  const selected = Object.keys(orgs.orgs).filter(
    (org) => orgs.orgs[org].environment === environment
  );
  if (selected.length !== 1)
    throw new Error(
      'The selected GitHub environment must map to exactly one org profile.'
    );
  return selected[0];
}

export function recordReference(value: string, operation: ReleaseOperation) {
  const match = /^(validation|deployment):([1-9][0-9]*)$/.exec(value);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[2])) ||
    (operation === 'quick-deploy' && match[1] !== 'validation')
  ) {
    throw new Error(
      'Use a saved reference such as validation:123 or deployment:456. Quick Deploy requires a validation reference.'
    );
  }
  return {
    recordKind: match[1] as 'validation' | 'deployment',
    recordId: Number(match[2])
  };
}

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
  const org = environmentOrg(orgs, environment);
  const plan = resolveConfig(config, branch);
  const deployment = plan.branchConfig.deployment as
    Record<string, unknown> | undefined;
  if (
    !plan.matchedBranch ||
    !deployment ||
    deployment.enabled !== true ||
    !Array.isArray(deployment.orgs) ||
    !deployment.orgs.includes(org)
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
    org,
    profile: orgConnection(orgs, org),
    branch,
    environment,
    settings
  };
}
