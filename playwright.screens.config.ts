import { defineConfig } from "@playwright/test";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: "tests/performance",
  testMatch: /screen-open.*\.benchmark\.spec\.ts$/u,
  outputDir: "test-results/screen-open-benchmark",
  timeout: 600_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    trace: "off",
    screenshot: "only-on-failure",
  },
});
