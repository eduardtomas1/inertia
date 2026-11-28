// @inertia-test-suite portable
import type { RunResult } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { cursorSdkStartResultSchema } from "../../src/node/cursor-sdk-protocol";
import { executeCursorSdkRun } from "../../src/server/provider/cursor-sdk-session";
import { CursorSdkStoreRecords } from "../../src/server/provider/cursor-sdk-store-records";

/**
 * The records Cursor SDK 1.0.38 writes through a custom store: `createFollowUpRun` starts a run at the agent's latest
 * checkpoint (`startCheckpointRef` = `latestCheckpointRef`), `saveCheckpoint` moves the agent pointer, then
 * `patchCheckpoint` moves the run's and the agent's (T3 c5fa33b27).
 */
function records(persist: () => void = () => undefined) {
  const store = new CursorSdkStoreRecords(() => undefined, persist, async () => undefined);
  const ref = (rootBlobId: string) => ({ schemaVersion: 1 as const, rootBlobId });
  const agent = (latest: string | null) => store.replay({ operation: "put", table: "agents", value: { agentId: "agent", cwd: "/workspace",
    status: "idle", activeRunId: null, createdAt: 1, updatedAt: 2, latestCheckpoint: latest === null ? null : ref(latest) } });
  const run = (runId: string, turnNumber: number, start: string | null, latest: string | null, status = "error") => store.replay({ operation: "put",
    table: "runs", value: { agentId: "agent", runId, turnNumber, status, createdAt: 1, updatedAt: 2,
      startCheckpointRef: start === null ? null : ref(start), latestCheckpointRef: latest === null ? null : ref(latest) } });
  return { store, agent, run };
}

describe("Cursor SDK run checkpoint records (T3 runCheckpointed)", () => {
  it("finds no checkpoint for a first run that never saved one, and one once Cursor patched it", () => {
    const { store, agent, run } = records();
    agent(null); run("first", 1, null, null);
    expect(store.runCheckpointed("agent", "first")).toBe(false);
    agent("blob-1"); run("first", 1, null, "blob-1", "finished");
    expect(store.runCheckpointed("agent", "first")).toBe(true);
  });

  it("finds no checkpoint for a follow-up that stayed on the checkpoint it started from, even with its start recorded as latest", () => {
    const { store, agent, run } = records();
    agent("blob-1"); run("first", 1, null, "blob-1", "finished"); run("follow-up", 2, "blob-1", "blob-1", "cancelled");
    expect(store.runCheckpointed("agent", "follow-up")).toBe(false);
    expect(store.runCheckpointed("agent", "first")).toBe(true);
  });

  it("counts a checkpoint whose agent pointer moved though the run's patch never landed: the next run loads it", () => {
    const { store, agent, run } = records();
    agent("blob-2"); run("follow-up", 2, "blob-1", "blob-1");
    expect(store.runCheckpointed("agent", "follow-up")).toBe(true);
  });

  it("cannot tell once a journal write failed: the journal may hold a checkpoint its tables never took", async () => {
    let fail = false;
    const { store, agent, run } = records(() => { if (fail) throw new Error("EIO: the directory sync failed after the record was written"); });
    agent("blob-1"); run("follow-up", 2, "blob-1", "blob-1");
    expect(store.runCheckpointed("agent", "follow-up")).toBe(false);
    fail = true;
    await expect(store.agents.update({ agent: { agentId: "agent", cwd: "/workspace", status: "idle", activeRunId: null, createdAt: 1,
      updatedAt: 3, latestCheckpoint: { schemaVersion: 1, rootBlobId: "blob-2" } } })).rejects.toThrow("EIO");
    expect(store.runCheckpointed("agent", "follow-up")).toBeUndefined();
  });

  it("cannot tell without the agent or the run, and refuses malformed records before they are read", () => {
    const { store, agent, run } = records();
    expect(store.runCheckpointed("agent", "missing")).toBeUndefined();
    run("orphan", 1, null, null);
    expect(store.runCheckpointed("agent", "orphan")).toBeUndefined();
    agent(null);
    expect(store.runCheckpointed("agent", "missing")).toBeUndefined();
    expect(store.runCheckpointed("other-agent", "orphan")).toBeUndefined();
    expect(() => store.replay({ operation: "put", table: "runs", value: { agentId: "agent", runId: "bad", turnNumber: 1, status: "error",
      createdAt: 1, updatedAt: 2, latestCheckpointRef: { schemaVersion: 2, rootBlobId: "blob" } } })).toThrow();
    expect(store.runCheckpointed("agent", "bad")).toBeUndefined();
  });
});

describe("the worker's checkpoint answer (executeCursorSdkRun)", () => {
  const session = { nativeSessionId: "agent", nativeRun: { agentId: "agent", runId: "follow-up" } };
  function started() {
    const f = records();
    f.agent("blob-1"); f.run("first", 1, null, "blob-1", "finished"); f.run("follow-up", 2, "blob-1", "blob-1", "running");
    const dispose = vi.spyOn(f.store, "dispose"); const read = vi.spyOn(f.store, "runCheckpointed");
    return { ...f, dispose, read };
  }

  it("answers a run that failed or was stopped without verified evidence, after closing the store", async () => {
    const f = started();
    const answer = await executeCursorSdkRun(session, f.store, async () => { throw new Error("Cursor SDK execution could not be verified."); });
    expect(answer).toEqual({ unverified: true, agentId: "agent", id: "follow-up", runCheckpointed: false });
    expect(cursorSdkStartResultSchema.parse(answer)).toEqual(answer);
    // The store is closed before it is read; that a closed journal store refuses later writes is covered on Linux.
    expect(f.dispose.mock.invocationCallOrder[0]!).toBeLessThan(f.read.mock.invocationCallOrder[0]!);
  });

  it("adds the answer to a verified terminal result of the same run", async () => {
    const f = started();
    f.run("follow-up", 2, "blob-1", "blob-2", "error");
    const answer = await executeCursorSdkRun(session, f.store, async () => ({ id: "follow-up", status: "error" }) as RunResult);
    expect(answer).toEqual({ id: "follow-up", status: "error", agentId: "agent", runCheckpointed: true });
    expect(cursorSdkStartResultSchema.parse(answer)).toMatchObject({ runCheckpointed: true });
  });

  it("rethrows a failure without a native run or an answer, and leaves a result without an answer the store cannot give", async () => {
    const failure = new Error("Cursor SDK execution could not be verified.");
    const f = started();
    await expect(executeCursorSdkRun({ nativeSessionId: "agent", nativeRun: undefined }, f.store, async () => { throw failure; })).rejects.toBe(failure);
    const empty = records();
    await expect(executeCursorSdkRun(session, empty.store, async () => { throw failure; })).rejects.toBe(failure);
    expect(await executeCursorSdkRun(session, records().store, async () => ({ id: "follow-up", status: "error" }) as RunResult))
      .toEqual({ id: "follow-up", status: "error", agentId: "agent" });
  });
});

describe("Cursor SDK checkpoint records", () => {
  it("accepts a checkpoint at its 6 MB limit and refuses data that is not canonical base64", () => {
    const { store } = records();
    const put = (data: string) => store.replay({ operation: "put", table: "checkpoints", value: { agentId: "agent", blobId: "blob", data } });
    expect(() => put(Buffer.alloc(6 * 1024 * 1024, 7).toString("base64"))).not.toThrow();
    for (const data of ["", "AA==", "AAA=", "AAAA"]) expect(() => put(data)).not.toThrow();
    for (const data of ["A", "AAA", "A===", "AB=C", "AA=A", "AAA!", "AA ="]) expect(() => put(data), data).toThrow();
  });
});

