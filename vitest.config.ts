import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": resolve("src/renderer/src"),
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: ["tests/renderer/**/*.dom.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer-dom",
          environment: "happy-dom",
          include: ["tests/renderer/**/*.dom.test.tsx"],
          setupFiles: ["tests/renderer/dom/setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text-summary", "json-summary", "html"],
      thresholds: {
        statements: 62.5,
        branches: 57.5,
        functions: 59,
        lines: 66,
        "src/renderer/**": {
          statements: 33,
          branches: 37,
          functions: 29,
          lines: 34.5,
        },
      },
    },
  },
});
