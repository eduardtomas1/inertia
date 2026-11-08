import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile, link, lstat, rename, unlink, readdir, truncate } from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorSdkStoreDirectory, openCursorSdkStore } from "../../src/server/provider/cursor-sdk-store";

const race = vi.hoisted(() => ({ beforeOpen: undefined as ((path: unknown) => void) | undefined, beforeWrite: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => { race.beforeOpen?.(args[0]); return fs.openSync(...args); },
    writeSync: (...args: Parameters<typeof fs.writeSync>) => { race.beforeWrite?.(); return fs.writeSync(...args); } };
});

const directories: string[] = [];
afterEach(async () => { race.beforeOpen = undefined; race.beforeWrite = undefined; await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-sdk-test-"))); directories.push(root);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  return { root, workspace };
}
describe.skipIf(process.platform !== "linux")("Cursor SDK native store scope", () => {
  it("uses stable per-workspace and per-instance directories", async () => {
    const { root, workspace } = await fixture();
    const first = await cursorSdkStoreDirectory(root, workspace, "instance-a");
    expect(await cursorSdkStoreDirectory(root, workspace, "instance-a")).toBe(first);
    expect(await cursorSdkStoreDirectory(root, workspace, "instance-b")).not.toBe(first);
    const other = join(root, "other"); await mkdir(other);
    expect(await cursorSdkStoreDirectory(root, other, "instance-a")).not.toBe(first);
  });
  it("rejects namespace symlinks", async () => {
    const { root, workspace } = await fixture();
    await symlink(workspace, join(root, "cursor-sdk"), "junction");
    await expect(cursorSdkStoreDirectory(root, workspace, "instance")).rejects.toThrow("escaped");
  });
  it("rejects noncanonical workspaces", async () => {
    const { root, workspace } = await fixture(); const alias = join(root, "alias");
    await symlink(workspace, alias, "junction");
    await expect(cursorSdkStoreDirectory(root, alias, "instance")).rejects.toThrow("canonical");
  });
});

describe.skipIf(process.platform !== "linux")("Cursor SDK descriptor-contained durable store", () => {
  async function scoped() {
    const { root, workspace } = await fixture();
    const directory = await cursorSdkStoreDirectory(root, workspace, "instance-a");
    return { root, workspace, directory };
  }
  const document = (cwd: string) => ({ agentId: "agent-test", cwd, status: "idle" as const, createdAt: 1, updatedAt: 2,
    sdkMetadata: { opaque: { native: ["one", 2] } }, latestCheckpoint: { schemaVersion: 1 as const, rootBlobId: "blob-test" } });
  it("durably preserves opaque native metadata, runs, checkpoints, events and idempotency", async () => {
    const { workspace, directory } = await scoped();
    let store = await openCursorSdkStore(directory, workspace);
    const agent = document(workspace);
    const run = { agentId: agent.agentId, runId: "run-test", turnNumber: 1, status: "finished" as const, createdAt: 1, updatedAt: 3,
      result: "answer", latestCheckpointRef: agent.latestCheckpoint, nativeExtra: { retained: true } };
    try {
      const returned = await store.agents.create({ agent });
      returned.sdkMetadata!.opaque = "caller change";
      await store.runs.create({ run });
      await store.checkpoints.create({ agentId: agent.agentId, blobId: "blob-test", data: Buffer.from([0, 255, 1, 27]) });
      const event = await store.runEvents.append({ runId: run.runId, eventType: "done", payload: { opaque: [1, null] }, idempotencyKey: "event-key" });
      expect(await store.runEvents.append({ runId: run.runId, eventType: "done", idempotencyKey: "event-key" })).toEqual(event);
      await store.dispose(); store = await openCursorSdkStore(directory, workspace);
      expect(await store.agents.get({ agentId: agent.agentId })).toEqual(agent);
      expect(await store.runs.get({ agentId: agent.agentId, runId: run.runId })).toEqual(run);
      expect(await store.checkpoints.get({ agentId: agent.agentId, blobId: "blob-test" })).toEqual(Buffer.from([0, 255, 1, 27]));
      expect((await store.runEvents.list({ runId: run.runId })).items).toEqual([event]);
      expect((await store.runEvents.append({ runId: run.runId, eventType: "next" })).seq).toBe(2);
    } finally { await store.dispose(); }
  });
  it("persists updates and filtered deletions and applies bounded pagination", async () => {
    const { workspace, directory } = await scoped();
    let store = await openCursorSdkStore(directory, workspace);
    try {
      await Promise.all(["a", "b", "c"].map(async (id) => store.agents.create({ agent: { ...document(workspace), agentId: id } })));
      const first = await store.agents.list({ filter: { limit: 1 } });
      expect(first.items.map((row) => row.agentId)).toEqual(["c"]);
      expect((await store.agents.list({ filter: { limit: 1, cursor: first.nextCursor } })).items[0]!.agentId).toBe("b");
      await store.agents.update({ agent: { ...document(workspace), agentId: "a", name: "updated" } });
      await store.agents.delete({ filter: { agentIds: ["c"] } });
      expect((await store.agents.list({ filter: { cursor: first.nextCursor } })).items.map((row) => row.agentId)).toEqual(["b", "a"]);
      await store.agents.delete({ filter: { agentIds: ["b"] } });
      await store.dispose(); store = await openCursorSdkStore(directory, workspace);
      expect(await store.agents.get({ agentId: "b" })).toBeNull();
      expect((await store.agents.get({ agentId: "a" }))!.name).toBe("updated");
      await expect(store.agents.list({ filter: { limit: 1001 } })).rejects.toThrow("limit");
    } finally { await store.dispose(); }
  });
  it("rejects deletions above the replay limit before persistence and reopens after a boundary-sized deletion", async () => {
    const { workspace, directory } = await scoped();
    const path = join(directory, "native-store.v1.jsonl");
    const records = Array.from({ length: 100_001 }, (_, index) => JSON.stringify({ sequence: index + 1,
      mutation: { operation: "put", table: "checkpoints", value: {
        agentId: index < 100_000 ? "bulk" : "keep", blobId: String(index), data: "" },
      } }));
    await writeFile(path, [JSON.stringify({ version: 1, workspace }), ...records, ""].join("\n"), { mode: 0o600 });
    const originalSize = (await lstat(path)).size;
    let store = await openCursorSdkStore(directory, workspace);
    try {
      await expect(store.checkpoints.delete({ filter: {} })).rejects.toThrow();
      expect((await lstat(path)).size).toBe(originalSize);
      expect(await store.checkpoints.get({ agentId: "bulk", blobId: "0" })).toEqual(Buffer.alloc(0));
      await store.dispose(); store = await openCursorSdkStore(directory, workspace);
      expect(await store.checkpoints.get({ agentId: "bulk", blobId: "99999" })).toEqual(Buffer.alloc(0));
      await store.checkpoints.delete({ filter: { agentIds: ["bulk"] } });
      await store.dispose(); store = await openCursorSdkStore(directory, workspace);
      expect(await store.checkpoints.get({ agentId: "bulk", blobId: "0" })).toBeNull();
      expect((await store.checkpoints.list()).items).toEqual(["100000"]);
      expect(await store.checkpoints.get({ agentId: "keep", blobId: "100000" })).toEqual(Buffer.alloc(0));
    } finally { await store.dispose(); }
  }, 30_000);
  it.each(["index.db", "index.db-wal", "index.db-shm", "index.db-journal", "agents", "checkpoints"]) (
    "rejects legacy or unrecognized descendant %s without following or deleting it", async (name) => {
      const { root, workspace, directory } = await scoped();
      const external = join(root, "external"); await writeFile(external, "sentinel");
      await symlink(external, join(directory, name));
      await expect(openCursorSdkStore(directory, workspace)).rejects.toThrow("legacy SQLite or unrecognized");
      expect(await readFile(external, "utf8")).toBe("sentinel");
      expect((await lstat(join(directory, name))).isSymbolicLink()).toBe(true);
    });
  it.each(["symlink", "hardlink"])("rejects an existing journal %s before writing", async (kind) => {
    const { root, workspace, directory } = await scoped();
    const external = join(root, "external"); await writeFile(external, "sentinel", { mode: 0o600 });
    if (kind === "symlink") await symlink(external, join(directory, "native-store.v1.jsonl"));
    else await link(external, join(directory, "native-store.v1.jsonl"));
    await expect(openCursorSdkStore(directory, workspace)).rejects.toThrow();
    expect(await readFile(external, "utf8")).toBe("sentinel");
  });
  it("pins the ancestor during initial open even when its pathname is replaced before the journal open", async () => {
    const { root, workspace, directory } = await scoped();
    const outside = join(root, "outside"); await mkdir(outside);
    race.beforeOpen = (path) => {
      if (typeof path !== "string" || !path.endsWith("/native-store.v1.jsonl")) return;
      race.beforeOpen = undefined;
      renameSync(directory, `${directory}-moved`);
      symlinkSync(outside, directory);
    };
    await expect(openCursorSdkStore(directory, workspace)).rejects.toThrow("authority changed");
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(join(`${directory}-moved`, "native-store.v1.jsonl"))).toHaveLength(0);
  });
  it("rejects live journal replacement and does not write through its new symlink", async () => {
    const { root, workspace, directory } = await scoped();
    const store = await openCursorSdkStore(directory, workspace);
    try {
      const external = join(root, "external"); await writeFile(external, "sentinel");
      await rename(join(directory, "native-store.v1.jsonl"), join(root, "saved-journal"));
      await symlink(external, join(directory, "native-store.v1.jsonl"));
      await expect(store.agents.create({ agent: document(workspace) })).rejects.toThrow("authority changed");
      expect(await readFile(external, "utf8")).toBe("sentinel");
    } finally { await store.dispose(); }
  });
  it("writes only the pinned inode when the journal is replaced after the operation check", async () => {
    const { root, workspace, directory } = await scoped();
    const external = join(root, "external"); await writeFile(external, "sentinel");
    const store = await openCursorSdkStore(directory, workspace);
    try {
      race.beforeWrite = () => {
        race.beforeWrite = undefined;
        renameSync(join(directory, "native-store.v1.jsonl"), join(root, "saved-journal"));
        symlinkSync(external, join(directory, "native-store.v1.jsonl"));
      };
      await expect(store.agents.create({ agent: document(workspace) })).rejects.toThrow("authority changed");
      await expect(store.agents.get({ agentId: "agent-test" })).rejects.toThrow("requires recovery");
      expect(await readFile(external, "utf8")).toBe("sentinel");
    } finally { await store.dispose(); }
  });
  it("rejects a real legacy checkpoint database hardlink without touching either link", async () => {
    const { root, workspace, directory } = await scoped();
    const checkpoint = join(directory, "agents", "agent-hash"); await mkdir(checkpoint, { recursive: true });
    const external = join(root, "external"); await writeFile(external, "sentinel", { mode: 0o600 });
    await link(external, join(checkpoint, "store.db"));
    await expect(openCursorSdkStore(directory, workspace)).rejects.toThrow("legacy SQLite");
    expect(await readFile(external, "utf8")).toBe("sentinel");
    expect((await lstat(external)).nlink).toBe(2);
  });
  it("rejects live namespace replacement, checkpoint injection and newly added hardlinks", async () => {
    const { root, workspace, directory } = await scoped();
    const store = await openCursorSdkStore(directory, workspace);
    try {
      await link(join(directory, "native-store.v1.jsonl"), join(root, "hardlink"));
      await expect(store.agents.create({ agent: document(workspace) })).rejects.toThrow("single-link");
      await unlink(join(root, "hardlink"));
      await symlink(workspace, join(directory, "agents"));
      await expect(store.checkpoints.create({ agentId: "a", blobId: "b", data: Buffer.from("data") })).rejects.toThrow("unrecognized");
      await unlink(join(directory, "agents"));
      await rename(directory, `${directory}-moved`); await symlink(workspace, directory);
      await expect(store.agents.get({ agentId: "a" })).rejects.toThrow("authority changed");
      expect(await readdir(workspace)).toEqual([]);
    } finally { await store.dispose(); }
  });
  it("rejects truncated, malformed, wrong-workspace and oversized journals without repairing data", async () => {
    const { workspace, directory } = await scoped();
    const path = join(directory, "native-store.v1.jsonl");
    for (const data of ['{"version":1', '{"version":1,"workspace":"foreign"}\n', `${JSON.stringify({ version: 1, workspace })}\n{"sequence":1,"mutation":{"operation":"bad"}}\n`]) {
      await writeFile(path, data, { mode: 0o600 });
      await expect(openCursorSdkStore(directory, workspace)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(data);
    }
    await truncate(path, 128 * 1024 * 1024 + 1);
    await expect(openCursorSdkStore(directory, workspace)).rejects.toThrow("limit");
  });
  it("never persists supplied vault credentials in native records or checkpoint bytes", async () => {
    const { workspace, directory } = await scoped();
    const secret = "synthetic-test-token";
    const store = await openCursorSdkStore(directory, workspace, secret);
    try {
      await expect(store.agents.create({ agent: { ...document(workspace), sdkMetadata: { apiKey: "synthetic-other-token" } } })).rejects.toThrow("credential");
      await expect(store.agents.create({ agent: { ...document(workspace), name: secret } })).rejects.toThrow("credential");
      await expect(store.checkpoints.create({ agentId: "a", blobId: "b", data: Buffer.from(`prefix:${secret}:suffix`) })).rejects.toThrow("credential");
      const disk = await readFile(join(directory, "native-store.v1.jsonl"), "utf8");
      expect(disk).not.toContain(secret); expect(disk).not.toContain("apiKey");
    } finally { await store.dispose(); }
  });
  it("refuses a second same-namespace writer until the first descriptor closes", async () => {
    const { workspace, directory } = await scoped();
    const store = await openCursorSdkStore(directory, workspace);
    try { await expect(openCursorSdkStore(directory, workspace)).rejects.toThrow("already in use"); }
    finally { await store.dispose(); }
    const next = await openCursorSdkStore(directory, workspace); await next.dispose();
  });
});
