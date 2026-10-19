// @inertia-e2e-resource primary-display
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { forceKillPosixProcessTreeWithStatus } from "../../src/node/posix-process-tree";
import { settleOperationBounded } from "./support/electron-app-lifecycle";

/**
 * The accessibility transport against a real Linux desktop: inside its own
 * Xvfb, D-Bus session and AT-SPI bus (the Snapshots native session), an
 * Electron harness runs the real App control service and utility worker, the
 * runtime's broker client and coordinator over the strict protocol parsers,
 * the launch manager and the App host tools. It launches the fixture app as a
 * project action (no debugging pipe) with --force-renderer-accessibility and
 * drives it only through AT-SPI.
 */

const require = createRequire(import.meta.url);
const tools = ["xvfb-run", "dbus-run-session", "openbox", "xdotool", "dbus-send"];
const missing = process.platform !== "linux"
  ? ["linux"]
  : tools.filter((name) => spawnSync("sh", ["-c", 'command -v "$1"', "sh", name], { stdio: "ignore" }).status !== 0);
const electronBinary = (() => {
  try {
    const path = require("electron") as unknown;
    return typeof path === "string" && existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
})();

// CI must exercise the real desktop: a missing tool or AT-SPI bus fails there, and skips only locally.
const ci = Boolean(process.env.CI);

test("Linux AT-SPI: an action launch is listed, read, driven, captured and stopped through accessibility", async () => {
  test.skip(process.platform !== "linux", "Native Linux AT-SPI scenario.");
  const unmet = `Needs ${missing.join(", ") || "the repository's Electron binary"}.`;
  if (ci) expect(missing.length === 0 && electronBinary !== null, unmet).toBe(true);
  test.skip(missing.length > 0 || !electronBinary, unmet);
  test.setTimeout(60_000);
  await mkdir(".cache", { recursive: true });
  // Inside the checkout so the shipped native bindings resolve exactly as packaged.
  const root = await mkdtemp(resolve(".cache/app-under-test-native-"));
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, output = "";
  try {
    for (const [entry, name] of [
      ["tests/e2e/support/app-under-test-native-main.ts", "main.mjs"],
      ["tests/e2e/support/app-under-test-native-session.ts", "session.mjs"],
      ["src/main/app-control-worker.ts", "app-control-worker.js"],
    ]) {
      await build({ entryPoints: [entry!], outfile: join(root, name!), bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
    }
    child = spawn("xvfb-run", ["--auto-servernum", "dbus-run-session", process.execPath, join(root, "session.mjs"), electronBinary!, realpathSync("tests/fixtures/app-under-test")], {
      shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined, NODE_OPTIONS: undefined },
    });
    exited = new Promise<void>((resolve, reject) => { child!.once("error", reject); child!.once("close", () => resolve()); });
    void exited.catch(() => undefined);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); });
    expect((await settleOperationBounded(exited, 50_000)).status, output).toBe("fulfilled");
    const noBus = output.includes("NATIVE_APP_SKIP at-spi-unavailable");
    if (ci) expect(noBus, `The session has no AT-SPI bus.\n${output}`).toBe(false);
    test.skip(noBus, "The session has no AT-SPI bus.");
    expect(child.exitCode, output).toBe(0);
    for (const step of [
      "window-listed", "snapshot-refs", "button-pressed", "value-refused", "x11-screenshot", "x11-agent-image", "synthesized-input",
      "password-redacted", "stopped-confirmed", "worker-stopped",
    ]) expect(output, output).toContain(`NATIVE_APP_EVIDENCE ${step}`);
  } finally {
    let stopped = !child;
    if (child && exited) {
      if (child.exitCode === null && child.signalCode === null && child.pid) forceKillPosixProcessTreeWithStatus(child.pid, { rootProcessGroup: true, deadlineAt: Date.now() + 2000 });
      stopped = (await settleOperationBounded(exited, 2000)).status === "fulfilled";
      expect(stopped, output).toBe(true);
    }
    if (stopped) await rm(root, { recursive: true, force: true });
  }
});
