# Check Salesforce Org Connection

Manually verify the configured JWT credentials can authenticate and make a
read-only Salesforce API request. The action does not deploy metadata, run
Apex tests, change org configuration, or create PR comments. It requires a
`workflow_dispatch` event and fails if called by a PR or push workflow.

## Run the Manual Workflow

The executable workflow is
[check-org-connections.yml](../../../.github/workflows/check-org-connections.yml),
named **Check Salesforce Org Connections**.

1. Push the workflow and built action files to the repository. The workflow
   must be on the default branch for GitHub to expose its Run workflow button.
2. Configure repository variable `SF_ORGS_CONFIG` and the mapped GitHub
   environment Secrets using [org setup](../config-reader/ORG_CONNECTIONS.md).
3. Open **Actions > Check Salesforce Org Connections > Run workflow**.
4. Select a reviewed workflow branch/ref. Enter an exact org profile key, such
   as `qa`, or leave it empty to check every configured org.
5. Approve protected environment jobs if required, then inspect each org's job
   result and summary. The successful summary includes the Salesforce org ID.

No `SF_CICD_CONFIG` branch policy is needed. Preparation reads and validates
only `SF_ORGS_CONFIG`, snapshots it, and emits a credential-free matrix. It does
not need secrets or Salesforce CLI. Each checking job binds `matrix.environment`
before resolving its own username, client ID, and private-key Secrets. All org
jobs use the same snapshot; `fail-fast: false` lets others finish if one fails.
Selection is limited to 1-256 configured profiles. Empty configurations and
unknown org selections fail before authentication.

The workflow requests only `contents: read` on GitHub and has no automatic
triggers. Each checking job installs Node.js 24 and the unversioned
`@salesforce/cli` package. No Java, Code Analyzer plugin, Salesforce project,
or deployment payload is needed. The action itself does not install tooling.

## What Is Verified

The checking phase:

1. Validates that all JWT inputs exist and the PEM is an unencrypted RSA private
   key with at least 2048 bits.
2. Creates a private temporary CLI home and a key file with `0600` permissions.
3. Runs `sf org login jwt` with a unique alias without setting a default org.
4. Runs `sf data query --query "SELECT Id FROM Organization LIMIT 1"` through
   the authenticated alias and requires a successful complete JSON result.
5. Exposes only connection success and the returned organization ID.
6. Removes local key and auth state in cleanup, including on login/query errors.

This tests both authentication and live API access; it does not merely read a
cached org-display response. The integration user must be allowed to query
Organization. It does not prove permission to deploy every metadata type or
that Apex tests will pass. Compare the displayed org ID with the intended org
when diagnosing accidental environment/credential routing errors.

Raw login/query output, access tokens, username values, client IDs, and private
keys are not included in summaries or artifacts. CLI errors are sanitized.
Inherited action inputs and GitHub/Salesforce auth variables are removed from
the CLI environment. The shared JWT implementation is also used by deployment
validation, so authentication/cleanup behavior is consistent.

## Security

Manual dispatch does not make the selected code automatically trusted. Running
an action from a modified branch gives that code access to the supplied secrets.
Choose reviewed refs, restrict workflow/variable editing, and protect sensitive
environments with required reviewers and branch rules. Use separate integration
users/apps/keys and least-privilege permissions as appropriate.

Keep private-key values only in environment Secrets. Config JSON contains login
URLs, environment names, and secret names, never actual credentials. Prefer
ephemeral runners; forced termination on a self-hosted runner still needs
runner/temp cleanup controls. Local logout/cleanup does not revoke the OAuth
app certificate or change the integration user's configuration.

## Action Inputs and Outputs

| Kind           | Name              | Contract                                                                                                        |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Required input | `orgs-config`     | Credential-free profile JSON, usually `${{ vars.SF_ORGS_CONFIG }}` or the preparation snapshot.                 |
| Optional input | `org`             | Exact profile key; empty allowed only in preparation to select all.                                             |
| Optional input | `prepare-only`    | Boolean string, default `false`. `true` builds a matrix without authenticating.                                 |
| Checking input | `username`        | The environment's username Secret.                                                                              |
| Checking input | `client-id`       | The environment's OAuth app client ID Secret.                                                                   |
| Checking input | `jwt-private-key` | The environment's full multiline private-key PEM Secret.                                                        |
| Output         | `matrix`          | Validated include matrix with org/environment/login metadata and secret names only.                             |
| Output         | `orgs-config`     | Captured validated profile JSON for downstream checking jobs.                                                   |
| Output         | `connected`       | String `true` after authentication and API success; `false` on a failed check. Unset in successful preparation. |
| Output         | `org-id`          | Returned Salesforce organization ID, empty on check failure. Unset in successful preparation.                   |

Each success/failure is recorded in the GitHub job summary without raw API
responses. A preparation failure prevents checking jobs from running. Normal
unit/integration tests use mock responses and a fake CLI and contact no orgs.
