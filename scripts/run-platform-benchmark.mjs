import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const enforce = process.argv.slice(2).includes("--enforce");
const reportPath = resolve(
  process.env.INERTIA_BENCHMARK_REPORT
    ?? `performance-results/platform-${process.platform}-${process.arch}.json`,
);

await mkdir(resolve(reportPath, ".."), { recursive: true });

const vitestEntry = resolve("node_modules/vitest/vitest.mjs");
const child = spawn(process.execPath, [
  vitestEntry,
  "run",
  "--config",
  "vitest.benchmark.config.ts",
  "tests/performance/platform.benchmark.test.ts",
], {
  env: {
    ...process.env,
    INERTIA_BENCHMARK_ENFORCE: enforce ? "1" : "0",
    INERTIA_BENCHMARK_REPORT: reportPath,
  },
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Platform benchmark stopped by ${signal}.`));
    else resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
else console.log(`Platform benchmark report: ${reportPath}`);
