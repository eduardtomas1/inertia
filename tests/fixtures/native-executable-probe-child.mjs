import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const pidFile = process.env.INERTIA_PROBE_PID_FILE;
if (!pidFile) throw new Error("INERTIA_PROBE_PID_FILE is required.");

const descendant = spawn(process.execPath, [
  join(import.meta.dirname, "native-executable-probe-descendant.mjs"),
], {
  detached: process.platform !== "win32",
  env: {},
  stdio: "ignore",
  windowsHide: true,
});
if (!descendant.pid) throw new Error("The probe descendant did not start.");
writeFileSync(pidFile, String(descendant.pid));
setInterval(() => {}, 60_000);
