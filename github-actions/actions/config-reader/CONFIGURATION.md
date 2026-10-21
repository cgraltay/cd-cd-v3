# Branch and Org Configuration

Keep the JSON in the GitHub Actions repository variable `SF_CICD_CONFIG`.
Changing branch rules, modes, or org lists changes subsequent workflow runs
without committing a configuration file. This action produces plans; the
[validation action](../validate-deployment/README.md) now executes validation
dry runs. Actual deployment and generated destructive delta packages remain
separate future work.

## Configuration Example

The standalone [ci-cd-config.example.json](ci-cd-config.example.json) contains this example.
It is documentation only: set the GitHub variable `SF_CICD_CONFIG` to your desired
JSON value. The action does not load this file, and later configuration changes
remain in GitHub settings without requiring commits.

```json
{
  "version": 1,
  "branches": {
    "develop": {
      "branchName": {
        "enabled": true,
        "allowedSourcePatterns": [
          "^feature/ASOS-[0-9]+$",
          "^bugfix/ASOS-[0-9]+$",
          "^hotfix/ASOS-[0-9]+$"
        ]
      },
      "prTitle": {
        "enabled": true,
        "allowedPatterns": ["^ASOS-[0-9]+: .+$"]
      },
      "codeAnalyzer": {
        "enabled": true,
        "packageDirectories": ["force-app"],
        "configPath": "code-analyzer.yml",
        "ruleSelectors": ["Recommended"],
        "failOnSeverity": 5,
        "maxInlineComments": 50
      },
      "validation": {
        "enabled": true,
        "mode": "delta",
        "orgs": ["development", "qa"],
        "testLevel": "RunRelevantTests",
        "waitMinutes": 180
      },
      "deployment": {
        "enabled": true,
        "mode": "delta",
        "orgs": ["development"]
      }
    },
    "qa": {
      "validation": {
        "enabled": true,
        "mode": "full",
        "orgs": ["qa"],
        "testLevel": "RunRelevantTests",
        "waitMinutes": 180
      },
      "deployment": {
        "enabled": true,
        "mode": "delta",
        "orgs": ["qa"]
      }
    },
    "uat": {
      "validation": {
        "enabled": true,
        "mode": "full",
        "orgs": ["uat"],
        "testLevel": "RunRelevantTests",
        "waitMinutes": 180
      },
      "deployment": {
        "enabled": true,
        "mode": "delta",
        "orgs": ["uat"]
      }
    },
    "main": {
      "validation": {
        "enabled": true,
        "mode": "full",
        "orgs": ["production"],
        "testLevel": "RunRelevantTests",
        "waitMinutes": 180
      },
      "deployment": {
        "enabled": true,
        "mode": "delta",
        "orgs": ["production"]
      }
    }
  }
}
```

Validation and deployment are independent. One can be full while the other is
delta, and they can target different orgs. Each org becomes a separate matrix
job, so adding another org does not require a workflow edit.

## PR Branch Names

The optional `branchName` section controls the separate
[PR branch name checker](../pr-branch-name-checker/README.md). In this example,
PRs into `develop` must come from branches such as `feature/ASOS-123`,
`bugfix/ASOS-456`, or `hotfix/ASOS-789`, with numeric ticket identifiers.
The config reader validates and preserves this policy but does not enforce the
PR name by itself; run the checker before validation as shown below.

| Field                   | Default | Contract                                                                                        |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `enabled`               | `false` | Boolean; enforce naming for this target branch.                                                 |
| `allowedSourcePatterns` | `[]`    | Up to 256 JavaScript regular expressions of at most 1024 characters; at least one when enabled. |

Source naming uses **regex only**, not globs or template placeholders.
Expressions match the entire branch name and are case-sensitive, with no regex
flags or surrounding `/.../` delimiters. `^feature/ASOS-[0-9]+$` accepts
`feature/ASOS-123` but rejects `feature/ASOS-abc` and `feature/ASOS-123-extra`.
Use `^develop$` to allow an exact promotion source into `qa`. In JSON, write
`\\d` for the regex digit escape, or use `[0-9]` to avoid escaping.

Convert previous source globs: `feature/*` becomes `^feature/[^/]+$`, and
`feature/**` becomes `^feature/.+$`. Existing source globs are not automatically
translated. Target branch keys under `branches` still use exact names/globs.
Malformed regexes fail config validation, even on disabled policies. Pattern
matching runs in an isolated worker with a two-second limit across the list;
timeouts fail the action. Source branch input is limited to 1024 characters.
Keep expressions simple, avoid nested repetition, and restrict config editing.
This checks format only, not whether a ticket exists.

Missing or disabled naming policies skip the naming check on a configured
target. In the example, `qa`, `uat`, and `main` do not yet enforce naming;
add their policies when their allowed source branches are decided. If no
target rule matches at all, the checker fails instead of silently approving it.
Add its job as a required status check to prevent invalid names being merged.
Rejected names also receive a PR comment with the allowed regexes; reruns
update the existing marked bot comment. The checker uses the default GitHub
token and needs `pull-requests: write`. If commenting is blocked, such as on a
fork PR with a read-only token, the naming check still fails and logs a warning.

## PR Titles

The optional `prTitle` section controls the separate
[PR title checker](../pr-title-checker/README.md). The example `develop` policy
accepts `ASOS-123: Add account validation` and rejects titles without a numeric
ticket and description. This is an example format, not a hardcoded requirement.

| Field             | Default | Contract                                                                                     |
| ----------------- | ------- | -------------------------------------------------------------------------------------------- |
| `enabled`         | `false` | Boolean; enforce a PR title policy for this target.                                          |
| `allowedPatterns` | `[]`    | Up to 256 nonblank JavaScript regexes of at most 1024 characters; at least one when enabled. |

Patterns are case-sensitive, match the full title, and share the naming
checker's two-second worker timeout. Title whitespace is not normalized.
Titles are limited to 1024 characters. Target selection still uses exact branch
names/globs, and missing or disabled title policies skip checks on known targets.
Unknown targets and invalid schemas fail rather than silently passing.

Invalid titles create a marked failure comment; subsequent failures update the
same comment. Once the title matches, the checker deletes its old failure
comment. If the title becomes invalid after deletion, a new comment is created
and later failures update it. Branch-checker feedback and human comments are
not changed. The action needs `pull-requests: write` to manage comments.
API/permission failures warn without changing the title-check result.

Include `pull_request: edited` so fixing the title reruns the checker. Make the
title job a required check to prevent merging a rejected title. Only `develop`
enforces the example title policy; add `prTitle` to other target rules as needed.

## Salesforce Code Analyzer

The optional `codeAnalyzer` policy controls the
[Code Analyzer action](../run-code-analyzer/README.md). It scans non-deleted
changed `.cls` and `.trigger` files under configured package directories,
writes a JSON report, and synchronizes inline PR findings plus a summary.
Run it in a separate job with the PR source checked out. The main workflow
loads local action code and profiles from the PR source as well, so their
proposed changes can be tested before merging.

| Field                | Default             | Contract                                                                                                  |
| -------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `enabled`            | `false`             | Boolean; enable analysis for this PR target.                                                              |
| `packageDirectories` | `["force-app"]`     | Nonempty list of repository-relative package directories.                                                 |
| `configPath`         | `code-analyzer.yml` | Analyzer YAML path, resolved from the scanned workspace.                                                  |
| `ruleSelectors`      | `["Recommended"]`   | Nonempty list of Salesforce Code Analyzer rule selectors.                                                 |
| `failOnSeverity`     | `5`                 | Integer 1-5; any finding with severity at or above this importance fails (numeric severity <= threshold). |
| `maxInlineComments`  | `50`                | Integer 0-100; limits inline feedback, not the findings counted.                                          |

The root [analyzer config](../../../code-analyzer.yml) now references
[pmd-ruleset.xml](../../../pmd-ruleset.xml). The PMD default includes Apex
security, error-prone, best-practice, and performance categories; rule selectors
still determine which loaded rules run. Analyzer YAML and XML files must exist
in the caller's checkout. They are not automatically copied from the action.

Blocking findings outside the reviewable diff still fail the action. Clean or
no-target reruns remove the analyzer's marked bot feedback; CLI/report failures
preserve existing feedback. Only matching bot comments are deleted. The legacy
root `run-code-analyzer/` implementation is retained, not used by the new action.

The main workflow uses the PR's changed analyzer YAML/PMD rules without
overwriting them. Require owner review of rule changes, which can weaken the
scan or execute custom code. Rules-only PRs still skip analysis if there are no
changed Apex targets. See the dedicated workflow example for setup and token
permission requirements.

## Promotion Flow

Define policies for the branches receiving PRs: `develop`, `qa`, `uat`, and
`main`. Feature branches do not need rules for this target-branch workflow.

| Event                                | Selected Rule | Intended Operation                                           |
| ------------------------------------ | ------------- | ------------------------------------------------------------ |
| PR `feature/ASOS-123` into `develop` | `develop`     | Validate against development and QA in parallel.             |
| Merged PR into `develop`             | `develop`     | Deploy only that PR's changes to development.                |
| PR into `qa`                         | `qa`          | Validate against QA.                                         |
| Merged PR into `qa`                  | `qa`          | Deploy only that PR's changes to QA.                         |
| PR into `uat`                        | `uat`         | Validate against UAT.                                        |
| Merged PR into `uat`                 | `uat`         | Deploy only that PR's changes to UAT.                        |
| PR into `main`                       | `main`        | Validate against production without deploying.               |
| Merged PR into `main`                | `main`        | Deploy only that PR's changes to production after approvals. |

The modes and org lists above are examples, not mandatory promotion rules.
The extra QA validation target under `develop` demonstrates parallel org checks;
remove it if development PRs should validate only against development.
Branch names and GitHub environment names are separate: `develop` maps to the
`development` environment here, while `main` maps to `production`.

Deployment plans require a `pull_request` event with `action: closed` and
`pull_request.merged: true`. Open PRs, closed-unmerged PRs, pushes, and manual
runs do not receive deployment targets, even when deployment is enabled in the
branch rule. The workflow below runs validation before merge and deployment
planning after merge. Require successful PR checks through branch protection.

## Target Branch Matching

- Exact branch names take precedence over glob rules regardless of order.
- Otherwise the first matching rule in JSON order wins. `feature/*` matches a
  single path segment; `feature/**` also matches nested branch names.
- Put a catch-all `**` last when a fallback is wanted.
- Rules are not merged. Missing operations are disabled. Unmatched branches
  produce empty matrices and false enable flags.
- PRs use their target branch (`github.base_ref`) by default; pushes use
  `github.ref_name`. To match the PR source branch instead, supply
  `branch: ${{ github.head_ref || github.ref_name }}`.

A PR from `feature/ASOS-123` into `develop` uses the `develop` policy by default,
regardless of the source branch's name. The example intentionally has no
feature-branch policy: a push to `feature/ASOS-123` produces no operation plans.
Add feature rules only if you want checks before a PR exists or explicitly
choose source-branch policies. All rules are validated, not just the selected one.

## Operation Fields

The same fields apply to `validation` and `deployment`:

| Field         | Default         | Contract                                                                                                              |
| ------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`     | `false`         | Boolean; enable this operation for the branch.                                                                        |
| `mode`        | `full`          | Exactly `full` or `delta`.                                                                                            |
| `orgs`        | `[]`            | Org profile keys; at least one when enabled, unique case-insensitively, at most 256.                                  |
| `sourceDirs`  | `["force-app"]` | Nonempty array of nonblank source directory strings.                                                                  |
| `baseRef`     | Automatic       | Validation delta defaults to `origin/<PR-target>`; deployment uses the merge commit's first parent.                   |
| `headRef`     | `HEAD`          | Validation end ref; deployment is always pinned to the merged PR's commit SHA.                                        |
| `testLevel`   | Action default  | Validation defaults to `RunRelevantTests`; also accepts `RunLocalTests`, `RunAllTestsInOrg`, and `RunSpecifiedTests`. |
| `tests`       | None            | Nonempty test-name array required for `RunSpecifiedTests`.                                                            |
| `waitMinutes` | Action default  | Integer 1-1440; validation defaults to 180 minutes.                                                                   |

`full` processes all configured source directories; it is not PR-only.
Choose `delta` for deployment to process just the merged PR's changes.

Validation delta defaults to `origin/develop` for a PR targeting `develop`,
`origin/main` for a PR targeting `main`, and so on. An explicit validation
`baseRef` takes precedence. Source-branch policy overrides do not change the
actual PR target used by the default. Outside PR events the selected branch is
used, so avoid comparing a branch against itself after merge. Consumers must
fetch the target ref before computing validation deltas. If the target has
advanced, validate an up-to-date PR merge result rather than an obsolete one.

The implemented validation action preserves the legacy action's delta strategy:
it uses GitHub's changed-file list, excludes removed files, and validates those
source paths in project package order. It does not use `baseRef`/`headRef` to
generate a metadata delta or destructive manifest. The reader continues to
expose those refs for other consumers. Removed-only or `.forceignore`-filtered
payloads are skipped; destructive-change validation is not implemented.

Deployment refs are derived from the closed-merged PR event:

- `headRef` is the immutable `pull_request.merge_commit_sha`.
- `baseRef` is `<merge_commit_sha>^1`, its first parent.
- `pullRequest` identifies the merged PR.

This range includes the PR's introduced/modified/deleted files, including new
classes, without incorporating later commits pushed to the target branch.
No tag or last-deployed baseline is needed. Any deployment refs left in older
configuration are overridden by the PR-derived range.

Use GitHub's **merge commit** or **squash merge** strategy. Rebase merging with
multiple PR commits is not supported by this range; disable rebase merging in
repository settings for this workflow. Otherwise the first-parent range would
only cover the last rebased commit. The reader does not determine the merge
strategy, run Git, generate a Salesforce delta package, or execute deployments;
those are responsibilities of future operation actions.

Deploying each PR independently intentionally does not recover changes from an
earlier failed deployment. Retry that failed PR before proceeding when later
PRs depend on it, and ensure deployment jobs execute in the required order.

Additional fields are preserved for future actions. Test level, named tests,
and wait time are validated and copied into matrix entries when supplied.

## Credentials and Environments

Repository variable `SF_ORGS_CONFIG` contains credential-free org JSON following
[orgs-connections-config.example.json](orgs-connections-config.example.json). It maps org keys to GitHub
environments, Salesforce login URLs, and secret names. Pass it through the
reader's `orgs-config` input; the file path remains an optional fallback.
Matrix rows then include
`environment`, `instanceUrl`, `usernameSecret`, `clientIdSecret`, and
`jwtKeySecret`, but never the credential values.

Create the mapped GitHub environments and set `SF_USERNAME`, `SF_CLIENT_ID`,
and `SF_JWT_PRIVATE_KEY` in each environment's Secrets. The names may be the same
across environments while their values differ. Jobs use
`environment: ${{ matrix.environment }}` and pass the resolved secrets directly
to the validation action. See [org setup](ORG_CONNECTIONS.md) for JWT app
and certificate preparation. Never put a private key or token in the orgs file,
variables, matrices, or outputs.

Protect production environments with required reviewers and branch restrictions.
Configuration and outputs are not secret storage, even though the action does
not print their contents. Restrict who can edit the configuration variable.

## Parallel Workflow Example

This example enforces PR naming and runs real Salesforce validation dry runs.
Deployment is still a plan-only placeholder. Configure the org environments,
OAuth app, and secrets before enabling it. Authenticated validation is skipped
for fork PRs; do not bypass that guard with privileged tokens.
Jobs run in parallel subject to runner availability and GitHub concurrency
limits. `fail-fast: false` lets other orgs finish if one fails.

```yaml
name: Salesforce CI/CD plan

on:
  pull_request:
    types: [opened, synchronize, reopened, edited, closed]

permissions:
  contents: read

jobs:
  configuration:
    if: github.event.action != 'closed' || github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    outputs:
      config: ${{ steps.config.outputs.config }}
      orgs-config: ${{ steps.config.outputs.orgs-config }}
      validation-enabled: ${{ steps.config.outputs.validation-enabled }}
      deployment-enabled: ${{ steps.config.outputs.deployment-enabled }}
      validation-matrix: ${{ steps.config.outputs.validation-matrix }}
      deployment-matrix: ${{ steps.config.outputs.deployment-matrix }}
      branch-config: ${{ steps.config.outputs.branch-config }}
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - name: Check PR source branch name
        if: github.event.action != 'closed'
        uses: ./github-actions/actions/pr-branch-name-checker
        with:
          config: ${{ vars.SF_CICD_CONFIG }}
      - name: Check PR title and synchronize feedback
        if: ${{ !cancelled() && github.event.action != 'closed' }}
        uses: ./github-actions/actions/pr-title-checker
        with:
          config: ${{ vars.SF_CICD_CONFIG }}
      - id: config
        uses: ./github-actions/actions/config-reader
        with:
          config: ${{ vars.SF_CICD_CONFIG }}
          orgs-config: ${{ vars.SF_ORGS_CONFIG }}

  validation:
    needs: configuration
    if: >-
      github.event.action != 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      needs.configuration.outputs.validation-enabled == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 200
    permissions:
      contents: read
      pull-requests: write
    environment: ${{ matrix.environment }}
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

  deployment:
    needs: configuration
    if: >-
      ${{ github.event_name == 'pull_request' &&
          github.event.action == 'closed' && github.event.pull_request.merged == true &&
          needs.configuration.outputs.deployment-enabled == 'true' }}
    runs-on: ubuntu-latest
    environment: ${{ matrix.environment }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.configuration.outputs.deployment-matrix) }}
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ matrix.headRef }}
          fetch-depth: 0
      - name: Deployment plan (no Salesforce operation yet)
        env:
          ORG: ${{ matrix.org }}
          MODE: ${{ matrix.mode }}
        run: printf 'Planned %s deployment for %s\n' "$MODE" "$ORG"
```

Keep the closed-and-merged event guard on real deployments. Enable the same
closed activity in the workflow: a generic PR trigger does not include it by
default. Validation runs belong to earlier PR events, so the deployment job
does not depend on a validation job in this closed-event run. Require successful
PR validation before merging through branch protection and keep production
environment approvals in place.
The configuration and validation action checkouts use the PR source commit,
while validation metadata uses the merge result. All generated action bundles
must be committed in the PR. Review changes to workflows, action code, profiles,
and rules before approving environment access: source-branch actions can access
the job's tokens and org secrets. Published consumers may use reviewed full
commit SHAs instead. The `edited` activity reruns naming checks when a PR is retargeted
or its title changes. The title step uses an explicit status condition so a
corrected title can clear its failure comment even if the branch-name step fails.
Do not use `pull_request_target` to execute untrusted PR code with org secrets.
Fork PRs normally do not receive secrets; define a safe policy before adding
authenticated validation.

The validation action re-reads the same configuration snapshot and selects the
requested org's row. Use the reader's `config` output rather than re-reading a
variable that could change during the run. Org profiles likewise use the
reader's captured `orgs-config` snapshot, not a re-evaluation of variables in
each environment job. Keep branch protection/up-to-date
PR requirements and environment approvals in place. Treat validation against
an org as privileged even though it is a dry run: PR Apex tests execute remotely.
Future deployment actions should consume the immutable deployment matrix refs.

Configuration can only control operations already wired into the workflow.
It cannot change workflow triggers or introduce new action implementations.
Once broad branch triggers and these matrix jobs are committed, policy changes
to existing operations can happen entirely through the variable.

## Outputs

| Output               | Value                                                    |
| -------------------- | -------------------------------------------------------- |
| `config`             | Original parsed configuration as compact JSON.           |
| `branch`             | Branch used for selection.                               |
| `matched-branch`     | Matched branch name/pattern, or an empty string.         |
| `branch-config`      | Selected settings with operation defaults, as JSON.      |
| `validation-enabled` | String `true` or `false`.                                |
| `deployment-enabled` | String `true` or `false`.                                |
| `validation-matrix`  | JSON `{ "include": [...] }`, one row per validation org. |
| `deployment-matrix`  | JSON `{ "include": [...] }`, one row per deployment org. |

Matrix rows contain `org`, `mode`, `sourceDirs`, `headRef`, and `baseRef` when
resolved. Optional test fields are propagated. With `orgs-config-path`, rows also
contain environment/login/secret-name metadata; no secret values are emitted.
Deployment rows also include `pullRequest`; their enable flag is true
only for an enabled operation on a closed merged PR. Use job-level enable flags
before expanding empty matrices.
Configuration without `branches` remains a legacy pass-through with no planned
operations. Branch configuration requires `version: 1` and a branch name.
Invalid schema/input fails before outputs are written, without printing values.

The configuration job should use the repository variable for a shared policy.
An environment-specific variable only affects jobs already referencing that
environment; matrix environments cannot retroactively change resolved config.
