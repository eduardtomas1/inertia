import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/performance",
  testMatch: "startup-profile.spec.ts",
  outputDir: "test-results/startup-profile",
  timeout: 60 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
});
