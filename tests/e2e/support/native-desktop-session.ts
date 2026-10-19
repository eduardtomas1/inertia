import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/**
 * The Linux native desktop the native end-to-end scenarios run in, inside
 * `xvfb-run dbus-run-session`: an Openbox window manager with its EWMH state
 * published, and the session's AT-SPI bus switched on the way a screen reader
 * would, so Chromium and GTK clients expose their accessibility trees.
 */

const runFile = promisify(execFile);

/** Thrown when the session has no AT-SPI bus to enable; callers report a skip. */
export class NativeDesktopUnavailable extends Error {}

export async function withNativeDesktopSession(run: () => Promise<void>): Promise<void> {
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
        if (performance.now() >= deadline || wm.exitCode !== null) throw new Error("Native fixture window manager did not become ready", { cause: error });
        await delay(25);
      }
    }
    try {
      for (const property of ["IsEnabled", "ScreenReaderEnabled"]) execFileSync("dbus-send", ["--session", "--print-reply", "--dest=org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties.Set", "string:org.a11y.Status", `string:${property}`, "variant:boolean:true"], { timeout: 3000, stdio: "ignore" });
    } catch (error) {
      throw new NativeDesktopUnavailable("The session has no AT-SPI bus", { cause: error });
    }
    await run();
  } finally { wm.kill(); await wmExited; }
}
