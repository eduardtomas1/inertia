import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLinuxGuardedSmoke } from "./linux-guarded-smoke.mjs";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("This public probe requires native Linux x64.");
const root = await mkdtemp(join(tmpdir(), "inertia-public-update-"));
const reportDirectory = resolve(process.argv[3]);
await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
let succeeded = false;
try {
  const output = await runLinuxGuardedSmoke({
    guardian: resolve("resources/generated/runtime-process-guardian/runtime-process-guardian"),
    command: process.execPath,
    args: [resolve(import.meta.dirname, "linux-public-update-probe-driver.mjs"), resolve(process.argv[2]), root],
  });
  console.log(output.trim());
  succeeded = true;
} catch {
  console.error("Public update probe failed; private root retained after guarded cleanup attempt.");
  process.exitCode = 1;
} finally {
  const source = await readFile(join(root, "report.json"), "utf8").catch(() => null);
  const report = source ? JSON.parse(source) : { phase: "driver-report-unavailable", passed: false };
  report.nativeCleanupConfirmed = succeeded;
  report.passed = report.passed === true && succeeded;
  await writeFile(join(reportDirectory, "public-update-probe.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (succeeded) await rm(root, { recursive: true, force: true });
}
