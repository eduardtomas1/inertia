import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const vitestPath = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const child = spawn(
  electronPath,
  [vitestPath, ...process.argv.slice(2)],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Electron-backed Vitest could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Electron-backed Vitest stopped after ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
