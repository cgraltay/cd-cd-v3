# Manual Validation and Deployment

Choose one of the focused workflows under **Actions > Run workflow**. They never
run automatically after a PR merge. Source workflows default to **validate**;
choose **deploy** explicitly to commit metadata. The previous combined Salesforce
Manual Release workflow has been replaced.

| Workflow                                                                                           | Inputs                                                          |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [Validate or Deploy Full Branch](../../../.github/workflows/validate-deploy-full-branch.yml)       | Source branch, environment, operation                           |
| [Validate or Deploy Commit Range](../../../.github/workflows/validate-deploy-commit-range.yml)     | Source branch, inclusive start/end SHAs, environment, operation |
| [Validate or Deploy Branch Changes](../../../.github/workflows/validate-deploy-branch-changes.yml) | Source branch, comparison branch, environment, operation        |
| [Quick Deploy](../../../.github/workflows/quick-deploy-release.yml)                                | Environment, saved validation reference                         |
| [Reconcile Deployment](../../../.github/workflows/reconcile-release.yml)                           | Environment, saved validation/deployment reference              |

One [reusable workflow](../../../.github/workflows/release-execution.yml) owns
checkout, environment secrets/approvals, the shared per-org lock, CLI installation,
and sanitized report upload. Thin actions reuse this directory's source, auth,
execution, and audit helpers. The PR validation action is unchanged.

## Source Branch and Environment

The **source-branch** field selects metadata independently of the native
**environment** dropdown. For example, enter `release-x`, select `production`,
and choose `validate` to validate that branch against production without deploying.
The source branch must exist and its deployment policy must allow the selected org.
The normal **Use workflow from** selector chooses the reviewed workflow/action code,
not the source metadata branch. Keep that selector on a trusted automation branch.

Set repository variables `SF_CICD_CONFIG` and `SF_ORGS_CONFIG`; see
[configuration](../config-reader/CONFIGURATION.md) and
[org credentials](../config-reader/ORG_CONNECTIONS.md). For example, merge this
branch policy into `SF_CICD_CONFIG` (replace the org key with your profile key):

```json
{
  "version": 1,
  "branches": {
    "release-*": {
      "deployment": {
        "enabled": true,
        "mode": "delta",
        "orgs": ["production"],
        "sourceDirs": ["force-app"],
        "testLevel": "RunRelevantTests",
        "waitMinutes": 180
      }
    }
  }
}
```

An environment must map to exactly one profile in `SF_ORGS_CONFIG`. An unknown,
ambiguous, disabled, or disallowed selection fails before authentication. Policies
are selected using the source branch, including existing exact/glob matching rules.
Environment protection rules must permit the trusted workflow code branch; they
do not replace this source-branch policy check. Protect routing variables and require
review for workflow/action/source changes before granting production secrets.

Preparation captures both variables and pins the selected branch tips and commit
range. Moving a branch while the run waits for approval cannot change its payload.

## Source Selection

**Full Branch** takes no commit inputs. It uses all configured source directories
at the pinned branch tip. No previous deployment or bootstrap is needed. This is
an additive deployment, not a mirror: metadata absent from Git is not deleted.

**Commit Range** takes two full 40-character SHAs on the selected branch. Both
endpoints are included. For `A -> B -> C -> D`, selecting B through D compares B's
first parent (A) with D, and uses source files at D. A single-commit range B through
B is supported. A range beginning at the root commit compares an empty tree with
the end commit. Reversed, unrelated, or off-branch ranges are rejected. This is a
net diff, not replay of individual commits; edits reverted by the end are absent.

**Branch Changes** compares a source branch with its common ancestor with a
comparison branch. For `release/x` against `main`, it includes source-branch
changes since their merge base, using files at the pinned `release/x` tip. It does
not merge the branches or validate a synthetic merge result. Changes present only
on `main` are not included. Branches must share history.

Both delta selectors reject in-scope deletions/renames because destructive changes
are not implemented. Delta changes to `sfdx-project.json` or `.forceignore` require
Full Branch. Clean pinned checkouts and source/config symlink checks still apply.

## Operations

| Operation            | Behavior                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `validate`           | Dry-run the explicit payload and save a validation check record. No metadata is committed.                         |
| `deploy`             | Deploy the explicit payload and configured tests, recording the actual outcome for audit.                          |
| Quick Deploy         | Enter `validation:123` from a successful validation. Reuse its exact server-side payload.                          |
| Reconcile Deployment | Enter `validation:123` or `deployment:456` to report an already-recorded Salesforce job. Never submit another job. |

References are prefixed GitHub check/deployment record IDs, not Salesforce IDs
starting with `0Af`. Summaries/outputs provide both. Utilities derive the branch,
commit, mode, and range from the saved context rather than asking for them again.
They verify the actual org identity and current branch-policy authorization.
Quick Deploy also checks that deployment settings still match the validation.

`RunRelevantTests` remains the default. A successful validation is **not assumed**
to guarantee Quick Deploy eligibility: Salesforce accepts or rejects the request,
including its validation-age/test/coverage requirements. The workflow never infers
eligibility solely from a nonzero or zero test count and never switches to
`RunLocalTests` automatically. If Salesforce definitively rejects Quick Deploy,
choose an appropriate normal-deploy workflow explicitly. Commit Range can select
the original end commit after the branch moves; Full Branch always selects the
current pinned tip, so revalidate if you need to deploy a newer full payload. Do not
retry an ambiguous submission or timeout until its actual state is resolved.

## Audit-Only History

Deployment records never choose the start/end commit, payload, or permission to
start another explicit release. No successful deployment baseline is required.
Operators are responsible for choosing ranges appropriate for the target org;
ancestry checks cannot prove that earlier changes or dependencies exist there.

Missing, stale, or unrelated audit history does not change a selected payload or
block its execution. Failures to create/update audit records warn without changing
the Salesforce outcome. Saved references must still exist for Quick Deploy or
reconciliation, because these utilities explicitly request that saved job context.

## History and Recovery

Actual deployments use GitHub deployment records with task `sf-metadata-release-v1`.
They store org key/ID, branch and explicit commit range, operation, settings, and a
deterministic payload-definition fingerprint; statuses store the Salesforce job ID.
The fingerprint describes pinned inputs, not Salesforce's final deployment ZIP.

Manual validations use check runs named **Release validation**, not deployment
objects. Environment jobs use `deployment: false`, keeping secrets, required
reviewers, wait timers, and branch policies without automatic misleading deployment
records. Custom GitHub App deployment protection rules are incompatible and fail
the job; do not silently disable them. Existing deployment records are not deleted.

All operations share a per-org concurrency group with `cancel-in-progress: false`.
GitHub can replace pending runs; do not rely on dispatch ordering. Source selection
stays pinned even while jobs wait for the execution lock.
Use one stable profile key/environment per actual org and a single release repository.
Different repositories or profile aliases do not share this lock/history.

If a run stops after saving a job ID, run **reconcile** with its release record ID.
It verifies the actual org, job ID, `checkOnly`, completion, and success before
updating the audit outcome. It cannot relabel a dry run as an actual deployment.
History does not automatically block later jobs, so operators must resolve unknown
or still-running Salesforce jobs before deliberately submitting another operation.

There is an unavoidable gap between Salesforce accepting a job and GitHub saving
its ID. If that write fails, or submission returns an ambiguous error with no ID,
the report/log may be the only recovery reference. An administrator must inspect Salesforce and repair the
recorded job association/status through the GitHub API only after establishing what
actually happened; do not mark an unknown deployment successful or submit duplicates.

Quick Deploy clicked directly in Salesforce is **not automatically reconciled**.
Its resulting deployment ID is not linked by this workflow to the saved validation;
the report alone does not prove which Git commit was deployed. Perform Quick Deploy
through this workflow to preserve the link. Out-of-band changes require an operator
review process; this action cannot discover or safely label them.

## Permissions and Reports

Preparation needs `contents: read`, `checks: read`, and `deployments: read`. Execution needs
`contents: read`, `checks: write`, and `deployments: write`, environment approval, and the three JWT
secrets named by the selected profile. It uses isolated temporary authentication
state and cleans it on normal/caught completion. Use ephemeral runners; hard kills
still require runner cleanup. The workflow installs `@salesforce/cli` without a
version suffix, so npm resolves its current latest release.

Each caller must set `secrets: inherit` on its job calling `release-execution.yml`.
GitHub requires secrets to be forwarded across that reusable-workflow boundary,
even when their values come from the environment selected by the called job.
Keep JWT values in environment secrets; matching environment secrets take
precedence over repository/organization secrets. Profile fields contain secret
names only. A preflight step checks those names before installing Salesforce CLI
and reports missing names without printing credential values.

Reports are sanitized, uploaded even after failure when available, and retained
for 10 days. Raw login output and credentials are never intentionally published.
Keep `waitMinutes` below the 360-minute runner limit with time for setup. Workflow
and all generated action `dist/` files must be committed before dispatching; the
workflow must exist on the default branch for the manual Run workflow UI.
