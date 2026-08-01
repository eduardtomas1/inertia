import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/performance",
  testMatch: "desktop.benchmark.spec.ts",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
