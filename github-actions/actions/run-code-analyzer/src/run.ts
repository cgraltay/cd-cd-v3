import type { getOctokit } from '@actions/github';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deletePullRequestComment,
  upsertPullRequestComment
} from '../../../shared/pr-comment';
import {
  analyzerArgs,
  inlineComments,
  parseAnalyzerReport,
  reviewCommentMarker,
  selectFiles,
  type AnalyzerPolicy
} from './analyzer';

interface AnalyzerOptions {
  client: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  workspace: string;
  policy: AnalyzerPolicy;
  tempDirectory?: string;
  execute?: (args: string[], workspace: string) => Promise<number>;
  warn?: (message: string) => void;
}

async function executeAnalyzer(
  args: string[],
  workspace: string
): Promise<number> {
  const { getExecOutput } = await import('@actions/exec');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== 'GITHUB_TOKEN' &&
        key !== 'INPUT_GITHUB-TOKEN'
    )
  ) as Record<string, string>;
  const result = await getExecOutput('sf', args, {
    cwd: workspace,
    env,
    ignoreReturnCode: true
  });
  return result.exitCode;
}

export async function analyzePullRequest(options: AnalyzerOptions) {
  const { client, owner, repo, number, headSha, workspace, policy } = options;
  const result = {
    skipped: true,
    filesAnalyzed: 0,
    violations: 0,
    blockingViolations: 0,
    inlineComments: 0,
    reportPath: ''
  };
  if (!policy.enabled) {
    return result;
  }

  const changedFiles = await client.paginate(client.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100
  });
  const files = selectFiles(changedFiles, policy.packageDirectories);
  let report = parseAnalyzerReport('{"violations":[]}');
  if (files.length > 0) {
    const configPath = path.resolve(workspace, policy.configPath);
    if (!existsSync(configPath)) {
      throw new Error(
        'Salesforce Code Analyzer config was not found. Provide codeAnalyzer.configPath and its referenced rulesets.'
      );
    }
    const outputDirectory = mkdtempSync(
      path.join(
        options.tempDirectory ?? process.env.RUNNER_TEMP ?? tmpdir(),
        'sf-code-analyzer-'
      )
    );
    result.reportPath = path.join(outputDirectory, 'codeanalyzerresult.json');
    const exitCode = await (options.execute ?? executeAnalyzer)(
      analyzerArgs(policy, files, configPath, result.reportPath),
      workspace
    );
    if (exitCode !== 0) {
      throw new Error(
        `Salesforce Code Analyzer failed with exit code ${exitCode}. Previous feedback was preserved.`
      );
    }
    if (!existsSync(result.reportPath)) {
      throw new Error(
        'Salesforce Code Analyzer did not write its JSON report. Previous feedback was preserved.'
      );
    }
    report = parseAnalyzerReport(readFileSync(result.reportPath, 'utf8'));
    result.skipped = false;
    result.filesAnalyzed = files.length;
    result.violations = report.violations.length;
    result.blockingViolations = report.violations.filter(
      (violation) => violation.severity <= policy.failOnSeverity
    ).length;
  }

  try {
    const existing = await client.paginate(
      client.rest.pulls.listReviewComments,
      { owner, repo, pull_number: number, per_page: 100 }
    );
    for (const comment of existing) {
      if (
        comment.user?.type === 'Bot' &&
        (comment.body.includes(reviewCommentMarker) ||
          comment.body.includes('<!-- run-code-analyzer -->'))
      ) {
        try {
          await client.rest.pulls.deleteReviewComment({
            owner,
            repo,
            comment_id: comment.id
          });
        } catch (error) {
          if ((error as { status?: number }).status !== 404) {
            throw error;
          }
        }
      }
    }
    for (const comment of inlineComments(report, files, workspace).slice(
      0,
      policy.maxInlineComments
    )) {
      await client.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: number,
        commit_id: headSha,
        ...comment
      });
      result.inlineComments += 1;
    }

    const pullRequest = { owner, repo, number };
    if (result.violations > 0) {
      await upsertPullRequestComment(client, pullRequest, {
        key: 'run-code-analyzer',
        body: [
          '## Salesforce Code Analyzer',
          '',
          `Analyzed files: ${result.filesAnalyzed}. Violations: ${result.violations}. Blocking violations: ${result.blockingViolations}.`,
          '',
          `Inline comments created: ${result.inlineComments} (limit ${policy.maxInlineComments}). Findings outside the reviewable diff still count toward the failure threshold.`,
          '',
          'See the JSON report artifact for the complete findings.'
        ].join('\n')
      });
    } else {
      await deletePullRequestComment(client, pullRequest, {
        key: 'run-code-analyzer'
      });
    }
  } catch {
    options.warn?.(
      'Unable to synchronize analyzer PR feedback. Grant pull-requests: write; fork PR tokens may be read-only. Analysis and severity results are unchanged.'
    );
  }
  return result;
}
