import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { comparisonPaths, contractDifference, currentRunJobs, resolveMainBaseline, selectMainBaseline, verificationContractAt } from "../../scripts/ci/validation-baseline.mjs";
import { classifyChangedPaths } from "../../scripts/ci/change-classifier.mjs";

const head = "a".repeat(40);
const older = "b".repeat(40);
const unproven = "c".repeat(40);
const repository = "test/ci";
const good = {
  id: 10, workflow_id: 2, path: ".github/workflows/ci.yml",
  repository: { full_name: repository }, head_repository: { full_name: repository },
  event: "push", head_branch: "main", status: "completed", conclusion: "success", head_sha: older,
};
function choose(runs: object[], options = {}) {
  return selectMainBaseline({
    runs, head, repository, workflowId: 2, currentRunId: 20,
    contractAt: () => "same-contract", isAncestor: () => true,
    hasSuccessfulGate: async () => true, ...options,
  });
}

it("retains the accumulated diff after failed and cancelled predecessors", async () => {
  const result = await choose([
    { ...good, id: 12, head_sha: unproven, conclusion: "cancelled" },
    { ...good, id: 11, head_sha: unproven, conclusion: "failure" },
    good,
  ]);
  expect(result).toMatchObject({ base: older, reason: "trusted-main-run:10",
    diagnostics: { evaluated: 3, rejected: { "run-metadata": 2 } } });
});

it.each([
  { conclusion: "failure" }, { conclusion: "cancelled" }, { status: "in_progress" },
  { event: "pull_request" }, { head_branch: "feature" }, { workflow_id: 3 },
  { path: ".github/workflows/other.yml" }, { repository: { full_name: "foreign/repo" } },
  { head_repository: { full_name: "foreign/repo" } }, { id: 20 }, { head_sha: "HEAD" },
])("rejects untrusted or unsuccessful baseline metadata %j", async (override) => {
  expect((await choose([{ ...good, ...override }])).base).toBeNull();
});

it("requires ancestry, compatible verifier, explicit aggregate and an available baseline", async () => {
  for (const options of [
    { isAncestor: () => false },
    { contractAt: (sha: string) => sha },
    { contractAt: () => null },
    { hasSuccessfulGate: async () => false },
  ]) expect((await choose([good], options)).base).toBeNull();
  expect((await choose([])).base).toBeNull();
});

it("reads accumulated real Git paths, preserves rename/deletion impact and detects contract replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-ci-baseline-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    await mkdir(join(root, "src/renderer"), { recursive: true });
    await mkdir(join(root, "tests"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "tests/contract.test.ts"), "initial verifier\n");
    await writeFile(join(root, "src/renderer/view.ts"), "original source\n");
    git("add", "."); git("commit", "--quiet", "-m", "trusted baseline");
    const baseline = git("rev-parse", "HEAD");
    await writeFile(join(root, "src/renderer/view.ts"), "unproven source\n");
    git("commit", "--quiet", "-am", "cancelled predecessor");
    await writeFile(join(root, "docs/note.md"), "latest docs\n");
    git("add", "."); git("commit", "--quiet", "-m", "latest push");
    const current = git("rev-parse", "HEAD");
    expect(comparisonPaths(baseline, current, root)).toEqual(["docs/note.md", "src/renderer/view.ts"]);
    expect(verificationContractAt(baseline, root)).toBe(verificationContractAt(current, root));
    git("mv", "tests/contract.test.ts", "docs/contract.md");
    git("commit", "--quiet", "-m", "move verifier into docs");
    const renamed = git("rev-parse", "HEAD");
    const paths = comparisonPaths(current, renamed, root)!;
    expect(paths).toEqual(["docs/contract.md", "tests/contract.test.ts"]);
    expect(classifyChangedPaths(paths).allEvidence).toBe(true);
    expect(verificationContractAt(renamed, root)).not.toBe(verificationContractAt(current, root));
    expect(comparisonPaths("missing", current, root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds diagnostics and rejects missing, malformed, future and excessive metadata", async () => {
  const result = await choose(Array.from({ length: 50 }, (_, i) => ({ ...good, id: i + 100 })));
  expect(result.diagnostics).toMatchObject({ evaluated: 50, rejected: { "run-metadata": 50 }, truncated: true });
  expect(result.diagnostics!.candidates).toHaveLength(10);
  for (const runs of [[null], [{}], [good, ...Array.from({ length: 50 }, () => good)]]) {
    expect((await selectMainBaseline({ runs, head, repository, workflowId: 2,
      currentRunId: 20, contractAt: () => "same", isAncestor: () => true,
      hasSuccessfulGate: async () => true })).base).toBeNull();
  }
  for (const context of [{ workflowId: NaN }, { currentRunId: NaN }, { head: "missing" }]) {
    expect((await choose([good], context)).reason).toBe("baseline-metadata-invalid");
  }
});

it("distinguishes ancestry, unavailable/changed contracts and unsuccessful exact aggregate", async () => {
  for (const [context, rejection] of [
    [{ isAncestor: () => false }, "not-ancestor-or-history-unavailable"],
    [{ contractAt: (sha: string) => sha === head ? "current" : null }, "contract-unavailable"],
    [{ contractAt: (sha: string) => sha }, "contract-changed"],
    [{ hasSuccessfulGate: async () => false }, "merge-ready-evidence"],
  ] as const) {
    const result = await choose([good], context);
    expect(result.diagnostics!.rejected).toEqual({ [rejection]: 1 });
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

it("shadows only existing regular DOM contents while preserving every other contract identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-ci-shadow-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = () => { git("add", "."); git("commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  const fingerprint = (sha: string) => verificationContractAt(sha, root, { rendererDomShadow: true });
  try {
    git("init", "--quiet"); git("config", "user.name", "CI fixture"); git("config", "user.email", "ci@example.invalid");
    await mkdir(join(root, "tests/renderer"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "tests/renderer/focus.dom.test.tsx"), "original test\n");
    const base = commit();
    await writeFile(join(root, "tests/renderer/focus.dom.test.tsx"), "current candidate regression\n");
    const changed = commit();
    expect(verificationContractAt(base, root)).not.toBe(verificationContractAt(changed, root));
    expect(fingerprint(base)).toBe(fingerprint(changed));
    expect(contractDifference(base, changed, root)).toEqual({ count: 1,
      paths: ["tests/renderer/focus.dom.test.tsx"], truncated: false });
    const common = { runs: [{ ...good, head_sha: base }], head: changed, repository,
      workflowId: 2, currentRunId: 20, isAncestor: () => true, hasSuccessfulGate: async () => true };
    expect((await selectMainBaseline({ ...common, contractAt: (sha) => verificationContractAt(sha, root) })).base).toBeNull();
    expect((await selectMainBaseline({ ...common, contractAt: fingerprint })).base).toBe(base);
    const gate = { name: "merge-ready", run_id: 10, head_sha: base, status: "completed", conclusion: "success" };
    const observe = (jobs: object[], rendererDomShadow = true) => resolveMainBaseline({ head: changed, repository, runId: 20, cwd: root,
      rendererDomShadow,
      api: (endpoint) => endpoint.endsWith("/runs/20") ? { ...good, id: 20, head_sha: changed }
        : endpoint.includes("workflows/ci.yml/runs") ? { workflow_runs: [{ ...good, head_sha: base }] }
          : { jobs, total_count: jobs.length },
    });
    const observed = await observe([gate]);
    expect(observed.base).toBeNull();
    expect(observed.shadow?.base).toBe(base);
    expect((await observe([gate], false)).shadow).toBeUndefined();
    for (const jobs of [[], [gate, gate], [{ ...gate, run_id: 9 }], [{ ...gate, head_sha: older }],
      [{ ...gate, conclusion: "cancelled" }], [{ ...gate, status: "in_progress" }]]) {
      expect((await observe(jobs)).shadow?.base).toBeNull();
    }

    // Additions, unknown test paths, shared helpers, control-plane changes and
    // resource declarations all keep their exact blob/path inventory.
    for (const file of ["tests/renderer/added.dom.test.tsx", "tests/renderer/dom/setup.ts",
      "tests/renderer/shared-fixture.ts", "tests/helpers/shared.ts", "tests/support/e2e-resource-policy.ts",
      "tests/e2e/resource.spec.ts", "tests/server/new.test.ts", "scripts/ci/renamed.mjs",
      ".github/workflows/ci.yml", "playwright.config.ts", "package-lock.json"]) {
      const previous = git("rev-parse", "HEAD");
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "first\n");
      expect(fingerprint(commit())).not.toBe(fingerprint(previous));
      if (file !== "tests/renderer/added.dom.test.tsx") {
        const beforeEdit = git("rev-parse", "HEAD");
        await writeFile(join(root, file), "changed resource or toolchain\n");
        expect(fingerprint(commit())).not.toBe(fingerprint(beforeEdit));
      }
    }
    let previous = git("rev-parse", "HEAD");
    git("mv", "tests/renderer/focus.dom.test.tsx", "tests/renderer/moved.dom.test.tsx");
    expect(fingerprint(commit())).not.toBe(fingerprint(previous));
    previous = git("rev-parse", "HEAD");
    git("rm", "tests/renderer/moved.dom.test.tsx");
    expect(fingerprint(commit())).not.toBe(fingerprint(previous));
    previous = git("rev-parse", "HEAD");
    await chmod(join(root, "tests/renderer/added.dom.test.tsx"), 0o755);
    git("update-index", "--chmod=+x", "tests/renderer/added.dom.test.tsx");
    git("commit", "--quiet", "-m", "mode");
    expect(fingerprint(git("rev-parse", "HEAD"))).not.toBe(fingerprint(previous));
    if (process.platform !== "win32") {
      previous = git("rev-parse", "HEAD");
      await rm(join(root, "tests/renderer/added.dom.test.tsx"));
      await symlink("shared-fixture.ts", join(root, "tests/renderer/added.dom.test.tsx"));
      expect(fingerprint(commit())).not.toBe(fingerprint(previous));
    }
    expect(fingerprint("missing")).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});


it("keeps API failures and the total lookup deadline closed without leaking error text", async () => {
  const failed = await resolveMainBaseline({ head, repository, runId: 20,
    api: () => { throw Object.assign(new Error("private child-process output"), { code: "api-timeout" }); },
  });
  expect(failed).toEqual({ base: null, reason: "trusted-main-baseline-unavailable", failureClass: "api-timeout" });
  expect(JSON.stringify(failed)).not.toContain("private");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    const expired = await resolveMainBaseline({ head, repository, runId: 20,
      api: () => { vi.setSystemTime(120_001); return { ...good, id: 20, head_sha: head }; },
    });
    expect(expired).toMatchObject({ base: null, failureClass: "metadata-deadline" });
  } finally { vi.useRealTimers(); }
});
