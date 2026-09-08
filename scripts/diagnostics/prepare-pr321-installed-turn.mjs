import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = "3be5a9ce64f776969ebc23f87a44ad52c70a4641";
const branch = "refs/heads/codex/validation-pr321-installed-turn-start";
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = "scripts/package-smoke-history-runtime.mjs";
const patchPath = "scripts/diagnostics/pr321-installed-turn.patch";
const allowed = [".github/workflows/provider-contract-drift.yml", patchPath,
  "scripts/diagnostics/prepare-pr321-installed-turn.mjs",
  "scripts/diagnostics/pr321-turn-observer.mjs"];
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
if (patchHash !== "be965eeed24bb2e958dde6ad3add93a4594d5731c47d240e03175b1a9de2314f") {
  throw new Error("Unexpected reviewed patch");
}
const originalHash = hash(normalized(target));
if (originalHash !== "aba41abfa5dfd6fdfed582d6b18fd07df1a486a88e117cf607c1792d11dd96d7") {
  throw new Error("Original installed history scenario changed");
}
const predecessor = JSON.parse(normalized("release/n-minus-one/metadata.json"));
if (predecessor.version !== "0.0.53"
  || predecessor.sha256 !== "ef5aa470ec6fed7e24030b22bacf30eab729205fb4762866f08a890a1899b599") {
  throw new Error("Unexpected checksummed predecessor");
}
const sanitizerSource = normalized("src/main/runtime-diagnostics.ts");
const sanitizer = sanitizerSource.slice(
  sanitizerSource.indexOf("export function sanitizeRuntimeDiagnosticText("),
  sanitizerSource.indexOf("\nfunction runtimeFailureSummary("),
).replace("value: unknown", "value").replace(": string | undefined", "");
if (!sanitizer.startsWith("export function sanitizeRuntimeDiagnosticText(value)")) {
  throw new Error("Unexpected existing diagnostic sanitizer");
}
const observerName = "scripts/diagnostics/pr321-turn-observer.mjs";
const observer = normalized(resolve(driver, observerName));
if (hash(observer) !== "e4a30ba5551213e51ac240930dc82e53441924c3c2914ef7d80e5dda21eff874") throw new Error("Unexpected reviewed observer");
mkdirSync("scripts/diagnostics", { recursive: true });
writeFileSync(observerName, observer, { flag: "wx" });
writeFileSync("scripts/diagnostics/pr321-runtime-text-sanitizer.mjs", sanitizer, { flag: "wx" });
mkdirSync("diagnostic-results", { recursive: true });
const appliedPatch = "diagnostic-results/failure-only.patch";
writeFileSync(appliedPatch, normalized(patch));
git(process.cwd(), "apply", "--check", appliedPatch);
git(process.cwd(), "apply", appliedPatch);
const observedHash = hash(normalized(target));
if (observedHash !== "7d524fc3e6f865f7df8d2c3dd41fda2482acee61542ce3895ce79bb7df102504"
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
  packagedAsarSha256: hash(readFileSync("release/win-unpacked/resources/app.asar")),
  command: "npm run test:windows-installer-smoke",
  expectedPhases: ["predecessor-seed", "installer-boundaries", "candidate-initial-fast", "candidate-speed-transitions", "compaction", "uninstall"],
  originalHistoryDeadlineMs: 9_000, repetitions: 1,
  observerSha256: hash(observer), sanitizerSha256: hash(sanitizer),
  predecessorVersion: predecessor.version, predecessorSha256: predecessor.sha256,
  tempMatchesRunnerTemp: process.env.TEMP === process.env.RUNNER_TEMP,
  tmpMatchesRunnerTemp: process.env.TMP === process.env.RUNNER_TEMP,
}, null, 2));
console.log(JSON.stringify({ source, driver: process.env.GITHUB_SHA, patchHash,
  sourceAndInstrumentationVerified: true }));
