# Validate Salesforce Deployment

JWT-authenticated deployment validation, ported from the legacy root
`validate-deployment/` action. It supports one org per matrix job and never
performs a real deployment: every metadata command includes `--dry-run`.
The legacy source is retained unchanged.

## Behavior

- Select the PR target's enabled validation policy and the requested org profile.
- Preserve package directory order from the checked-out `sfdx-project.json`.
- Authenticate the selected org using JWT and a unique temporary alias.
- Run one `sf project deploy start --dry-run --json` command for the payload.
- Default to `RunRelevantTests` and a 180-minute wait, matching the old action.
- Delete the previous bot result comment for the org and create a fresh report
  at the end of the PR conversation, without touching another org's feedback.
- Report component, test, and Apex coverage failures in separate sections.
- Expose sanitized JSON for a workflow artifact, even when validation fails.
- Treat `NothingToDeploy` as skipped, not failed.
- Remove the private key and temporary CLI auth state in cleanup.

## Full and Delta Modes

Set `validation.mode` in `SF_CICD_CONFIG`:

| Mode    | Source Paths                                                       |
| ------- | ------------------------------------------------------------------ |
| `full`  | All configured `sourceDirs`, in project package order.             |
| `delta` | Non-deleted PR files under `sourceDirs`, grouped in package order. |

Delta preserves the old action's changed-file strategy. It does not generate a
manifest, infer dependencies beyond Salesforce's source handling, or validate
deletions/destructive changes. Removed-only changes skip authentication and
validation. Changes ignored by `.forceignore` can result in `NothingToDeploy`.
The config reader's planning `baseRef`/`headRef` fields are not used by this
action; GitHub's PR file list determines the changed payload.

The checked-out source should be the PR's current merge result, not arbitrary
latest branch contents. Require the PR to be up to date and revalidate when the
target changes. No successful-org deployment or tag is used as a baseline.

## Branch Configuration

```json
{
  "validation": {
    "enabled": true,
    "mode": "delta",
    "orgs": ["development", "qa"],
    "sourceDirs": ["force-app"],
    "testLevel": "RunRelevantTests",
    "waitMinutes": 180
  }
}
```

Put this under the desired target rule in `branches`. `testLevel` can also be
`RunLocalTests`, `RunAllTestsInOrg`, or `RunSpecifiedTests`; the last requires a
nonempty `tests` array. `NoTestRun` is intentionally unsupported. `waitMinutes`
must be 1-1440, and the workflow timeout must allow that wait plus setup.
An unfinished result, malformed JSON, nonzero CLI exit, or failed result cannot
be treated as success. The selected CLI/org version must support the test level;
there is no silent downgrade when `RunRelevantTests` is unavailable.

## Org Profiles and Credentials

Repository variable `SF_ORGS_CONFIG` maps org keys to GitHub environments,
login URLs, and secret names. [orgs-connections-config.example.json](../config-reader/orgs-connections-config.example.json)
documents the JSON schema; it is not runtime configuration. See
[org setup](../config-reader/ORG_CONNECTIONS.md) for JWT and environment Secrets. Neither
variable JSON nor files may contain actual credentials or private keys.

Pass `${{ vars.SF_ORGS_CONFIG }}` to the reader's `orgs-config` input. Its
validation matrix then includes `environment`, `usernameSecret`, `clientIdSecret`,
and `jwtKeySecret`. Secret **values** are resolved only inside each environment
job and supplied directly to this action.
Capture the reader's validated `orgs-config` job output and pass that snapshot
to this action. Nonblank JSON overrides an explicitly supplied `orgs-config-path`;
invalid JSON fails rather than falling back. There is no default file path,
and examples are never loaded automatically. File-based callers must supply
their own path when JSON is absent or blank.

## Parallel Workflow

The [complete workflow guide](../config-reader/CONFIGURATION.md) includes the
configuration job and profile-enriched matrix. The important validation job is:

```yaml
validation:
  needs: configuration
  if: >-
    github.event.action != 'closed' &&
    github.event.pull_request.head.repo.full_name == github.repository &&
    needs.configuration.outputs.validation-enabled == 'true'
  runs-on: ubuntu-latest
  timeout-minutes: 200
  environment:
    name: ${{ matrix.environment }}
    deployment: false
  permissions:
    contents: read
    pull-requests: write
  strategy:
    fail-fast: false
    matrix: ${{ fromJSON(needs.configuration.outputs.validation-matrix) }}
  steps:
    - uses: actions/checkout@v5
      with:
        ref: ${{ github.event.pull_request.head.sha }}
        path: .ci
        persist-credentials: false
    - uses: actions/checkout@v5
      with:
        ref: ${{ github.event.pull_request.merge_commit_sha || github.sha }}
        path: source
        persist-credentials: false
    - uses: actions/setup-node@v5
      with:
        node-version: 24
    - name: Install Salesforce CLI
      run: npm install --global @salesforce/cli
    - id: validation
      uses: ./.ci/github-actions/actions/validate-deployment
      with:
        config: ${{ needs.configuration.outputs.config }}
        org: ${{ matrix.org }}
        orgs-config: ${{ needs.configuration.outputs.orgs-config }}
        working-directory: source
        username: ${{ secrets[matrix.usernameSecret] }}
        client-id: ${{ secrets[matrix.clientIdSecret] }}
        jwt-private-key: ${{ secrets[matrix.jwtKeySecret] }}
    - uses: actions/upload-artifact@v7
      if: ${{ !cancelled() && steps.validation.outputs.report-path != '' }}
      with:
        name: ${{ steps.validation.outputs.artifact-name }}
        path: ${{ steps.validation.outputs.report-path }}
        retention-days: 10
```

The configuration job must expose `config`, `orgs-config`, and
`validation-matrix`; pass the captured JSON snapshots rather than re-reading
variables that could change during the run.
The default `github-token` is `${{ github.token }}`. Each matrix job binds its
environment before resolving Secrets. `fail-fast: false` lets other org jobs
finish after one fails; actual parallelism depends on runner availability.

`deployment: false` retains environment secrets, reviewers, wait timers, and
branch restrictions without creating automatic GitHub deployment records for
validation-only jobs. Custom GitHub App deployment protection rules are incompatible
with this setting; such environments cause the job to fail. Existing deployment
records are not removed, and actual release jobs keep their deployment tracking.

The example installs `@salesforce/cli` without a version suffix, using npm's
current stable `latest` release. CLI Node 24 support is required. No Code Analyzer/Java installation
is needed for validation itself. No tools are installed by the action.

Require the full validation matrix through branch protection or an aggregate
required job, and protect sensitive environments with approvals. Action code
comes from the PR source commit, while profiles come from the captured repository
variable. Review action changes and control edits to routing variables before
approving environment credentials: modified actions can access the supplied
private key and tokens. Use isolated test orgs for action development. Do not run authenticated
validation for forks by exposing privileged tokens/secrets, and do not use
`pull_request_target` to execute untrusted PR code. Dry-run Apex tests still run
in the selected org; sandbox/data isolation and least privilege remain essential.

## Results and Feedback

Failed dry runs publish feedback before the action fails. Successful reruns
replace that org's existing result comment; skipped runs report why no payload
was validated. Artifact upload is a separate workflow step with a 10-day
retention example. The comment links to the workflow run/artifacts, not an
artifact ID created inside the action. Upload and comment permission failures
must not turn a failed Salesforce validation into a pass.

Comments use a concise Markdown heading, a bullet summary with inline-code values,
and separate component/test/coverage failure lists. Detailed stacks and complete
results remain in the sanitized JSON artifact rather than filling the PR comment.

Comments are keyed by a stable org hash. Each publication deletes all matching bot
comments, then posts a new comment so the latest result appears at the bottom.
Human comments, other actions, and other orgs are untouched. Replacement is not
atomic: if creation fails after deletion, the previous comment is already gone;
the action warns and preserves the Salesforce result and available report artifact.
If deletion is forbidden, creation is not attempted. The report and
comment redact known credentials and sensitive token fields. Raw login output
is not logged or uploaded; invalid deployment JSON is replaced with a generic
failure report instead of storing raw stdout/stderr. CLI auth/key state lives
in a temporary home directory and is removed after normal success/caught errors.
Use ephemeral runners or explicit temp cleanup for force-terminated jobs.

## Inputs and Outputs

| Kind           | Name                | Contract                                                                                 |
| -------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Required input | `config`            | The captured branch configuration JSON.                                                  |
| Required input | `org`               | Enabled org key from the validation matrix.                                              |
| Optional input | `orgs-config`       | Captured credential-free profile JSON; overrides the file.                               |
| Optional input | `orgs-config-path`  | Explicit fallback profile path; no default and no automatic example loading.             |
| Input          | `username`          | Integration username secret; required when there are sources.                            |
| Input          | `client-id`         | OAuth app client ID secret; required when there are sources.                             |
| Input          | `jwt-private-key`   | Full multiline unencrypted RSA PEM, at least 2048 bits; required when there are sources. |
| Optional input | `github-token`      | Defaults to `${{ github.token }}`; needs PR read/write permissions.                      |
| Optional input | `working-directory` | Salesforce project checkout relative to `GITHUB_WORKSPACE`, default `.`.                 |
| Output         | `outcome`           | `Succeeded`, `Failed`, or `Skipped`.                                                     |
| Output         | `deployment-id`     | Validation deployment ID, if returned.                                                   |
| Output         | `sources-count`     | Number of selected source paths.                                                         |
| Output         | `report-path`       | Sanitized JSON report path; empty when no source paths matched.                          |
| Output         | `artifact-name`     | Safe, distinct per-org artifact name.                                                    |

This action runs only for same-repository, open `pull_request` context and an org enabled by the target's
validation policy. Missing profiles, secrets for nonempty payloads, invalid keys,
or auth/tool failures fail early; they do not produce a successful validation.
An authentication failure never persists raw output as a report. GitHub write
failures only warn and preserve the Salesforce outcome. No real org is contacted
by unit/integration tests; they use a local mock API and fake `sf` process.
