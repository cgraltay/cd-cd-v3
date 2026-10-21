# Salesforce CI/CD Actions

An independent TypeScript project for multiple Salesforce CI/CD GitHub Actions. The
Salesforce DX project and its root npm package are not changed.

## Available Actions

| Action                                                             | Purpose                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [Config reader](actions/config-reader/README.md)                   | Select branch-specific full/delta operations and plan parallel org matrices from a JSON GitHub Actions variable. |
| [PR branch name checker](actions/pr-branch-name-checker/README.md) | Enforce regex source-branch naming rules configured per PR target branch.                                        |
| [PR title checker](actions/pr-title-checker/README.md)             | Enforce target-specific PR title regexes, update failure comments, and delete them after correction.             |
| [Run Code Analyzer](actions/run-code-analyzer/README.md)           | Run Salesforce Code Analyzer on changed Apex files with JSON reports, inline findings, and severity gating.      |
| [Validate deployment](actions/validate-deployment/README.md)       | Run JWT-authenticated dry runs per org/environment with failure comments and sanitized reports.                  |
| [Check org connection](actions/check-org-connection/README.md)     | Manually verify JWT authentication and read-only API access for one org or all configured environments.          |
| [Deploy metadata](actions/deploy-metadata/README.md)               | Manually validate, deploy, Quick Deploy, and recover pinned releases with per-org cumulative baselines.          |

## Main Salesforce Workflow

The executable orchestration is
[.github/workflows/salesforce-pr-review.yml](../.github/workflows/salesforce-pr-review.yml),
named **Salesforce PR Review**. The separate `github-actions-ci` workflow builds/tests
the action tooling and is not the Salesforce PR pipeline.

The Actions graph shows configuration, independent branch/title checks, Code
Analyzer, parallel per-org validation, and the
final **Salesforce CI Status** check. Job summaries show the selected branch
rule, orgs, environments, modes, and results. Failed analyzer/validation jobs
still upload available JSON reports with 10-day retention.

Branch and title checks run independently. Code Analyzer starts only after both
pass. When analysis is enabled, org validation requires Code Analyzer success;
an enabled analyzer that fails, is cancelled, or is skipped blocks validation.
When analysis is disabled, its skipped job does not block org validation.

### Observe It

1. Commit/push the workflow and all generated action bundles.
   PR jobs load local actions from the PR source commit, so action changes can
   be tested before merge. Commit updated `dist/` bundles with TypeScript edits.
   Manual runs use the selected workflow commit; the Run workflow button also
   requires the workflow to exist on the default branch.
2. Set repository variable `SF_CICD_CONFIG` using the
   [example](actions/config-reader/ci-cd-config.example.json), adjusted to your policy.
   Set `SF_ORGS_CONFIG` using [orgs-connections-config.example.json](actions/config-reader/orgs-connections-config.example.json),
   with connection metadata and secret names only. Profile changes in this
   variable need no commit. Both files are examples only and are not loaded automatically.
3. Open **Actions > Salesforce PR Review > Run workflow** and choose a target-policy
   branch, such as `develop`. This is **plan only**: it displays the matrix and
   summary without running PR checks, installing Salesforce tools, or contacting
   an org. No Salesforce credentials are needed for this observation run.
4. For actual PR checks, create the mapped environments and Secrets using
   [org setup](actions/config-reader/ORG_CONNECTIONS.md), then open/update a same-repository PR into a
   configured target. Include `edited` events so a corrected title clears its
   failure comment. Wait for approvals on protected environments when required.

Set **Salesforce CI Status** as the stable required check in branch protection
or a ruleset. It fails if required checks fail, are cancelled, or unexpectedly
skip; a skipped matrix is not silently treated as successful validation. Draft
and fork PRs do not run privileged analysis/authenticated validation, so their
required status remains unsuccessful when those operations are enabled. Mark
drafts ready or follow an approved trusted-branch process for fork contributions.

Validation uses `fail-fast: false`, preserving results from other orgs when one
fails. The job has GitHub-hosted runners' 360-minute limit; keep `waitMinutes`
below that limit with room for setup. Analyzer YAML/XML are read from the PR
checkout without being overwritten, so proposed rule changes apply to the scan.
The analyzer still scans only changed Apex files; a rules-only PR currently has
no Apex targets and skips analysis. Salesforce CLI uses the unversioned
`@salesforce/cli` package, which resolves npm's current `latest` release.

Action code and analyzer rules can change in a PR. Org profiles in the main
workflow come from `SF_ORGS_CONFIG`, captured once by the reader and reused by
all validators. Restrict who can edit connection-routing variables. Actions are
not a security boundary against the PR author: modified actions can access the
job's GitHub token and validation secrets. Require owner review for workflow,
action, profile, and ruleset changes, and environment approval before releasing
org credentials. Use isolated test orgs for action development; do not run
unreviewed code against sensitive orgs. Fork restrictions remain in place.

This workflow reviews open PRs only; there is no merged-PR deployment job or
deployment-plan placeholder. Actual releases use the separate
[Salesforce Manual Release workflow](../.github/workflows/salesforce-release.yml).
Manual PR planning does not run Salesforce commands and is not proof of org connectivity or deployment.

## Manual Releases

Open **Actions > Salesforce Manual Release > Run workflow**. Select the source branch
(for example `release-x`) independently of the target environment (`production`).
Choose **validate** for validation-only; **deploy** for an actual deployment;
**quick-deploy** for a recorded validation; or **reconcile** to check an interrupted
pipeline job without resubmitting. The default is validation-only.

The source branch's `deployment` policy must allow the selected org. Full mode
bootstraps an org without history; subsequent delta releases include cumulative
changes since that org's last successful actual release. `RunRelevantTests` remains
the default; Quick Deploy eligibility is decided by Salesforce, with no silent
normal-deploy fallback. See the [release guide](actions/deploy-metadata/README.md)
for branch policies, saved record IDs, concurrency, recovery, and limitations.

## Manual Org Connection Checks

Use [.github/workflows/check-org-connections.yml](../.github/workflows/check-org-connections.yml),
named **Check Salesforce Org Connections**, to test the environment credentials
independently of PR validation. It runs only through **Run workflow**. Enter an
org profile key, or leave it empty to check all configured orgs in parallel.

The workflow uses `SF_ORGS_CONFIG` and environment Secrets, not `SF_CICD_CONFIG`.
Its preparation job needs no credentials; checking jobs verify JWT login and a
read-only API query, publish sanitized summaries, and clean up local auth state.
No metadata is deployed and no PR checks are started. See the
[connection action guide](actions/check-org-connection/README.md) for setup and
security requirements. Do not run unreviewed action code with production secrets.

## Development

Use Node.js 24, then run commands from this directory:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run lint
npm run format
npm run check
```

This project has its own dependencies and lockfile. Do not install its packages
into the root Salesforce project.

## Structure

```text
github-actions/
  package.json
  package-lock.json
  tsconfig.json
  actions/
    check-org-connection/
      action.yml
      src/index.ts
      dist/index.js
      dist/licenses.txt
    config-reader/
      action.yml
      ci-cd-config.example.json
      orgs-connections-config.example.json
      ORG_CONNECTIONS.md
      src/index.ts
      dist/index.js
      dist/licenses.txt
    pr-branch-name-checker/
      action.yml
      src/index.ts
      dist/index.js
      dist/licenses.txt
    pr-title-checker/
      action.yml
      src/index.ts
      dist/index.js
      dist/licenses.txt
    run-code-analyzer/
      action.yml
      src/index.ts
      dist/index.js
      dist/licenses.txt
    validate-deployment/
      action.yml
      src/index.ts
      dist/index.js
      dist/licenses.txt
  shared/
    branch-name.ts
    code-analyzer.ts
    jwt.ts
    orgs.ts
    pr-comment.ts
    pr-title.ts
    regex.ts
  scripts/build.ts
  tests/build.test.ts
  tests/check-org-connection.test.ts
  tests/config-reader.test.ts
  tests/pr-branch-name-checker.test.ts
  tests/pr-branch-comment.test.ts
  tests/pr-title-checker.test.ts
  tests/run-code-analyzer.test.ts
  tests/validate-deployment.test.ts
  tests/salesforce-workflow.test.ts
```

Add one directory per new action, such as validation or deployment. Keep reusable
helpers in `shared/` and action-specific tests alongside the build tests in
`tests/`.

## Shared PR Comments

Use [shared/pr-comment.ts](shared/pr-comment.ts) from any action that needs
GitHub PR feedback. The helper accepts an authenticated Octokit client, PR
coordinates, and a stable key with a Markdown body:

```typescript
import { upsertPullRequestComment } from '../../../shared/pr-comment';

await upsertPullRequestComment(
  client,
  { owner, repo, number },
  { key: 'deployment', body: '## Deployment\n\nDeployment completed.' }
);
```

Use a distinct key per action, or per action/org when separate comments are
needed. Keys start with a lowercase letter and contain only lowercase letters,
digits, and hyphens, up to 100 characters. The helper adds the hidden marker,
searches all comment pages, and creates or updates the matching bot comment
without changing other actions' feedback or human comments.

Use `deletePullRequestComment(client, { owner, repo, number }, { key })` to
remove matching bot feedback when an issue is resolved. It searches all pages,
removes duplicate comments for that key, tolerates comments already deleted,
and leaves human comments and other actions' keys untouched. The title checker
uses this cleanup on success; the branch checker retains its existing behavior.

Use `replacePullRequestComment(client, { owner, repo, number }, { key, body })`
to delete matching bot comments and create a fresh comment at the end of the PR
conversation. Validation reports use this operation; other actions retain their
existing upsert behavior. A deletion error prevents creation, while a creation
error after deletion cannot restore the old comment automatically.

Each caller owns its message template, escapes untrusted values, and handles
token/context lookup and API failures. The helper does not change action status
or log errors. Its client needs permission to comment on the PR, normally
`pull-requests: write`. The branch-name checker retains its specific message
and failed-check behavior while using this shared implementation.

## Bundling

`npm run build` discovers directories inside `actions/` and uses `@vercel/ncc`
to compile each `src/index.ts` into its own `dist/index.js`. Runtime dependencies
and imported shared helpers are bundled, and dependency licenses are collected.
The build succeeds without creating bundles until actions are added.

Type checking runs before bundling. The strict TypeScript configuration covers
actions, shared helpers, development scripts, and tests. `tsx` runs TypeScript
scripts and tests locally; GitHub runners only execute the bundled JavaScript.

Each action needs an `action.yml` (or `action.yaml`) using `node24` with
`runs.main` set to `dist/index.js`, relative to that action's directory.
Commit the entire generated `dist/` directory, including any additional SDK
chunks. GitHub reads the action manifest and executes
the committed bundle; it does not install dependencies or run the build.

The toolkit packages are installed now: `@actions/core` for inputs, outputs,
logging, and failures; `@actions/exec` for invoking tools such as Salesforce CLI;
and `@actions/github` for PR feedback comments.
These toolkit versions are ESM-only: use `import` in action entry points rather
than `require`. The bundler produces executable CommonJS output. TypeScript
development scripts also use imports, with `tsx` handling local execution.
The validation action uses JWT and an already installed Salesforce CLI. Its
[org profiles and setup](actions/config-reader/ORG_CONNECTIONS.md) separate public connection metadata
from GitHub environment secrets. Actual metadata deployment execution remains
future work. The config reader itself never connects to an org.

## Usage Once Published

After publishing a `v1` tag, the config reader can be used from another repository:

```yaml
- id: config
  uses: owner/repository/github-actions/actions/config-reader@v1
  with:
    config: ${{ vars.SF_CICD_CONFIG }}
```

Replace the owner and repository with real values. Each action has a separate
manifest and subdirectory, but all actions share repository release tags.

The repository's `github-actions-ci` workflow checks this project's formatting,
linting, types, tests, build, and committed bundle freshness. It does not deploy to an
org or require Salesforce credentials.
