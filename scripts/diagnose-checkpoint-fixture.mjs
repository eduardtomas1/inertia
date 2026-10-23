import childProcess from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Disposable, secret-free diagnostic: observe the real fixture without changing
// its operations, Git arguments, or timeout. No product process uses this file.
const execFile = promisify(childProcess.execFile);
const originalExecFile = childProcess.execFile;
const originalMkdir = fs.promises.mkdir;
const originalWriteFile = fs.promises.writeFile;
let started = 0;
let directories = 0;
let writes = 0;
const mark = (phase, extra = {}) => console.log(JSON.stringify({
  phase, elapsedMs: Math.round(performance.now() - started), directories, writes, ...extra,
}));
const observedExecFile = (...args) => originalExecFile(...args);
observedExecFile[promisify.custom] = async (...args) => {
  const command = args[1].filter((arg) => ["init", "config", "add", "commit"].includes(arg)).join("-");
  mark(`git-${command}-start`);
  try { return await execFile(...args); }
  finally { mark(`git-${command}-end`); }
};
childProcess.execFile = observedExecFile;
fs.promises.mkdir = async (...args) => {
  directories += 1;
  return await originalMkdir(...args);
};
fs.promises.writeFile = async (...args) => {
  writes += 1;
  return await originalWriteFile(...args);
};
syncBuiltinESMExports();
const { createCheckpointBenchmarkRepository } = await import(
  "../tests/helpers/checkpoint-benchmark-repository.ts"
);
for (let sample = 1; sample <= 3; sample += 1) {
  const root = await mkdtemp(join(tmpdir(), "inertia-checkpoint-phase-"));
  const config = join(root, "gitconfig");
  await writeFile(config, "[core]\n\tautocrlf = true\n\tsafecrlf = warn\n");
  started = performance.now();
  directories = 0;
  writes = 0;
  mark("sample-start", { sample, platform: process.platform, architecture: process.arch });
  try {
    const result = await createCheckpointBenchmarkRepository(join(root, "repository"), 12_000, {
      ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1",
    });
    mark("fixture-complete", { stderrBytes: Buffer.byteLength(result.stderr) });
  } finally {
    mark("cleanup-start");
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    mark("cleanup-complete");
  }
}
