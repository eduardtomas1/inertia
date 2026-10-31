import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationCommandLanes } from "../../src/server/orchestration-v2/command-lanes";
import { RuntimeStore } from "../../src/server/database";
import { OrchestrationEffectOutbox } from "../../src/server/orchestration-v2/effect-outbox";
import { OrchestrationEventStore } from "../../src/server/orchestration-v2/event-store";
import { durableJson } from "../../src/server/orchestration-v2/json";
import { orchestrationV2Migration } from "../../src/server/persistence/migrations/orchestration-v2";
import type { CommandCommit, ProjectEvent } from "../../src/server/orchestration-v2/types";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
} from "../support/turn-controller-runtime";

const databases: Database.Database[] = [];
const project: ProjectEvent = (event) => [{ kind: "test", id: event.threadId, value: event.payload }];

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(orchestrationV2Migration.up as string);
  let now = "2026-10-29T21:00:00.000Z";
  const clock = () => now;
  const store = new OrchestrationEventStore(db, project, "runtime-1", clock);
  const outbox = new OrchestrationEffectOutbox(db, "runtime-1", clock);
  return { db, store, outbox, clock, advance: () => { now = "2026-10-29T21:01:00.000Z"; } };
}

function command(overrides: Partial<CommandCommit> = {}): CommandCommit {
  return { actorId: "user", commandId: "command-1", projectId: "project-1", threadId: "thread-1",
    command: { type: "test", text: "request" }, expectedRevision: 0,
    events: [{ type: "test.accepted", payload: { value: 1 } }],
    effects: [{ id: "effect-1", kind: "test.deliver", eventIndex: 0, replayPolicy: "process-bound", payload: null }],
    result: { accepted: "run-1" }, ...overrides };
}

afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  await cleanupTurnControllerTestDirectories();
});

describe("Orchestrator V2 atomic command boundary", () => {
  it("commits events, projections, effects and a replayable caller-scoped receipt together", () => {
    const { store, outbox } = fixture();
    const committed = store.commit(command());
    expect(committed.replayed).toBe(false);
    expect(committed.receipt.firstSequence).toBe(1);
    expect(store.projection("test", "thread-1")?.value).toEqual({ value: 1 });
    expect(outbox.get("effect-1")?.state).toBe("pending");
    const replay = store.commit(command({ command: { text: "request", type: "test" }, expectedRevision: 999 }));
    expect(replay).toEqual({ replayed: true, receipt: committed.receipt, events: [] });
    expect(store.revision("thread-1")).toBe(1);
    expect(() => store.commit(command({ command: { text: "different" } }))).toThrow("command-conflict");
    expect(() => store.commit(command({ threadId: "different-thread" }))).toThrow("command-conflict");
  });

  it("rolls back the entire commit when projection or compatibility writing fails", () => {
    const { db, store, outbox } = fixture();
    db.exec("CREATE TABLE compatibility (id TEXT PRIMARY KEY)");
    expect(() => store.commit(command(), () => {
      db.prepare("INSERT INTO compatibility VALUES ('not-committed')").run();
      throw new Error("projection-write-failed");
    })).toThrow("projection-write-failed");
    expect(store.revision("thread-1")).toBe(0);
    expect(store.projection("test", "thread-1")).toBeNull();
    expect(outbox.get("effect-1")).toBeNull();
    expect(store.receipt(command(), command().command)).toBeNull();
    expect(db.prepare("SELECT * FROM compatibility").all()).toEqual([]);
    const broken = new OrchestrationEventStore(db, () => { throw new Error("broken reducer"); }, "runtime-1");
    expect(() => broken.commit(command())).toThrow("broken reducer");
    expect(store.revision("thread-1")).toBe(0);
  });

  it("rejects stale decisions and cross-project/thread projection writes without partial state", () => {
    const { db, store } = fixture();
    store.commit(command());
    expect(() => store.commit(command({ commandId: "next", effects: [] }))).toThrow("revision-conflict");
    expect(() => store.commit(command({ commandId: "next", projectId: "other", expectedRevision: 1, effects: [] })))
      .toThrow("scope-conflict");
    const corrupt = new OrchestrationEventStore(db,
      () => [{ kind: "test", id: "thread-1", value: "cross-thread overwrite" }], "runtime-1");
    expect(() => corrupt.commit(command({ commandId: "cross", threadId: "thread-2", effects: [] })))
      .toThrow("scope-conflict");
    expect(store.revision("thread-2")).toBe(0);
    expect(store.projection("test", "thread-1")?.value).toEqual({ value: 1 });
  });

  it("rebuilds projections without replaying effects or republishing receipts", () => {
    const { db, store, outbox } = fixture();
    store.commit(command());
    const claim = outbox.claim()!;
    outbox.settle(claim, { kind: "succeeded" });
    db.prepare("DELETE FROM orchestration_v2_entities").run();
    store.rebuildProjections();
    expect(store.projection("test", "thread-1")?.value).toEqual({ value: 1 });
    expect(outbox.get(claim.id)?.state).toBe("succeeded");
    expect(outbox.claim()).toBeNull();
    expect(store.commit(command()).events).toEqual([]);
    expect(store.readEvents({ projectId: "unrelated" })).toEqual([]);
    expect(store.readEvents({ projectId: "project-1", afterSequence: 1 })).toEqual([]);
    expect(() => store.readEvents({ projectId: "project-1", limit: 501 })).toThrow();
  });

  it("rejects malformed and oversized durable data before any writes", () => {
    const { store } = fixture();
    expect(() => store.commit(command({ events: [{ type: "test", payload: "x".repeat(1_048_577) }] }))).toThrow("size limit");
    expect(() => store.commit(command({ effects: [{ id: "bad", eventIndex: 1, kind: "test", replayPolicy: "process-bound", payload: null }] })))
      .toThrow("must belong");
    expect(() => durableJson({ bad: Number.NaN })).toThrow("finite");
    expect(() => durableJson({ bad: undefined } as never)).toThrow("acyclic JSON");
    expect(store.revision("thread-1")).toBe(0);
  });
});

describe("Orchestrator V2 effect ownership", () => {
  it("serializes a thread's effects while allowing another thread to progress", () => {
    const { store, outbox } = fixture();
    store.commit(command({ effects: [
      { id: "a1", eventIndex: 0, kind: "test", replayPolicy: "process-bound", payload: null },
      { id: "a2", eventIndex: 0, kind: "test", replayPolicy: "process-bound", payload: null },
    ] }));
    store.commit(command({ commandId: "b", threadId: "thread-2", effects: [
      { id: "b1", eventIndex: 0, kind: "test", replayPolicy: "process-bound", payload: null },
    ] }));
    const first = outbox.claim()!;
    expect(first.id).toBe("a1");
    expect(outbox.claim("a2")).toBeNull();
    expect(outbox.claim()?.id).toBe("b1");
    expect(outbox.settle(first, { kind: "succeeded" })).toBe(true);
    expect(outbox.settle(first, { kind: "failed", code: "late" })).toBe(false);
    expect(outbox.claim()?.id).toBe("a2");
  });

  it("retires process-bound effects after a crash and fences old replay-safe claims", () => {
    const { db, store, outbox, clock } = fixture();
    store.commit(command());
    const processBound = outbox.claim()!;
    store.commit(command({ commandId: "safe", threadId: "thread-2", effects: [
      { id: "safe", eventIndex: 0, kind: "notify", replayPolicy: "replay-safe", payload: null },
    ] }));
    const oldSafeClaim = outbox.claim()!;
    const restarted = new OrchestrationEffectOutbox(db, "runtime-2", clock);
    expect(restarted.recover()).toEqual({ retired: 1, replayable: 1 });
    expect(restarted.get(processBound.id)?.state).toBe("retired");
    expect(outbox.settle(processBound, { kind: "succeeded" })).toBe(false);
    expect(outbox.settle(oldSafeClaim, { kind: "succeeded" })).toBe(false);
    const newSafeClaim = restarted.claim()!;
    expect(newSafeClaim.claimId).not.toBe(oldSafeClaim.claimId);
    expect(newSafeClaim.id).toBe("safe");
    expect(newSafeClaim.attempts).toBe(2);
    expect(restarted.settle(newSafeClaim, { kind: "succeeded" })).toBe(true);
  });

  it("holds later lane effects during a safe retry and never retries ambiguous process work", () => {
    const { store, outbox, advance } = fixture();
    store.commit(command({ effects: [
      { id: "safe", eventIndex: 0, kind: "notify", replayPolicy: "replay-safe", payload: null },
      { id: "native", eventIndex: 0, kind: "native", replayPolicy: "process-bound", payload: null },
    ] }));
    const safe = outbox.claim()!;
    expect(outbox.settle(safe, { kind: "failed", code: "temporary", retryable: true })).toBe(true);
    expect(outbox.claim()).toBeNull();
    advance();
    const retried = outbox.claim()!;
    expect(retried.id).toBe("safe");
    outbox.settle(retried, { kind: "succeeded" });
    const native = outbox.claim()!;
    outbox.settle(native, { kind: "failed", code: "ambiguous", retryable: true });
    expect(outbox.get(native.id)?.state).toBe("failed");
    expect(outbox.claim()).toBeNull();
    expect(outbox.pruneSettled("2026-10-30T00:00:00.000Z")).toBe(1);
    expect(outbox.get(native.id)?.failureCode).toBe("ambiguous");
  });
});

describe("Orchestrator V2 real turn integration", () => {
  it("replays the original ingress acknowledgement across restart without creating a new message", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const source = { actorId: "human", commandId: "request-once",
      command: { type: "message.send", payload: { content: "Run once", conversationId: runtime.conversationId } } };
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Run once", orchestrationRequest: source });
    const oldRuntime = runtime.store.orchestration.runtimeId;
    runtime.store.close();
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(reopened.orchestration.runtimeId).not.toBe(oldRuntime);
      const replay = reopened.orchestration.acceptedRequest(runtime.conversationId, source);
      expect(replay?.turn.id).toBe(queued.turn.id);
      expect(replay?.message.id).toBe(queued.message.id);
      expect(reopened.orchestration.startIntent(queued.turn.runId)?.state).toBe("retired");
      expect(reopened.orchestration.events.projection("run", queued.turn.runId)?.value).toMatchObject({
        status: "interrupted", executionState: "interrupted",
      });
      expect(() => reopened.orchestration.acceptedRequest(runtime.conversationId,
        { ...source, command: { ...source.command, payload: { ...source.command.payload, content: "Different" } } }))
        .toThrow("command-conflict");
      expect(reopened.snapshot().messages.filter(({ role }) => role === "user")).toHaveLength(1);
    } finally { reopened.close(); }
  });

  it("withdraws an unclaimed start when admission fails before dispatch, allowing the next turn", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Never start" });
    expect(runtime.controller.failBeforeStart(runtime.conversationId, "Acknowledgement failed")).toBe(true);
    await flushTurnControllerTestPromises();
    expect(runtime.store.orchestration.startIntent(queued.turn.runId)?.state).toBe("retired");
    const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again" });
    expect(runtime.controller.start(next.turn.id)).toBe(true);
    expect(runtime.provider.runCount).toBe(1);
    runtime.provider.resolve({ status: "completed", text: "Finished" });
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });

  it("keeps historical attempts separate when confirmed provider cleanup is followed by a new attempt", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Retry an attempt" });
    const { orchestration } = runtime.store;
    const run = orchestration.events.projection("run", queued.turn.runId)!.value as { attemptId: string };
    const identity = { turnId: queued.turn.id, runId: queued.turn.runId };
    orchestration.cleanup(identity, "pending");
    orchestration.cleanup(identity, "confirmed");
    orchestration.cleanup(identity, "pending");
    const replacement = orchestration.events.projection("run", queued.turn.runId)!.value as { attemptId: string };
    expect(replacement.attemptId).not.toBe(run.attemptId);
    expect(orchestration.events.projection("attempt", run.attemptId)?.value).toMatchObject({ cleanup: "confirmed" });
    expect(orchestration.events.projection("attempt", replacement.attemptId)?.value).toMatchObject({ cleanup: "pending" });
    runtime.store.close();
  });

  it("admits a durable start intent and claims it only once before provider execution", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Inspect the project" });
      const { orchestration } = runtime.store;
      expect(orchestration.startIntent(queued.turn.runId)?.state).toBe("pending");
      expect(orchestration.events.projection("run", queued.turn.runId)?.value).toMatchObject({
        turnId: queued.turn.id, status: "queued", messageId: queued.message.id,
      });
      expect(runtime.controller.start(queued.turn.id)).toBe(true);
      expect(runtime.controller.start(queued.turn.id)).toBe(false);
      await flushTurnControllerTestPromises();
      expect(orchestration.startIntent(queued.turn.runId)?.state).toBe("succeeded");
      expect(orchestration.events.projection("run", queued.turn.runId)?.value).toMatchObject({ status: "starting" });
    } finally { runtime.store.close(); }
  });

  it("rolls back user-visible admission when the orchestration commit fails", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const before = runtime.store.snapshot().messages.length;
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First" });
      const input = {
        id: "conflicting-turn", runId: "conflicting-run", conversationId: runtime.conversationId,
        content: "Must roll back", providerId: first.turn.providerId, modelSelection: first.turn.modelSelection,
        reasoningEffort: first.turn.reasoningEffort, interactionMode: first.turn.interactionMode,
        accessMode: first.turn.accessMode, configurationRevision: first.turn.configurationRevision,
        association: "authoritative" as const,
      };
      expect(() => runtime.store.beginOrchestratedAgentTurn(input)).toThrow();
      expect(runtime.store.snapshot().messages.length).toBe(before + 1);
      expect(runtime.store.agentTurnForRun(input.runId)).toBeNull();
    } finally { runtime.store.close(); }
  });
});

describe("Orchestrator V2 command lanes", () => {
  it("orders commands per thread, isolates failures, and drains before shutdown", async () => {
    const lanes = new OrchestrationCommandLanes();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = lanes.run("a", async () => { order.push("a1"); await gate; throw new Error("failed"); });
    const failure = expect(first).rejects.toThrow("failed");
    const second = lanes.run("a", () => { order.push("a2"); });
    await lanes.run("b", () => { order.push("b1"); });
    expect(order).toEqual(["a1", "b1"]);
    const closing = lanes.close();
    await expect(lanes.run("c", () => undefined)).rejects.toThrow("shutting down");
    release();
    await Promise.all([failure, second, closing]);
    expect(order).toEqual(["a1", "b1", "a2"]);
  });
});
