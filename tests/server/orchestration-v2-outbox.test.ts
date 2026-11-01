import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestrationEffectOutbox } from "../../src/server/orchestration-v2/effect-outbox";
import {
  checkpointCaptureEffect,
  effectKindPolicy,
  ORCHESTRATION_EFFECT_KINDS,
  OrchestrationEffectRuntime,
  type CheckpointCaptureRequest,
  type ReplaySafeEffectContext,
} from "../../src/server/orchestration-v2/effect-runtime";
import { OrchestrationEventStore } from "../../src/server/orchestration-v2/event-store";
import { orchestrationV2Migration } from "../../src/server/persistence/migrations/orchestration-v2";
import { orchestrationV2ReceiptStatusMigration } from "../../src/server/persistence/migrations/orchestration-v2-receipt-status";
import type { EffectDraft, ProjectEvent } from "../../src/server/orchestration-v2/types";
import { RuntimeStore } from "../../src/server/database";
import { checkpointCaptureExecutor } from "../../src/server/runtime/checkpoint-capture-executor";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

const project: ProjectEvent = (event) => [{ kind: "test", id: event.threadId, value: event.payload }];
const databases: Database.Database[] = [];
const runtimes: OrchestrationEffectRuntime[] = [];
const directories: string[] = [];
const CAPTURE = "checkpoint.capture-requested";

function openDatabase(path = ":memory:"): Database.Database {
  const db = new Database(path);
  databases.push(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function databaseFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-outbox-"));
  directories.push(directory);
  const path = join(directory, "orchestration.sqlite");
  migrateOrchestration(openDatabase(path));
  return path;
}

function memoryDatabase(): Database.Database {
  return migrateOrchestration(openDatabase());
}

function migrateOrchestration(db: Database.Database): Database.Database {
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
  store.commit({ actorId: "runtime", commandId: `command-${commandCounter}`, projectId: "project-1", threadId,
    command: { type: "test", index: commandCounter }, expectedRevision: store.revision(threadId),
    events: [{ type: "test.committed", payload: { index: commandCounter } }], effects, result: null });
}

function capture(turn: string, threadId = "thread-1"): EffectDraft {
  return checkpointCaptureEffect({ conversationId: threadId, turnId: `turn-${turn}`, runId: `run-${turn}` }, 0);
}

function processBound(id: string, kind: "provider.start" | "native.fork"): EffectDraft {
  return { id, eventIndex: 0, kind, replayPolicy: ORCHESTRATION_EFFECT_KINDS[kind].replayPolicy, payload: { id } };
}

async function flushFake(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await vi.advanceTimersByTimeAsync(0);
}

async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  await cleanupTurnControllerTestDirectories();
});

describe("Orchestrator V2 effect classification", () => {
  it("classifies every production effect kind and records that process-bound work never retries", () => {
    expect(effectKindPolicy("provider.start")).toMatchObject({ replayPolicy: "process-bound", retry: "never" });
    expect(effectKindPolicy("native.fork")).toMatchObject({ replayPolicy: "process-bound", retry: "never" });
    expect(effectKindPolicy("native.rollback")).toMatchObject({ replayPolicy: "process-bound", retry: "never" });
    expect(effectKindPolicy(CAPTURE)).toMatchObject({ replayPolicy: "replay-safe", retry: "bounded" });
    expect(effectKindPolicy("toString")).toBeNull();
    expect(effectKindPolicy("unclassified.kind")).toBeNull();
    expect(() => checkpointCaptureEffect({ conversationId: "thread-1", turnId: "", runId: "run" }, 0)).toThrow();
    expect(capture("a").id).toBe(capture("a").id);
    expect(capture("a").id).not.toBe(capture("b").id);

    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    commitEffects(db, "runtime-1", "thread-1", [processBound("start-1", "provider.start")]);
    const start = outbox.claim("start-1")!;
    expect(outbox.settle(start, { kind: "failed", code: "start-failed", retryable: true })).toBe(true);
    expect(outbox.get("start-1")).toMatchObject({ state: "failed", attempts: 1, failureCode: "start-failed" });
    const runtime = runtimeFor(outbox);
    expect(() => runtime.register("provider.start" as never, async () => undefined)).toThrow("replay-safe");
    runtime.register(CAPTURE, async () => undefined);
    expect(() => runtime.register(CAPTURE, async () => undefined)).toThrow("already registered");
  });
});

describe("Orchestrator V2 effect runtime", () => {
  it("runs a replay-safe effect pending at shutdown exactly once after restart", async () => {
    const path = databaseFile();
    const first = openDatabase(path);
    const firstOutbox = new OrchestrationEffectOutbox(first, "runtime-1");
    const beforeShutdown = runtimeFor(firstOutbox);
    beforeShutdown.start();
    const pendingId = capture("pending").id;
    const runningId = capture("running", "thread-2").id;
    commitEffects(first, "runtime-1", "thread-1", [capture("pending")]);
    commitEffects(first, "runtime-1", "thread-2", [capture("running", "thread-2")]);
    expect(firstOutbox.claim(runningId)?.attempts).toBe(1);
    beforeShutdown.wake();
    await flush();
    await beforeShutdown.stop();
    expect(firstOutbox.get(pendingId)).toMatchObject({ state: "pending", attempts: 0 });
    expect(firstOutbox.get(runningId)).toMatchObject({ state: "running", attempts: 1 });
    first.close();

    const reopened = openDatabase(path);
    const outbox = new OrchestrationEffectOutbox(reopened, "runtime-2");
    expect(outbox.recover()).toEqual({ retired: 0, replayable: 2 });
    const runtime = runtimeFor(outbox);
    const executed: Array<{ payload: CheckpointCaptureRequest; context: ReplaySafeEffectContext }> = [];
    runtime.register(CAPTURE, async (payload, context) => { executed.push({ payload, context }); });
    runtime.start();
    await Promise.all([runtime.awaitSettled(pendingId), runtime.awaitSettled(runningId)]);
    runtime.wake();
    await flush();
    expect(executed.map(({ payload }) => payload.turnId).sort()).toEqual(["turn-pending", "turn-running"]);
    expect(executed.find(({ payload }) => payload.turnId === "turn-pending")?.context)
      .toMatchObject({ effectId: pendingId, threadId: "thread-1", projectId: "project-1", attempt: 1, willRetry: true });
    expect(executed.find(({ payload }) => payload.turnId === "turn-running")?.context.attempt).toBe(2);
    expect(outbox.get(pendingId)).toMatchObject({ state: "succeeded", runtimeId: "runtime-2" });
    expect(outbox.get(runningId)).toMatchObject({ state: "succeeded", runtimeId: "runtime-2" });
    expect(new OrchestrationEffectOutbox(reopened, "runtime-3").recover()).toEqual({ retired: 0, replayable: 0 });
  });

  it("never runs an effect cancelled between claim and execution", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const runtime = runtimeFor(outbox);
    const executed: string[] = [];
    runtime.register(CAPTURE, async (payload) => { executed.push(payload.turnId); });
    commitEffects(db, "runtime-1", "thread-1", [capture("signalled")]);
    commitEffects(db, "runtime-1", "thread-2", [capture("durable", "thread-2")]);
    runtime.start();
    expect(runtime.pump()).toBe(2);
    expect(runtime.cancelUnsettled({ threadId: "thread-1", kinds: [CAPTURE], reason: "run-stopped" }))
      .toEqual([capture("signalled").id]);
    expect(outbox.cancelUnsettled("thread-2", [CAPTURE], "run-stopped")).toEqual([capture("durable", "thread-2").id]);
    await flush();
    expect(executed).toEqual([]);
    expect(outbox.get(capture("signalled").id)).toMatchObject({ state: "retired", failureCode: "run-stopped", claimId: null });
    expect(outbox.get(capture("durable", "thread-2").id)).toMatchObject({ state: "retired", failureCode: "run-stopped" });
    expect(runtime.inFlight).toBe(0);
  });

  it("aborts a running effect on cancellation and keeps the cancellation authoritative", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const runtime = runtimeFor(outbox);
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let observedAbort = false;
    runtime.register(CAPTURE, (_payload, { signal }) => new Promise<void>((resolve) => {
      started();
      signal.addEventListener("abort", () => { observedAbort = true; resolve(); });
    }));
    commitEffects(db, "runtime-1", "thread-1", [capture("running")]);
    runtime.start();
    await running;
    const settled = runtime.awaitSettled(capture("running").id);
    runtime.cancelUnsettled({ threadId: "thread-1", kinds: [CAPTURE], reason: "run-stopped" });
    await settled;
    await flush();
    expect(observedAbort).toBe(true);
    expect(outbox.get(capture("running").id)).toMatchObject({ state: "retired", failureCode: "run-stopped" });
  });

  it("makes a retry claimable from its own timer and wakes after commit without an external pump", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T00:00:00.000Z"),
      toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const runtime = runtimeFor(outbox);
    const attempts: number[] = [];
    runtime.register(CAPTURE, async (_payload, { attempt }) => {
      attempts.push(attempt);
      if (attempt === 1) throw new Error("git busy");
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    commitEffects(db, "runtime-1", "thread-1", [capture("retry")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toEqual([]);
    runtime.wake();
    await flushFake();
    expect(attempts).toEqual([1]);
    expect(outbox.get(capture("retry").id)).toMatchObject({ state: "pending", attempts: 1,
      availableAt: "2026-11-01T00:00:00.100Z", failureCode: "effect-execution-failed" });
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    await flushFake();
    expect(attempts).toEqual([1, 2]);
    expect(outbox.get(capture("retry").id)).toMatchObject({ state: "succeeded", attempts: 2 });

    commitEffects(db, "runtime-1", "thread-1", [capture("liveness")]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(attempts).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushFake();
    expect(attempts).toEqual([1, 2, 1]);
    expect(outbox.get(capture("liveness").id)).toMatchObject({ state: "pending", attempts: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await flushFake();
    expect(attempts).toEqual([1, 2, 1, 2]);
    expect(outbox.get(capture("liveness").id)).toMatchObject({ state: "succeeded", attempts: 2 });

    commitEffects(db, "runtime-1", "thread-1", [capture("committed")]);
    outbox.notifyAvailable();
    await flushFake();
    expect(attempts).toEqual([1, 2, 1, 2, 1]);
  });

  it("keeps later effects in a thread behind an earlier inline process-bound effect", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const runtime = runtimeFor(outbox);
    const executed: string[] = [];
    runtime.register(CAPTURE, async (payload) => { executed.push(payload.turnId); });
    commitEffects(db, "runtime-1", "thread-1", [processBound("start-1", "provider.start"), capture("after-start")]);
    runtime.start();
    await flush();
    expect(executed).toEqual([]);
    expect(outbox.get("start-1")?.state).toBe("pending");
    const start = outbox.claim("start-1")!;
    expect(outbox.settle(start, { kind: "succeeded" })).toBe(true);
    await runtime.awaitSettled(capture("after-start").id);
    expect(executed).toEqual(["turn-after-start"]);
  });

  it("prunes settled effects older than seven days in bounded batches and keeps failed rows", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const nowMs = Date.parse("2026-11-01T00:00:00.000Z");
    for (let commit = 0; commit < 5; commit += 1) {
      commitEffects(db, "runtime-1", `thread-${commit}`, Array.from({ length: 222 }, (_, index) => ({
        id: `effect-${commit}-${index}`, eventIndex: 0, kind: CAPTURE, replayPolicy: "replay-safe" as const, payload: null })));
    }
    const old = "2026-10-20T00:00:00.000Z";
    const recent = "2026-10-30T00:00:00.000Z";
    const setState = db.prepare(`UPDATE orchestration_v2_effects SET state = ?, settled_at = ?, failure_code = ?
      WHERE sequence IN (SELECT sequence FROM orchestration_v2_effects WHERE state = 'pending' ORDER BY sequence LIMIT ?)`);
    setState.run("succeeded", old, null, 1_000);
    setState.run("retired", old, "run-stopped", 101);
    setState.run("failed", old, "effect-execution-failed", 4);
    setState.run("succeeded", recent, null, 3);
    const batches = vi.spyOn(outbox, "pruneSettled");
    const runtime = runtimeFor(outbox, { now: () => nowMs });
    expect(await runtime.pruneSettled()).toBe(1_101);
    expect(batches.mock.calls.map(([before, options]) => [before, options?.limit, [...(options?.kinds ?? [])]])).toEqual([
      ["2026-10-25T00:00:00.000Z", 500, [CAPTURE]], ["2026-10-25T00:00:00.000Z", 500, [CAPTURE]],
      ["2026-10-25T00:00:00.000Z", 500, [CAPTURE]],
    ]);
    expect(batches.mock.results.map(({ value }) => value as number)).toEqual([500, 500, 101]);
    const remaining = db.prepare(`SELECT state, COUNT(*) AS count FROM orchestration_v2_effects
      GROUP BY state ORDER BY state`).all();
    expect(remaining).toEqual([
      { state: "failed", count: 4 }, { state: "pending", count: 2 }, { state: "succeeded", count: 3 },
    ]);
  });

  it("never prunes settled process-bound intents while removing old replay-safe effects", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    commitEffects(db, "runtime-1", "thread-1", [
      processBound("start-1", "provider.start"), processBound("fork-1", "native.fork"),
      { ...processBound("rollback-1", "native.fork"), kind: "native.rollback" }, capture("old"),
    ]);
    commitEffects(db, "runtime-1", "thread-2", [{ id: "unclassified", eventIndex: 0, kind: "test.notify",
      replayPolicy: "replay-safe", payload: null }]);
    db.prepare(`UPDATE orchestration_v2_effects SET state = 'succeeded', settled_at = '2026-10-01T00:00:00.000Z'
      WHERE id IN ('start-1', 'fork-1', 'unclassified', ?)`).run(capture("old").id);
    db.prepare(`UPDATE orchestration_v2_effects SET state = 'retired', settled_at = '2026-10-01T00:00:00.000Z',
      failure_code = 'runtime-lost' WHERE id = 'rollback-1'`).run();
    const runtime = runtimeFor(outbox, { now: () => Date.parse("2026-11-01T00:00:00.000Z") });
    expect(await runtime.pruneSettled()).toBe(1);
    expect(outbox.get(capture("old").id)).toBeNull();
    expect(outbox.get("start-1")).toMatchObject({ state: "succeeded", replayPolicy: "process-bound" });
    expect(outbox.get("fork-1")).toMatchObject({ state: "succeeded", replayPolicy: "process-bound" });
    expect(outbox.get("rollback-1")).toMatchObject({ state: "retired", replayPolicy: "process-bound" });
    expect(outbox.get("unclassified")?.state).toBe("succeeded");
    expect(outbox.pruneSettled("2026-10-25T00:00:00.000Z", { kinds: ["provider.start", "native.fork"] })).toBe(0);
    expect(outbox.pruneSettled("2026-10-25T00:00:00.000Z", { kinds: [] })).toBe(0);
    expect(outbox.get("start-1")).not.toBeNull();
    expect(outbox.get("fork-1")).not.toBeNull();
  });

  it("schedules pruning at startup and hourly while running", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T00:00:00.000Z"),
      toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    commitEffects(db, "runtime-1", "thread-1", [capture("a"), capture("b")]);
    const settleOld = db.prepare(`UPDATE orchestration_v2_effects SET state = 'succeeded', settled_at = ? WHERE id = ?`);
    settleOld.run("2026-10-20T00:00:00.000Z", capture("a").id);
    const runtime = runtimeFor(outbox);
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(outbox.get(capture("a").id)).toBeNull();
    settleOld.run("2026-10-20T00:00:00.000Z", capture("b").id);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(outbox.get(capture("b").id)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outbox.get(capture("b").id)).toBeNull();
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires process-bound effects after restart instead of replaying them", async () => {
    const path = databaseFile();
    const first = openDatabase(path);
    const before = new OrchestrationEffectOutbox(first, "runtime-1");
    commitEffects(first, "runtime-1", "thread-1", [processBound("start-1", "provider.start")]);
    commitEffects(first, "runtime-1", "thread-2", [processBound("fork-1", "native.fork")]);
    commitEffects(first, "runtime-1", "thread-3", [capture("safe", "thread-3")]);
    const inFlightFork = before.claim("fork-1")!;
    first.close();

    const reopened = openDatabase(path);
    const outbox = new OrchestrationEffectOutbox(reopened, "runtime-2");
    expect(outbox.recover()).toEqual({ retired: 2, replayable: 1 });
    const runtime = runtimeFor(outbox);
    const executed: string[] = [];
    runtime.register(CAPTURE, async (payload) => { executed.push(payload.turnId); });
    runtime.start();
    await runtime.awaitSettled(capture("safe", "thread-3").id);
    await flush();
    expect(executed).toEqual(["turn-safe"]);
    expect(outbox.get("start-1")).toMatchObject({ state: "retired", failureCode: "runtime-lost", attempts: 0 });
    expect(outbox.get("fork-1")).toMatchObject({ state: "retired", failureCode: "runtime-lost", attempts: 1 });
    expect(outbox.settle(inFlightFork, { kind: "succeeded" })).toBe(false);
    expect(outbox.claim("start-1")).toBeNull();
  });

  it("never lets concurrent dispatchers double-claim and fences stale acknowledgements", async () => {
    const path = databaseFile();
    const left = openDatabase(path);
    const right = openDatabase(path);
    for (const db of [left, right]) db.pragma("busy_timeout = 1000");
    const leftOutbox = new OrchestrationEffectOutbox(left, "runtime-1");
    const rightOutbox = new OrchestrationEffectOutbox(right, "runtime-1");
    commitEffects(left, "runtime-1", "thread-1", [capture("one")]);
    commitEffects(left, "runtime-1", "thread-1", [capture("two")]);
    const executed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = async (payload: CheckpointCaptureRequest) => { executed.push(payload.turnId); await gate; };
    const leftRuntime = runtimeFor(leftOutbox);
    const rightRuntime = runtimeFor(rightOutbox);
    leftRuntime.register(CAPTURE, executor);
    rightRuntime.register(CAPTURE, executor);
    leftRuntime.start();
    rightRuntime.start();
    expect(leftRuntime.pump() + rightRuntime.pump()).toBe(1);
    await flush();
    expect(executed).toEqual(["turn-one"]);
    const claimed = leftOutbox.get(capture("one").id)!;
    expect(claimed.state).toBe("running");
    expect(rightOutbox.settle({ ...claimed, claimId: "forged-claim" }, { kind: "succeeded" })).toBe(false);
    expect(rightOutbox.settle({ ...claimed, attempts: claimed.attempts + 1 }, { kind: "succeeded" })).toBe(false);
    release();
    await leftRuntime.awaitSettled(capture("two").id);
    await flush();
    expect(executed).toEqual(["turn-one", "turn-two"]);
    expect(leftOutbox.get(capture("one").id)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(leftOutbox.get(capture("two").id)).toMatchObject({ state: "succeeded", attempts: 1 });
    expect(rightOutbox.settle(claimed, { kind: "failed", code: "late", retryable: true })).toBe(false);
  });

  it("stops cleanly, leaves interrupted replay-safe work for the next runtime, and stops itself when the database closes", async () => {
    const db = memoryDatabase();
    const outbox = new OrchestrationEffectOutbox(db, "runtime-1");
    const runtime = runtimeFor(outbox);
    runtime.register(CAPTURE, (_payload, { signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => { reject(new Error("aborted")); });
    }));
    commitEffects(db, "runtime-1", "thread-1", [capture("interrupted")]);
    runtime.start();
    await flush();
    const waiting = runtime.awaitSettled(capture("interrupted").id);
    await runtime.stop();
    await expect(waiting).rejects.toThrow("stopped");
    expect(runtime.running).toBe(false);
    expect(outbox.get(capture("interrupted").id)).toMatchObject({ state: "running", attempts: 1 });
    expect(runtime.pump()).toBe(0);

    const closing = memoryDatabase();
    const closingRuntime = runtimeFor(new OrchestrationEffectOutbox(closing, "runtime-1"));
    closingRuntime.start();
    closing.close();
    expect(closingRuntime.pump()).toBe(0);
    expect(closingRuntime.running).toBe(false);
  });
});

async function finishTurn(runtime: TurnControllerTestRuntime, content: string) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
  const runs = runtime.provider.runCount;
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  await vi.waitFor(() => { expect(runtime.provider.runCount).toBe(runs + 1); });
  runtime.provider.resolve({ status: "completed", text: `${content} done` });
  await flushTurnControllerTestPromises();
  return queued.turn;
}

function turnCapture(turn: { conversationId: string; id: string; runId: string }): string {
  return checkpointCaptureEffect({ conversationId: turn.conversationId, turnId: turn.id, runId: turn.runId }, 0).id;
}

describe("Orchestrator V2 checkpoint capture effect", () => {
  it("commits the capture with the terminal run status and finalizes the turn's artifacts once", async () => {
    let artifacts!: TurnGitArtifactManager;
    const runtime = await createTurnControllerTestRuntime({
      captureGitBefore: (input) => artifacts.captureBefore(input),
      captureGitArtifacts: (input) => artifacts.finalize(input),
    });
    try {
      artifacts = new TurnGitArtifactManager(runtime.store, runtime.directory);
      const completions = vi.spyOn(runtime.store, "completeTurnGitArtifact");
      const effects = runtimeFor(runtime.store.orchestration.effects);
      runtime.store.orchestration.attachEffectRuntime(effects);
      const invalidated: string[] = [];
      checkpointCaptureExecutor({ effects, store: runtime.store, artifacts,
        invalidate: (conversationId) => { invalidated.push(conversationId); } })();
      effects.start();
      const turn = await finishTurn(runtime, "Capture once");
      const captureId = turnCapture(turn);
      await effects.awaitSettled(captureId);
      await flush();
      const effect = runtime.store.orchestration.effects.get(captureId)!;
      expect(effect).toMatchObject({ state: "succeeded", attempts: 1, kind: CAPTURE });
      const terminal = runtime.store.orchestration.events.readEvents({ projectId: effect.projectId, threadId: runtime.conversationId })
        .find(({ sequence }) => sequence === effect.eventSequence);
      expect(terminal).toMatchObject({ type: "run.status-changed", payload: { runId: turn.runId, status: "completed" } });
      expect(completions.mock.calls.filter(([turnId]) => turnId === turn.id)).toHaveLength(1);
      expect(runtime.store.turnGitArtifact(turn.id)?.capturedAt).not.toBeNull();
      expect(invalidated).toEqual([runtime.conversationId]);
      runtime.store.orchestration.reconcile();
      effects.wake();
      await flush();
      expect(completions.mock.calls.filter(([turnId]) => turnId === turn.id)).toHaveLength(1);
    } finally { runtime.store.close(); }
  });

  it("runs a capture left pending at shutdown exactly once after restart", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const turn = await finishTurn(runtime, "Pending at shutdown");
    const captureId = turnCapture(turn);
    expect(runtime.store.orchestration.effects.get(captureId)).toMatchObject({ state: "pending", attempts: 0 });
    runtime.store.close();
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(reopened.orchestration.effects.get(captureId))
        .toMatchObject({ state: "pending", attempts: 0, runtimeId: reopened.orchestration.runtimeId });
      const effects = runtimeFor(reopened.orchestration.effects);
      reopened.orchestration.attachEffectRuntime(effects);
      const finalized: string[] = [];
      checkpointCaptureExecutor({ effects, store: reopened,
        artifacts: { finalize: async ({ turn: captured }) => { finalized.push(captured.id); } },
        invalidate: () => undefined })();
      effects.start();
      await effects.awaitSettled(captureId);
      effects.wake();
      await flush();
      expect(finalized).toEqual([turn.id]);
      expect(reopened.orchestration.effects.get(captureId)).toMatchObject({ state: "succeeded", attempts: 1 });
    } finally { reopened.close(); }
  });

  it("holds the next start until the previous turn's capture settles", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const effects = runtimeFor(runtime.store.orchestration.effects);
      runtime.store.orchestration.attachEffectRuntime(effects);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const finalized: string[] = [];
      checkpointCaptureExecutor({ effects, store: runtime.store,
        artifacts: { finalize: async ({ turn }) => { finalized.push(turn.id); await gate; } },
        invalidate: () => undefined })();
      effects.start();
      const first = await finishTurn(runtime, "First");
      await vi.waitFor(() => { expect(finalized).toEqual([first.id]); });
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Second" });
      expect(runtime.controller.start(next.turn.id)).toBe(true);
      await flush();
      expect(runtime.provider.runCount).toBe(1);
      expect(runtime.store.orchestration.startIntent(next.turn.runId)?.state).toBe("pending");
      release();
      await effects.awaitSettled(turnCapture(first));
      await vi.waitFor(() => { expect(runtime.provider.runCount).toBe(2); });
      expect(runtime.store.orchestration.startIntent(next.turn.runId)?.state).toBe("succeeded");
      runtime.provider.resolve({ status: "completed", text: "Second done" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(next.turn.id).status).toBe("completed");
    } finally { runtime.store.close(); }
  });
});
