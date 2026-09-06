import { spawn, type ChildProcess } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { createPackage } from "@electron/asar";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { forceKillPosixProcessTreeWithStatus } from "../../src/node/posix-process-tree";
import { processExists, settleOperationBounded } from "./support/electron-app-lifecycle";

const require = createRequire(import.meta.url);

async function linkRuntime(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const original = join(source, entry.name);
    const linked = join(target, entry.name === "electron" ? "inertia" : entry.name);
    if (entry.isDirectory()) await linkRuntime(original, linked);
    else if (entry.isSymbolicLink()) await symlink(await readlink(original), linked);
    else {
      try { await link(original, linked); } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EXDEV") throw error;
        await copyFile(original, linked, constants.COPYFILE_FICLONE);
      }
    }
  }
}

interface FixtureProcess {
  child: ChildProcess;
  exited: Promise<void>;
  output(): string;
}

function launch(executable: string, profileDirectory: string): FixtureProcess {
  const child = spawn(executable, [
    "--no-sandbox", "--disable-crash-reporter", `--user-data-dir=${profileDirectory}`,
  ], {
    shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined,
      APPIMAGE: undefined, APPDIR: undefined },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); });
  }
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  void exited.catch(() => undefined);
  return { child, exited, output: () => output };
}

async function closeFixture(fixture: FixtureProcess): Promise<void> {
  const { child } = fixture;
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Both benign stubs accept an explicit stop over their retained stdin pipe.
  child.stdin?.end("close\n");
  if ((await settleOperationBounded(fixture.exited, 2_000)).status !== "timed-out") return;
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    forceKillPosixProcessTreeWithStatus(child.pid, {
      rootProcessGroup: true, deadlineAt: Date.now() + 2_000,
    });
  }
  expect((await settleOperationBounded(fixture.exited, 2_000)).status).toBe("fulfilled");
}

test("continues a different-version Linux launch after the notified owner releases its real singleton", async () => {
  test.skip(process.platform !== "linux", "Exercises the native Linux Electron singleton.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia native singleton-")));
  const profile = join(root, "profile");
  const eventsPath = join(root, "events.jsonl");
  const readyPath = join(root, "owner-ready");
  const children: FixtureProcess[] = [];
  try {
    await mkdir(profile);
    const runtime = dirname(require("electron") as string);
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL("../../src/main/linux-singleton-launch.ts", import.meta.url))],
      bundle: true, platform: "node", format: "cjs", target: "node22", write: false,
    });
    const common = `
const { app } = require("electron");
const fs = require("node:fs");
app.setPath("userData", ${JSON.stringify(profile)});
app.disableHardwareAcceleration();
const record = (event, extra = {}) => {
  const line = JSON.stringify({ event, pid: process.pid, version: app.getVersion(), ...extra });
  fs.appendFileSync(${JSON.stringify(eventsPath)}, line + "\\n");
  console.log(line);
};
process.stdin.on("data", () => app.exit(0));
process.stdin.resume();
setTimeout(() => app.exit(90), 20_000).unref();
`;
    for (const [role, version] of [["owner", "1.0.0"], ["contender", "2.0.0"]] as const) {
      const directory = join(root, role);
      const source = join(root, `${role}-source`);
      await linkRuntime(runtime, directory);
      await mkdir(join(source, "out", "main"), { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify({
        name: "inertia", version, inertiaReleaseChannel: "stable", main: "out/main/index.js",
      }));
      const behavior = role === "owner" ? `
if (!app.requestSingleInstanceLock()) app.exit(91);
app.on("second-instance", () => {
  record("second-instance");
  setTimeout(() => app.exit(0), 200);
});
app.whenReady().then(() => {
  record("owner-ready", { pids: app.getAppMetrics().map(({ pid }) => pid) });
  fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
});
` : `
const { requestLinuxSingletonLaunch } = require("./launcher.cjs");
(async () => {
  const acquired = await requestLinuxSingletonLaunch({
    profileDirectory: app.getPath("userData"), channel: "stable", version: app.getVersion(),
    requestLock: () => {
      const acquired = app.requestSingleInstanceLock();
      record("lock-attempt", { acquired });
      return acquired;
    },
    reportContention: (notice) => record("blocked", notice),
  });
  if (!acquired) { app.exit(92); return; }
  await app.whenReady();
  record("bootstrap", { ownsSingleton: app.hasSingleInstanceLock(),
    pids: app.getAppMetrics().map(({ pid }) => pid) });
  app.exit(0);
})().catch((error) => { console.error(error); app.exit(93); });
`;
      await writeFile(join(source, "out", "main", "index.js"), common + behavior);
      if (role === "contender") {
        await writeFile(join(source, "out", "main", "launcher.cjs"), bundled.outputFiles[0]!.text);
      }
      await finished(await createPackage(source, join(directory, "resources", "app.asar")));
    }
    const owner = launch(join(root, "owner", "inertia"), profile);
    children.push(owner);
    await expect.poll(() => existsSync(readyPath), { timeout: 10_000 }).toBe(true);
    const contender = launch(join(root, "contender", "inertia"), profile);
    children.push(contender);
    for (const fixture of children) {
      const settled = await settleOperationBounded(fixture.exited, 10_000);
      expect(settled.status, fixture.output()).toBe("fulfilled");
      expect(fixture.child.exitCode, fixture.output()).toBe(0);
      expect(fixture.child.signalCode).toBeNull();
    }
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as {
        event: string; pid: number; version: string; acquired?: boolean;
        ownsSingleton?: boolean; pids?: number[];
      });
    expect(events.filter(({ event }) => event === "second-instance")).toHaveLength(1);
    expect(events.filter(({ event }) => event === "lock-attempt").map(({ acquired }) => acquired))
      .toEqual([false, true]);
    expect(events.filter(({ event }) => event === "bootstrap")).toEqual([
      expect.objectContaining({ version: "2.0.0", pid: contender.child.pid, ownsSingleton: true }),
    ]);
    expect(events.some(({ event }) => event === "blocked")).toBe(false);
    const pids = [...new Set(events.flatMap(({ pid, pids }) => [pid, ...(pids ?? [])]))];
    await expect.poll(() => pids.filter(processExists), { timeout: 5_000 }).toEqual([]);
  } finally {
    await Promise.all(children.map(closeFixture));
    await rm(root, { recursive: true, force: true });
  }
});
