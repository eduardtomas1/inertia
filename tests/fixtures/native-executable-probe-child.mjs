import { spawn } from "node:child_process";
import { closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pidFile = process.env.INERTIA_PROBE_PID_FILE;
const rootPidFile = process.env.INERTIA_PROBE_ROOT_PID_FILE;
if (!pidFile || !rootPidFile) {
  throw new Error("INERTIA_PROBE_PID_FILE and INERTIA_PROBE_ROOT_PID_FILE are required.");
}
writeFileSync(rootPidFile, String(process.pid));

const redirectsDescendant = process.env.INERTIA_PROBE_REDIRECT_DESCENDANT === "1";
if (redirectsDescendant) {
  for (const descriptor of [1, 2]) {
    try { closeSync(descriptor); } catch { /* The descriptor may already be closed. */ }
  }
}

const descendant = spawn(process.execPath, [
  join(import.meta.dirname, "native-executable-probe-descendant.mjs"),
], {
  detached: process.platform !== "win32",
  env: {},
  stdio: redirectsDescendant
    ? ["ignore", "ignore", "ignore"]
    : ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
if (!descendant.pid) throw new Error("The probe descendant did not start.");
writeFileSync(pidFile, String(descendant.pid));
if (process.env.INERTIA_PROBE_KEEP_ROOT === "1") setInterval(() => {}, 60_000);
else process.exit(0);
