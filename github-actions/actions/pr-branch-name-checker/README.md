# PR Branch Name Checker

Check the PR source branch against regular expressions configured for its target
branch. Rules live in the existing `SF_CICD_CONFIG` GitHub Actions variable, so
changing naming policy does not require a configuration commit or action release.
Rejected names fail the check and receive a PR feedback comment through the
GitHub API. The action uses a GitHub token for commenting, but does not use
Salesforce credentials or run Salesforce commands.

## Configuration

Add `branchName` under the target branch in your existing configuration:

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
      }
    }
  }
}
```

Keep validation/deployment sections alongside `branchName` when needed. See the
combined [example configuration](../config-reader/ci-cd-config.example.json).

For a PR into `develop`, this example accepts `feature/ASOS-123`,
`bugfix/ASOS-456`, and `hotfix/ASOS-789`. It rejects `feature/ASOS-abc`,
`feature/ASOS-123-extra`, `Feature/ASOS-123`, and unrelated prefixes.
It checks naming format, not whether a ticket exists.

Source patterns are standard JavaScript regular-expression strings. Every
expression must match the **entire** branch name, even if `^` and `$` are
omitted. Matching is case-sensitive; regex flags and `/.../` delimiters are not
accepted as syntax. Use `[0-9]+` for digits, or escape backslashes in JSON:

```json
"^feature/ASOS-\\d+$"
```

There is no `{{ticketNumber}}` template expansion. `!` and `#` are literal regex
characters, not exclusion or comment markers.

Each target can have different patterns. For instance, a `qa` rule can allow
the exact source using `^develop$`. Those are policy choices, not built-in restrictions.
Target selection uses the config reader's rules: exact target names first,
otherwise the first matching target glob. Target rules are not merged.
Only source naming changed to regex; target-branch selection still uses globs.

An enabled policy requires a nonempty array of patterns, with at most 256
nonblank strings of up to 1024 characters. Malformed regexes fail configuration
validation, including in disabled policies. Missing or disabled policies skip checking for configured
targets. An unknown target, missing PR branch names, malformed config, or an
invalid policy fails the action. Invalid names produce `valid: false` and a
failed action; disabled checks produce `checked: false`, `valid: true`.

## Migrating Source Globs

Previously this field used minimatch globs. Convert existing GitHub variable
values before using this action version; patterns are not auto-detected or
translated. For example:

| Old Source Glob | Regex Replacement |
| --------------- | ----------------- |
| `feature/*`     | `^feature/[^/]+$` |
| `feature/**`    | `^feature/.+$`    |
| `develop`       | `^develop$`       |

## Regex Safety

Patterns are syntax-checked before matching. Source branch inputs are limited
to 1024 characters. Matching runs in an isolated worker with a two-second
budget for the complete pattern list; expensive expressions are terminated
and fail the action without producing outputs. Keep patterns simple, avoid
nested repetitions such as `(a+)+`, and restrict who can edit configuration.

## PR Feedback Comments

When an enabled policy rejects a source branch, the action fails and posts a
comment containing the source branch, target branch, and allowed regexes.
Reruns update an existing marked bot comment instead of creating a new one.
The comment includes at most ten patterns to keep feedback bounded; unrelated
configuration fields and tokens are never included. Patterns must not contain
secrets because the feedback is visible on the PR.

`github-token` defaults to `${{ github.token }}`. Grant the check job
`pull-requests: write`, alongside `contents: read` for checkout, as shown below.
No additional repository secret is needed when the default token has permission.
You can supply another suitable token through the optional input.

If the token or PR context is missing, or GitHub rejects the write, a warning is
logged and the naming check still fails. Fork PRs commonly have read-only
tokens, so a comment may not be possible even with requested permissions.
Do not expose a privileged token to untrusted PR code to work around this.

Accepted names and disabled policies do not post or modify comments. Existing
rejection comments are not removed on later success; the current status check
is authoritative. Configuration errors and regex timeouts do not generate
name-mismatch comments.

## Workflow

```yaml
name: PR branch name

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read

jobs:
  branch-name:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - id: branch
        uses: ./github-actions/actions/pr-branch-name-checker
        with:
          config: ${{ vars.SF_CICD_CONFIG }}
```

The local example uses action code from the PR source commit, so changes to the
checker can be tested in the same PR. Commit the rebuilt bundle in the PR and
require review of action/workflow changes before allowing write-token access.
For another repository, use
`owner/repository/github-actions/actions/pr-branch-name-checker@<full-commit-sha>`
with a real owner, repository, and reviewed commit. The consumer need not check
out code when using a published action. Pin reviewed versions of other actions
for production use as well.

The `edited` activity rechecks PRs when their target branch changes. Make the
`branch-name` job a required status check through branch protection or rulesets;
an action failure alone does not prevent merging. You can instead place this
action before the config reader in an existing configuration job, making
validation depend on the naming check. Do not use `continue-on-error` on it.

## Inputs and Outputs

| Kind           | Name              | Behavior                                                                           |
| -------------- | ----------------- | ---------------------------------------------------------------------------------- |
| Required input | `config`          | The JSON value, typically `${{ vars.SF_CICD_CONFIG }}`.                            |
| Optional input | `github-token`    | Defaults to `${{ github.token }}`; needs `pull-requests: write` for comments.      |
| Optional input | `source-branch`   | Defaults to `${{ github.head_ref }}`.                                              |
| Optional input | `target-branch`   | Defaults to `${{ github.base_ref }}`.                                              |
| Output         | `checked`         | String `true` if an enabled policy was evaluated.                                  |
| Output         | `valid`           | String `true` for an accepted name or disabled check; `false` for a rejected name. |
| Output         | `source-branch`   | Evaluated source branch.                                                           |
| Output         | `target-branch`   | Evaluated target branch.                                                           |
| Output         | `matched-branch`  | Selected target rule name or glob pattern.                                         |
| Output         | `matched-pattern` | Accepted source regular expression, or an empty string.                            |

Source and target inputs can be overridden for manual workflows, but are
required to resolve to nonblank branch names. No outputs are produced when
configuration or context validation fails. Config values are not printed in
logs; rejected-name comments intentionally show the allowed naming regexes.
Commit the entire generated `dist/` directory, including SDK chunks emitted by
the bundler, not just its main entry point.
