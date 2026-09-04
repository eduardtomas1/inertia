import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof process.threadCpuUsage !== "function") {
  throw new Error(
    "The browser-evidence CPU budget requires process.threadCpuUsage.",
  );
}

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const vitestEntry = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
const result = spawnSync(process.execPath, [
  vitestEntry,
  "run",
  "--project=node",
  "--maxWorkers=1",
  "--coverage=false",
  "tests/main/browser-evidence-capture.test.ts",
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    INERTIA_ENFORCE_BROWSER_EVIDENCE_CPU_BUDGET: "1",
  },
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
if (result.signal) {
  throw new Error(
    `Browser-evidence CPU budget process stopped by ${result.signal}.`,
  );
}
if (result.status === null) {
  throw new Error("Browser-evidence CPU budget process returned no status.");
}
if (result.status !== 0) process.exitCode = result.status;
