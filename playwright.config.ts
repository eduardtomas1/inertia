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

// Keyboard and mouse input reaches these specs over CDP rather than through the
// window manager, so operating-system focus is not contended. Electron startup
// is the real cost, and each fixture already owns a private temporary
// directory, Electron profile, and workspace.
const parsedWorkers = Number.parseInt(process.env.INERTIA_E2E_WORKERS ?? "", 10);
const workers =
  Number.isInteger(parsedWorkers) && parsedWorkers > 0 ? parsedWorkers : 2;

// Deadlines have to be stated per concurrent Electron instance, not per run.
// The hosted runners have four cores, so a second instance roughly halves the
// cycles available to secure attachment import, which hashes and copies real
// files: at one worker it settles well inside 15s, and at two it overran that
// budget on Linux x64 while the same specs passed on Linux ARM64. Scaling with
// the worker count keeps the assertion honest instead of retrying a green test
// until it passes; a genuine break still fails inside one scaled budget.
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
