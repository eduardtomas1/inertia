import { mkdtemp, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCursorSdkWorker } from "../../src/server/provider/cursor-sdk-process";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";
import { runtimeOwnedProcessStopConfirmation } from "../../src/node/runtime-owned-processes";

import { build } from "esbuild";
import { fork, type ChildProcess } from "node:child_process";

const supported = process.platform === "linux";
let bundleRoot: string;
let workerPath: string;
let storeProbe: string;
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(process.cwd(), ".cursor-store-worker-test-"));
  workerPath = join(bundleRoot, "worker.mjs");
  storeProbe = join(bundleRoot, "store.mjs");
  await build({ entryPoints: ["src/server/provider/cursor-sdk-worker.ts"], outfile: workerPath,
    bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
  await build({ stdin: { contents: `
    import { openCursorSdkStore } from "./src/server/provider/cursor-sdk-store";
    const [directory, workspace, mode] = process.argv.slice(2);
    try {
      const store = await openCursorSdkStore(directory, workspace);
      if (mode === "hold") {
        await store.agents.create({ agent: { agentId: "persisted", cwd: workspace, status: "idle", createdAt: 1, updatedAt: 1 } });
        process.send({ state: "holding" }); setInterval(() => {}, 1000);
      } else {
        const record = await store.agents.get({ agentId: "persisted" });
        await store.dispose(); process.send({ state: "opened", record }); process.disconnect();
      }
    } catch { process.send({ state: "refused" }); process.disconnect(); }
  `, resolveDir: process.cwd(), loader: "ts" }, outfile: storeProbe,
    bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
});
afterAll(async () => { if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true }); });

describe("Cursor SDK owned worker", () => {
  it.skipIf(!supported)("verifies external Node only after guardian enrollment and joins cleanup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-sdk-owned-")));
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(root, `${randomUUID()}:1`, `test:${randomUUID()}`,
      { darwinGuardianPath: resolve("resources/generated/runtime-process-guardian/runtime-process-guardian") });
    try {
      const worker = await openCursorSdkWorker({ cwd: root, environment: { ...process.env, CURSOR_API_KEY: "synthetic-test-token" }, signal: new AbortController().signal,
        handle: async () => { throw new Error("unexpected"); } }, { workerPath });
      expect(runtimeOwnedProcessStopConfirmation(worker.child)).toBe(false);
      const hello = await worker.channel.request("hello", null);
      expect(hello).toMatchObject({ version: "1.0.38", node: process.versions.node });
      await expect(worker.channel.request("inspect", null)).resolves.toEqual({ sdkVersion: "1.0.38", nativeStore: true, storeKind: "inertia-journal-v1" });
      await worker.close(); expect(runtimeOwnedProcessStopConfirmation(worker.child)).toBe(true);
    } finally { deactivate?.(); await rm(root, { recursive: true, force: true }); }
  }, 20_000);
  it("does not import the SDK without ownership enrollment", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-sdk-unowned-")));
    try {
      await expect(openCursorSdkWorker({ cwd: root, environment: process.env, signal: new AbortController().signal,
        handle: async () => null }, { workerPath })).rejects.toThrow();
    } finally { await rm(root, { force: true, recursive: true }); }
  });
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); await exited;
}
function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Store process timed out.")), 5000);
    child.once("message", (value) => { clearTimeout(timer); resolve(value); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Store process exited before replying.")); });
  });
}
it.skipIf(!supported)("kernel store lock excludes another process and releases after SIGKILL with durable native state", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-store-lock-")));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const children: ChildProcess[] = [];
  const launch = (mode: string) => {
    const child = fork(storeProbe, [root, workspace, mode], { execPath: process.execPath, env: {}, silent: true });
    children.push(child); return child;
  };
  try {
    const directory = join(root, "store"); await mkdir(directory, { mode: 0o700 });
    const run = (mode: string) => {
      const child = fork(storeProbe, [directory, workspace, mode], { execPath: process.execPath, env: {}, silent: true });
      children.push(child); return child;
    };
    const first = run("hold"); expect(await message(first)).toEqual({ state: "holding" });
    const second = run("read"); expect(await message(second)).toEqual({ state: "refused" }); await stop(second);
    await stop(first);
    const third = run("read"); expect(await message(third)).toEqual({ state: "opened",
      record: { agentId: "persisted", cwd: workspace, status: "idle", createdAt: 1, updatedAt: 1 } }); await stop(third);
    const wrongNamespace = launch("read"); expect(await message(wrongNamespace)).toEqual({ state: "refused" });
  } finally { await Promise.all(children.map(stop)); await rm(root, { recursive: true, force: true }); }
}, 20000);
