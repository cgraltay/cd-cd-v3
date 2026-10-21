# Salesforce Org Profiles

Store org profile JSON in the repository variable `SF_ORGS_CONFIG`.
[orgs-connections-config.example.json](orgs-connections-config.example.json)
is the schema example, not runtime configuration. It contains metadata, not credentials.
The branch variable `SF_CICD_CONFIG` chooses which org keys to validate. The
config reader resolves each key to a GitHub environment and secret names, forming
one matrix job per org. For example, `development` and `qa` can validate the same
PR in parallel while using different environment secret values.

## Recommended Authentication

Use Salesforce OAuth JWT bearer authentication with a dedicated integration
user and an approved app. The app can be an existing Connected App or an
External Client App configured for JWT bearer flow, depending on your org's
app-management setup. New-app creation policies can differ by Salesforce release.

JWT avoids persisting a refresh-token auth URL. It still requires protecting
and rotating the signing key. Use a separate app/key/user for production when
appropriate, least-privilege permissions, and approved environments/runners.
GitHub OIDC is not a drop-in replacement for `sf org login jwt`; additional
Salesforce/identity-provider trust configuration would be required.

## Salesforce Setup

1. Create or select a dedicated integration user with API access and the metadata
   permissions needed to validate your project's components and execute tests.
2. Prepare an RSA signing key of at least 2048 bits and its public certificate.
   The action accepts an unencrypted RSA PEM private key. Generate/manage it
   through your approved secret-management process, outside the repository.
3. Configure the OAuth app for JWT bearer authentication, upload only the public
   certificate, and approve the integration user. Record its client/consumer ID.
4. Choose the login URL. Sandbox profiles default to `https://test.salesforce.com`
   and production to `https://login.salesforce.com`. Use the correct My Domain
   URL when required by your org policies.
5. Rotate the private key and app certificate together before certificate expiry.

## GitHub Setup

Under **Settings > Secrets and variables > Actions > Variables**, configure:

| Repository Variable | Contents                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SF_CICD_CONFIG`    | Branch rules and enabled validation org keys.                                                                                                                       |
| `SF_ORGS_CONFIG`    | The `version: 1` / `orgs` JSON shown in [orgs-connections-config.example.json](orgs-connections-config.example.json), adjusted to your environments and login URLs. |

The main workflow passes `${{ vars.SF_ORGS_CONFIG }}` to the config reader's
`orgs-config` input. Its validated `orgs-config` output is captured as a job
output and passed to every validator. All matrix jobs use the same snapshot
even if variables change during a run. Profile metadata and secret-name mapping
changes in the variable need no commit.

Create environments matching each profile's `environment` value. The supplied
profiles use `development`, `qa`, `uat`, and `production`. In every environment,
create these Secrets with that org's values:

| Secret               | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| `SF_USERNAME`        | Integration user's Salesforce username.                  |
| `SF_CLIENT_ID`       | Approved OAuth app client/consumer ID.                   |
| `SF_JWT_PRIVATE_KEY` | Full multiline private-key PEM, including header/footer. |

The same secret names are used in different environments, but the values are
environment-specific. Put the actual values only in Secrets; never in this file,
GitHub variables, matrix rows, comments, logs, or committed source. Do not use
literal `${{ secrets... }}` strings in JSON; workflows resolve secret references.

## Profile Contract

| Field            | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `environment`    | GitHub environment to bind to the matrix job.                                    |
| `auth`           | Currently `jwt` only.                                                            |
| `instanceUrl`    | HTTPS Salesforce login/My Domain origin without credentials, query, or fragment. |
| `usernameSecret` | Name of the GitHub environment secret containing the username.                   |
| `clientIdSecret` | Name of the environment secret containing the OAuth app ID.                      |
| `jwtKeySecret`   | Name of the environment secret containing the private-key PEM.                   |

Both variable JSON and file input require `version: 1` and an `orgs` object. Unknown profile properties,
including embedded private keys, are rejected. Selected orgs must have profiles.
Treat profiles as trusted configuration: someone who can edit the variable's
login URLs or environment/secret mappings can change authentication routing.
Restrict variable editing and review mapping changes. The main workflow loads
action bundles from the PR source commit; schema validation does not make PR
code trustworthy. Require review before approving org credentials and use
isolated test orgs for action development.

## Optional File Fallback

Both actions accept `orgs-config` JSON and `orgs-config-path`. Nonblank JSON
takes precedence and is validated before any file is read. Invalid JSON fails;
it never silently switches to the file. When JSON is absent/blank, either action
can read an explicitly supplied path. Neither automatically loads an example.
The validator fails if neither input is supplied. The main workflow uses JSON
only and does not require a committed org configuration file. Never store
actual credential values in either format.

## Manually Verify Connections

Run **Actions > Check Salesforce Org Connections > Run workflow** after setting
the profiles and environment Secrets. Select one exact org key or leave the
selection empty to check all configured orgs in parallel. The workflow is
dispatch-only; it does not run on PRs or pushes and performs no deployments.
It verifies JWT login plus a read-only API query and reports the org ID.
See the [connection action guide](../check-org-connection/README.md) for details.

## Operational Safety

Use GitHub-hosted or ephemeral runners. The action creates a private key file
with `0600` permissions in a restricted temporary directory, isolates CLI auth
state, avoids setting a default org, and removes the key/state on normal success
and caught failures. Force-terminated self-hosted jobs still require runner/temp
cleanup controls. Report artifacts exclude login responses and redact known
credential values and token fields.

Protect sensitive environments with approvals and deployment-branch rules.
Do not expose credentials to fork PRs or unreviewed code. A dry run still executes
Apex tests in the selected org, so treat validation as a privileged operation.
Use non-production orgs with appropriate data isolation for untrusted changes.

See the [validation action guide](../validate-deployment/README.md) and
the [parallel workflow](CONFIGURATION.md) for wiring.
