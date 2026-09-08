import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

const source = "0fc4f60e1dc4a538d05c3af3773e7e67a3e02bbb";
const manifestPath = "resources/generated/windows-runtime-job-integrity.json";
const helperPath = "resources/generated/runtime-process-guardian/windows-runtime-job.exe";
const testPath = "tests/performance/desktop.benchmark.spec.ts";
const instrumentationPath = "tests/helpers/streaming-timeline-diagnostic.ts";
const phase = process.argv[2];
if (!["before", "after"].includes(phase)) throw new Error("Unexpected verification phase");
if (process.env.GITHUB_REPOSITORY !== "eduardtomas1/inertia"
  || process.env.GITHUB_REF !== "refs/heads/codex/diagnose-323-windows-streaming"
  || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Unexpected diagnostic scope");
const git = (...args) => execFileSync("git", args, {
  encoding: "utf8", maxBuffer: 256 * 1024, timeout: 10_000,
}).trim();
if (git("rev-parse", "HEAD") !== source) throw new Error("Unexpected source identity");
const readBoundedRegular = (path, limit) => {
  const info = lstatSync(path);
  const contained = relative(realpathSync(process.cwd()), realpathSync(path));
  if (!info.isFile() || info.size <= 0 || info.size > limit
    || contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error("Invalid generated Windows helper evidence");
  }
  return readFileSync(path);
};
const manifest = JSON.parse(readBoundedRegular(manifestPath, 4 * 1024).toString("utf8"));
const helper = readBoundedRegular(helperPath, 16 * 1024 * 1024);
const helperHash = createHash("sha256").update(helper).digest("hex");
if (!manifest || Array.isArray(manifest) || Object.keys(manifest).length !== 1
  || typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
  || manifest.sha256 !== helperHash) throw new Error("Generated Windows helper hash mismatch");
const expected = phase === "before" ? [manifestPath] : [manifestPath, testPath].sort();
const changed = git("diff", "--name-only", "HEAD").split("\n").filter(Boolean).sort();
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error("Build or instrumentation changed unrelated source");
if (phase === "after" && git("ls-files", "--others", "--exclude-standard", "tests") !== instrumentationPath) {
  throw new Error("Unexpected test additions");
}
mkdirSync("diagnostic-evidence", { recursive: true });
const evidence = { source, phase, helperHash, helperBytes: helper.length, manifestSha256: manifest.sha256 };
if (phase === "after") {
  const before = JSON.parse(readFileSync("diagnostic-evidence/generated-helper-before.json", "utf8"));
  if (before.source !== source || before.helperHash !== helperHash || before.helperBytes !== helper.length) {
    throw new Error("Generated helper changed after instrumentation");
  }
}
writeFileSync(`diagnostic-evidence/generated-helper-${phase}.json`, JSON.stringify(evidence));
console.log(JSON.stringify(evidence));
