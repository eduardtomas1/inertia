import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ORCHESTRATION_V2_PROJECTION_VERSION } from "../../src/server/orchestration-v2/projector";
import type { AgentTurn } from "../../src/shared/contracts";
import { orchestrationRunSchema, orchestrationThreadSchema } from "../../src/shared/orchestration-v2";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

function storeDatabase(store: RuntimeStore): Database.Database {
  return (store as unknown as { database: Database.Database }).database;
}

function ledger(store: RuntimeStore) {
  return (store as unknown as { turnLedgerRepository: {
    updateLifecycle(turnId: string, update: { status: "starting"; updatedAt: string }): AgentTurn;
  } }).turnLedgerRepository;
}

function entities(db: Database.Database) {
  return db.prepare(`SELECT kind, id, project_id, thread_id, revision, payload_json
    FROM orchestration_v2_entities ORDER BY kind, id`).all();
}

function events(db: Database.Database, threadId: string, type: string) {
  return (db.prepare(`SELECT command_id, payload_json FROM orchestration_v2_events
    WHERE thread_id = ? AND type = ? ORDER BY revision`).all(threadId, type) as { command_id: string; payload_json: string }[])
    .map((row) => ({ commandId: row.command_id, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

function run(store: RuntimeStore, runId: string) {
  return orchestrationRunSchema.parse(store.orchestration.events.projection("run", runId)?.value);
}

function boundary(nativeTurnId: string) {
  return { nativeConversationId: "native-thread", nativeSessionId: null, nativeTurnId,
    persistedHeadId: null, phase: "started" as const };
}

async function started(runtime: TurnControllerTestRuntime, content: string): Promise<AgentTurn> {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
  runtime.controller.start(queued.turn.id);
  await flushTurnControllerTestPromises();
  return queued.turn;
}

async function completed(runtime: TurnControllerTestRuntime, content: string): Promise<AgentTurn> {
  const turn = await started(runtime, content);
  runtime.provider.resolve({ text: `${content} answer` });
  await flushTurnControllerTestPromises();
  return turn;
}

function recoveredAttempt(runtime: TurnControllerTestRuntime, turn: AgentTurn) {
  const { orchestration } = runtime.store;
  const initial = orchestration.attempts(turn.runId).at(-1)!;
  if (initial.cleanup === "not-started") orchestration.cleanup({ turnId: turn.id, runId: turn.runId }, "pending");
  const replacement = orchestration.replaceAttempt({ runId: turn.runId, turnId: turn.id,
    expectedAttemptId: initial.id, reason: "provider_recovery", priorCleanup: "confirmed" });
  return { initial, replacement };
}

describe("Orchestrator V2 run and attempt ordinals", () => {
  it("numbers runs per thread and records the initial attempt", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await completed(runtime, "First");
      const second = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Second" }).turn;
      expect(run(runtime.store, first.runId).ordinal).toBe(1);
      expect(run(runtime.store, second.runId).ordinal).toBe(2);
      expect(orchestrationThreadSchema.parse(runtime.store.orchestration.events
        .projection("thread", runtime.conversationId)?.value).lastRunOrdinal).toBe(2);
      expect(runtime.store.orchestration.attempts(second.runId)).toMatchObject([
        { ordinal: 1, reason: "initial", status: "queued", cleanup: "not-started" }]);
      expect(runtime.store.orchestration.attempts(first.runId)).toMatchObject([
        { ordinal: 1, reason: "initial", status: "completed", cleanup: "confirmed" }]);
    } finally { runtime.store.close(); }
  });
});

describe("Orchestrator V2 attempt replacement", () => {
  it("marks the replaced attempt superseded with its reason and replays an identical replacement", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await started(runtime, "Recover the provider");
      const { orchestration } = runtime.store;
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "native-boundary", ...boundary("native-turn-1") });
      const [initial] = orchestration.attempts(turn.runId);
      expect(initial).toMatchObject({ ordinal: 1, reason: "initial", cleanup: "pending",
        nativeThreadId: "native-thread", nativeTurnId: "native-turn-1" });
      const request = { runId: turn.runId, turnId: turn.id, expectedAttemptId: initial!.id,
        reason: "provider_recovery" as const };
      expect(() => orchestration.replaceAttempt(request)).toThrow("scope-conflict");

      const replacement = orchestration.replaceAttempt({ ...request, priorCleanup: "confirmed" });
      const status = run(runtime.store, turn.runId).status;
      expect(run(runtime.store, turn.runId).attemptId).toBe(replacement.id);
      expect(orchestration.attempts(turn.runId)).toEqual([
        { ...initial, status: "superseded", supersededAt: expect.any(String), cleanup: "confirmed" },
        { id: replacement.id, runId: turn.runId, turnId: turn.id, threadId: runtime.conversationId,
          providerInstanceId: initial!.providerInstanceId, ordinal: 2, reason: "provider_recovery", status,
          nativeSessionId: null, nativeThreadId: null, nativeTurnId: null, interruptRequestedAt: null,
          cleanup: "pending", runtimeId: orchestration.runtimeId },
      ]);
      expect(orchestration.nativeBoundaries.forRun(turn.runId)).toBeNull();

      const revision = orchestration.events.revision(runtime.conversationId);
      expect(orchestration.replaceAttempt({ ...request, priorCleanup: "confirmed" })).toEqual(replacement);
      expect(orchestration.events.revision(runtime.conversationId)).toBe(revision);
      expect(() => orchestration.replaceAttempt({ ...request, reason: "retry" })).toThrow("revision-conflict");
      expect(() => orchestration.replaceAttempt(request)).toThrow("command-conflict");
      expect(events(storeDatabase(runtime.store), runtime.conversationId, "run.attempt-replaced")).toMatchObject([
        { payload: { attemptId: initial!.id, reason: "provider_recovery", priorCleanup: "confirmed" } }]);

      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "native-boundary", ...boundary("native-turn-2") });
      runtime.provider.resolve({ text: "Recovered answer" });
      await flushTurnControllerTestPromises();
      expect(orchestration.attempts(turn.runId)).toMatchObject([
        { id: initial!.id, status: "superseded", nativeTurnId: "native-turn-1" },
        { id: replacement.id, status: "completed", nativeThreadId: "native-thread", nativeTurnId: "native-turn-2" },
      ]);
    } finally { runtime.store.close(); }
  });

  it("records the implicit retry replacement after confirmed cleanup", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Retry" }).turn;
      const { orchestration } = runtime.store;
      const identity = { turnId: turn.id, runId: turn.runId };
      orchestration.cleanup(identity, "pending");
      orchestration.cleanup(identity, "confirmed");
      orchestration.cleanup(identity, "pending");
      orchestration.cleanup(identity, "pending");
      expect(orchestration.attempts(turn.runId)).toMatchObject([
        { ordinal: 1, reason: "initial", status: "superseded", cleanup: "confirmed" },
        { ordinal: 2, reason: "retry", status: "queued", cleanup: "pending" },
      ]);
      expect(events(storeDatabase(runtime.store), runtime.conversationId, "run.attempt-replaced")).toHaveLength(1);
    } finally { runtime.store.close(); }
  });
});

describe("Orchestrator V2 attempt fence", () => {
  it("writes nothing for late observations from a replaced attempt or a run that moved on", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Late events" }).turn;
      const { orchestration } = runtime.store;
      const { initial, replacement } = recoveredAttempt(runtime, turn);
      const stale = { reason: "attempt-superseded", runId: turn.runId,
        observedAttemptId: initial.id, currentAttemptId: replacement.id };
      const db = storeDatabase(runtime.store);
      const before = entities(db);
      const revision = orchestration.events.revision(runtime.conversationId);

      const writes: string[] = [];
      const startLifecycle = () => {
        writes.push("starting");
        return ledger(runtime.store).updateLifecycle(turn.id, { status: "starting", updatedAt: "2031-01-01T00:00:00.000Z" });
      };
      expect(orchestration.nativeBoundaries.observe(turn, boundary("late-turn"), { attemptId: initial.id })).toEqual(stale);
      expect(orchestration.acknowledge(turn.runId, { attemptId: initial.id })).toEqual(stale);
      expect(orchestration.lifecycleIfCurrent(turn.id, { attemptId: initial.id }, startLifecycle))
        .toEqual({ committed: false, stale });
      expect(orchestration.synchronize(turn, { attemptId: "unknown-attempt" })).toEqual({ ...stale,
        reason: "attempt-not-current", observedAttemptId: "unknown-attempt" });
      expect(writes).toEqual([]);
      expect(runtime.store.agentTurn(turn.id).status).toBe(turn.status);
      expect(orchestration.events.revision(runtime.conversationId)).toBe(revision);
      expect(entities(db)).toEqual(before);

      const current = orchestration.lifecycleIfCurrent(turn.id,
        { attemptId: replacement.id, expectedStatus: turn.status }, startLifecycle);
      expect(current).toMatchObject({ committed: true, result: { status: "starting" } });
      expect(writes).toEqual(["starting"]);
      expect(run(runtime.store, turn.runId)).toMatchObject({ status: "starting", attemptId: replacement.id });
      expect(orchestration.lifecycleIfCurrent(turn.id, { attemptId: replacement.id, expectedStatus: turn.status },
        startLifecycle)).toEqual({ committed: false, stale: { ...stale, reason: "run-status-changed",
        observedAttemptId: replacement.id } });
      expect(writes).toEqual(["starting"]);
      expect(orchestration.attempts(turn.runId)).toMatchObject([
        { id: initial.id, status: "superseded" }, { id: replacement.id, status: "starting" }]);
      expect(orchestration.nativeBoundaries.observe(turn, boundary("current-turn"), { attemptId: replacement.id })).toBeNull();
      expect(orchestration.attempts(turn.runId)[1]).toMatchObject({ nativeTurnId: "current-turn" });
    } finally { runtime.store.close(); }
  });
});

describe("Orchestrator V2 cleanup command identity", () => {
  it("records every cleanup transition, including a return to an earlier state", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Cleanup" }).turn;
      const { orchestration } = runtime.store;
      const identity = { turnId: turn.id, runId: turn.runId };
      orchestration.cleanup(identity, "pending");
      orchestration.cleanup(identity, "unconfirmed");
      orchestration.cleanup(identity, "pending");
      const db = storeDatabase(runtime.store);
      const changes = events(db, runtime.conversationId, "attempt.cleanup-changed");
      expect(changes.map(({ payload }) => payload.cleanup)).toEqual(["pending", "unconfirmed", "pending"]);
      expect(new Set(changes.map(({ commandId }) => commandId)).size).toBe(3);
      expect(orchestration.attempts(turn.runId)).toMatchObject([{ cleanup: "pending" }]);

      const release = { stopOutcome: "force-detached" as const, runtimeGenerationId: "generation-1",
        systemBootId: "boot-1", stopBudgetMs: 0, releasedAt: "2030-01-01T00:00:00.000Z" };
      expect(orchestration.releaseCleanup(identity, release)).toBe(true);
      orchestration.cleanup(identity, "pending");
      expect(orchestration.releaseCleanup(identity, release)).toBe(true);
      const releases = events(db, runtime.conversationId, "attempt.cleanup-released");
      expect(releases).toHaveLength(2);
      expect(releases[0]!.commandId).not.toBe(releases[1]!.commandId);
      expect(orchestration.attempts(turn.runId)).toMatchObject([{ cleanup: "unconfirmed-released" }]);
    } finally { runtime.store.close(); }
  });
});

describe("Orchestrator V2 attempt projection rebuild", () => {
  async function replacedRuns(runtime: TurnControllerTestRuntime) {
    const first = await completed(runtime, "First");
    const second = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Second" }).turn;
    const identity = { turnId: second.id, runId: second.runId };
    runtime.store.orchestration.cleanup(identity, "pending");
    runtime.store.orchestration.cleanup(identity, "confirmed");
    runtime.store.orchestration.cleanup(identity, "pending");
    recoveredAttempt(runtime, second);
    return { first, second };
  }

  function expectReplacedRuns(store: RuntimeStore, first: AgentTurn, second: AgentTurn) {
    expect(run(store, first.runId).ordinal).toBe(1);
    expect(run(store, second.runId).ordinal).toBe(2);
    expect(store.orchestration.attempts(second.runId).map(({ ordinal, reason, status, cleanup }) =>
      ({ ordinal, reason, status, cleanup }))).toEqual([
      { ordinal: 1, reason: "initial", status: "superseded", cleanup: "confirmed" },
      { ordinal: 2, reason: "retry", status: "superseded", cleanup: "confirmed" },
      { ordinal: 3, reason: "provider_recovery", status: "queued", cleanup: "pending" },
    ]);
  }

  it("reproduces ordinals, reasons and superseded marks when projections are rebuilt", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { first, second } = await replacedRuns(runtime);
      const db = storeDatabase(runtime.store);
      expectReplacedRuns(runtime.store, first, second);
      const before = entities(db);
      db.prepare("DELETE FROM orchestration_v2_entities WHERE kind IN ('run', 'attempt')").run();
      db.prepare("UPDATE orchestration_v2_projection_metadata SET last_sequence = last_sequence - 1").run();
      expect(runtime.store.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: true });
      expect(entities(db)).toEqual(before);
      expectReplacedRuns(runtime.store, first, second);
    } finally { runtime.store.close(); }
  });

  it("replays pre-change events and rebuilds an upgraded database once when it opens", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const { first, second } = await replacedRuns(runtime);
    const path = join(runtime.directory, "inertia.sqlite");
    const before = entities(storeDatabase(runtime.store));
    runtime.store.close();

    const upgraded = new Database(path);
    upgraded.exec(`
      UPDATE orchestration_v2_events SET payload_json = json_remove(payload_json, '$.reason')
        WHERE type = 'run.attempt-replaced' AND json_extract(payload_json, '$.reason') = 'retry';
      UPDATE orchestration_v2_entities SET payload_json = json_remove(payload_json,
        '$.ordinal', '$.reason', '$.supersededAt', '$.lastRunOrdinal') WHERE kind IN ('thread', 'run', 'attempt');
      UPDATE orchestration_v2_entities SET payload_json = json_set(payload_json, '$.status', 'queued')
        WHERE kind = 'attempt' AND json_extract(payload_json, '$.status') = 'superseded';
      UPDATE orchestration_v2_projection_metadata SET schema_version = 1;
    `);
    expect(upgraded.prepare(`SELECT COUNT(*) AS count FROM orchestration_v2_events
      WHERE type = 'run.attempt-replaced' AND json_extract(payload_json, '$.reason') IS NULL`).get()).toEqual({ count: 1 });
    expect(entities(upgraded)).not.toEqual(before);
    upgraded.close();

    const reopened = new RuntimeStore(path, runtime.workspace, { recoverInterruptedRuns: false });
    try {
      const db = storeDatabase(reopened);
      expect(entities(db)).toEqual(before);
      expect(db.prepare("SELECT schema_version FROM orchestration_v2_projection_metadata").get())
        .toEqual({ schema_version: ORCHESTRATION_V2_PROJECTION_VERSION });
      expectReplacedRuns(reopened, first, second);
      expect(reopened.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: false });
    } finally { reopened.close(); }
  });
});
