# PR Title Checker

Validate a PR title using the regex policy configured for its target branch in
`SF_CICD_CONFIG`. Invalid titles fail the action and create or update one failure
comment. When the title is corrected, its existing failure comment is deleted.
The action does not use Salesforce credentials or run Salesforce commands.

## Configuration

Add `prTitle` alongside `branchName`, validation, and deployment settings:

```json
{
  "version": 1,
  "branches": {
    "develop": {
      "prTitle": {
        "enabled": true,
        "allowedPatterns": ["^ASOS-[0-9]+: .+$"]
      }
    }
  }
}
```

This example accepts `ASOS-123: Add account validation` and rejects
`Add account validation`, `ASOS-abc: Fix`, and `ASOS-123:`. It checks title
format, not whether a ticket exists. See the combined
[example config](../config-reader/ci-cd-config.example.json) for other settings.

Each target branch can have different patterns. Exact target names take
precedence over target globs; otherwise the first matching target rule wins.
Source branch names do not determine the title policy. The example enables
checking only for `develop`; other configured targets skip title checks until
their own `prTitle` policy is added. An unknown target fails the action.

## Regex Rules

`enabled` defaults to `false`. When enabled, `allowedPatterns` must contain
1-256 valid JavaScript regex strings, each at most 1024 characters. The same
rules are schema-checked even when disabled. Expressions match the whole title,
are case-sensitive, and do not accept `/.../` delimiters or separate flags.
In JSON, escape backslashes, for example `"^ASOS-\\d+: .+$"`, or use `[0-9]`.

Titles are evaluated verbatim, without trimming whitespace, and cannot exceed
1024 characters. Missing or blank titles and missing target context fail.
Matching uses the same isolated, two-second worker budget as the branch checker.
Malformed or timed-out expressions fail without generating mismatch comments.
Keep patterns simple and restrict who can edit configuration.

## Comment Lifecycle

| Result                                    | Check Status                    | Feedback                                                             |
| ----------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| First invalid title                       | Failed                          | Create a marked failure comment.                                     |
| Still invalid after editing/rerunning     | Failed                          | Update the existing comment in place.                                |
| Title corrected                           | Passed                          | Delete all marked title-failure bot comments.                        |
| Valid rerun with no failure comment       | Passed                          | No comment is created or deleted.                                    |
| Invalid again after correction            | Failed                          | Create a new failure comment, then update it on subsequent failures. |
| Missing/disabled policy on a known target | Skipped internally, step passes | Do not manage comments.                                              |

The key is `pr-title-checker`. Comments from other actions and human comments
are not modified. Feedback includes the current title, target branch, and up to
ten allowed regexes; values are escaped, and unrelated config is not included.
Do not store secrets in title policies.

`github-token` defaults to `${{ github.token }}` and needs `pull-requests: write`.
If the token/PR context is unavailable or GitHub denies a write, the action logs
a warning and preserves the title-check result. Thus a corrected title passes
even if cleanup is blocked, but the stale comment can remain until a permitted
rerun. Fork PR tokens may be read-only even when write permission is requested.
Do not expose privileged credentials to untrusted PR code to bypass this.

## Workflow

```yaml
name: PR title

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read

jobs:
  title:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    concurrency:
      group: pr-title-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - id: title
        uses: ./github-actions/actions/pr-title-checker
        with:
          config: ${{ vars.SF_CICD_CONFIG }}
```

The `edited` activity is essential: editing a PR title then reruns the check
and deletes stale feedback once it passes. Per-PR concurrency reduces overlap
between title edits. Make this job a required status check in branch protection
or rulesets. The action does not remove the historical failed workflow run;
it deletes the old feedback comment and the new run reports the current result.

The example checks out action code from the PR source commit. Commit all generated
`dist/` files and chunks in the PR so action changes are tested. Review action
and workflow edits before allowing write-token access. Published
consumers can use
`owner/repository/github-actions/actions/pr-title-checker@<full-commit-sha>`
with a real reviewed commit. Do not execute untrusted PR code with a privileged
token. In a combined job, place title checks first or use an explicit
`if: ${{ !cancelled() }}` so other failed checks do not prevent cleanup.

## Inputs and Outputs

| Kind           | Name              | Contract                                                          |
| -------------- | ----------------- | ----------------------------------------------------------------- |
| Required input | `config`          | JSON, typically `${{ vars.SF_CICD_CONFIG }}`.                     |
| Optional input | `github-token`    | Defaults to `${{ github.token }}`.                                |
| Optional input | `title`           | Defaults to the PR title from the event; whitespace is preserved. |
| Optional input | `target-branch`   | Defaults to the PR target.                                        |
| Output         | `checked`         | String `true` if an enabled policy was evaluated.                 |
| Output         | `valid`           | String `true` if accepted or disabled, otherwise `false`.         |
| Output         | `title`           | The exact evaluated title.                                        |
| Output         | `target-branch`   | Evaluated target branch.                                          |
| Output         | `matched-branch`  | Selected target rule or glob.                                     |
| Output         | `matched-pattern` | Accepted title regex, or an empty string.                         |

Explicit title/target inputs support manual checking. Without PR context no
feedback is managed. Configuration, context, or regex evaluation errors produce
no outputs. Logs do not print the title or raw config; feedback comments
intentionally display the title and allowed patterns.
