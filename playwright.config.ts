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

// Keyboard and mouse input reaches the isolated specs over CDP rather than
// through the window manager, so operating-system focus is not contended.
// Electron startup is the real cost, and each fixture owns a private temporary
// directory, profile, and workspace.
const parsedWorkers = Number.parseInt(process.env.INERTIA_E2E_WORKERS ?? "", 10);
const workers =
  Number.isInteger(parsedWorkers) && parsedWorkers > 0 ? parsedWorkers : 2;

const testTimeout = 45_000;
const assertionTimeout = 15_000;
const runtimeRecoveryTag = /@runtime-recovery/u;

export default defineConfig({
  testDir,
  timeout: testTimeout,
  // Cold Electron runtime, Git, and fixture readiness on macOS ARM64 can exceed
  // Playwright's five-second default; explicit shorter protocol waits still win.
  expect: { timeout: assertionTimeout },
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
      grepInvert: runtimeRecoveryTag,
      workers,
      // Only this phase launches concurrent Electron instances. The hosted
      // runners have four cores, so each instance gets proportional deadline
      // headroom without weakening the single-worker geometry phase.
      timeout: testTimeout * workers,
      expect: { timeout: assertionTimeout * workers },
    },
    {
      name: "runtime-recovery",
      testIgnore: displaySensitiveSpecs,
      grep: runtimeRecoveryTag,
      workers: 1,
      timeout: testTimeout * 2,
      expect: { timeout: assertionTimeout * 2 },
    },
  ],
});
