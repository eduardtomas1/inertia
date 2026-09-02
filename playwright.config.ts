import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const testDir = "tests/e2e";

// Specs that pin their window to the primary display's work-area origin share
// a real, single machine resource: two of them at the same coordinates occlude
// each other, and Chromium throttles rendering for an occluded window. They
// are discovered here rather than listed so a new spec cannot silently opt
// itself into concurrency by adding windowDisplay.
const displaySensitiveSpecs = readdirSync(testDir)
  .filter((entry) => entry.endsWith(".spec.ts"))
  .filter((entry) =>
    readFileSync(join(testDir, entry), "utf8").includes('windowDisplay: "primary"'),
  )
  .sort();

// Measured on the hosted runners rather than assumed: a second concurrent
// Electron instance does not pay for itself. Electron startup here is bound by
// disk rather than by cores, so on windows-2025 two workers ran the suite in
// 10.6m against 9.58m serial — slower — and pushed six specs past their
// deadlines. macOS ARM64 and Linux x64 also lost specs; only Linux ARM64
// gained (8.2m to 4.5m). Serial stays the default because that trade is not
// worth a weaker deadline on every assertion.
//
// The override remains so the trade can be re-measured on future runner
// images without a code change, and everything below keeps that safe: budgets
// scale with the worker count, and the specs that share one machine resource
// are held in their own phase.
const parsedWorkers = Number.parseInt(process.env.INERTIA_E2E_WORKERS ?? "", 10);
const workers =
  Number.isInteger(parsedWorkers) && parsedWorkers > 0 ? parsedWorkers : 1;

// Deadlines belong to a concurrent Electron instance, not to a run. At one
// worker this reproduces the deadlines exactly as they were; raising the
// worker count raises them with it, so nobody has to rediscover that secure
// attachment import needs more than 15s while sharing four cores.
const budgetScale = workers;

export default defineConfig({
  testDir,
  timeout: 45_000 * budgetScale,
  // Cold Electron runtime, Git, and fixture readiness on macOS ARM64 can exceed
  // Playwright's five-second default; explicit shorter protocol waits still win.
  expect: { timeout: 15_000 * budgetScale },
  fullyParallel: false,
  workers,
  reporter: "line",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "display-sensitive",
      testMatch: displaySensitiveSpecs,
      workers: 1,
    },
    {
      name: "isolated",
      testIgnore: displaySensitiveSpecs,
      // Runs only once the display-sensitive phase has released the primary
      // display, so no spec that positions a window competes for it.
      dependencies: ["display-sensitive"],
    },
  ],
});
