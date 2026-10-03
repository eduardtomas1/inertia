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
      expect(plan(performancePaths, options).performanceSmoke).toBe(!("draft" in options && options.draft));
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
    expect(renderer.performanceSmoke).toBe(true);
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
  ])("requires the three primary native targets for a ready PR changing only %s", (path) => {
    const selected = plan([path], {
      event: "pull_request", draft: false,
    });
    expect(selected.fullCertification).toBe(true);
    expect(selected.platforms).toEqual(["linux-x64", "windows-x64", "macos-arm64"]);
    expect(selected.requiredJobs).toEqual(["gate", "lineage", "node-22-minimum", "test", "electron", "windows-unit"]);
    expect(selected.requiredChecks).toEqual([
      "Quality gate", "Migration lineage / Reject released migration tamper", "Node 22.13 minimum runtime",
      "Linux x64", "Windows x64", "macOS arm64",
      "Linux x64 Electron (display-sensitive)", "Linux x64 Electron (isolated)",
      "Windows x64 Electron (display-sensitive)", "Windows x64 Electron (isolated 1/2)",
      "Windows x64 Electron (isolated 2/2)",
      "macOS arm64 Electron (display-sensitive)", "macOS arm64 Electron (isolated)",
      "Windows unit tests (1/4)", "Windows unit tests (2/4)",
      "Windows unit tests (3/4)", "Windows unit tests (4/4)",
    ]);
    expect(selected.omittedPlatforms).toEqual(["linux-arm64", "windows-arm64", "macos-x64"].map((platform) => ({
      platform, reason: "sibling-architecture-certified-nightly-and-release",
    })));
    expect(evaluateMergeEvidence(selected, evidence(selected))).toEqual([]);
    for (const missingName of [
      "Linux x64", "Windows x64", "macOS arm64", "Linux x64 Electron (display-sensitive)",
      "Windows x64 Electron (isolated 2/2)", "macOS arm64 Electron (isolated)",
    ]) {
      const missingNative = evidence(selected);
      missingNative.jobs = missingNative.jobs.filter(({ name }) => name !== missingName);
      expect(evaluateMergeEvidence(selected, missingNative))
        .toContain(`Required check ${missingName} lacks exact successful evidence.`);
    }
  });

  it("requires all six targets for a native dependency change, with sibling recovery projects only", () => {
    const selected = plan(["package-lock.json"]);
    expect(selected.platforms).toEqual([
      "linux-x64", "linux-arm64", "windows-x64", "windows-arm64", "macos-arm64", "macos-x64",
    ]);
    expect(selected.requiredChecks).toEqual([
      "Quality gate", "Migration lineage / Reject released migration tamper", "Node 22.13 minimum runtime",
      "Linux x64", "Linux ARM64", "Windows x64", "Windows ARM64", "macOS arm64", "macOS x64",
      "Linux x64 Electron (display-sensitive)", "Linux x64 Electron (isolated)",
      "Windows x64 Electron (display-sensitive)", "Windows x64 Electron (isolated 1/2)",
      "Windows x64 Electron (isolated 2/2)",
      "macOS arm64 Electron (display-sensitive)", "macOS arm64 Electron (isolated)",
      "Linux ARM64 Electron (runtime-recovery)", "Windows ARM64 Electron (runtime-recovery)",
      "macOS x64 Electron (runtime-recovery)",
      "Windows unit tests (1/4)", "Windows unit tests (2/4)",
      "Windows unit tests (3/4)", "Windows unit tests (4/4)",
    ]);
    expect(selected.omittedPlatforms).toEqual([]);
    for (const missingName of ["Linux ARM64", "Windows ARM64", "macOS x64", "Windows ARM64 Electron (runtime-recovery)"]) {
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
    "src/node/runtime-owned-processes.ts", "package-lock.json",
    ".github/workflows/ci.yml", "scripts/new-tool.mjs", "unknown.xyz",
  ])("keeps native and uncertain verifier changes on all six targets: %s", (path) => {
    const selected = plan([path]);
    expect(selected.platforms).toEqual(PLATFORMS.map(({ artifact }: { artifact: string }) => artifact));
    expect(selected.requiredJobs).toEqual(["gate", "lineage", "node-22-minimum", "test", "electron", "windows-unit"]);
    expect(selected.requiredChecks.filter((name: string) => name.startsWith("Windows unit tests")))
      .toHaveLength(4);
    expect(selected.requiredChecks.filter((name: string) => name.includes(" Electron"))).toHaveLength(10);
  });

  it.each([
    "src/server/runtime/turns/turn-controller.ts", "src/server/database.ts",
    "src/shared/contracts.ts", "playwright.config.ts", "tests/support/new-fixture.ts",
  ])("keeps shared lifecycle and verifier changes on the primary targets: %s", (path) => {
    const selected = plan([path]);
    expect(selected.platforms).toEqual(["linux-x64", "windows-x64", "macos-arm64"]);
    expect(selected.requiredJobs).toEqual(["gate", "lineage", "node-22-minimum", "test", "electron", "windows-unit"]);
    expect(selected.requiredChecks.filter((name: string) => name.startsWith("Windows unit tests")))
      .toHaveLength(4);
    expect(selected.requiredChecks.filter((name: string) => name.includes(" Electron"))).toHaveLength(7);
  });

  it("missing baseline overrides an apparently harmless latest push", () => {
    expect(plan(["README.md"], { event: "push", base: null }).platforms).toHaveLength(6);
  });

  it("describes nightly documentation coverage and actual published upgrade proof truthfully", () => {
    const selected = plan(["README.md"], { event: "schedule" });
    expect(selected.suites).toContain("linux-all-source-coverage");
    expect(selected.suites).toContain("linux-x64:native-units-package-smoke");
    expect(selected.suites).toContain("linux-x64:electron-display-sensitive");
    expect(selected.suites).toContain("linux-x64:electron-isolated-recovery");
    expect(selected.suites).not.toContain("macos-x64:electron-recovery");
    expect(selected.suites.filter((suite) => suite.startsWith("windows-arm64:electron-"))).toEqual([
      "windows-arm64:electron-display-sensitive", "windows-arm64:electron-isolated-1-of-2-recovery",
      "windows-arm64:electron-isolated-2-of-2",
    ]);
    expect(selected.suites.filter((suite) => suite.includes("upgrade"))).toEqual([
      "windows-x64:published-N-1-installed-upgrade",
      "windows-arm64:published-N-1-installed-upgrade",
    ]);
    expect(selected.requiredJobs).toEqual(["gate", "lineage", "node-22-minimum", "test", "electron", "windows-unit"]);
    expect(selected.electronMatrix.include.map(({ check }) => check)).toEqual(
      ["Linux x64", "Linux ARM64", "Windows x64", "Windows ARM64", "macOS arm64", "macOS x64"].flatMap((label) => [
        `${label} Electron (display-sensitive)`,
        ...(label.startsWith("Windows")
          ? [`${label} Electron (isolated 1/2)`, `${label} Electron (isolated 2/2)`]
          : [`${label} Electron (isolated)`]),
      ]),
    );
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

describe("main push reuse of an identical certified pull-request tree", () => {
  const reusedRun = { runId: 7, pullRequest: 12, sourceHead: "d".repeat(40) };
  const reusedPlan = () => plan(["src/server/database.ts"], { event: "push", reusedRun });
  const mergeReady = (override = {}) => ({
    name: "merge-ready", run_id: 7, head_sha: reusedRun.sourceHead,
    status: "completed", conclusion: "success", ...override,
  });

  it("requires only quality and lineage and records the certified run", () => {
    const selected = reusedPlan();
    expect(selected.lane).toBe("main-reused");
    expect(selected.reusedRun).toEqual(reusedRun);
    expect(selected.requiredJobs).toEqual(["gate", "lineage"]);
    expect(selected.platforms).toEqual([]);
    expect(selected.benchmarks).toBe(false);
    expect(evaluateMergeEvidence(selected, { ...evidence(selected), reusedRunJobs: [mergeReady()] })).toEqual([]);
  });

  it.each([
    ["missing", []],
    ["failed", [mergeReady({ conclusion: "failure" })]],
    ["foreign run", [mergeReady({ run_id: 8 })]],
    ["foreign head", [mergeReady({ head_sha: "e".repeat(40) })]],
    ["duplicated", [mergeReady(), mergeReady()]],
  ])("rejects %s pull-request merge-ready evidence", (_label, reusedRunJobs) => {
    const selected = reusedPlan();
    expect(evaluateMergeEvidence(selected, { ...evidence(selected), reusedRunJobs }))
      .toContain("Reused pull-request certification lacks exact successful merge-ready evidence.");
  });

  it("falls back to the complete plan without a valid run, base or with performance changes", () => {
    for (const options of [
      { event: "push", reusedRun: null },
      { event: "push", reusedRun: { ...reusedRun, runId: 0 } },
      { event: "push", reusedRun: { ...reusedRun, sourceHead: "HEAD" } },
      { event: "push", reusedRun, base: null },
      { event: "pull_request", reusedRun },
    ]) {
      const selected = plan(["src/server/database.ts"], options);
      expect(selected.lane).not.toBe("main-reused");
      expect(selected.reusedRun).toBeNull();
    }
    expect(plan(["src/server/database.ts"], { event: "push", reusedRun, base: null }).platforms).toHaveLength(6);
    const performance = plan(["benchmarks/data-throughput.test.ts"], { event: "push", reusedRun });
    expect(performance).toMatchObject({ lane: "main", reusedRun, benchmarks: true });
    expect(performance.reasons).toContain("performance-change-measured-on-main");
    expect(performance.platforms).toEqual(["linux-x64", "windows-x64", "macos-arm64"]);
    expect(createEvidencePlan({ ...performance, draft: false })).toEqual(performance);
    expect(evaluateMergeEvidence(performance, evidence(performance))).toEqual([]);
  });

  it("cannot be forged by editing the plan", () => {
    const forged = { ...plan(["src/server/database.ts"], { event: "push" }), lane: "main-reused" };
    expect(evaluateMergeEvidence(forged, { ...evidence(forged), reusedRunJobs: [mergeReady()] }))
      .toContain("Plan is not canonical.");
  });
});
