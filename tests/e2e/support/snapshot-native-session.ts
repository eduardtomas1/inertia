import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));
const wm = spawn("openbox", [], { stdio: "ignore", shell: false });
const wmExited = new Promise<void>((resolve) => wm.once("close", () => resolve()));
try {
  // Openbox must publish its EWMH state before Electron can own the foreground.
  const deadline = performance.now() + 5000;
  while (true) {
    try {
      const { stdout } = await runFile("xdotool", ["get_desktop"], { timeout: 500, maxBuffer: 1024 });
      assert.match(stdout.trim(), /^\d+$/);
      break;
    } catch (error) {
      if (performance.now() >= deadline || wm.exitCode !== null) throw new Error("Native snapshot fixture window manager did not become ready", { cause: error });
      await delay(25);
    }
  }
  for (const property of ["IsEnabled", "ScreenReaderEnabled"]) execFileSync("dbus-send", ["--session", "--print-reply", "--dest=org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties.Set", "string:org.a11y.Status", `string:${property}`, "variant:boolean:true"], { timeout: 3000, stdio: "ignore" });
  for (const negative of [false, true]) {
    const child = spawn(process.argv[2]!, ["--no-sandbox", negative ? "--disable-renderer-accessibility" : "--force-renderer-accessibility", join(root, "main.mjs"), ...(negative ? ["--negative"] : []), `--user-data-dir=${join(root, negative ? "disabled-profile" : "enabled-profile")}`], {
      shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_AT_BRIDGE: "0", ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, APPIMAGE: undefined, APPDIR: undefined },
    });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    try { assert.equal(await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 0); }
    finally { clearTimeout(timer); }
  }
} finally { wm.kill(); await wmExited; }
