import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { linuxProcessGroupCanExecute } from
  "../../scripts/linux-process-group.mjs";

const moduleUrl = pathToFileURL(join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "ci",
  "run-repeated-lifecycle.mjs",
)).href;

async function repeatedLifecycleModule() {
  return await import(moduleUrl) as {
    repeatedLifecycleClassification: (
      attempts: readonly { passed: boolean }[],
    ) => "flake-observed" | "stable-failure" | "stable-pass";
    repeatedLifecycleSuites: (platform: "darwin" | "linux" | "win32") =>
      readonly string[];
    runLifecycleAttempt: (options: {
      args: string[];
      command: string;
      label: string;
      outputPath: string;
      timeoutMs: number;
    }) => Promise<{
      durationMs: number;
      outcome: "cleanup-unconfirmed" | "failed" | "passed" | "timed-out";
      passed: boolean;
    }>;
  };
}

function processCanExecute(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingName = stat.lastIndexOf(")");
      const state = closingName < 0
        ? ""
        : stat.slice(closingName + 1).trimStart().split(/\s+/u)[0];
      return state !== "Z" && state !== "X" && state !== "x";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("keeps common lifecycle ownership proof in every platform repetition", async () => {
  const { repeatedLifecycleSuites } = await repeatedLifecycleModule();
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const suites = repeatedLifecycleSuites(platform);
    expect(suites).toEqual(expect.arrayContaining([
      "tests/main/app-update-handoff.test.ts",
      "tests/main/runtime-supervisor-lifecycle.test.ts",
      "tests/server/process-lifecycle.test.ts",
      "tests/server/runtime-shutdown-authority.test.ts",
    ]));
    expect(new Set(suites).size).toBe(suites.length);
  }
  expect(repeatedLifecycleSuites("linux")).toContain(
    "tests/main/app-update-startup.test.ts",
  );
  expect(repeatedLifecycleSuites("win32")).toContain(
    "tests/main/windows-runtime-job.test.ts",
  );
  expect(repeatedLifecycleSuites("darwin")).toContain(
    "tests/main/runtime-live-darwin-recovery.test.ts",
  );
});

test("records mixed attempts as flakes without converting them to success", async () => {
  const { repeatedLifecycleClassification } = await repeatedLifecycleModule();

  expect(repeatedLifecycleClassification([
    { passed: true },
    { passed: true },
    { passed: true },
  ])).toBe("stable-pass");
  expect(repeatedLifecycleClassification([
    { passed: false },
    { passed: false },
    { passed: false },
  ])).toBe("stable-failure");
  expect(repeatedLifecycleClassification([
    { passed: false },
    { passed: true },
    { passed: true },
  ])).toBe("flake-observed");
});

test("bounds a hung attempt, retains typed start evidence, and confirms owned-tree cleanup", async () => {
  const { runLifecycleAttempt } = await repeatedLifecycleModule();
  const root = await mkdtemp(join(tmpdir(), "inertia-lifecycle-deadline-"));
  const outputPath = join(root, "attempt.log");
  const source = `
    setInterval(() => {}, 1000);
  `;
  try {
    const result = await runLifecycleAttempt({
      args: ["-e", source],
      command: process.execPath,
      label: "Injected lifecycle deadline",
      outputPath,
      timeoutMs: 100,
    });
    expect(result).toMatchObject({
      outcome: "timed-out",
      passed: false,
    });
    expect(result.durationMs).toBeLessThan(10_000);
    const log = await readFile(outputPath, "utf8");
    const started = JSON.parse(log.split("\n")[0]!) as {
      event: string;
      owner: { pid: number; processGroupId: number | null };
      schemaVersion: number;
    };
    expect(started).toEqual({
      schemaVersion: 1,
      event: "attempt-started",
      owner: {
        pid: expect.any(Number),
        processGroupId: process.platform === "win32"
          ? null
          : expect.any(Number),
      },
    });
    expect(log).toContain("Lifecycle attempt terminal outcome: timed-out");
    expect(started.owner.pid).toBeGreaterThan(1);
    await expect.poll(
      () => process.platform === "linux" && started.owner.processGroupId !== null
        ? linuxProcessGroupCanExecute(started.owner.processGroupId)
        : processCanExecute(started.owner.pid),
      { timeout: 5_000 },
    ).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

test("retains every scheduled attempt and opens one bounded tracked failure", async () => {
  const repositoryRoot = join(import.meta.dirname, "..", "..");
  const [manifestSource, workflow] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as {
    scripts: Record<string, string>;
  };

  expect(manifest.scripts["test:lifecycle-repeat"])
    .toBe("node scripts/ci/run-repeated-lifecycle.mjs");
  expect(workflow).toContain(
    "Repeat selected lifecycle invariants for nightly flake evidence",
  );
  expect(workflow).toContain("--iterations 3");
  expect(workflow).toContain("name: nightly-lifecycle-${{ matrix.artifact }}");
  expect(workflow).toContain(
    "Fail certification when any lifecycle repetition failed",
  );
  expect(workflow).toContain("Report nightly lifecycle certification failure");
  expect(workflow).toContain("issues: write");
  expect(workflow).toContain("github.rest.issues.listComments");
  expect(workflow).toContain(
    "priorComments.filter((comment) => comment.body?.includes(marker)).length",
  );
  expect(workflow).toContain("Provider dependency versions bound to this SHA");
  expect(workflow).toContain("Prior occurrences tracked here");
  expect(workflow).toContain("Runner logs and retained artifacts");
  const reporter = workflow.slice(workflow.indexOf("  report-nightly-failure:"));
  expect(reporter).not.toContain("continue-on-error:");
});
