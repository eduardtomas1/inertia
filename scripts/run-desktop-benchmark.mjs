import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const reportPath = resolve(
  process.env.INERTIA_DESKTOP_BENCHMARK_REPORT
    ?? `performance-results/desktop-${process.platform}-${process.arch}.json`,
);
await mkdir(dirname(reportPath), { recursive: true });

const playwrightEntry = resolve("node_modules/@playwright/test/cli.js");
const child = spawn(process.execPath, [
  playwrightEntry,
  "test",
  "--config",
  "playwright.benchmark.config.ts",
], {
  env: {
    ...process.env,
    INERTIA_DESKTOP_BENCHMARK_REPORT: reportPath,
  },
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Desktop benchmark stopped by ${signal}.`));
    else resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
else console.log(`Desktop benchmark report: ${reportPath}`);
