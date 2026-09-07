import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { runLinuxGuardedSmoke } from "./linux-guarded-smoke.mjs";

if (process.platform !== "linux") throw new Error("Installed AppImage updates require native Linux.");
if (![3, 5].includes(process.argv.length)) throw new Error("Expected candidate, optionally predecessor and exact predecessor version.");
const predecessor = process.argv[3] ? resolve(process.argv[3]) : null;
const predecessorVersion = process.argv[4];
if (predecessor && predecessorVersion !== "0.0.53") throw new Error("This predecessor proof requires public v0.0.53.");
const root = await mkdtemp(join(tmpdir(), "inertia-installed-update-"));
const guardian = resolve("resources/generated/runtime-process-guardian/runtime-process-guardian");
const reportPath = process.env.INERTIA_VALIDATION_REPORT;
if (reportPath && !isAbsolute(reportPath)) throw new Error("Expected an absolute external evidence path.");
let report = { proof: "installed-handoff", passed: false, nativeCleanupConfirmed: false };
try {
  const output = await runLinuxGuardedSmoke({ guardian, command: process.execPath,
    args: [resolve(import.meta.dirname, "linux-installed-update-driver.mjs"), resolve(process.argv[2]), root,
      ...(predecessor ? [predecessor, predecessorVersion] : [])] });
  console.log(output.trim());
  const records = output.split("\n").filter(line => line.startsWith('{"proof":"installed-handoff"'));
  assert.equal(records.length, 1);
  const evidence = JSON.parse(records[0]);
  for (const key of ["predecessorDigest", "candidateDigest", "installedDigest"]) {
    assert.match(evidence[key], /^[a-f0-9]{64}$/u);
  }
  for (const key of ["predecessorVersion", "candidateVersion"]) assert.match(evidence[key], /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u);
  for (const key of ["predecessorBytes", "candidateBytes"]) assert(Number.isSafeInteger(evidence[key]) && evidence[key] > 0 && evidence[key] <= 512 * 1024 * 1024);
  assert.equal(evidence.fixtureServiceCurrentVersion, "0.0.0");
  assert.equal(evidence.fixtureAdvertisementAndDownload, true);
  assert.equal(evidence.realPredecessor, Boolean(predecessor));
  assert.equal(evidence.candidateDigest, evidence.installedDigest);
  report = { ...report, nativeCleanupConfirmed: true,
    ...Object.fromEntries(["predecessorVersion", "predecessorDigest", "predecessorBytes", "candidateVersion", "candidateDigest", "candidateBytes", "installedDigest",
      "realPredecessor", "fixtureAdvertisementAndDownload", "fixtureServiceCurrentVersion"].map(key => [key, evidence[key]])) };
  // The native subreaper proved that even detached/update descendants are
  // gone before removal. Failure retains this exact root for investigation.
  await rm(root, { recursive: true, force: true });
  report.passed = true;
  console.log("Installed update fixture removed after native process-tree cleanup.");
} catch (error) {
  console.error(`Installed update evidence retained at ${root}`);
  throw error;
} finally {
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
