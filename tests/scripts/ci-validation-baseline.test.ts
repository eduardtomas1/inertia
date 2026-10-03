import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { comparisonPaths, currentRunJobs, resolveCertifiedPullRequest } from "../../scripts/ci/validation-baseline.mjs";
import { classifyChangedPaths } from "../../scripts/ci/change-classifier.mjs";

const head = "a".repeat(40);
const parent = "b".repeat(40);
const sourceHead = "c".repeat(40);
const tree = "d".repeat(40);
const repository = "test/ci";
const runId = 20;

type Responses = Record<string, unknown>;
function responses(overrides: Responses = {}): Responses {
  return {
    [`repos/${repository}/actions/runs/${runId}`]: {
      id: runId, head_sha: head, event: "push", head_branch: "main", repository: { full_name: repository },
    },
    [`repos/${repository}/commits/${head}/pulls`]: [{
      number: 12, merged_at: "2026-10-02T00:00:00Z", merge_commit_sha: head,
      base: { ref: "main", repo: { full_name: repository } },
      head: { sha: sourceHead, repo: { full_name: repository } },
    }],
    [`repos/${repository}/git/commits/${sourceHead}`]: { sha: sourceHead, tree: { sha: tree } },
    [`repos/${repository}/compare/${parent}...${sourceHead}`]: { status: "ahead", merge_base_commit: { sha: parent } },
    [`repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${sourceHead}&status=completed&per_page=20`]: {
      workflow_runs: [{
        id: 7, event: "pull_request", head_sha: sourceHead, path: ".github/workflows/ci.yml", status: "completed",
        repository: { full_name: repository }, head_repository: { full_name: repository },
      }],
    },
    [`repos/${repository}/actions/runs/7/jobs?filter=latest&per_page=100&page=1`]: {
      total_count: 1,
      jobs: [{ name: "merge-ready", run_id: 7, head_sha: sourceHead, status: "completed", conclusion: "success" }],
    },
    ...overrides,
  };
}
function git(overrides: { parents?: string | null; tree?: string | null } = {}) {
  return (args: string[]) => args[0] === "rev-list"
    ? ("parents" in overrides ? overrides.parents! : `${head} ${parent}\n`)
    : ("tree" in overrides ? overrides.tree! : `${tree}\n`);
}
function resolve(overrides: Responses = {}, gitOverrides = {}) {
  const table = responses(overrides);
  return resolveCertifiedPullRequest({
    head, repository, runId, git: git(gitOverrides),
    api: (endpoint: string) => {
      if (!(endpoint in table)) throw Object.assign(new Error("private output"), { code: "api-command-failed" });
      const value = table[endpoint];
      if (value instanceof Error) throw value;
      return value;
    },
  });
}
const pulls = `repos/${repository}/commits/${head}/pulls`;
const runs = `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${sourceHead}&status=completed&per_page=20`;
const jobs = `repos/${repository}/actions/runs/7/jobs?filter=latest&per_page=100&page=1`;
const pullRecord = (responses()[pulls] as Array<Record<string, unknown>>)[0]!;
const runRecord = (responses()[runs] as { workflow_runs: Array<Record<string, unknown>> }).workflow_runs[0]!;

it("reuses the successful pull-request run whose head has the identical tree", async () => {
  expect(await resolve()).toEqual({
    reused: { runId: 7, pullRequest: 12, sourceHead }, base: parent, reason: "certified-pull-request-run:7",
  });
});

it.each([
  ["current-run-identity", { [`repos/${repository}/actions/runs/${runId}`]: { id: runId, head_sha: head, event: "pull_request", head_branch: "main", repository: { full_name: repository } } }],
  ["pull-request-list-invalid", { [pulls]: {} }],
  ["pull-request-not-unique", { [pulls]: [] }],
  ["pull-request-not-unique", { [pulls]: [pullRecord, pullRecord] }],
  ["pull-request-not-unique", { [pulls]: [{ ...pullRecord, merged_at: null }] }],
  ["pull-request-not-unique", { [pulls]: [{ ...pullRecord, merge_commit_sha: parent }] }],
  ["pull-request-not-unique", { [pulls]: [{ ...pullRecord, head: { sha: sourceHead, repo: { full_name: "fork/ci" } } }] }],
  ["tree-mismatch", { [`repos/${repository}/git/commits/${sourceHead}`]: { sha: sourceHead, tree: { sha: "e".repeat(40) } } }],
  ["parent-not-ancestor", { [`repos/${repository}/compare/${parent}...${sourceHead}`]: { status: "diverged", merge_base_commit: { sha: "e".repeat(40) } } }],
  ["run-list-invalid", { [runs]: {} }],
  ["no-successful-merge-ready", { [runs]: { workflow_runs: [] } }],
  ["no-successful-merge-ready", { [runs]: { workflow_runs: [{ ...runRecord, head_repository: { full_name: "fork/ci" } }] } }],
  ["no-successful-merge-ready", { [runs]: { workflow_runs: [{ ...runRecord, id: runId }] } }],
  ["no-successful-merge-ready", { [jobs]: { total_count: 1, jobs: [{ name: "merge-ready", run_id: 7, head_sha: sourceHead, status: "completed", conclusion: "failure" }] } }],
  ["no-successful-merge-ready", { [jobs]: { total_count: 1, jobs: [{ name: "merge-ready", run_id: 7, head_sha: parent, status: "completed", conclusion: "success" }] } }],
  ["metadata-or-history-unavailable", { [jobs]: { total_count: 2, jobs: [] } }],
  ["api-command-failed", { [pulls]: Object.assign(new Error("private output"), { code: "api-command-failed" }) }],
  ["api-timeout", { [`repos/${repository}/compare/${parent}...${sourceHead}`]: Object.assign(new Error("private"), { code: "api-timeout" }) }],
])("falls back to the complete plan: %s", async (reason, overrides) => {
  const result = await resolve(overrides as Responses);
  expect(result).toEqual({ reused: null, reason });
  expect(JSON.stringify(result)).not.toContain("private");
});

it.each([
  [{ parents: `${head} ${parent} ${"e".repeat(40)}\n` }],
  [{ parents: null }],
  [{ tree: null }],
])("requires a single-parent main commit with a readable tree %j", async (gitOverrides) => {
  expect(await resolve({}, gitOverrides)).toEqual({ reused: null, reason: "main-commit-history-unavailable" });
});

it("stops at the shared lookup deadline", async () => {
  let clock = 0;
  const table = responses();
  const result = await resolveCertifiedPullRequest({
    head, repository, runId, git: git(), now: () => clock,
    api: (endpoint: string) => { clock = 120_001; return table[endpoint]; },
  });
  expect(result).toEqual({ reused: null, reason: "metadata-deadline" });
});

it("reads accumulated real Git paths and preserves rename/deletion impact", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-ci-baseline-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    run("init", "--quiet");
    run("config", "user.name", "CI fixture");
    run("config", "user.email", "ci@example.invalid");
    await mkdir(join(root, "src/renderer"), { recursive: true });
    await mkdir(join(root, "tests"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "tests/contract.test.ts"), "initial verifier\n");
    await writeFile(join(root, "src/renderer/view.ts"), "original source\n");
    run("add", "."); run("commit", "--quiet", "-m", "baseline");
    const baseline = run("rev-parse", "HEAD");
    await writeFile(join(root, "src/renderer/view.ts"), "changed source\n");
    await writeFile(join(root, "docs/note.md"), "latest docs\n");
    run("add", "."); run("commit", "--quiet", "-m", "latest push");
    const current = run("rev-parse", "HEAD");
    expect(comparisonPaths(baseline, current, root)).toEqual(["docs/note.md", "src/renderer/view.ts"]);
    run("mv", "tests/contract.test.ts", "docs/contract.md");
    run("commit", "--quiet", "-m", "move verifier into docs");
    const paths = comparisonPaths(current, run("rev-parse", "HEAD"), root)!;
    expect(paths).toEqual(["docs/contract.md", "tests/contract.test.ts"]);
    expect(classifyChangedPaths(paths).allEvidence).toBe(true);
    expect(comparisonPaths("missing", current, root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { jobs: [] }, { jobs: [], total_count: "0" }, { jobs: [], total_count: -1 },
  { jobs: [], total_count: 301 }, { jobs: [], total_count: 1 },
  { jobs: [{}], total_count: 0 },
])("rejects missing or truncated REST evidence %j", (response) => {
  expect(() => currentRunJobs(repository, 10, Date.now() + 30_000, () => response)).toThrow();
});

it("accepts complete bounded pagination and rejects counts changing during pagination", () => {
  let calls = 0;
  const page = { jobs: Array.from({ length: 100 }, (_, id) => ({ id })), total_count: 101 };
  expect(currentRunJobs(repository, 10, Date.now() + 30_000,
    () => ++calls === 1 ? page : { jobs: [{ id: 100 }], total_count: 101 })).toHaveLength(101);
  calls = 0;
  expect(() => currentRunJobs(repository, 10, Date.now() + 30_000,
    () => ++calls === 1 ? page : { jobs: [{ id: 100 }], total_count: 102 })).toThrow();
});
