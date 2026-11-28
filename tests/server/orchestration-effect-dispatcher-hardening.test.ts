import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EFFECT_WORKER_SLOT_WAIT,
  MALFORMED_EFFECT_PAYLOAD_CODE,
  OrchestrationEffectDispatcher,
  OrchestrationEffectOutbox,
  type EffectHandler,
} from "../../src/server/orchestration-v2/effect-outbox";
import {
  checkpointCaptureEffect,
  ORCHESTRATION_EFFECT_KINDS,
  OrchestrationEffectRuntime,
} from "../../src/server/orchestration-v2/effect-runtime";
import { OrchestrationEventStore } from "../../src/server/orchestration-v2/event-store";
import { projectOrchestrationEvent } from "../../src/server/orchestration-v2/projector";
import { RunControlRepository } from "../../src/server/orchestration-v2/run-control-repository";
import { OrchestrationConflict, type EffectDraft, type ProjectEvent } from "../../src/server/orchestration-v2/types";
import { orchestrationV2Migration } from "../../src/server/persistence/migrations/orchestration-v2";
import { orchestrationV2ReceiptStatusMigration } from "../../src/server/persistence/migrations/orchestration-v2-receipt-status";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { runSteerSchema } from "../../src/shared/orchestration-run-control";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
} from "../support/turn-controller-runtime";

const project: ProjectEvent = (event) => [{ kind: "test", id: event.threadId, value: event.payload }];
const databases: Database.Database[] = [];
const runtimes: OrchestrationEffectRuntime[] = [];
const CAPTURE = "checkpoint.capture-requested";

function memoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(orchestrationV2Migration.up as string);
  (orchestrationV2ReceiptStatusMigration.up as (database: Database.Database) => void)(db);
  return db;
}

function runtimeFor(outbox: OrchestrationEffectOutbox, options: ConstructorParameters<typeof OrchestrationEffectRuntime>[1] = {}) {
  const runtime = new OrchestrationEffectRuntime(outbox, options);
  runtimes.push(runtime);
  return runtime;
}

let commandCounter = 0;
function commitEffects(db: Database.Database, runtimeId: string, threadId: string, effects: EffectDraft[]): void {
  const store = new OrchestrationEventStore(db, project, runtimeId);
  commandCounter += 1;
  store.commit({
    actorId: "runtime",
    commandId: `cmd-${commandCounter}`,
    projectId: "project-1",
    threadId,
    command: { type: "test", index: commandCounter },
    expectedRevision: store.revision(threadId),
    events: [{ type: "test.committed", payload: { index: commandCounter } }],
    effects,
    result: null,
  });
}

function capture(turn: string, threadId = "thread-1"): EffectDraft {
  return checkpointCaptureEffect({ conversationId: threadId, turnId: `turn-${turn}`, runId: `run-${turn}` }, 0);
}

function controlEffect(id: string, kind: "provider.interrupt" | "provider.steer", suffix = "1"): EffectDraft {
  return {
    id,
    eventIndex: 0,
    kind,
    replayPolicy: ORCHESTRATION_EFFECT_KINDS[kind].replayPolicy,
    payload: { runId: `run-${suffix}`, attemptId: `attempt-${suffix}`, turnId: `turn-${suffix}` },
  };
}

async function flushFake(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await vi.advanceTimersByTimeAsync(0);
}

async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const db of databases.splice(0)) if (db.open) db.close();
  await cleanupTurnControllerTestDirectories();
});

describe("Orchestrator V2 effect dispatcher hardening", () => {
  it("detaches a slow effect from its concurrency slot after slotWaitMs while letting it settle normally", async () => {
    expect(EFFECT_WORKER_SLOT_WAIT).toBe(30_000);
    vi.useFakeTimers({
      now: new Date("2026-11-26T00:00:00.000Z"),
      toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"],
    });
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const started: string[] = [];
    const runtime = runtimeFor(outbox, { concurrency: 1, slotWaitMs: 500 });
    runtime.register(CAPTURE, async (payload) => {
      started.push(payload.turnId);
      if (payload.turnId === "turn-slow") await slowDone;
    });
    commitEffects(db, "runtime-1", "thread-1", [capture("slow", "thread-1")]);
    commitEffects(db, "runtime-1", "thread-2", [capture("fast", "thread-2")]);
    runtime.start();
    await flushFake();
    expect(started).toEqual(["turn-slow"]);
    expect(outbox.get(capture("slow", "thread-1").id)?.state).toBe("running");
    expect(outbox.get(capture("fast", "thread-2").id)?.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(499);
    await flushFake();
    expect(started).toEqual(["turn-slow"]);

    // At 500 ms the slow effect detaches its slot so thread-2's fast effect runs while thread-1 stays running.
    await vi.advanceTimersByTimeAsync(1);
    await flushFake();
    expect(started).toEqual(["turn-slow", "turn-fast"]);
    expect(outbox.get(capture("fast", "thread-2").id)?.state).toBe("succeeded");
    expect(outbox.get(capture("slow", "thread-1").id)?.state).toBe("running");

    // The detached handler still settles cleanly when it eventually finishes.
    releaseSlow();
    await flushFake();
    expect(outbox.get(capture("slow", "thread-1").id)?.state).toBe("succeeded");
    expect(runtime.inFlight).toBe(0);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces per-kind running caps in claimNext and pump without blocking other kinds", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    commitEffects(db, "runtime-1", "thread-1", [capture("cap-1", "thread-1")]);
    commitEffects(db, "runtime-1", "thread-2", [capture("cap-2", "thread-2")]);
    commitEffects(db, "runtime-1", "thread-3", [controlEffect("steer-1", "provider.steer", "3")]);

    const perKindCaps = { [CAPTURE]: 1 };
    const first = outbox.claimNext([CAPTURE, "provider.steer"], { perKindCaps });
    expect(first?.kind).toBe(CAPTURE);
    // Second capture is blocked by cap=1, so steer is claimed next.
    const second = outbox.claimNext([CAPTURE, "provider.steer"], { perKindCaps });
    expect(second?.kind).toBe("provider.steer");
    expect(outbox.claimNext([CAPTURE, "provider.steer"], { perKindCaps })).toBeNull();
    outbox.settle(first!, { kind: "succeeded" });
    outbox.settle(second!, { kind: "succeeded" });
    const third = outbox.claimNext([CAPTURE, "provider.steer"], { perKindCaps });
    expect(third?.id).toBe(capture("cap-2", "thread-2").id);
    outbox.settle(third!, { kind: "succeeded" });

    // Also verify dispatcher.pump() respects perKindCaps.
    commitEffects(db, "runtime-1", "thread-4", [capture("pump-1", "thread-4")]);
    commitEffects(db, "runtime-1", "thread-5", [capture("pump-2", "thread-5")]);
    commitEffects(db, "runtime-1", "thread-6", [controlEffect("steer-2", "provider.steer", "6")]);
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const ran: string[] = [];
    const handlers = new Map<string, EffectHandler>([
      [CAPTURE, async (effect) => { ran.push(effect.id); await captureGate; }],
      ["provider.steer", async (effect) => { ran.push(effect.id); }],
    ]);
    const dispatcher = new OrchestrationEffectDispatcher(outbox, handlers, {
      concurrency: 3,
      perKindCaps: { [CAPTURE]: 1 },
    });
    expect(dispatcher.pump()).toBe(2);
    await flush();
    expect(ran).toEqual([capture("pump-1", "thread-4").id, "steer-2"]);
    expect(outbox.get(capture("pump-2", "thread-5").id)?.state).toBe("pending");
    releaseCapture();
    await flush();
    expect(dispatcher.pump()).toBe(1);
    await flush();
    expect(outbox.get(capture("pump-2", "thread-5").id)?.state).toBe("succeeded");
    await dispatcher.close();
  });

  it("never head-of-line blocks provider.interrupt behind provider.steer or checkpoint.capture-requested (Audit 2 Bug #4)", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    commitEffects(db, "runtime-1", "thread-1", [
      controlEffect("steer-1", "provider.steer", "1"),
      capture("cap-1", "thread-1"),
      controlEffect("stop-1", "provider.interrupt", "1"),
    ]);

    // Even when steer-1 and cap-1 precede stop-1 on the same thread, stop-1 is claimed first with priority.
    const claimedPriority = outbox.claimNext(["provider.steer", CAPTURE, "provider.interrupt"]);
    expect(claimedPriority?.id).toBe("stop-1");
    expect(outbox.settle(claimedPriority!, { kind: "succeeded" })).toBe(true);

    // Now claim steer-1 (leave it running), enqueue another interrupt stop-2 behind it: stop-2 must still claim immediately!
    const runningSteer = outbox.claimNext(["provider.steer", CAPTURE, "provider.interrupt"]);
    expect(runningSteer?.id).toBe("steer-1");
    commitEffects(db, "runtime-1", "thread-1", [controlEffect("stop-2", "provider.interrupt", "1")]);
    // cap-1 is still blocked behind running steer-1, while stop-2 bypasses it.
    const claimedInterrupt = outbox.claimNext([CAPTURE, "provider.interrupt"]);
    expect(claimedInterrupt?.id).toBe("stop-2");
    expect(outbox.claimNext([CAPTURE])).toBeNull();
    expect(outbox.settle(claimedInterrupt!, { kind: "succeeded" })).toBe(true);
    expect(outbox.settle(runningSteer!, { kind: "succeeded" })).toBe(true);
    const claimedCapture = outbox.claimNext([CAPTURE]);
    expect(claimedCapture?.id).toBe(capture("cap-1", "thread-1").id);
  });

  it("marks rows with malformed payload_json as failed and skips them instead of wedging pump()", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    commitEffects(db, "runtime-1", "thread-1", [capture("bad", "thread-1")]);
    commitEffects(db, "runtime-1", "thread-2", [capture("good", "thread-2")]);
    const badId = capture("bad", "thread-1").id;
    const goodId = capture("good", "thread-2").id;
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE orchestration_v2_effects SET payload_json = '{not valid json' WHERE id = ?").run(badId);
    db.pragma("ignore_check_constraints = OFF");

    const runtime = runtimeFor(outbox);
    const ran: string[] = [];
    runtime.register(CAPTURE, async (payload) => { ran.push(payload.turnId); });
    runtime.start();
    await runtime.awaitSettled(goodId);
    await flush();

    expect(ran).toEqual(["turn-good"]);
    expect(outbox.get(badId)).toMatchObject({ state: "failed", failureCode: MALFORMED_EFFECT_PAYLOAD_CODE, payload: null });
    expect(outbox.get(goodId)).toMatchObject({ state: "succeeded" });
  });

  it("allows registering provider.interrupt and provider.steer while failing closed for other process-bound kinds", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const runtime = runtimeFor(outbox);

    expect(() => runtime.register("provider.start" as never, async () => undefined)).toThrow("replay-safe");
    expect(() => runtime.register("native.fork" as never, async () => undefined)).toThrow("replay-safe");
    expect(() => runtime.register("native.rollback" as never, async () => undefined)).toThrow("replay-safe");
    expect(() => runtime.register("unknown.kind" as never, async () => undefined)).toThrow("Unknown orchestration effect kind");

    const seen: string[] = [];
    runtime.register("provider.interrupt", async (payload, ctx) => {
      seen.push(`interrupt:${payload.runId}:${ctx.willRetry}`);
    });
    runtime.register("provider.steer", async (payload, ctx) => {
      seen.push(`steer:${payload.runId}:${ctx.willRetry}`);
    });
    commitEffects(db, "runtime-1", "thread-1", [
      controlEffect("steer-1", "provider.steer", "1"),
      controlEffect("stop-1", "provider.interrupt", "1"),
    ]);
    runtime.start();
    await Promise.all([runtime.awaitSettled("steer-1"), runtime.awaitSettled("stop-1")]);
    await flush();

    expect(seen).toContain("interrupt:run-1:false");
    expect(seen).toContain("steer:run-1:false");
    expect(outbox.get("stop-1")?.state).toBe("succeeded");
    expect(outbox.get("steer-1")?.state).toBe("succeeded");
  });

  it("preserves existing awaitSettled waiters when a later caller hits a transient read error (Audit 2 Bug #6)", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const runtime = runtimeFor(outbox);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runtime.register(CAPTURE, async () => { await gate; });
    const effectId = capture("shared", "thread-1").id;
    commitEffects(db, "runtime-1", "thread-1", [capture("shared", "thread-1")]);
    runtime.start();
    await flush();

    // First caller registers a waiter normally while the effect is running.
    const firstWaiter = runtime.awaitSettled(effectId);

    // Second caller encounters a transient SQLITE_BUSY during initial resolveSettled().
    const originalGet = outbox.get.bind(outbox);
    const spy = vi.spyOn(outbox, "get").mockImplementationOnce(() => {
      throw new Database.SqliteError("database is locked", "SQLITE_BUSY");
    });
    await expect(runtime.awaitSettled(effectId)).rejects.toThrow("database is locked");
    spy.mockImplementation(originalGet);

    // First caller's waiter must still be intact and resolve when the effect finishes!
    let firstResolved = false;
    void firstWaiter.then(() => { firstResolved = true; });
    release();
    await firstWaiter;
    expect(firstResolved).toBe(true);
    expect(outbox.get(effectId)?.state).toBe("succeeded");
  });
});

describe("RunControlRepository atomic settle and run-control.steer-read", () => {
  function setupRunControl() {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const events = new OrchestrationEventStore(db, projectOrchestrationEvent, "runtime-1");
    const runControl = new RunControlRepository(events, outbox, () => null);
    const now = "2026-11-26T00:00:00.000Z";
    const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test" });
    events.commit({
      actorId: "runtime",
      commandId: "register-thread",
      projectId: "proj-1",
      threadId: "thread-1",
      command: { type: "register" },
      expectedRevision: 0,
      events: [
        {
          type: "thread.registered",
          payload: {
            id: "thread-1", projectId: "proj-1", workspaceKey: "/tmp/ws", title: "Test",
            providerId: "codex", selection: JSON.parse(JSON.stringify(selection)), activeRunId: null, latestRunId: null,
            createdAt: now, updatedAt: now,
          },
        },
        {
          type: "run.accepted",
          payload: {
            run: {
              id: "run-1", threadId: "thread-1", projectId: "proj-1", turnId: "turn-1",
              messageId: "msg-1", attemptId: "attempt-1", providerInstanceId: "inst-1",
              providerId: "codex", selection: JSON.parse(JSON.stringify(selection)), workspaceKey: "/tmp/ws", status: "queued",
              executionState: "queued", providerState: null, stateRevision: 0,
              requestedAt: now, startedAt: null, completedAt: null, terminalMessageId: null,
            },
            attempt: {
              id: "attempt-1", runId: "run-1", turnId: "turn-1", threadId: "thread-1",
              providerInstanceId: "inst-1", status: "queued", nativeSessionId: null,
              nativeThreadId: null, nativeTurnId: null, interruptRequestedAt: null,
              cleanup: "not-started", runtimeId: "runtime-1",
            },
          },
        },
      ],
      result: null,
    });
    const makeTicket = (commandId: string) => ({
      identity: { actorId: "human", commandId, projectId: "proj-1", threadId: "thread-1" },
      commit: (draft: { events: readonly { type: string; payload: unknown }[]; effects?: readonly EffectDraft[]; result: unknown }, compat?: () => void) =>
        events.commit({
          actorId: "human", commandId, projectId: "proj-1", threadId: "thread-1",
          command: { commandId }, expectedRevision: events.revision("thread-1"),
          events: draft.events as never, effects: draft.effects, result: draft.result as never,
        }, compat),
    });
    return { db, outbox, events, runControl, makeTicket };
  }

  it("settles outbox effects atomically inside commit() and preserves claims/waiters on failure (Audit 2 Bug #2)", async () => {
    const { outbox, events, runControl, makeTicket } = setupRunControl();
    const steerReq = runControl.requestSteer(makeTicket("steer-cmd-1") as never, "run-1", "turn-1");
    expect(steerReq.kind).toBe("requested");
    if (steerReq.kind !== "requested") throw new Error("expected requested");
    expect(outbox.get(steerReq.effectId)?.state).toBe("running");

    // Simulate a commit failure during settleSteer: outbox row must remain running and waiter must stay unresolved.
    const commitSpy = vi.spyOn(events, "commit").mockImplementationOnce(() => {
      throw new OrchestrationConflict("revision-conflict");
    });
    expect(() => runControl.settleSteer(steerReq.effectId, "accepted", { messageId: "msg-steer-1" }))
      .toThrow(OrchestrationConflict);
    commitSpy.mockRestore();
    expect(outbox.get(steerReq.effectId)?.state).toBe("running");
    expect(runControl.steer(steerReq.effectId)?.state).toBe("dispatching");
    expect(await runControl.awaitSettled([steerReq.effectId], Date.now() + 20)).toBe(false);

    // Retry succeeds atomically: both projection and outbox settle and waiter resolves.
    runControl.settleSteer(steerReq.effectId, "accepted", { messageId: "msg-steer-1" });
    expect(outbox.get(steerReq.effectId)?.state).toBe("succeeded");
    expect(runControl.steer(steerReq.effectId)).toMatchObject({ state: "settled", outcome: "accepted", readAt: null });
    expect(await runControl.awaitSettled([steerReq.effectId], Date.now() + 50)).toBe(true);

    // Same atomicity test for settleInterrupt.
    const target = runControl.target("run-1")!;
    const interruptEffectId = runControl.recordInterrupt(makeTicket("stop-cmd-1") as never, target, "turn-1", "user");
    expect(outbox.get(interruptEffectId)?.state).toBe("running");
    const stopSpy = vi.spyOn(events, "commit").mockImplementationOnce(() => {
      throw new OrchestrationConflict("revision-conflict");
    });
    expect(() => runControl.settleInterrupt("run-1", "settled")).toThrow(OrchestrationConflict);
    stopSpy.mockRestore();
    expect(outbox.get(interruptEffectId)?.state).toBe("running");
    expect(runControl.attemptInterrupt("attempt-1")?.outcome).toBeNull();
    expect(await runControl.awaitSettled([interruptEffectId], Date.now() + 20)).toBe(false);

    expect(runControl.settleInterrupt("run-1", "settled")).toBe(true);
    expect(outbox.get(interruptEffectId)?.state).toBe("succeeded");
    expect(runControl.attemptInterrupt("attempt-1")?.outcome).toBe("settled");
    expect(await runControl.awaitSettled([interruptEffectId], Date.now() + 50)).toBe(true);
  });

  it("projects run-control.steer-read, enforces idempotency, lists unread accepted steers, and survives rebuild", async () => {
    const { events, runControl, makeTicket } = setupRunControl();
    const s1 = runControl.requestSteer(makeTicket("steer-1") as never, "run-1", "turn-1");
    const s2 = runControl.requestSteer(makeTicket("steer-2") as never, "run-1", "turn-1");
    const s3 = runControl.requestSteer(makeTicket("steer-3") as never, "run-1", "turn-1");
    if (s1.kind !== "requested" || s2.kind !== "requested" || s3.kind !== "requested") throw new Error("expected requested");

    // Cannot mark dispatching steer as read.
    expect(runControl.recordSteerRead({
      conversationId: "thread-1", projectId: "proj-1", runId: "run-1", attemptId: "attempt-1",
      effectId: s1.effectId, readAt: "2026-11-26T00:01:00.000Z",
    })).toBe(false);

    runControl.settleSteer(s1.effectId, "accepted", { messageId: "m-1" });
    runControl.settleSteer(s2.effectId, "accepted", { messageId: "m-2" });
    runControl.settleSteer(s3.effectId, "refused", { messageId: null });

    expect(runControl.listUnreadAcceptedSteers("run-1").map(({ effectId }) => effectId)).toEqual([s1.effectId, s2.effectId]);
    // Cannot mark refused steer as read.
    expect(runControl.recordSteerRead({
      conversationId: "thread-1", projectId: "proj-1", runId: "run-1", attemptId: "attempt-1",
      effectId: s3.effectId, readAt: "2026-11-26T00:01:00.000Z",
    })).toBe(false);

    // Mark s1 read; second call is idempotent and writes nothing.
    expect(runControl.recordSteerRead({
      conversationId: "thread-1", projectId: "proj-1", runId: "run-1", attemptId: "attempt-1",
      effectId: s1.effectId, readAt: "2026-11-26T00:01:00.000Z",
    })).toBe(true);
    const revAfterRead = events.revision("thread-1");
    expect(runControl.recordSteerRead({
      conversationId: "thread-1", projectId: "proj-1", runId: "run-1", attemptId: "attempt-1",
      effectId: s1.effectId, readAt: "2026-11-26T00:02:00.000Z",
    })).toBe(false);
    expect(events.revision("thread-1")).toBe(revAfterRead);

    expect(runControl.steer(s1.effectId)?.readAt).toBe("2026-11-26T00:01:00.000Z");
    expect(runControl.listUnreadAcceptedSteers("run-1").map(({ effectId }) => effectId)).toEqual([s2.effectId]);

    // Projector rejects a duplicate run-control.steer-read event directly.
    expect(() => events.commit({
      actorId: "runtime", commandId: "dup-steer-read", projectId: "proj-1", threadId: "thread-1",
      command: { type: "dup" }, expectedRevision: events.revision("thread-1"),
      events: [{ type: "run-control.steer-read", payload: { runId: "run-1", attemptId: "attempt-1", effectId: s1.effectId, readAt: "2026-11-26T00:03:00.000Z" } }],
      result: null,
    })).toThrow(OrchestrationConflict);

    // Full-log rebuild reproduces readAt and listUnreadAcceptedSteers cleanly.
    events.rebuildProjections();
    expect(runControl.steer(s1.effectId)?.readAt).toBe("2026-11-26T00:01:00.000Z");
    expect(runControl.steer(s2.effectId)?.readAt).toBeNull();
    expect(runControl.listUnreadAcceptedSteers("run-1").map(({ effectId }) => effectId)).toEqual([s2.effectId]);

    // Legacy run-steer rows without readAt still parse cleanly with default null.
    const legacy = runSteerSchema.parse({
      runId: "run-1", attemptId: "attempt-1", effectId: "legacy-1", requestedAt: "2026-11-26T00:00:00.000Z",
      state: "settled", outcome: "accepted", messageId: "m-1", queuedMessageId: null, settledAt: "2026-11-26T00:00:05.000Z",
    });
    expect(legacy.readAt).toBeNull();

    // Ensure full TurnController runtime initializes cleanly with the new RunControlRepository.
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Hello" });
      runtime.controller.start(queued.turn.id);
      runtime.provider.resolve({ text: "Hi" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.runControl.listUnreadAcceptedSteers(queued.turn.runId)).toEqual([]);
    } finally {
      runtime.store.close();
    }
  });
});
