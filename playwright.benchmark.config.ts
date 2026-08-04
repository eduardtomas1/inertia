import { defineConfig } from "@playwright/test";

import {
  TURN_GIT_ARTIFACT_FINALIZATION_TIMEOUT_MS,
} from "./src/shared/runtime-command-timeouts";

const STREAMING_SAMPLE_COUNT = process.env.CI ? 3 : 5;
const BASE_BENCHMARK_TIMEOUT_MS = 180_000;

export default defineConfig({
  testDir: "tests/performance",
  testMatch: "desktop.benchmark.spec.ts",
  // Each serial stream may legitimately spend the full production Git
  // artifact finalization window before its final-layout sample is valid.
  timeout: BASE_BENCHMARK_TIMEOUT_MS
    + STREAMING_SAMPLE_COUNT * TURN_GIT_ARTIFACT_FINALIZATION_TIMEOUT_MS,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
