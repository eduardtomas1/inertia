import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLinuxGuardedSmoke } from "./linux-guarded-smoke.mjs";

if (process.platform !== "linux") throw new Error("Installed AppImage updates require native Linux.");
if (![3, 5].includes(process.argv.length)) throw new Error("Expected candidate, optionally predecessor and exact predecessor version.");
const predecessor = process.argv[3] ? resolve(process.argv[3]) : null;
const predecessorVersion = process.argv[4];
if (predecessor && predecessorVersion !== "0.0.53") throw new Error("This predecessor proof requires public v0.0.53.");
const root = await mkdtemp(join(tmpdir(), "inertia-installed-update-"));
const guardian = resolve("resources/generated/runtime-process-guardian/runtime-process-guardian");
try {
  const output = await runLinuxGuardedSmoke({ guardian, command: process.execPath,
    args: [resolve(import.meta.dirname, "linux-installed-update-driver.mjs"), resolve(process.argv[2]), root,
      ...(predecessor ? [predecessor, predecessorVersion] : [])] });
  console.log(output.trim());
  // The native subreaper proved that even detached/update descendants are
  // gone before removal. Failure retains this exact root for investigation.
  await rm(root, { recursive: true, force: true });
  console.log("Installed update fixture removed after native process-tree cleanup.");
} catch (error) {
  console.error(`Installed update evidence retained at ${root}`);
  throw error;
}
