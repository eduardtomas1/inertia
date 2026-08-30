import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  // Cold Electron runtime, Git, and fixture readiness on macOS ARM64 can exceed
  // Playwright's five-second default; explicit shorter protocol waits still win.
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
