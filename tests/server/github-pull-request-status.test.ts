import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitHubPullRequestStatusError,
  inspectGitHubPullRequestStatus,
  MAX_PULL_REQUEST_CHECKS,
} from "../../src/server/git/github-pull-request-status";
import { RestrictedCliError, type runRestrictedCli } from "../../src/server/restricted-cli-runner";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const BRANCH = "feature/status";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function repository(remote = "https://github.com/acme/widgets.git"): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "inertia-pr-status-"));
  directories.push(root);
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("add", "README.md");
  await git("-c", "user.name=Inertia", "-c", "user.email=test@inertia.local", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  await git("branch", "-m", BRANCH);
  await git("remote", "add", "origin", remote);
  return { root, head: await git("rev-parse", "HEAD") };
}

function listed(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    state: "OPEN",
    headRefName: BRANCH,
    isCrossRepository: false,
    headRepositoryOwner: { login: "acme" },
    updatedAt: "2026-11-20T10:00:00Z",
    ...overrides,
  };
}

function viewed(number: number, head: string, repository = "acme/widgets", overrides: Record<string, unknown> = {}) {
  return {
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    title: "Add status",
    state: "OPEN",
    isDraft: false,
    headRefName: BRANCH,
    headRefOid: head,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    updatedAt: "2026-11-20T10:00:00Z",
    statusCheckRollup: [
      { name: "Linux", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Windows", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/${repository}/actions/runs/1` },
      { name: "macOS", workflowName: "CI", status: "IN_PROGRESS", conclusion: "" },
      { context: "external/ci", state: "FAILURE", targetUrl: "https://ci.example.test/build/9" },
    ],
    ...overrides,
  };
}

type Responder = (args: readonly string[]) => unknown;

function gh(respond: Responder) {
  const runCli = vi.fn<typeof runRestrictedCli>(async (_executable, args) => ({
    stdout: JSON.stringify(respond(args)),
    stderr: "",
  }));
  return {
    runCli,
    dependencies: {
      environment: async () => ({ env: { PATH: "/fake" }, pathEntries: ["/fake"] }),
      executableCandidates: async () => ["/fake/gh"],
      runCli,
    },
  };
}

const options = () => ({ deadlineAt: Date.now() + 20_000 });

describe("inspectGitHubPullRequestStatus", () => {
  it("reads the open pull request of the branch with its checks, through two bounded GitHub CLI reads", async () => {
    const { root, head } = await repository();
    const signal = new AbortController().signal;
    const { runCli, dependencies } = gh((args) => args[1] === "list" ? [listed(7)] : viewed(7, head));
    const deadlineAt = Date.now() + 20_000;
    const lookup = await inspectGitHubPullRequestStatus(root, { deadlineAt, signal }, dependencies);
    expect(lookup).toMatchObject({
      kind: "pull-request",
      branch: BRANCH,
      localHead: head,
      pullRequest: {
        number: 7,
        url: "https://github.com/acme/widgets/pull/7",
        state: "OPEN",
        draft: false,
        baseBranch: "main",
        headBranch: BRANCH,
        head,
        mergeable: "MERGEABLE",
        mergeState: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
        totalChecks: 4,
      },
    });
    if (lookup.kind !== "pull-request") throw new Error("Expected a pull request.");
    expect(lookup.pullRequest.checks.map(({ name, state, detailsUrl }) => [name, state, detailsUrl])).toEqual([
      ["Linux", "passed", null],
      ["Windows", "failed", "https://github.com/acme/widgets/actions/runs/1"],
      ["macOS", "pending", null],
      // A details link outside the pull request's repository is dropped.
      ["external/ci", "failed", null],
    ]);
    expect(runCli.mock.calls.map(([, args]) => args)).toEqual([
      ["pr", "list", "--repo", "acme/widgets", "--head", BRANCH, "--state", "all", "--limit", "30", "--json", "number,state,headRefName,isCrossRepository,headRepositoryOwner,updatedAt"],
      ["pr", "view", "7", "--repo", "acme/widgets", "--json", expect.stringContaining("statusCheckRollup")],
    ]);
    for (const [executable, , cli] of runCli.mock.calls) {
      expect(executable).toBe("/fake/gh");
      expect(cli.signal).toBe(signal);
      expect(cli.timeoutMs).toBeLessThanOrEqual(20_000);
      expect(cli.classifyFailure?.("To get started with GitHub CLI, please run:  gh auth login")).toBe("signed-out");
    }
  });

  it("prefers the newest open pull request of this repository over a merged one and a fork's same-named branch", async () => {
    const { root, head } = await repository();
    const { runCli, dependencies } = gh((args) => args[1] === "list"
      ? [
          listed(3, { state: "MERGED", updatedAt: "2026-11-21T10:00:00Z" }),
          listed(4, { isCrossRepository: true, headRepositoryOwner: { login: "mallory" }, updatedAt: "2026-11-22T10:00:00Z" }),
          listed(5, { headRefName: "feature/other" }),
          listed(6, { updatedAt: "2026-11-19T10:00:00Z" }),
        ]
      : viewed(Number(args[2]), head));
    const lookup = await inspectGitHubPullRequestStatus(root, options(), dependencies);
    expect(lookup).toMatchObject({ kind: "pull-request", pullRequest: { number: 6 } });
    expect(runCli.mock.calls[1]?.[1].slice(0, 3)).toEqual(["pr", "view", "6"]);
  });

  it("falls back to the newest closed or merged pull request", async () => {
    const { root, head } = await repository();
    const { dependencies } = gh((args) => args[1] === "list"
      ? [listed(3, { state: "CLOSED" }), listed(8, { state: "MERGED", updatedAt: "2026-11-21T10:00:00Z" })]
      : viewed(8, head, "acme/widgets", { state: "MERGED", mergeable: "UNKNOWN", reviewDecision: null }));
    await expect(inspectGitHubPullRequestStatus(root, options(), dependencies)).resolves.toMatchObject({
      kind: "pull-request",
      pullRequest: { number: 8, state: "MERGED", mergeable: "UNKNOWN", reviewDecision: null },
    });
  });

  it("finds a fork's pull request in the repository it was forked from, only from the fork's owner", async () => {
    const { root, head } = await repository();
    const { runCli, dependencies } = gh((args) => {
      if (args[0] === "repo") return { parent: { name: "widgets", owner: { login: "upstream" } } };
      if (args[1] === "list" && args[3] === "acme/widgets") return [];
      if (args[1] === "list") {
        return [
          listed(11, { isCrossRepository: true, headRepositoryOwner: { login: "mallory" }, updatedAt: "2026-11-22T10:00:00Z" }),
          listed(12, { isCrossRepository: true, headRepositoryOwner: { login: "ACME" } }),
          listed(13, { isCrossRepository: false }),
        ];
      }
      return viewed(12, head, "upstream/widgets");
    });
    await expect(inspectGitHubPullRequestStatus(root, options(), dependencies)).resolves.toMatchObject({
      kind: "pull-request",
      pullRequest: { number: 12, url: "https://github.com/upstream/widgets/pull/12" },
    });
    expect(runCli.mock.calls.map(([, args]) => args.slice(0, 5))).toEqual([
      ["pr", "list", "--repo", "acme/widgets", "--head"],
      ["repo", "view", "acme/widgets", "--json", "parent"],
      ["pr", "list", "--repo", "upstream/widgets", "--head"],
      ["pr", "view", "12", "--repo", "upstream/widgets"],
    ]);
  });

  it("answers no pull request without an error, and never runs GitHub CLI for a detached HEAD or a remote that is not GitHub", async () => {
    const { root } = await repository();
    const empty = gh((args) => args[0] === "repo" ? { parent: null } : []);
    await expect(inspectGitHubPullRequestStatus(root, options(), empty.dependencies))
      .resolves.toEqual({ kind: "none", reason: "no-pull-request", branch: BRANCH });

    const unused = gh(() => {
      throw new Error("GitHub CLI must not run.");
    });
    const gitlab = await repository("https://gitlab.com/acme/widgets.git");
    await expect(inspectGitHubPullRequestStatus(gitlab.root, options(), unused.dependencies))
      .resolves.toEqual({ kind: "none", reason: "no-github-remote", branch: BRANCH });
    await execFileAsync("git", ["checkout", "-q", "--detach"], { cwd: root });
    await expect(inspectGitHubPullRequestStatus(root, options(), unused.dependencies))
      .resolves.toEqual({ kind: "none", reason: "detached-head", branch: null });
    expect(unused.runCli).not.toHaveBeenCalled();
  });

  it("parses at most the capped number of checks but reports how many GitHub has", async () => {
    const { root, head } = await repository();
    const rollup = Array.from({ length: MAX_PULL_REQUEST_CHECKS + 20 }, (_, index) => ({
      name: `check ${index}`, status: "COMPLETED", conclusion: "SUCCESS",
    }));
    const { dependencies } = gh((args) => args[1] === "list" ? [listed(7)] : viewed(7, head, "acme/widgets", { statusCheckRollup: rollup }));
    const lookup = await inspectGitHubPullRequestStatus(root, options(), dependencies);
    if (lookup.kind !== "pull-request") throw new Error("Expected a pull request.");
    expect(lookup.pullRequest.checks).toHaveLength(MAX_PULL_REQUEST_CHECKS);
    expect(lookup.pullRequest.totalChecks).toBe(MAX_PULL_REQUEST_CHECKS + 20);
  });

  it.each([
    ["GitHub CLI is missing", { candidates: [] }, "github_cli_unavailable"],
    ["GitHub CLI is not signed in", { stderr: "To get started with GitHub CLI, please run:  gh auth login" }, "github_cli_unauthenticated"],
    ["GitHub cannot be reached", { stderr: "error connecting to api.github.com" }, "github_unavailable"],
    ["GitHub CLI times out", { error: new RestrictedCliError("timeout", "gh took too long to complete.") }, "github_timeout"],
    ["GitHub returns malformed data", { stdout: "not json" }, "github_unavailable"],
    ["GitHub returns a pull request for another repository", { view: { url: "https://github.com/evil/widgets/pull/7" } }, "github_unavailable"],
  ] as const)("returns %s as a GitHub status error", async (_name, failure, code) => {
    const { root, head } = await repository();
    const runCli = vi.fn<typeof runRestrictedCli>(async (_executable, args, cli) => {
      if ("error" in failure) throw failure.error;
      if ("stderr" in failure) {
        throw new RestrictedCliError("failed", cli.failureMessage, undefined, cli.classifyFailure?.(failure.stderr) ?? null);
      }
      if ("stdout" in failure) return { stdout: failure.stdout, stderr: "" };
      const view = "view" in failure ? { ...viewed(7, head), ...failure.view } : viewed(7, head);
      return { stdout: JSON.stringify(args[1] === "list" ? [listed(7)] : view), stderr: "" };
    });
    const error = await inspectGitHubPullRequestStatus(root, options(), {
      environment: async () => ({ env: { PATH: "/fake" }, pathEntries: ["/fake"] }),
      executableCandidates: async () => ("candidates" in failure ? [...failure.candidates] : ["/fake/gh"]),
      runCli,
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubPullRequestStatusError);
    expect((error as GitHubPullRequestStatusError).code).toBe(code);
    expect((error as Error).message).not.toMatch(/\/fake|acme|api\.github\.com/u);
  });
});
