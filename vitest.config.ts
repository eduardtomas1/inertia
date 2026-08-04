import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Native Git, SQLite, and WebSocket fixtures contend heavily on hosted Windows.
const windowsCiMaxWorkers =
  process.platform === "win32" && process.env.CI === "true" ? 2 : undefined;

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
    maxWorkers: windowsCiMaxWorkers,
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: [
            "tests/performance/**/*.benchmark.test.ts",
            "tests/renderer/**/*.dom.test.tsx",
          ],
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
        "src/shared/remote-*.ts": {
          statements: 96,
          branches: 91,
          functions: 96,
          lines: 97,
        },
        "src/server/remote-*.ts": {
          statements: 84,
          branches: 75,
          functions: 80,
          lines: 87,
        },
        "src/main/remote-access-*.ts": {
          statements: 74,
          branches: 69,
          functions: 80,
          lines: 76,
        },
        "src/{main,server/runtime}/secure-file*.ts": {
          statements: 78,
          branches: 75,
          functions: 79,
          lines: 82,
        },
        "src/main/credential-vault.ts": {
          statements: 70,
          branches: 69,
          functions: 68,
          lines: 76,
        },
      },
    },
  },
});
