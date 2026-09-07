import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLinuxGuardedSmoke } from "./linux-guarded-smoke.mjs";

if (process.platform !== "linux") throw new Error("Installed AppImage updates require native Linux.");
const root = await mkdtemp(join(tmpdir(), "inertia-installed-update-"));
const guardian = resolve("resources/generated/runtime-process-guardian/runtime-process-guardian");
try {
  const output = await runLinuxGuardedSmoke({ guardian, command: process.execPath,
    args: [resolve(import.meta.dirname, "linux-installed-update-driver.mjs"), resolve(process.argv[2]), root] });
  console.log(output.trim());
  // The native subreaper proved that even detached/update descendants are
  // gone before removal. Failure retains this exact root for investigation.
  await rm(root, { recursive: true, force: true });
  console.log("Installed update fixture removed after native process-tree cleanup.");
} catch (error) {
  console.error(`Installed update evidence retained at ${root}`);
  throw error;
}
