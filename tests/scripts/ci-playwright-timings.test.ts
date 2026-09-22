import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("reports actual discovery, failed/skipped attempts and exact identity without test output", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-ci-playwright-timings-"));
  try {
    const testModule = pathToFileURL(resolve("node_modules/@playwright/test/index.mjs")).href;
    const reporter = resolve("scripts/ci/playwright-timings.mjs");
    await writeFile(join(root, "playwright.config.mjs"), `export default {
      testDir: '.', workers: 1, retries: 0, reporter: [[${JSON.stringify(reporter)}]],
      projects: [{name: 'isolated'}]
    };`);
    await writeFile(join(root, "timing.spec.mjs"), `import { test, expect } from ${JSON.stringify(testModule)};
      test('pass', () => { console.log('private test output'); });
      test('failure', () => { expect('private error').toBe('different'); });
      test.skip('skip', () => {});
    `);
    const result = spawnSync(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test"], {
      cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GITHUB_SHA: "a".repeat(40), INERTIA_CI_SOURCE_HEAD: "b".repeat(40),
        GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const raw = await readFile(join(root, "ci-test-timings/isolated-all.json"), "utf8");
    const report = JSON.parse(raw);
    expect(report).toMatchObject({ candidate: "a".repeat(40), sourceHead: "b".repeat(40),
      runId: "42", runAttempt: "2", status: "failed", discovered: 3, files: 1, projects: ["isolated"] });
    expect(report.tests.map((test: { attempts: Array<{ status: string }> }) => test.attempts[0]!.status))
      .toEqual(["passed", "failed", "skipped"]);
    expect(new Set(report.tests.map((test: { id: string }) => test.id)).size).toBe(3);
    expect(raw).not.toContain("private");
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("attachments");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
