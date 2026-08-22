import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gitHubPreMergeTestSupport,
  inspectGitHubPreMergeConfidence,
} from "../../src/server/git/github-pre-merge";
import type { runRestrictedCli } from "../../src/server/restricted-cli-runner";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function repository(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "inertia-pre-merge-"));
  directories.push(root);
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", [
    "-c", "user.name=Inertia", "-c", "user.email=test@inertia.local",
    "commit", "-qm", "fixture",
  ], { cwd: root });
  await execFileAsync("git", ["branch", "-m", "feature/confidence"], {
    cwd: root,
  });
  await execFileAsync("git", [
    "remote", "add", "origin", "https://github.com/openai/codex.git",
  ], { cwd: root });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
  });
  return { root, head: stdout.trim() };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("GitHub pre-merge confidence", () => {
  it("marks only a stable exact head with clean reviews and complete platforms ready", async () => {
    const { root, head } = await repository();
    const pullRequest = {
      number: 42,
      url: "https://github.com/openai/codex/pull/42",
      title: "Add exact-head confidence",
      state: "OPEN",
      isDraft: false,
      headRefName: "feature/confidence",
      headRefOid: head,
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      updatedAt: "2026-08-22T15:00:00Z",
      changedFiles: 3,
      body: "## Verification\n\nAuthor-entered claim",
      files: [
        { path: "src/server/git/github-pre-merge.ts", additions: 10, deletions: 2 },
        { path: "tests/server/github-pre-merge.test.ts", additions: 8, deletions: 0 },
        { path: "src/renderer/src/components/PreMergeConfidenceDialog.tsx", additions: 12, deletions: 1 },
      ],
      statusCheckRollup: [
        { name: "Linux x64", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Windows x64", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "macOS arm64", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    };
    const runCli = vi.fn<typeof runRestrictedCli>(async (_executable, args) => ({
      stdout: args[0] === "pr" && args[1] === "list"
        ? JSON.stringify([pullRequest])
        : args[0] === "pr" && args[1] === "view"
          ? JSON.stringify(pullRequest)
          : JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 42,
                  headRefOid: head,
                  updatedAt: pullRequest.updatedAt,
                  reviewThreads: {
                    nodes: [],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          }),
      stderr: "",
    }));

    const confidence = await inspectGitHubPreMergeConfidence(root, {}, {
      now: () => new Date("2026-08-22T15:01:00Z"),
      environment: async () => ({ env: { PATH: "/fake" }, pathEntries: ["/fake"] }),
      executableCandidates: async () => ["/fake/gh"],
      runCli,
    });

    expect(confidence).toMatchObject({
      state: "ready",
      local: { branch: "feature/confidence", head, dirty: false },
      github: { number: 42, head, repository: "openai/codex" },
      identity: { state: "exact" },
      platforms: [
        { platform: "Linux", state: "passed" },
        { platform: "Windows", state: "passed" },
        { platform: "macOS", state: "passed" },
      ],
      mergeReadiness: { state: "ready", blockers: [] },
      bundle: { state: "not-published" },
      releaseReadiness: { state: "not-proven" },
      authorClaim: { source: "pull-request-body" },
    });
    expect(confidence.changedTestFiles).toEqual([
      "tests/server/github-pre-merge.test.ts",
    ]);
    expect(runCli).toHaveBeenCalledTimes(3);
    expect(runCli.mock.calls[1]?.[1]).toEqual([
      "api", "graphql", "--input", "-",
    ]);
    expect(runCli.mock.calls[1]?.[2].input).not.toContain("token");
    expect(runCli.mock.calls[2]?.[1].slice(0, 3)).toEqual([
      "pr", "view", "42",
    ]);
  });

  it("withholds green when GitHub reports more review threads than the bounded page", async () => {
    const { root, head } = await repository();
    const pullRequest = {
      number: 42,
      url: "https://github.com/openai/codex/pull/42",
      state: "OPEN",
      isDraft: false,
      headRefName: "feature/confidence",
      headRefOid: head,
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      updatedAt: "2026-08-22T15:00:00Z",
      changedFiles: 1,
      files: [{ path: "src/server/git/github-pre-merge.ts", additions: 1, deletions: 0 }],
      statusCheckRollup: [
        { name: "Linux x64", conclusion: "SUCCESS" },
        { name: "Windows x64", conclusion: "SUCCESS" },
        { name: "macOS arm64", conclusion: "SUCCESS" },
      ],
    };
    const runCli = vi.fn<typeof runRestrictedCli>(async (_executable, args) => ({
      stdout: args[0] === "pr"
        ? JSON.stringify(args[1] === "list" ? [pullRequest] : pullRequest)
        : JSON.stringify({
          data: { repository: { pullRequest: {
            number: 42,
            headRefOid: head,
            updatedAt: pullRequest.updatedAt,
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } },
          } } },
        }),
      stderr: "",
    }));

    const confidence = await inspectGitHubPreMergeConfidence(root, {}, {
      environment: async () => ({ env: { PATH: "/fake" }, pathEntries: ["/fake"] }),
      executableCandidates: async () => ["/fake/gh"],
      runCli,
    });

    expect(confidence).toMatchObject({
      state: "unavailable",
      unavailableReason: "GitHub review-thread evidence is truncated.",
      reviewThreadsTruncated: true,
      mergeReadiness: {
        state: "blocked",
        blockers: expect.arrayContaining(["GitHub evidence is incomplete or truncated."]),
      },
    });
  });

  it("keeps unresolved Codex threads actionable and detects a changed remote head", () => {
    const evidence = gitHubPreMergeTestSupport.parseReviewThreads(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 7,
              headRefOid: "b".repeat(40),
              updatedAt: "2026-08-22T15:00:00Z",
              reviewThreads: {
                nodes: [
                  {
                    id: "resolved",
                    isResolved: true,
                    isOutdated: false,
                    path: "src/old.ts",
                    line: 3,
                    comments: { nodes: [{ author: { login: "codex-review" }, body: "Old", url: "https://github.com/openai/codex/pull/7#discussion_r1" }] },
                  },
                  {
                    id: "actionable",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/current.ts",
                    line: 12,
                    comments: { nodes: [{ author: { login: "chatgpt-codex-connector" }, body: "Revalidate the exact head.", url: "https://github.com/openai/codex/pull/7#discussion_r2" }] },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
      "https://github.com/openai/codex",
      7,
    );

    expect(evidence.head).toBe("b".repeat(40));
    expect(evidence.threads).toEqual([
      expect.objectContaining({
        id: "actionable",
        codex: true,
        path: "src/current.ts",
        line: 12,
        url: "https://github.com/openai/codex/pull/7#discussion_r2",
      }),
    ]);
  });

  it("treats a full bounded check page as truncated", () => {
    const details = gitHubPreMergeTestSupport.parsePullRequestList(
      JSON.stringify([{
        number: 9,
        url: "https://github.com/openai/codex/pull/9",
        state: "OPEN",
        headRefName: "feature/confidence",
        headRefOid: "c".repeat(40),
        updatedAt: "2026-08-22T15:00:00Z",
        statusCheckRollup: Array.from({ length: 100 }, (_, index) => ({
          name: `check-${index}`,
          status: "COMPLETED",
          conclusion: "SUCCESS",
        })),
      }]),
      "https://github.com/openai/codex",
      "feature/confidence",
    );

    expect(details?.checks).toHaveLength(100);
    expect(details?.checksTruncated).toBe(true);
  });

  it("treats skipped and missing platform checks as visibly incomplete", () => {
    const coverage = gitHubPreMergeTestSupport.platformCoverage([
      {
        name: "Linux x64",
        workflow: "CI",
        state: "passed",
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
      },
      {
        name: "Windows x64",
        workflow: "CI",
        state: "skipped",
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
      },
    ]);

    expect(coverage).toEqual([
      expect.objectContaining({ platform: "Linux", state: "passed" }),
      expect.objectContaining({ platform: "Windows", state: "skipped" }),
      expect.objectContaining({ platform: "macOS", state: "missing" }),
    ]);
  });
});
