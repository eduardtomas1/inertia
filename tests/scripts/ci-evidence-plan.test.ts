import { describe, expect, it } from "vitest";
import { createEvidencePlan, evaluateMergeEvidence, PLATFORMS } from "../../scripts/ci/evidence-plan.mjs";

const head = "a".repeat(40);
const sourceHead = "b".repeat(40);
const base = "c".repeat(40);
const runId = 42;
function plan(paths: string[], options = {}) {
  return createEvidencePlan({ head, sourceHead, base, paths, ...options });
}
function evidence(selected = plan(["package-lock.json"])) {
  return {
    head, sourceHead, event: selected.event, draft: selected.lane === "draft", runId,
    needs: Object.fromEntries(["classify", ...selected.requiredJobs]
      .map((job: string) => [job, { result: "success" }])),
    jobs: selected.requiredChecks.map((name: string) => ({
      name, run_id: runId, head_sha: sourceHead, status: "completed", conclusion: "success",
    })),
  };
}

describe("explainable CI plan", () => {
  it("measures desktop performance on main and nightly, never as pull request gating", () => {
    const performancePaths = ["benchmarks/renderer-primitives.test.ts"];
    expect(plan(performancePaths, { event: "push" }).domains).toContain("performance");
    expect(plan(performancePaths, { event: "push" }).benchmarks).toBe(true);
    expect(plan(performancePaths, { event: "schedule" }).benchmarks).toBe(true);
    expect(plan(["docs/CI_EVIDENCE.md"], { event: "schedule" }).benchmarks).toBe(true);
    for (const options of [{ event: "pull_request" }, { event: "pull_request", draft: true }, { event: "merge_group" }]) {
      expect(plan(performancePaths, options).benchmarks).toBe(false);
    }
    expect(plan(["docs/CI_EVIDENCE.md"], { event: "push" }).benchmarks).toBe(false);
  });

  it("does not buy native installers for documentation or renderer contracts", () => {
    const docs = plan(["docs/CI_EVIDENCE.md"]);
    expect(docs.requiredJobs).toEqual(["gate", "lineage"]);
    expect(docs.platforms).toEqual([]);
    expect(docs.reasons).toContain("documentation-only");
    expect(docs.omissions.map(({ job }: { job: string }) => job)).toContain("test");
    const renderer = plan(["src/renderer/src/App.tsx"]);
    expect(renderer.platforms).toEqual([]);
    expect(renderer.renderer).toBe(true);
    expect(renderer.requiredJobs).toEqual(["gate", "lineage", "pr-linux-core", "pr-linux-lifecycle"]);
  });

  it("retains portable contracts and all three native transport owners for adapters", () => {
    const provider = plan(["src/server/provider/codex-app-server-harness.ts"]);
    expect(provider.platforms).toEqual([]);
    expect(provider.domains).toContain("provider_codex");
    expect(provider.requiredJobs).toEqual([
      "gate", "lineage", "pr-linux-core", "pr-linux-lifecycle", "pr-windows-lifecycle", "pr-macos-lifecycle",
    ]);
  });

  it.each([
    "tests/e2e/support/electron-app-lifecycle.ts",
    "tests/e2e/runtime-live-recovery.spec.ts",
  ])("requires all six native targets for a ready PR changing only %s", (path) => {
    const selected = plan([path], {
      event: "pull_request", draft: false,
    });
    expect(selected.fullCertification).toBe(true);
    expect(selected.platforms).toEqual([
      "linux-x64", "linux-arm64", "windows-x64", "windows-arm64", "macos-arm64", "macos-x64",
    ]);
    expect(selected.requiredJobs).toEqual(["gate", "lineage", "node-22-minimum", "test", "electron", "windows-unit"]);
    expect(selected.requiredChecks).toEqual([
      "Quality gate", "Migration lineage / Reject released migration tamper", "Node 22.13 minimum runtime",
      "Linux x64", "Linux ARM64", "Windows x64", "Windows ARM64", "macOS arm64", "macOS x64",
      "Linux x64 Electron", "Linux ARM64 Electron", "Windows x64 Electron", "Windows ARM64 Electron",
      "macOS arm64 Electron", "macOS x64 Electron",
      "Windows unit tests (1/4)", "Windows unit tests (2/4)",
      "Windows unit tests (3/4)", "Windows unit tests (4/4)",
    ]);
    expect(selected.omittedPlatforms).toEqual([]);
    expect(evaluateMergeEvidence(selected, evidence(selected))).toEqual([]);
    for (const missingName of [
      "Linux x64", "Linux ARM64", "Windows x64", "Windows ARM64", "macOS arm64", "macOS x64",
      "Linux x64 Electron", "Windows ARM64 Electron", "macOS x64 Electron",
    ]) {
      const missingNative = evidence(selected);
      missingNative.jobs = missingNative.jobs.filter(({ name }) => name !== missingName);
      expect(evaluateMergeEvidence(selected, missingNative))
        .toContain(`Required check ${missingName} lacks exact successful evidence.`);
    }
  });

  it.each([
    ["build/linux/icon.png", ["linux-x64", "linux-arm64"]],
    ["build/windows/icon.ico", ["windows-x64", "windows-arm64"]],
    ["build/macos/icon.icns", ["macos-arm64", "macos-x64"]],
  ])("selects both affected native architectures for %s", (path, targets) => {
    const selected = plan([path as string]);
    expect(selected.platforms).toEqual(targets);
    expect(selected.requiredJobs.includes("pr-linux-core"))
      .toBe(!(targets as string[]).includes("linux-x64"));
  });

  it("unions mixed domains without duplicating a platform's sentinel and complete proof", () => {
    const mixed = plan(["build/windows/icon.ico", "src/server/provider/codex-app-server-harness.ts"]);
    expect(mixed.platforms).toEqual(["windows-x64", "windows-arm64"]);
    expect(mixed.requiredJobs).toContain("windows-unit");
    expect(mixed.requiredJobs).toContain("pr-macos-lifecycle");
    expect(mixed.requiredJobs).not.toContain("pr-windows-lifecycle");
  });

  it.each([
    "src/server/runtime/turns/turn-controller.ts", "src/server/database.ts",
    "src/node/runtime-owned-processes.ts", "src/shared/contracts.ts",
    "package-lock.json", "playwright.config.ts", "tests/support/new-fixture.ts",
    ".github/workflows/ci.yml", "scripts/new-tool.mjs", "unknown.xyz",
  ])("keeps shared lifecycle and uncertain verifier changes broad: %s", (path) => {
    const selected = plan([path]);
    expect(selected.platforms).toEqual(PLATFORMS.map(({ artifact }: { artifact: string }) => artifact));
    expect(selected.requiredJobs).toEqual(["gate", "lineage", "node-22-minimum", "test", "electron", "windows-unit"]);
    expect(selected.requiredChecks.filter((name: string) => name.startsWith("Windows unit tests")))
      .toHaveLength(4);
    expect(selected.requiredChecks.filter((name: string) => name.endsWith(" Electron"))).toHaveLength(6);
  });

  it("missing baseline overrides an apparently harmless latest push", () => {
    expect(plan(["README.md"], { event: "push", base: null }).platforms).toHaveLength(6);
  });

  it("describes nightly documentation coverage and actual published upgrade proof truthfully", () => {
    const selected = plan(["README.md"], { event: "schedule" });
    expect(selected.suites).toContain("linux-all-source-coverage");
    expect(selected.suites).toContain("linux-x64:native-units-package-smoke");
    expect(selected.suites).toContain("linux-x64:electron-display-isolated-recovery");
    expect(selected.suites.filter((suite) => suite.includes("upgrade"))).toEqual([
      "windows-x64:published-N-1-installed-upgrade",
      "windows-arm64:published-N-1-installed-upgrade",
    ]);
    expect(selected.requiredJobs).toEqual(["gate", "lineage", "node-22-minimum", "test", "electron", "windows-unit"]);
  });

  it("draft feedback is not the merge tier; ready and merge queue certify the same broad change", () => {
    const draft = plan(["package-lock.json"], { draft: true });
    expect(draft.lane).toBe("draft");
    expect(draft.platforms).toEqual([]);
    expect(draft.requiredJobs).toContain("pr-linux-core");
    for (const event of ["pull_request", "merge_group", "schedule"]) {
      expect(plan(["package-lock.json"], { event }).platforms).toHaveLength(6);
    }
    expect(plan(["README.md"], { event: "schedule" }).platforms).toHaveLength(6);
  });
});

describe("fail-closed exact-candidate aggregate", () => {
  it("accepts complete proof and records intentional omissions separately", () => {
    for (const selected of [plan(["package-lock.json"]), plan(["README.md"])]) {
      expect(evaluateMergeEvidence(selected, evidence(selected))).toEqual([]);
    }
  });

  it.each(["failure", "cancelled", "skipped", "timed_out", "action_required", "neutral"])(
    "rejects %s for one required shard even when the matrix needs result says success", (conclusion) => {
      const actual = evidence();
      actual.jobs.at(-1)!.conclusion = conclusion;
      expect(evaluateMergeEvidence(plan(["package-lock.json"]), actual).length).toBeGreaterThan(0);
    },
  );

  it("rejects a missing shard, duplicate check, wrong run and old head", () => {
    for (const mutate of [
      (actual: ReturnType<typeof evidence>) => actual.jobs.pop(),
      (actual: ReturnType<typeof evidence>) => actual.jobs.push(actual.jobs[0]!),
      (actual: ReturnType<typeof evidence>) => { actual.jobs[0]!.run_id = 41; },
      (actual: ReturnType<typeof evidence>) => { actual.jobs[0]!.head_sha = base; },
      (actual: ReturnType<typeof evidence>) => { actual.head = base; },
      (actual: ReturnType<typeof evidence>) => { delete actual.needs.classify; },
    ]) {
      const actual = evidence();
      mutate(actual);
      expect(evaluateMergeEvidence(plan(["package-lock.json"]), actual).length).toBeGreaterThan(0);
    }
  });

  it("rejects silently removed obligations and green draft feedback", () => {
    const altered = plan(["package-lock.json"]);
    altered.requiredChecks.pop();
    expect(evaluateMergeEvidence(altered, evidence(altered))).toContain("Plan is not canonical.");
    const draft = plan(["README.md"], { draft: true });
    expect(evaluateMergeEvidence(draft, evidence(draft)).join(" ")).toContain("does not authorize merge");
  });

  it("binds even a canonical merge plan to the real draft/event context", () => {
    const merge = plan(["README.md"]);
    const actualDraft = { ...evidence(merge), draft: true };
    expect(evaluateMergeEvidence(merge, actualDraft).join(" ")).toContain("does not authorize merge");
    expect(evaluateMergeEvidence(merge, { ...evidence(merge), event: "push" }))
      .toContain("Plan event does not match the workflow context.");
  });
});

it("enumerates every shadow omission without changing canonical current-candidate obligations", async () => {
  const { compareEvidencePlans } = await import("../../scripts/ci/evidence-plan.mjs");
  const current = plan([], { event: "push", base: null });
  const proposed = plan(["src/renderer/src/components/UsageLimitsPanel.tsx",
    "tests/renderer/usage-limits-focus.dom.test.tsx"], { event: "push" });
  const before = JSON.stringify(current);
  const comparison = compareEvidencePlans(current, proposed);
  expect(comparison.newlyOmittedChecks).toEqual([
    "Node 22.13 minimum runtime", "Linux x64", "Linux ARM64", "Windows x64", "Windows ARM64",
    "macOS arm64", "macOS x64",
    "Linux x64 Electron", "Linux ARM64 Electron", "Windows x64 Electron", "Windows ARM64 Electron",
    "macOS arm64 Electron", "macOS x64 Electron",
    "Windows unit tests (1/4)", "Windows unit tests (2/4)",
    "Windows unit tests (3/4)", "Windows unit tests (4/4)",
  ]);
  expect(comparison.newlyRequiredChecks).toEqual(["Linux core and portable conformance", "Linux interaction and lifecycle"]);
  expect(comparison).toMatchObject({ currentBenchmarks: true, proposedBenchmarks: false });
  expect(comparison.newlyOmittedSuites).toHaveLength(14);
  expect(JSON.stringify(current)).toBe(before);
  // Shadow evidence cannot satisfy the strict plan, nor can a different source
  // or merge SHA be compared as if it were the candidate.
  expect(evaluateMergeEvidence(current, evidence(proposed)).length).toBeGreaterThan(0);
  expect(() => compareEvidencePlans(current, { ...proposed, head: base })).toThrow();
  expect(() => compareEvidencePlans(current, { ...proposed, sourceHead: base })).toThrow();
  for (const path of ["README.md", "package-lock.json", "src/node/runtime-owned-processes.ts", "unknown/path"]) {
    const narrow = plan([path], { event: "push" });
    const change = compareEvidencePlans(current, narrow);
    if (path === "README.md") expect(change.newlyOmittedChecks.length).toBeGreaterThan(0);
    else expect(change.newlyOmittedChecks).toEqual([]);
  }
});
