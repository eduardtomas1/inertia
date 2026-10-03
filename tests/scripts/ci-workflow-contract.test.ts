import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { createEvidencePlan, EVIDENCE_JOBS, outputsForEvidencePlan, PLATFORMS } from "../../scripts/ci/evidence-plan.mjs";

const source = (file: string) => readFileSync(file, "utf8");
const workflow = parse(source(".github/workflows/ci.yml"));

it.each(PLATFORMS.filter(({ artifact }) => artifact.startsWith("linux-")))(
  "certifies the release configuration and updater metadata for $artifact",
  (platform) => {
    expect(platform.release_platform).toBe(platform.artifact);
    const scripts = JSON.parse(source("package.json")).scripts as Record<string, string>;
    expect(scripts[platform.release_package_script!]).toContain("--config scripts/electron-builder.release.cjs");
    expect(scripts[platform.release_package_script!]).toContain(`--${platform.arch}`);
    const step = workflow.jobs.test.steps.find((entry: { name: string }) => entry.name === "Package Linux AppImage and unpacked app");
    expect(step.run).toBe('npm run "${{ matrix.release_package_script }}"');
    expect(step.env).toMatchObject({
      INERTIA_RELEASE_CHANNEL: "stable",
      INERTIA_RELEASE_PLATFORM: "${{ matrix.release_platform }}",
    });
  },
);

it("stages the actual native artifacts before package smoke without publishing them", () => {
  const steps = workflow.jobs.test.steps as Array<{ name: string; run?: string; env?: Record<string, string>; "continue-on-error"?: boolean }>;
  const stageIndex = steps.findIndex(({ name }) => name === "Validate native release asset staging");
  expect(stageIndex).toBeGreaterThan(steps.findIndex(({ name }) => name === "Package Linux AppImage and unpacked app"));
  expect(stageIndex).toBeLessThan(steps.findIndex(({ run }) => run?.includes("npm run test:package-smoke")));
  const stage = steps[stageIndex]!;
  expect(stage.run).toContain('node scripts/release-assets.mjs stage "$RELEASE_PLATFORM"');
  expect(stage.run).not.toMatch(/gh release|publish/u);
  expect(stage.env).toMatchObject({
    RELEASE_PLATFORM: "${{ matrix.release_platform }}",
    RELEASE_SOURCE_SHA: "${{ github.sha }}",
    INERTIA_RELEASE_CHANNEL: "stable",
    INERTIA_RELEASE_STAGE_DIR: "${{ runner.temp }}/inertia-ci-release-stage",
  });
  expect(stage["continue-on-error"]).not.toBe(true);
});

it("runs ready-for-review, later heads and merge groups, cancelling only obsolete validation", () => {
  expect(workflow.on.pull_request.types).toEqual([
    "opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft",
  ]);
  expect(workflow.on.merge_group.types).toEqual(["checks_requested"]);
  expect(workflow.concurrency["cancel-in-progress"]).toContain("github.event_name == 'push'");
  expect(workflow.jobs["merge-ready"].if).toBe("always()");
  expect(workflow.jobs["merge-ready"].needs).toEqual(["classify", ...Object.keys(EVIDENCE_JOBS)]);
  const aggregate = workflow.jobs["merge-ready"].steps.find((step: { run?: string }) => step.run === "node scripts/ci/merge-ready.mjs");
  expect(aggregate.env.PR_DRAFT).toBe("${{ github.event.pull_request.draft }}");
  expect(aggregate.env.SOURCE_HEAD).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
  expect(parse(source(".github/workflows/release-platforms.yml")).concurrency["cancel-in-progress"])
    .toBe(false);
});

it.each([
  ["README.md", false], ["src/renderer/src/App.tsx", false],
  ["src/server/provider/codex-app-server-harness.ts", false],
  ["build/windows/icon.ico", false], ["package-lock.json", false],
  ["package-lock.json", true],
])("the emitted plan selects exactly its declared workflow jobs: %s draft=%s", (path, draft) => {
  const selected = createEvidencePlan({
    head: "a".repeat(40), base: "b".repeat(40), paths: [path], draft,
  });
  const outputs = Object.fromEntries(outputsForEvidencePlan(selected).trim().split("\n")
    .map((line: string) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const actual = Object.keys(EVIDENCE_JOBS).filter((id) => {
    const job = workflow.jobs[id];
    expect(job, id).toBeDefined();
    if (!job.if) return true;
    const match = /^needs\.classify\.outputs\.([a-z0-9_]+) == 'true'$/u.exec(job.if);
    expect(match, `Unexpected selection condition for ${id}`).not.toBeNull();
    expect(workflow.jobs.classify.outputs[match![1]!]).toBe(`\${{ steps.changes.outputs.${match![1]} }}`);
    return outputs[match![1]!] === "true";
  });
  expect(actual).toEqual(selected.requiredJobs);
  expect(JSON.parse(outputs.matrix_json!)).toEqual(selected.matrix);
  expect(JSON.parse(outputs.electron_matrix_json!)).toEqual(selected.electronMatrix);
  expect(workflow.jobs.test.strategy.matrix).toBe("${{ fromJSON(needs.classify.outputs.matrix_json) }}");
  expect(workflow.jobs["windows-unit"].strategy.matrix.shard).toEqual([1, 2, 3, 4]);
});

it("binds every checkout to the candidate and makes migration lineage part of the stable aggregate", () => {
  for (const job of Object.values(workflow.jobs) as Array<{ steps?: Array<{ uses?: string; with?: { ref?: string } }> }>) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) expect(step.with?.ref).toBe("${{ github.sha }}");
    }
  }
  const lineage = parse(source(".github/workflows/database-migration-lineage.yml"));
  expect(Object.keys(lineage.on)).toEqual(["workflow_call"]);
  expect(workflow.jobs.lineage.uses).toBe("./.github/workflows/database-migration-lineage.yml");
  expect(lineage.jobs.lineage.steps[0].with.ref).toBe("${{ github.sha }}");
  expect(source(".github/actions/install-dependencies/action.yml")).toContain('default: "22.23.2"');
});

it("release builds prove exact packages before desktop tests and never continue on unconfirmed cleanup", () => {
  const job = parse(source(".github/workflows/release-platforms.yml")).jobs.build;
  const steps = job.steps as Array<{ name: string; run?: string; if?: string }>;
  const firstDesktop = steps.findIndex((step) => step.run?.includes("playwright test"));
  const packageSmokes = steps.map((step, index) => ({ step, index }))
    .filter(({ step }) => /npm run test:(?:package-smoke|release-container-smoke|windows-installer-smoke)/u.test(step.run ?? ""));
  expect(packageSmokes.length).toBeGreaterThanOrEqual(5);
  for (const { index } of packageSmokes) expect(index).toBeLessThan(firstDesktop);
  for (const step of steps.filter((step) => step.run?.includes("playwright test"))) {
    expect(step.if).not.toMatch(/always\(|failure\(|cancelled\(/u);
  }
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(steps.filter((step) => step.run === "npm run build:packaged")).toHaveLength(1);
});

it("CI runs native package proof and desktop Electron projects as separate same-source jobs", () => {
  const packageSteps = workflow.jobs.test.steps as Array<{ name: string; run?: string; if?: string }>;
  const electronSteps = workflow.jobs.electron.steps as Array<{ name: string; run?: string; if?: string; uses?: string }>;
  expect(packageSteps.some((step) => step.run?.includes("playwright test"))).toBe(false);
  expect(packageSteps.filter((step) =>
    /npm run test:(?:package-smoke|release-container-smoke|windows-installer-smoke)/u.test(step.run ?? "")).length)
    .toBeGreaterThanOrEqual(5);
  expect(packageSteps.filter((step) => step.run === "npm run build:packaged")).toHaveLength(1);
  expect(electronSteps.filter((step) => step.run === "npm run build:packaged")).toHaveLength(1);
  expect(electronSteps.some((step) => step.run?.includes("npm run test:package-smoke"))).toBe(false);
  const projects = electronSteps.filter((step) => step.run?.includes("playwright test"))
    .map((step) => /--project=([a-z-]+)/u.exec(step.run!)![1]);
  // Every project once without Xvfb and once under it, in the documented order.
  expect(projects).toEqual([
    "display-sensitive", "isolated", "runtime-recovery",
    "display-sensitive", "isolated", "runtime-recovery",
  ]);
  for (const step of electronSteps.filter((step) => step.run?.includes("playwright test"))) {
    expect(step.if).not.toMatch(/always\(|failure\(|cancelled\(/u);
  }
  for (const id of ["test", "electron"]) {
    const job = workflow.jobs[id];
    expect(job.needs).toEqual(["classify", "gate"]);
    expect(job["runs-on"]).toBe("${{ matrix.runner }}");
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job.strategy.matrix).toBe(id === "electron"
      ? "${{ fromJSON(needs.classify.outputs.electron_matrix_json) }}"
      : "${{ fromJSON(needs.classify.outputs.matrix_json) }}");
    expect(job.strategy["max-parallel"]).toBe(`\${{ github.event_name == 'schedule' && 2 || ${id === "electron" ? 10 : 6} }}`);
    expect(job.steps[0].uses).toMatch(/^actions\/checkout@/u);
    expect(job.steps.some((step: { uses?: string }) => step.uses === "./.github/actions/install-dependencies")).toBe(true);
  }
  expect(workflow.jobs.test["timeout-minutes"]).toBe("${{ matrix.timeout_minutes }}");
  expect(workflow.jobs.electron["timeout-minutes"]).toBe("${{ matrix.electron_timeout_minutes }}");
  expect(workflow.jobs.electron.name).toBe("${{ matrix.check }}");
  for (const platform of PLATFORMS) {
    expect(platform.electron_timeout_minutes).toBeGreaterThanOrEqual(40);
    expect(platform.electron_timeout_minutes).toBeLessThanOrEqual(platform.timeout_minutes);
  }
});

it("splits every complete Electron target into display-sensitive and isolated-plus-recovery jobs", () => {
  const entry = ({ artifact, phase, shard }: { artifact: string; phase: string; shard?: string }) =>
    `${artifact}:${phase}${shard ? ` ${shard}` : ""}`;
  const pullRequest = createEvidencePlan({ head: "a".repeat(40), base: "b".repeat(40), paths: ["package-lock.json"] });
  expect(pullRequest.electronMatrix.include.map(entry)).toEqual([
    "linux-x64:display-sensitive", "linux-x64:isolated",
    "windows-x64:display-sensitive", "windows-x64:isolated 1/2", "windows-x64:isolated 2/2",
    "macos-arm64:display-sensitive", "macos-arm64:isolated",
    "linux-arm64:runtime-recovery", "windows-arm64:runtime-recovery", "macos-x64:runtime-recovery",
  ]);
  const nightly = createEvidencePlan({ head: "a".repeat(40), base: "b".repeat(40), paths: ["README.md"], event: "schedule" });
  expect(nightly.electronMatrix.include.map(entry)).toEqual(
    PLATFORMS.flatMap(({ artifact }) => [`${artifact}:display-sensitive`, ...(artifact.startsWith("windows-")
      ? [`${artifact}:isolated 1/2`, `${artifact}:isolated 2/2`] : [`${artifact}:isolated`])]),
  );
  expect(nightly.electronMatrix.include.filter(({ shard }) => shard).map(({ check, evidence_artifact }) => [check, evidence_artifact]))
    .toEqual([
      ["Windows x64 Electron (isolated 1/2)", "windows-x64-isolated-1-of-2"],
      ["Windows x64 Electron (isolated 2/2)", "windows-x64-isolated-2-of-2"],
      ["Windows ARM64 Electron (isolated 1/2)", "windows-arm64-isolated-1-of-2"],
      ["Windows ARM64 Electron (isolated 2/2)", "windows-arm64-isolated-2-of-2"],
    ]);
  for (const plan of [pullRequest, nightly]) {
    expect(new Set(plan.electronMatrix.include.map(({ evidence_artifact }) => evidence_artifact)).size)
      .toBe(plan.electronMatrix.include.length);
    for (const { check } of plan.electronMatrix.include) expect(plan.requiredChecks).toContain(check);
  }
  expect(pullRequest.electronMatrix.include.length).toBeLessThanOrEqual(10);
  const playwrightSteps = workflow.jobs.electron.steps.filter((entry: { run?: string }) => entry.run?.includes("playwright test"));
  const phasesFor = (project: string) => playwrightSteps.filter((step: { run: string }) => step.run.includes(`--project=${project} `));
  for (const [project, phases] of [
    ["display-sensitive", ["display-sensitive"]],
    ["isolated", ["isolated"]],
    ["runtime-recovery", ["isolated", "runtime-recovery"]],
  ] as const) {
    const steps = phasesFor(project);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      const guarded = [...step.if.matchAll(/matrix\.phase == '([a-z-]+)'/gu)].map((match) => match[1]);
      expect(guarded).toEqual(phases);
      expect(step["continue-on-error"]).not.toBe(true);
    }
  }
  const nativeIsolated = phasesFor("isolated").find((step: { if: string }) => step.if.startsWith("runner.os != 'Linux'"));
  expect(nativeIsolated.env.INERTIA_E2E_WORKERS).toBe("${{ runner.os == 'Windows' && '1' || '2' }}");
  expect(nativeIsolated.run).toContain("${{ matrix.shard && format('--shard={0}', matrix.shard) || '' }}");
  for (const step of phasesFor("runtime-recovery")) {
    expect(step.if.includes("matrix.shard != '2/2'")).toBe(step.if.startsWith("runner.os != 'Linux'"));
  }
  expect(workflow.jobs.electron.steps.find((step: { name: string }) => step.name === "Keep provider settings visual evidence").if)
    .toContain("matrix.phase == 'display-sensitive'");
  const benchmarks = workflow.jobs.electron.steps.filter((step: { run?: string }) => step.run?.includes("benchmark:desktop"));
  expect(benchmarks).toHaveLength(1);
  expect(benchmarks[0].if).toContain("matrix.artifact == 'linux-x64' && matrix.phase == 'isolated'");
  expect(workflow.jobs.electron.steps.find((step: { name: string }) => step.name === "Keep desktop performance evidence").if)
    .toContain("matrix.artifact == 'linux-x64' && matrix.phase == 'isolated'");
});

it("runs bounded operation-count performance checks before native jobs for a performance PR", () => {
  const plan = createEvidencePlan({ head: "a".repeat(40), base: "b".repeat(40), paths: ["benchmarks/data-throughput.test.ts"] });
  expect(plan.performanceSmoke).toBe(true);
  expect(plan.benchmarks).toBe(false);
  expect(workflow.jobs.gate.needs).toBe("classify");
  const smoke = workflow.jobs.gate.steps.find((step: { name: string }) => step.name === "Enforce bounded streaming and rendering work");
  expect(smoke.if).toBe("needs.classify.outputs.performance_smoke == 'true'");
  expect(smoke["timeout-minutes"]).toBe(3);
  expect(smoke.run).toContain("tests/renderer/streaming-render-isolation.dom.test.tsx");
  expect(smoke["continue-on-error"]).not.toBe(true);
});

it("keeps provider canary failures visible without filing incidents for cancelled or branch runs", () => {
  const drift = parse(source(".github/workflows/provider-contract-drift.yml"));
  expect(drift.on.push).toBeUndefined();
  expect(drift.jobs["provider-drift"]["continue-on-error"]).not.toBe(true);
  const final = drift.jobs["provider-drift"].steps.at(-1);
  expect(final.if).toBe("always()");
  expect(final.run).toBe('test "$CANARY_FAILED" = false');
  expect(final["continue-on-error"]).not.toBe(true);
  expect(workflow.jobs["merge-ready"].needs).not.toContain("provider-drift");
  expect(drift.jobs["report-failure"].if).toContain("github.ref == 'refs/heads/main'");
  expect(drift.jobs["report-failure"].if).toContain("needs.provider-drift.result != 'cancelled'");
});
