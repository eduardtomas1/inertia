import { defineConfig } from "@playwright/test";
import { discoverE2eResources, exactScenarioPattern } from "./tests/support/e2e-resource-policy";

const testDir = "tests/e2e";

// Every scenario declares its machine resource, including nested and new specs.
// The fixture also rejects helper-selected primary windows in an isolated lane.
const resources = discoverE2eResources(testDir);
const displaySensitiveSpecs = exactScenarioPattern(resources["primary-display"]);
const isolatedSpecs = exactScenarioPattern(resources.isolated);

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
      testMatch: isolatedSpecs,
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
      testMatch: isolatedSpecs,
      grep: runtimeRecoveryTag,
      workers: 1,
      timeout: testTimeout * 2,
      expect: { timeout: assertionTimeout * 2 },
    },
  ],
});
