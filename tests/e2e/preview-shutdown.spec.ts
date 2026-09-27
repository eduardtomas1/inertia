// @inertia-e2e-resource isolated
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { forceKillPosixProcessTreeWithStatus } from "../../src/node/posix-process-tree";
import { settleOperationBounded } from "./support/electron-app-lifecycle";
import { forceStopWindowsElectronLauncher } from "./support/electron-windows-process";

const require = createRequire(import.meta.url);

test("closes every Browser tab after its native owner window is destroyed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-preview-shutdown-")));
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let output = "";
  try {
    await mkdir(join(root, "preload"));
    await build({ entryPoints: ["src/preload/preview-agent-privacy.ts"],
      outfile: join(root, "preload/preview-agent-privacy.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    await build({ entryPoints: [fileURLToPath(new URL("support/preview-shutdown-main.ts", import.meta.url))],
      outfile: join(root, "main/index.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node22" });
    child = spawn(require("electron") as string, ["--no-sandbox", join(root, "main/index.mjs"), `--user-data-dir=${join(root, "profile")}`], {
      shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, APPIMAGE: undefined, APPDIR: undefined },
    });
    exited = new Promise<void>((resolve, reject) => { child!.once("error", reject); child!.once("close", () => resolve()); });
    void exited.catch(() => undefined);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); });
    expect((await settleOperationBounded(exited, 30_000)).status, output).toBe("fulfilled");
    expect(child.exitCode, output).toBe(0);
    expect(child.signalCode, output).toBeNull();
    const report = /PREVIEW_SHUTDOWN (.+)/u.exec(output)?.[1];
    expect(report, output).toBeDefined();
    expect(JSON.parse(report!)).toMatchObject({ scenarios: 4, platform: process.platform });
  } finally {
    let stopped = !child;
    try {
      if (child && exited) {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          if (process.platform === "win32") await forceStopWindowsElectronLauncher(child, 2_000);
          else forceKillPosixProcessTreeWithStatus(child.pid, { rootProcessGroup: true, deadlineAt: Date.now() + 2_000 });
        }
        stopped = (await settleOperationBounded(exited, 2_000)).status === "fulfilled";
        expect(stopped, output).toBe(true);
      }
    } finally { if (stopped) await rm(root, { recursive: true, force: true }); }
  }
});
