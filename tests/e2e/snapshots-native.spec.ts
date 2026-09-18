// @inertia-e2e-resource primary-display
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { forceKillPosixProcessTreeWithStatus } from "../../src/node/posix-process-tree";
import { settleOperationBounded } from "./support/electron-app-lifecycle";

const require = createRequire(import.meta.url);
test("Linux X11 global shortcut captures masked pixels and refuses missing accessibility", async () => {
  test.skip(process.platform !== "linux", "Native Linux X11 regression for issue #384");
  await mkdir(".cache", { recursive: true });
  // Inside the checkout so external native bindings resolve exactly as shipped.
  const root = await mkdtemp(resolve(".cache/snapshot-native-"));
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, output = "";
  try {
    for (const [entry, name] of [["tests/e2e/support/snapshot-native-main.ts", "main.mjs"], ["tests/e2e/support/snapshot-native-session.ts", "session.mjs"], ["src/main/snapshot-capture-worker.ts", "snapshot-capture-worker.js"]]) {
      await build({ entryPoints: [entry!], outfile: join(root, name!), bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
    }
    child = spawn("xvfb-run", ["--auto-servernum", "dbus-run-session", process.execPath, join(root, "session.mjs"), require("electron") as string], {
      shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined, NODE_OPTIONS: undefined },
    });
    exited = new Promise<void>((resolve, reject) => { child!.once("error", reject); child!.once("close", () => resolve()); });
    void exited.catch(() => undefined);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); });
    expect((await settleOperationBounded(exited, 35_000)).status, output).toBe("fulfilled");
    expect(child.exitCode, output).toBe(0);
    expect(output).toContain("NATIVE_SNAPSHOT_EVIDENCE masked-capture");
    expect(output).toContain("NATIVE_SNAPSHOT_EVIDENCE accessibility-refused");
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
