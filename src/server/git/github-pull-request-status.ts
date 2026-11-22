import type { GitPreMergeCheck } from "../../shared/contracts";
import { RestrictedCliError, runRestrictedCli } from "../restricted-cli-runner";
import { classifyGitHubCliFailure } from "./github-issue-report";
import { parseGitHubCheck } from "./github-pre-merge";
import {
  githubRepositorySlug,
  resolveGitHubCli,
  verifiedGitHubPullRequestUrl,
  type GitHubPullRequestDependencies,
} from "./github-pull-request";
import { inspectGitRemoteRouting } from "./remote-routing";
import { runGitInspection } from "./runner";
import { GitError } from "./types";

/** Every check GitHub reports is counted; at most this many are parsed. */
export const MAX_PULL_REQUEST_CHECKS = 100;
const MAX_LIST_OUTPUT_BYTES = 64 * 1024;
const MAX_VIEW_OUTPUT_BYTES = 1024 * 1024;
const MAX_LISTED_PULL_REQUESTS = 30;
const LIST_FIELDS = "number,state,headRefName,isCrossRepository,headRepositoryOwner,updatedAt";
const VIEW_FIELDS = [
  "number", "url", "title", "state", "isDraft", "headRefName", "headRefOid",
  "baseRefName", "mergeable", "mergeStateStatus", "reviewDecision", "updatedAt",
  "statusCheckRollup",
].join(",");
const STATES = new Set(["OPEN", "CLOSED", "MERGED"]);
const MERGEABLE = new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
const REVIEW_DECISIONS = new Set(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

type UnknownRecord = Record<string, unknown>;

export interface GitHubPullRequestStatusDependencies extends GitHubPullRequestDependencies {
  runCli?: typeof runRestrictedCli;
}

export interface GitHubPullRequestStatus {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  head: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState: string;
  reviewDecision: string | null;
  updatedAt: string;
  checks: GitPreMergeCheck[];
  /** Checks GitHub reported, including any past the parsed cap. */
  totalChecks: number;
}

export type GitHubPullRequestLookup =
  | { kind: "pull-request"; branch: string; localHead: string | null; pullRequest: GitHubPullRequestStatus }
  | { kind: "none"; reason: "detached-head" | "no-github-remote" | "no-pull-request"; branch: string | null };

export type GitHubPullRequestStatusErrorCode =
  | "github_cli_unavailable"
  | "github_cli_unauthenticated"
  | "github_unavailable"
  | "github_timeout";

export class GitHubPullRequestStatusError extends Error {
  constructor(readonly code: GitHubPullRequestStatusErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubPullRequestStatusError";
  }
}

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function malformed(): GitHubPullRequestStatusError {
  return new GitHubPullRequestStatusError("github_unavailable", "GitHub returned malformed pull request data.");
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw malformed();
  }
}

function cliFailure(error: unknown): unknown {
  if (!(error instanceof RestrictedCliError)) return error;
  if (error.code === "unavailable") {
    return new GitHubPullRequestStatusError("github_cli_unavailable", "GitHub CLI (gh) is not installed or could not be started.", { cause: error });
  }
  if (error.code === "timeout") {
    return new GitHubPullRequestStatusError("github_timeout", "GitHub did not answer in time.", { cause: error });
  }
  if (error.reason === "signed-out") {
    return new GitHubPullRequestStatusError("github_cli_unauthenticated", "GitHub CLI is not signed in. The user can run gh auth login.", { cause: error });
  }
  const message = error.code === "output-limit"
    ? "GitHub returned more data than Inertia can safely process."
    : error.reason === "offline"
      ? "GitHub could not be reached."
      : error.reason === "rate-limited"
        ? "GitHub's rate limit was reached. Try again later."
        : error.reason === "repository"
          ? "GitHub CLI cannot read this repository."
          : "GitHub could not load the pull request.";
  return new GitHubPullRequestStatusError("github_unavailable", message, { cause: error });
}

async function optionalGitLine(
  root: string,
  args: string[],
  options: { deadlineAt: number; signal?: AbortSignal },
): Promise<string | null> {
  try {
    const result = await runGitInspection(root, args, {
      ...options,
      maxOutputBytes: 4_096,
      failureMessage: "Unable to read the current branch.",
    });
    return result.stdout.toString("utf8").trim() || null;
  } catch (error) {
    if (error instanceof GitError && error.code === "operation-failed") return null;
    throw error;
  }
}

/** The newest open pull request whose head is `branch` from `headOwner`, else the newest closed or merged one. */
function chooseListed(source: string, branch: string, headOwner: string | null): number | null {
  const parsed = parseJson(source);
  if (!Array.isArray(parsed)) throw malformed();
  const candidates = parsed.filter((entry): entry is UnknownRecord => (
    record(entry)
    && text(entry.headRefName) === branch
    && STATES.has(text(entry.state))
    && Number.isSafeInteger(entry.number) && Number(entry.number) > 0
    && (headOwner === null
      ? entry.isCrossRepository !== true
      : entry.isCrossRepository === true
        && record(entry.headRepositoryOwner)
        && text(entry.headRepositoryOwner.login).toLowerCase() === headOwner.toLowerCase())
  ));
  const newest = (entries: UnknownRecord[]) => entries
    .sort((left, right) => text(right.updatedAt).localeCompare(text(left.updatedAt), "en"))[0];
  const chosen = newest(candidates.filter(({ state }) => state === "OPEN")) ?? newest(candidates);
  return chosen ? Number(chosen.number) : null;
}

function parseView(source: string, repositoryBaseUrl: string, expectedNumber: number): GitHubPullRequestStatus {
  const value = parseJson(source);
  if (!record(value) || value.number !== expectedNumber) throw malformed();
  const url = verifiedGitHubPullRequestUrl(text(value.url), repositoryBaseUrl, expectedNumber);
  const state = text(value.state).toUpperCase();
  const mergeable = text(value.mergeable).toUpperCase() || "UNKNOWN";
  const head = text(value.headRefOid).toLowerCase();
  const reviewDecision = value.reviewDecision === null || value.reviewDecision === "" ? null : text(value.reviewDecision);
  if (
    !url
    || !STATES.has(state)
    || !MERGEABLE.has(mergeable)
    || typeof value.isDraft !== "boolean"
    || !text(value.headRefName)
    || !text(value.baseRefName)
    || !/^[0-9a-f]{40,64}$/u.test(head)
    || (reviewDecision !== null && !REVIEW_DECISIONS.has(reviewDecision))
  ) throw malformed();
  const rollup = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  return {
    number: expectedNumber,
    url,
    title: text(value.title).slice(0, 512),
    state: state as GitHubPullRequestStatus["state"],
    draft: value.isDraft,
    baseBranch: text(value.baseRefName).slice(0, 255),
    headBranch: text(value.headRefName).slice(0, 255),
    head,
    mergeable: mergeable as GitHubPullRequestStatus["mergeable"],
    mergeState: text(value.mergeStateStatus).toUpperCase().slice(0, 64) || "UNKNOWN",
    reviewDecision,
    updatedAt: text(value.updatedAt).slice(0, 64),
    checks: rollup.slice(0, MAX_PULL_REQUEST_CHECKS)
      .map((entry) => parseGitHubCheck(entry, repositoryBaseUrl))
      .filter((entry): entry is GitPreMergeCheck => entry !== null),
    totalChecks: rollup.length,
  };
}

/**
 * The GitHub pull request for the branch checked out at `root`: the newest
 * open one whose head is that branch in the branch's push repository, or in
 * the repository it was forked from, otherwise the newest closed or merged
 * one. Reads use GitHub CLI through the restricted runner, within one
 * deadline and the caller's cancellation.
 */
export async function inspectGitHubPullRequestStatus(
  root: string,
  options: { deadlineAt: number; signal?: AbortSignal },
  dependencies: GitHubPullRequestStatusDependencies = {},
): Promise<GitHubPullRequestLookup> {
  const gitOptions = { deadlineAt: options.deadlineAt, signal: options.signal };
  const branch = await optionalGitLine(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], gitOptions);
  if (!branch) return { kind: "none", reason: "detached-head", branch: null };
  const localHead = await optionalGitLine(root, ["rev-parse", "--verify", "--quiet", "HEAD"], gitOptions);
  const routing = await inspectGitRemoteRouting(root, branch, gitOptions);
  let sourceSlug: string;
  try {
    if (routing.target?.forge !== "github") throw new Error("Not a GitHub remote.");
    sourceSlug = githubRepositorySlug(routing.target.baseUrl);
  } catch {
    return { kind: "none", reason: "no-github-remote", branch };
  }
  const runCli = dependencies.runCli ?? runRestrictedCli;
  try {
    const gh = await resolveGitHubCli(dependencies, { signal: options.signal });
    const run = async (args: string[], maxOutputBytes: number): Promise<string> => (await runCli(gh.executable, args, {
      cwd: root,
      environment: gh.environment,
      signal: options.signal,
      timeoutMs: Math.max(1_000, options.deadlineAt - Date.now()),
      maxOutputBytes,
      failureMessage: "GitHub could not load the pull request.",
      classifyFailure: classifyGitHubCliFailure,
    }, dependencies)).stdout;
    const list = async (repository: string) => await run([
      "pr", "list", "--repo", repository, "--head", branch, "--state", "all",
      "--limit", String(MAX_LISTED_PULL_REQUESTS), "--json", LIST_FIELDS,
    ], MAX_LIST_OUTPUT_BYTES);
    let repository = sourceSlug;
    let number = chooseListed(await list(sourceSlug), branch, null);
    if (number === null) {
      // A fork's pull requests live in the repository it was forked from.
      const parent = parseJson(await run(["repo", "view", sourceSlug, "--json", "parent"], MAX_LIST_OUTPUT_BYTES));
      const parentRecord = record(parent) && record(parent.parent) ? parent.parent : null;
      const owner = parentRecord && record(parentRecord.owner) ? text(parentRecord.owner.login) : "";
      const parentSlug = `${owner}/${parentRecord ? text(parentRecord.name) : ""}`;
      if (SLUG.test(parentSlug)) {
        number = chooseListed(await list(parentSlug), branch, sourceSlug.split("/")[0]!);
        repository = parentSlug;
      }
    }
    if (number === null) return { kind: "none", reason: "no-pull-request", branch };
    const view = await run(["pr", "view", String(number), "--repo", repository, "--json", VIEW_FIELDS], MAX_VIEW_OUTPUT_BYTES);
    return {
      kind: "pull-request",
      branch,
      localHead,
      pullRequest: parseView(view, `https://github.com/${repository}`, number),
    };
  } catch (error) {
    throw cliFailure(error);
  }
}
