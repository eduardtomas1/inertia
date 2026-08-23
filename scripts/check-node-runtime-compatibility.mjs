import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runtimeStatusCli = join(repositoryRoot, "out", "main", "runtime-status-cli.js");
const temporaryRoot = mkdtempSync(join(tmpdir(), "inertia-node-runtime-"));
const projectRoot = join(temporaryRoot, "project");
const emptyPath = join(temporaryRoot, "bin");
const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) {
  if (name.toLowerCase() === "path") delete childEnvironment[name];
}
childEnvironment.PATH = emptyPath;

function run(arguments_) {
  const result = spawnSync(process.execPath, [runtimeStatusCli, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: childEnvironment,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Node runtime compatibility check failed: ${message}`);
}

try {
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  mkdirSync(emptyPath);

  const help = run(["--help"]);
  assert(help.status === 0, `help exited ${help.status}: ${help.stderr}`);
  assert(help.stdout.startsWith("Usage: npm run --silent status:runtime"), "help did not execute the runtime CLI");

  const rejected = run(["--token=must-not-be-accepted"]);
  assert(rejected.status === 1, `unknown-option path exited ${rejected.status}`);
  assert(rejected.stderr === "Unknown status option.\n", "unknown-option path changed its bounded error");

  const readiness = run(["--cwd", projectRoot]);
  assert(readiness.status === 0, `readiness report exited ${readiness.status}: ${readiness.stderr}`);
  const report = JSON.parse(readiness.stdout);
  assert(report.environment?.workspaceReadable === true, "readiness report did not inspect the workspace");
  assert(
    report.sourceControl?.some((sourceControl) => sourceControl.kind === "git"),
    "readiness report did not inspect source control",
  );
  assert(
    JSON.stringify(report.providers?.map((provider) => provider.id))
      === JSON.stringify(["codex", "claude", "cursor", "kimi", "opencode"]),
    "readiness report did not exercise every provider route",
  );

  process.stdout.write(`Node ${process.versions.node} executed the built runtime status CLI.\n`);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
