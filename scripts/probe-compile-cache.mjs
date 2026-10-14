import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const electron = resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const bundle = resolve(process.argv[2] ?? "out/main/runtime-worker.js");
const runs = Number(process.argv[3] ?? 7);
const source = (cacheDirectory) => `
const { performance } = require("node:perf_hooks");
const started = performance.now();
${cacheDirectory ? `require("node:module").enableCompileCache(${JSON.stringify(cacheDirectory)});` : ""}
import(${JSON.stringify(bundle)}).then(() => { console.log(JSON.stringify({ ms: performance.now() - started, outcome: "loaded" })); }, (error) => {
  console.log(JSON.stringify({ ms: performance.now() - started, outcome: String(error.message).slice(0, 80) }));
});`;
function run(cacheDirectory) {
  const result = spawnSync(electron, ["-e", source(cacheDirectory)], {
    env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin:/bin", HOME: tmpdir() },
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; };
const noCache = []; const firstFill = []; const cached = [];
for (let index = 0; index < runs; index += 1) {
  noCache.push(run(null));
  const directory = mkdtempSync(join(tmpdir(), "inertia-compile-cache-"));
  firstFill.push(run(directory));
  cached.push(run(directory));
  rmSync(directory, { recursive: true, force: true });
}
for (const [label, values] of [["no cache", noCache], ["cache fill", firstFill], ["cache hit", cached]]) {
  const ms = values.map((value) => value.ms);
  console.log(`${label}: median ${median(ms).toFixed(1)} ms, max ${Math.max(...ms).toFixed(1)}, raw ${ms.map((v) => v.toFixed(0)).join(",")}, outcome ${values[0].outcome}`);
}
