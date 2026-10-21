# Manual Salesforce Releases

Use **Actions > Salesforce Manual Release > Run workflow**. This workflow never
runs automatically after a PR merge. Its default operation is **validate**, which
does not change Salesforce metadata or advance the actual deployment baseline.

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

Preparation captures both variables and pins the branch tip. Optional **to-sha**
selects a full 40-character commit SHA that must belong to the source branch.
Moving the branch while a run waits for approval does not change the payload.

## Operations

| Operation      | Behavior                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`     | Submit a dry run, save its Salesforce job ID and GitHub release record ID. Never advance the actual baseline.                            |
| `deploy`       | Submit an actual deployment using the pinned source commit and configured tests. Advance the baseline only after complete success.       |
| `quick-deploy` | Enter the **GitHub release record ID** from a successful validation. Deploy its existing server-side payload, not the latest branch tip. |
| `reconcile`    | Enter a previous **GitHub release record ID** to report its already-recorded Salesforce job. Never submit another deployment.            |

Record IDs are GitHub deployment record IDs, not Salesforce IDs starting with `0Af`.
The run summary/outputs provide both. Quick Deploy requires the same source branch,
environment, org identity, and deployment settings; its saved payload mode wins over
the form's mode selector. The selected branch must still contain the saved commit.

`RunRelevantTests` remains the default. A successful validation is **not assumed**
to guarantee Quick Deploy eligibility: Salesforce accepts or rejects the request,
including its validation-age/test/coverage requirements. The workflow never infers
eligibility solely from a nonzero or zero test count and never switches to
`RunLocalTests` automatically. If Salesforce definitively rejects Quick Deploy,
choose `deploy` explicitly, with the saved validation's commit in **to-sha** and its
mode, to deploy the same payload definition using normal deployment/tests. Do not
retry an ambiguous submission or timeout until its actual state is resolved.

## Baselines and Cumulative Delta

Each org profile tracks its last **successful actual metadata release**. Delta
means all supported source changes from that commit to the selected source commit,
not just one PR. Validation-only runs never move this baseline. Full mode deploys
the configured source directories at the selected commit.

For an org without a baseline, first choose **full**. A full validation can be
followed by Quick Deploy when Salesforce permits it, or by a normal full deployment
of the same commit. Only the successful actual operation bootstraps history.

The previous actual release must be an ancestor of the new commit, even in full
mode. Rollbacks, unrelated branches, dirty checkouts, and source/config symlinks are
rejected. Delta changes to the project configuration or `.forceignore` require full
mode. Metadata removals and renames are rejected, including in full mode when a
baseline exists: destructive changes are not implemented. Full mode is an additive
deployment, not an exact mirror or deletion of existing org metadata.

Another tracked actual release after validation makes that validation stale for
Quick Deploy, even if its commit is unchanged. Revalidate against the current
baseline. Salesforce still determines whether the saved validation itself is usable.

## History and Recovery

Explicit GitHub deployment records use task `sf-metadata-release-v1` and a versioned
payload containing org key/ID, source branch/commit, previous baseline, settings,
and a deterministic payload-definition fingerprint. Statuses store the Salesforce
job ID. The fingerprint describes pinned inputs, not a hash of Salesforce's final
deployment ZIP. Validation receipts are distinguished from actual releases.

Ordinary automatic environment records, PR validations, and connection checks are
never used as actual release baselines. Failed, incomplete, canceled, or partially
successful actual operations never advance the baseline. Keep these explicit
records/statuses: deleting or altering them destroys the tracking guarantees.

All operations share a per-org concurrency group with `cancel-in-progress: false`.
GitHub concurrency is not FIFO and can replace pending runs. Baselines are read
again under the execution lock; ancestry checks reject a superseded older target.
Use one stable profile key/environment per actual org and a single release repository.
Different repositories or profile aliases do not share this lock/history.

If a run stops after saving a job ID, run **reconcile** with its release record ID.
It verifies the actual org, job ID, `checkOnly`, completion, success, and unchanged
baseline before recording success. An unresolved actual operation blocks subsequent
releases. Reconciliation cannot relabel a dry run as an actual deployment.

There is an unavoidable gap between Salesforce accepting a job and GitHub saving
its ID. If that write fails, or submission returns an ambiguous error with no ID,
history stays unresolved. An administrator must inspect Salesforce and repair the
recorded job association/status through the GitHub API only after establishing what
actually happened; do not mark an unknown deployment successful or submit duplicates.

Quick Deploy clicked directly in Salesforce is **not automatically reconciled**.
Its resulting deployment ID is not linked by this workflow to the saved validation;
the report alone does not prove which Git commit was deployed. Perform Quick Deploy
through this workflow to preserve the link. Out-of-band changes require an operator
review/rebaseline process; this action cannot discover or safely label them.

## Permissions and Reports

Preparation needs `contents: read` and `deployments: read`. Execution needs
`contents: read` and `deployments: write`, environment approval, and the three JWT
secrets named by the selected profile. It uses isolated temporary authentication
state and cleans it on normal/caught completion. Use ephemeral runners; hard kills
still require runner cleanup. The workflow installs `@salesforce/cli` without a
version suffix, so npm resolves its current latest release.

Reports are sanitized, uploaded even after failure when available, and retained
for 10 days. Raw login output and credentials are never intentionally published.
Keep `waitMinutes` below the 360-minute runner limit with time for setup. Workflow
and all generated action `dist/` files must be committed before dispatching; the
workflow must exist on the default branch for the manual Run workflow UI.
