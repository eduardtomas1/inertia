import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("src/renderer/src"),
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/performance/**/*.benchmark.test.ts"],
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
