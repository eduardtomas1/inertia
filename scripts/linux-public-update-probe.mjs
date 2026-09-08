import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLinuxGuardedSmoke } from "./linux-guarded-smoke.mjs";
import { strict as assert } from "node:assert";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("This public probe requires native Linux x64.");
assert([6, 7].includes(process.argv.length));
const completeUpgrade = process.argv[6] === "public-upgrade";
if (process.argv.length === 7) assert(completeUpgrade);
assert.equal(process.argv[4], "0.0.54");
assert.match(process.argv[5], /^[a-f0-9]{64}$/u);
const root = await mkdtemp(join(tmpdir(), "inertia-public-update-"));
const reportDirectory = resolve(process.argv[3]);
await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
let succeeded = false;
let cleanupEvidence = null;
try {
  const output = await runLinuxGuardedSmoke({
    onCleanupEvidence: confirmed => { cleanupEvidence = confirmed; },
    guardian: resolve("resources/generated/runtime-process-guardian/runtime-process-guardian"),
    command: process.execPath,
    args: [resolve(import.meta.dirname, completeUpgrade ? "linux-public-upgrade-driver.mjs" : "linux-public-update-probe-driver.mjs"), resolve(process.argv[2]), root, process.argv[4], process.argv[5]],
  });
  console.log(output.trim());
  succeeded = true;
} catch {
  console.error("Public update probe failed; private root retained after guarded cleanup attempt.");
  process.exitCode = 1;
} finally {
  const source = await readFile(join(root, "report.json"), "utf8").catch(() => null);
  const report = source ? JSON.parse(source) : { phase: "driver-report-unavailable", passed: false };
  report.nativeCleanupConfirmed = cleanupEvidence === true;
  report.cleanupOutcome = cleanupEvidence === true ? "confirmed" : cleanupEvidence === false ? "unconfirmed" : "not-observed";
  report.passed = report.passed === true && succeeded && cleanupEvidence === true;
  await writeFile(join(reportDirectory, completeUpgrade ? "public-upgrade.json" : "public-update-probe.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (succeeded) await rm(root, { recursive: true, force: true });
}
