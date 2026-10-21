# Run Salesforce Code Analyzer

TypeScript port of the repository's older root `run-code-analyzer/` action.
Settings now come from `SF_CICD_CONFIG`, not a committed review-config JSON.
The legacy action is retained unchanged; use this action's path for new workflows.

## Behavior

- Select the policy for the PR target using the config reader's exact/glob rules.
- Analyze changed, non-deleted Apex classes and triggers inside package directories.
- Run `sf code-analyzer run` without a shell and with explicit file targets.
- Write a fresh JSON report in the runner temporary directory.
- Replace this action's marked bot inline comments on reviewable PR diff lines.
- Upsert a separate summary comment; remove both feedback types on clean/no-target runs.
- Fail for findings whose numeric severity is <= `failOnSeverity`, including
  findings outside the inline-reviewable diff or beyond the comment cap.

Unlike the legacy code, unrelated/human comments are never matched by a broad
message-format regex. Explicit legacy `<!-- run-code-analyzer -->` bot comments
are recognized during cleanup. A CLI failure, missing report, or malformed
report fails the action without clearing previous feedback.

Feedback permission failures warn but never hide blocking analyzer results.
Fork PR tokens may be read-only. Large/binary/truncated patches may not support
inline feedback; the JSON report and summary remain the authoritative counts.
The full report is produced even when findings fail the check.

## Branch Configuration

Add this policy under each desired target branch in `SF_CICD_CONFIG`:

```json
{
  "codeAnalyzer": {
    "enabled": true,
    "packageDirectories": ["force-app"],
    "configPath": "code-analyzer.yml",
    "ruleSelectors": ["Recommended"],
    "failOnSeverity": 5,
    "maxInlineComments": 50
  }
}
```

`enabled` defaults to `false`; other defaults are shown above. `packageDirectories`
and `ruleSelectors` must be nonempty arrays. `failOnSeverity` is an integer 1-5
(1 critical, 5 informational); choose `3` to block critical/high/moderate only.
`maxInlineComments` is 0-100 and does not affect the failure threshold.
Unknown targets fail, while missing/disabled policies skip analysis.

## PMD and Analyzer Configuration

The root [code-analyzer.yml](../../../code-analyzer.yml) references the new
[pmd-ruleset.xml](../../../pmd-ruleset.xml), which imports Apex security,
error-prone, best-practice, and performance categories. Existing YAML rule
overrides and engine settings are preserved. `Recommended` is the normal
selector; `pmd` selects all PMD rules, including rules without Recommended tags.
Custom ruleset loading does not itself select every loaded rule.

Keep both files in the scanned repository, or supply your own analyzer YAML
through `configPath` with valid ruleset references relative to its config root.
Published actions do not supply these files automatically. Updating branch
policy values needs no commit; editing PMD rule definitions still changes XML
and requires a commit. Keep secrets out of configuration.

## Prerequisites and Security

Provide Node.js 24, Salesforce CLI, the `code-analyzer` plugin, and a Java
version supported by your selected engines. Java 17 is used below. Other
engines can require Python or additional setup. This action does not install
tools, authenticate to Salesforce, or require an org.

The main workflow intentionally uses action code and analyzer YAML/PMD rules
from the PR source commit, allowing changes to be tested before merge. Require
review of those changes: custom ESLint configs or Java rules can execute code,
and modified actions can access the job's GitHub token. Do not use `pull_request_target`
to run untrusted PR code with privileged credentials. The CLI subprocess omits
the action's GitHub-token input and `GITHUB_TOKEN`, but this is not a sandbox.
Restrict selected engines/config access and use separate workflows when needed
for untrusted forks. The main workflow skips analysis for fork PRs. Restrict
which contributors may run jobs with write tokens and use required owner reviews.

## Workflow Example

This example checks out the PR source for both local action code and analyzed
files. Keep `codeAnalyzer.configPath` set to `code-analyzer.yml` so changes to
that YAML and its referenced PMD ruleset in the PR apply to analysis. No files
are restored from the target branch. Rules-only PRs still skip analysis if
there are no changed Apex classes/triggers.

```yaml
name: Salesforce code analysis

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  analyze:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          path: .ci
          persist-credentials: false
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          path: source
          persist-credentials: false
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: 17
      - name: Install Salesforce analysis tooling
        run: |
          npm install --global @salesforce/cli
          sf plugins install code-analyzer
      - id: analyzer
        uses: ./.ci/github-actions/actions/run-code-analyzer
        with:
          config: ${{ vars.SF_CICD_CONFIG }}
          working-directory: source
      - uses: actions/upload-artifact@v7
        if: ${{ !cancelled() && steps.analyzer.outputs.report-path != '' }}
        with:
          name: salesforce-code-analyzer
          path: ${{ steps.analyzer.outputs.report-path }}
```

The scanned files must match the PR head SHA used for inline comments. Required
checks/branch protection are needed to block merges; comment failures alone do
not do so. The workflow supports Ubuntu, with local development also tested on
macOS. For another repository, use the published action pinned to a reviewed
full commit. For local PR action development, commit all generated `dist/` files
in the PR and review action/config/ruleset changes before granting write access.

## Inputs and Outputs

| Kind           | Name                  | Contract                                                          |
| -------------- | --------------------- | ----------------------------------------------------------------- |
| Required input | `config`              | JSON, typically `${{ vars.SF_CICD_CONFIG }}`.                     |
| Optional input | `github-token`        | Defaults to `${{ github.token }}`; read PR files, write feedback. |
| Optional input | `working-directory`   | PR checkout path, default `.` relative to `GITHUB_WORKSPACE`.     |
| Output         | `skipped`             | String true for disabled/no-target runs.                          |
| Output         | `files-analyzed`      | Count of scanned changed files.                                   |
| Output         | `violations`          | All report findings, regardless of inline placement.              |
| Output         | `blocking-violations` | Findings meeting the configured failure threshold.                |
| Output         | `inline-comments`     | Successfully created inline comments.                             |
| Output         | `report-path`         | Absolute JSON report path; empty when no scan ran.                |

No-target enabled runs clear stale analyzer feedback without calling the CLI.
Disabled policies do not manage comments. API file-list failures and tool/report
errors fail; feedback-write errors only warn. Keep the entire generated `dist/`
directory, including SDK chunks, committed for consumers.

## Verification

Normal npm tests use mock APIs and a fake `sf` executable, not an org. An opt-in
test runs the real local PMD engine with the repository YAML/XML:

```sh
SF_ANALYZER_SMOKE=1 npx tsx --test --test-name-pattern="real Salesforce" tests/run-code-analyzer.test.ts
```
