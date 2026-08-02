import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": resolve("src/renderer/src"),
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    disableConsoleIntercept: true,
    environment: "node",
    include: [
      "benchmarks/**/*.test.ts",
      "tests/performance/**/*.benchmark.test.ts",
    ],
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
