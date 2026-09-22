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

it("stages the actual native artifacts before desktop tests without publishing them", () => {
  const steps = workflow.jobs.test.steps as Array<{ name: string; run?: string; env?: Record<string, string>; "continue-on-error"?: boolean }>;
  const stageIndex = steps.findIndex(({ name }) => name === "Validate native release asset staging");
  expect(stageIndex).toBeGreaterThan(steps.findIndex(({ name }) => name === "Package Linux AppImage and unpacked app"));
  expect(stageIndex).toBeLessThan(steps.findIndex(({ run }) => run?.includes("playwright test")));
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

it.each([["ci.yml", "test"], ["release-platforms.yml", "build"]])(
  "%s proves exact packages before desktop tests and never continues on unconfirmed cleanup", (file, id) => {
    const job = parse(source(`.github/workflows/${file}`)).jobs[id];
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
  },
);

it.each([["ci.yml", "pr-linux-lifecycle"], ["ci.yml", "test"], ["release-platforms.yml", "build"]])(
  "%s %s provides real private Secret Service prerequisites before Linux desktop tests", (file, id) => {
    const steps = parse(source(`.github/workflows/${file}`)).jobs[id].steps as Array<{ run?: string }>;
    const install = steps.findIndex((step) => step.run?.includes("apt-get install") && step.run.includes("gnome-keyring"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(steps[install]!.run).toContain("dbus-daemon dbus-bin gnome-keyring");
    expect(install).toBeLessThan(steps.findIndex((step) => step.run?.includes("playwright test")));
  },
);

it("isolates native and verifier dependency changes without suppressing security updates or protocol review", () => {
  const config = parse(source(".github/dependabot.yml"));
  const npm = config.updates.find((entry: { "package-ecosystem": string }) => entry["package-ecosystem"] === "npm");
  expect(npm.groups["vitest-contract"].patterns).toEqual(["vitest", "@vitest/*"]);
  expect(npm.groups["vitest-contract"]["update-types"]).toEqual(["patch", "minor", "major"]);
  expect(npm.groups["production-patch-and-minor"]["exclude-patterns"]).toEqual(expect.arrayContaining([
    "@agentclientprotocol/sdk", "@anthropic-ai/claude-agent-sdk", "@opencode-ai/sdk",
    "@napi-rs/canvas", "better-sqlite3", "node-pty", "electron-updater",
  ]));
  expect(npm.groups["development-patch-and-minor"]["exclude-patterns"]).toEqual(expect.arrayContaining([
    "electron", "electron-builder", "@playwright/test", "vitest", "@vitest/*",
  ]));
  expect(npm["target-branch"]).toBeUndefined();
  expect(npm["rebase-strategy"]).not.toBe("disabled");
  expect(npm["open-pull-requests-limit"]).toBeGreaterThan(0);
});

it("retains compact timing evidence on success and failure without adding retries or changing selection", () => {
  for (const id of ["pr-linux-lifecycle", "pr-windows-lifecycle", "pr-macos-lifecycle", "test"]) {
    const job = workflow.jobs[id];
    expect(job.env.INERTIA_CI_TIMINGS).toBe("true");
    expect(job.env.INERTIA_CI_SOURCE_HEAD).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
    const timing = job.steps.find((step: { name: string }) => step.name === "Keep compact Electron timing evidence");
    expect(timing.if).toBe("always()");
    expect(timing.with.path).toBe("ci-test-timings/*.json");
    expect(timing.with.name).toContain("${{ github.run_attempt }}");
    expect(timing.with["retention-days"]).toBe(7);
  }
  expect(source("playwright.config.ts")).toContain('trace: "retain-on-failure"');
  expect(source("playwright.config.ts")).not.toMatch(/retries:/u);
});
