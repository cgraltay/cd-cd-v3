# Config Reader

Read Salesforce CI/CD configuration from a GitHub Actions variable containing
JSON. Configuration values live in GitHub settings rather than in a committed
configuration file. Editing the variable changes subsequent workflow runs without
requiring a commit or a new action release.

Branch rules now support independent full/delta validation and deployment modes,
with multiple orgs per operation. See the [configuration guide](CONFIGURATION.md)
for the schema, branch matching rules, and a parallel workflow example.

## Set Up the Variable

1. Open your repository on GitHub.
2. Go to **Settings > Secrets and variables > Actions > Variables**.
3. Create a repository variable named `SF_CICD_CONFIG`.
4. Use [ci-cd-config.example.json](ci-cd-config.example.json) as a starting point for the
   variable's JSON value, adjust the modes and org names, and save it.
5. Create repository variable `SF_ORGS_CONFIG` with credential-free profiles
   following [orgs-connections-config.example.json](orgs-connections-config.example.json). Set environment
   names, login URLs, and secret names only; keep actual credentials in Secrets.

Both example files are documentation, not runtime configuration. The action
reads the GitHub variables, so later configuration changes do not require commits.

The variable name is a convention, not a hardcoded requirement. Workflows pass
the variable value explicitly to the action's `config` input. The action does
not call the GitHub API or require a GitHub token.

GitHub variables are not secret storage. Keep SFDX auth URLs, access tokens,
private keys, and passwords in GitHub **Secrets**, not in this configuration.
The action does not print configuration values, but its output is not masked
and must not be used to transport secrets.

## Branch Configuration Example

Use rules for PR target branches: `develop`, `qa`, `uat`, and `main`. A PR
from `feature/x` into `develop` selects `develop`, not the feature branch.
Feature rules are unnecessary unless you also want feature-branch push checks
or explicitly choose source-branch matching.

The [configuration guide](CONFIGURATION.md) contains the complete JSON example,
including per-branch modes, parallel org targets, and the promotion flow.
Branch and org names need not be identical: the example maps `develop` to the
`development` environment and `main` to `production`.

The branch schema is validated. Missing operations are disabled; enabled
operations need org targets. Validation delta defaults to `origin/<PR-target>`.
Optional `branchName` settings are validated and preserved for the separate
[PR branch name checker](../pr-branch-name-checker/README.md), which enforces
allowed source patterns for the PR target.
Optional `prTitle` settings are also validated and preserved for the
[PR title checker](../pr-title-checker/README.md), which manages its own failure
comment and removes it once the title is valid.
Deployment delta uses the merged PR's first-parent commit range automatically,
with no tags or configured baseline. Deployment plans are emitted only on
`pull_request: closed` events where the PR was merged. Org names identify
GitHub environments, not credentials. The reader plans operations only: it does
not generate deltas, authenticate, validate metadata, or deploy to Salesforce.
Legacy JSON objects without `branches` still pass through `config` but do not
schedule operations. Additional fields are preserved, but Salesforce-specific
validation settings such as `testLevel`, `tests`, and `waitMinutes` are validated
and propagated to matrix entries. The
[validation action](../validate-deployment/README.md) executes their dry runs.

Use strict JSON: double-quoted property names and strings, no comments, and no
trailing commas. Expressions such as `${{ secrets.SF_AUTH_URL }}` written inside
a variable value are not recursively evaluated by this action.

## Workflow Usage

When using the action from this repository, check out the repository first:

```yaml
name: Read CI/CD configuration

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  configuration:
    runs-on: ubuntu-latest
    outputs:
      config: ${{ steps.config.outputs.config }}
      orgs-config: ${{ steps.config.outputs.orgs-config }}
    steps:
      - uses: actions/checkout@v5
      - name: Read configuration
        id: config
        uses: ./github-actions/actions/config-reader
        with:
          config: ${{ vars.SF_CICD_CONFIG }}
          orgs-config: ${{ vars.SF_ORGS_CONFIG }}
```

The committed `dist/` bundle must be present; consumers do not need to install
npm packages or compile TypeScript. Once published, another repository can use
`owner/repository/github-actions/actions/config-reader@v1`, replacing the owner,
repository, and tag with real values.

Subsequent steps can access the original object using
`${{ fromJSON(steps.config.outputs.config) }}` and the selected rule using
`${{ fromJSON(steps.config.outputs.branch-config) }}`.
Another job that declares `needs: configuration` can read
`${{ fromJSON(needs.configuration.outputs.config) }}`.

Pass configuration-derived values through action inputs or environment variables
rather than interpolating them directly into shell scripts.

## Environment-Specific Configuration

To keep different values for staging and production, create the same variable
name in each GitHub environment under **Settings > Environments**. Set the
workflow job's `environment` to the appropriate environment. The environment's
variable takes precedence over a repository variable of the same name.

For multi-org jobs, prefer one repository-level branch policy and load the
credential-free org JSON from `vars.SF_ORGS_CONFIG` through `orgs-config`.
The [org profile example](orgs-connections-config.example.json) documents the
format and is never loaded automatically. An explicit `orgs-config-path` input
remains supported for callers that choose their own file.
Matrix jobs use `environment: ${{ matrix.environment }}`.
Each environment supplies the username, app client ID, and JWT private key
through Secrets; the matrix carries only their names. See
[org setup](ORG_CONNECTIONS.md) for authentication requirements.
An environment-level variable only affects jobs referencing that environment;
it does not change config already resolved by the initial configuration job.

## Contract

| Kind           | Name               | Behavior                                                                              |
| -------------- | ------------------ | ------------------------------------------------------------------------------------- |
| Required input | `config`           | A JSON string with an object at its root.                                             |
| Optional input | `orgs-config`      | Credential-free org JSON, typically `${{ vars.SF_ORGS_CONFIG }}`; overrides the file. |
| Optional input | `orgs-config-path` | Fallback credential-free JSON file.                                                   |
| Output         | `config`           | The parsed object serialized as compact JSON.                                         |
| Output         | `orgs-config`      | Validated profile JSON snapshot, or empty if no org input was supplied.               |

Branch-aware outputs are `branch`, `matched-branch`, `branch-config`,
`validation-enabled`, `deployment-enabled`, `validation-matrix`, and
`deployment-matrix`. The [configuration guide](CONFIGURATION.md) documents their
contracts and how to use the matrices safely.

Missing or blank input, malformed JSON, and non-object roots such as `null`,
arrays, strings, numbers, or booleans fail the action without setting the output.
Invalid branch schemas also fail without outputs.
Errors do not include raw configuration values. Branch policy comes from the
input; org profiles come from JSON first, otherwise the optional file. Invalid
nonblank JSON fails without file fallback. No environment variables
are exported, and no Salesforce commands are executed.
The GitHub event payload is read only to identify closed merged PRs.

Changing the JSON value in GitHub needs no commit. Changing this action's code,
its input/output contract, or the enforced branch schema still requires a code
change and an updated bundle.
