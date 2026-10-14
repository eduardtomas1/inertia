import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/performance",
  testMatch: "scroll-profile.spec.ts",
  outputDir: "test-results/scroll-profile",
  timeout: 30 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    trace: "off",
    screenshot: "only-on-failure",
  },
});
