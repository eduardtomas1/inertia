import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/performance",
  testMatch: "content-loading.benchmark.spec.ts",
  outputDir: "test-results/content-benchmark",
  timeout: 1_800_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    trace: "off",
    screenshot: "only-on-failure",
  },
});
