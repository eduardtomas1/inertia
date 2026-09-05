import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Native Git, SQLite, and WebSocket fixtures contend heavily on hosted Windows.
const isWindowsCi = process.platform === "win32" && process.env.CI === "true";
const windowsRuntimeJobIntegrity: unknown = JSON.parse(readFileSync(resolve(
  "resources/generated/windows-runtime-job-integrity.json",
), "utf8"));
if (
  !windowsRuntimeJobIntegrity
  || typeof windowsRuntimeJobIntegrity !== "object"
  || Object.keys(windowsRuntimeJobIntegrity).length !== 1
  || !("sha256" in windowsRuntimeJobIntegrity)
  || (windowsRuntimeJobIntegrity.sha256 !== null
    && (typeof windowsRuntimeJobIntegrity.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(windowsRuntimeJobIntegrity.sha256)))
) throw new Error("The Windows runtime Job Object integrity manifest is invalid.");

export default defineConfig({
  define: {
    __INERTIA_WINDOWS_RUNTIME_JOB_SHA256__: JSON.stringify(
      windowsRuntimeJobIntegrity.sha256,
    ),
  },
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
    // #74 established that two hosted-Windows workers contend across native
    // Git, SQLite, and WebSocket fixtures. Sharding reduces wall time without
    // reintroducing that per-runner race.
    maxWorkers: isWindowsCi ? 1 : undefined,
    testTimeout: isWindowsCi ? 30_000 : 15_000,
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
            "tests/server/runtime.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "runtime-integration",
          environment: "node",
          include: ["tests/server/runtime.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: {
            groupOrder: 1,
          },
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
        "src/shared/private-connect/*.ts": {
          statements: 95,
          branches: 90,
          functions: 96,
          lines: 97,
        },
        "src/server/private-connect/*.ts": {
          statements: 62,
          branches: 50,
          functions: 63,
          lines: 67,
        },
        "src/main/private-connect/*.ts": {
          statements: 60,
          branches: 57,
          functions: 62,
          lines: 66,
        },
        "src/{main,server/runtime}/secure-file*.ts": {
          statements: 78,
          branches: 75,
          functions: 79,
          lines: 82,
        },
        "src/main/credential-vault.ts": {
          statements: 68,
          branches: 67,
          functions: 60,
          lines: 73,
        },
      },
    },
  },
});
