import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = "de8a45abaaaae269478ed3c787cbfc4a9ee9ee7c";
const branch = "refs/heads/codex/validation-pr315-attach-enablement";
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = "tests/e2e/sent-attachments.spec.ts";
const patchPath = "scripts/diagnostics/pr315-attach-enablement.patch";
const allowed = [".github/workflows/provider-contract-drift.yml", patchPath,
  "scripts/diagnostics/prepare-pr315-attach-enablement.mjs"];
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", maxBuffer: 256 * 1024, timeout: 10_000,
}).trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalized = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
if (process.env.GITHUB_REPOSITORY !== "eduardtomas1/inertia"
  || process.env.GITHUB_REF !== branch
  || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Unexpected diagnostic scope");
if (git(process.cwd(), "rev-parse", "HEAD") !== source
  || git(driver, "rev-parse", "HEAD") !== process.env.GITHUB_SHA) throw new Error("Unexpected source or driver identity");
const changed = git(driver, "diff", "--name-only", source, "HEAD").split("\n");
if (changed.length !== allowed.length || changed.some((path) => !allowed.includes(path))) {
  throw new Error("Driver changes exceed diagnostic-only scope");
}
const generatedManifest = "resources/generated/windows-runtime-job-integrity.json";
const generatedJob = "resources/generated/runtime-process-guardian/windows-runtime-job.exe";
const manifest = JSON.parse(normalized(generatedManifest));
const jobStat = statSync(generatedJob);
if (!manifest || Object.keys(manifest).length !== 1
  || typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
  || !jobStat.isFile() || jobStat.size <= 0 || jobStat.size > 16 * 1024 * 1024) {
  throw new Error("Invalid generated Windows Job Object evidence");
}
const generatedJobHash = hash(readFileSync(generatedJob));
if (manifest.sha256 !== generatedJobHash
  || git(process.cwd(), "diff", "--name-only", "HEAD") !== generatedManifest) {
  throw new Error("Build changed source or generated Windows Job Object identity");
}
const patch = resolve(driver, patchPath);
const patchHash = hash(normalized(patch));
if (patchHash !== "da10eb743a3eab3a4a9734a0c0ab02fac11b2dae996aa417b476e15d0cdc1aec") {
  throw new Error("Unexpected reviewed patch");
}
const originalHash = hash(normalized(target));
if (originalHash !== "eef47b25bcfcfbe326b2457932901c140c7cf5e4fd4b60f43c03df5522659288") {
  throw new Error("Original recovery scenario changed");
}
mkdirSync("diagnostic-results", { recursive: true });
const appliedPatch = "diagnostic-results/failure-only.patch";
writeFileSync(appliedPatch, normalized(patch));
git(process.cwd(), "apply", "--check", appliedPatch);
git(process.cwd(), "apply", appliedPatch);
const observedHash = hash(normalized(target));
if (observedHash !== "db45588882d1e326c8181dcfe564386851b1ef5307c91e8f2ec38b1ca1719e63"
  || git(process.cwd(), "diff", "--name-only", "HEAD")
    !== [generatedManifest, target].join("\n")) {
  throw new Error("Unexpected applied instrumentation");
}
writeFileSync("diagnostic-results/provenance.json", JSON.stringify({
  schema: 1, source, sourceTree: git(process.cwd(), "rev-parse", "HEAD^{tree}"),
  driver: process.env.GITHUB_SHA, driverTree: git(driver, "rev-parse", "HEAD^{tree}"),
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  workflowSha256: hash(normalized(resolve(driver, ".github/workflows/provider-contract-drift.yml"))),
  lockSha256: hash(normalized("package-lock.json")),
  patchSha256: patchHash, originalTestSha256: originalHash, observedTestSha256: observedHash,
  generatedWindowsJobSha256: generatedJobHash, generatedWindowsJobBytes: jobStat.size,
  productionBuiltBeforeInstrumentation: true,
  command: "npm exec -- playwright test --project=runtime-recovery --output=test-results/runtime-recovery",
  expectedScenarios: ["app-shell", "goal-reliability", "runtime-stranded-profile", "sent-attachments"],
  originalAssertionMs: 5_000, originalWorkers: 1, repetitions: 1,
  tempMatchesRunnerTemp: process.env.TEMP === process.env.RUNNER_TEMP,
  tmpMatchesRunnerTemp: process.env.TMP === process.env.RUNNER_TEMP,
}, null, 2));
console.log(JSON.stringify({ source, driver: process.env.GITHUB_SHA, patchHash,
  sourceAndInstrumentationVerified: true }));
