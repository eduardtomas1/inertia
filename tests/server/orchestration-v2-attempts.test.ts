import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ORCHESTRATION_V2_PROJECTION_VERSION } from "../../src/server/orchestration-v2/projector";
import type { AgentTurn } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { orchestrationRunSchema, orchestrationThreadSchema } from "../../src/shared/orchestration-v2";
import { resolveNativeModelRoute } from "./model-route-fixture";
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

      // The running harness was started under the replaced attempt, so its
      // observations write nothing; the controller's own settlement still does.
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "native-boundary", ...boundary("native-turn-2") });
      expect(orchestration.events.revision(runtime.conversationId)).toBe(revision);
      runtime.provider.resolve({ text: "Recovered answer" });
      await flushTurnControllerTestPromises();
      expect(orchestration.attempts(turn.runId)).toMatchObject([
        { id: initial!.id, status: "superseded", nativeTurnId: "native-turn-1" },
        { id: replacement.id, status: "completed", nativeThreadId: null, nativeTurnId: null },
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

describe("Orchestrator V2 rejected-resume fallback (G9)", () => {
  async function resumingChat() {
    const runtime = await createTurnControllerTestRuntime({}, {
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
      resolveModelRoute: resolveNativeModelRoute,
    });
    const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Keep the API." });
    runtime.controller.start(first.turn.id);
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "saved-session" });
    runtime.provider.resolve({ status: "completed", sessionId: "saved-session", text: "Understood." });
    await flushTurnControllerTestPromises();
    const turn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue." }).turn;
    runtime.controller.start(turn.id);
    expect(runtime.provider.input?.sessionId).toBe("saved-session");
    const rejectedRoute = runtime.provider.callbacks!.onEvent!;
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
    return { runtime, turn, rejectedRoute };
  }

  async function closeRuntime(runtime: TurnControllerTestRuntime) {
    await runtime.controller.dispose();
    runtime.store.close();
  }

  it("records the in-run restart as a provider_recovery replacement and commits the fresh session under it", async () => {
    const { runtime, turn } = await resumingChat();
    try {
      const { orchestration } = runtime.store;
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "native-boundary",
        nativeConversationId: "saved-session", nativeSessionId: null, nativeTurnId: null, persistedHeadId: null,
        phase: "started" });
      const [initial] = orchestration.attempts(turn.runId);
      expect(initial).toMatchObject({ ordinal: 1, cleanup: "pending", nativeSessionId: "saved-session",
        nativeThreadId: "saved-session" });

      expect(runtime.provider.freshSession()).not.toBeNull();
      const [superseded, replacement] = orchestration.attempts(turn.runId);
      expect(superseded).toMatchObject({ id: initial!.id, status: "superseded", supersededAt: expect.any(String),
        cleanup: "confirmed", nativeSessionId: "saved-session", nativeThreadId: "saved-session" });
      expect(orchestration.nativeBoundaries.forRun(turn.runId)).toBeNull();
      expect(replacement).toMatchObject({ ordinal: 2, reason: "provider_recovery", status: "running",
        cleanup: "pending", nativeSessionId: null, nativeThreadId: null, nativeTurnId: null });
      expect(run(runtime.store, turn.runId).attemptId).toBe(replacement!.id);
      expect(events(storeDatabase(runtime.store), runtime.conversationId, "run.attempt-replaced")).toMatchObject([
        { payload: { attemptId: initial!.id, reason: "provider_recovery", priorCleanup: "confirmed" } }]);
      expect(orchestration.backings.handoff(turn.runId)).toMatchObject({ attemptId: replacement!.id, state: "dispatching" });
      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ providerSessionBefore: null,
        continuationReasonCode: "stale-provider-session" });

      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "session", sessionId: "fresh-session" });
      runtime.provider.emit({ ...identity, type: "native-boundary", nativeConversationId: "fresh-session",
        nativeSessionId: null, nativeTurnId: "fresh-turn", persistedHeadId: null, phase: "started" });
      runtime.provider.emit({ ...identity, type: "text", text: "Continuing." });
      expect(orchestration.attempts(turn.runId)[1]).toMatchObject({ nativeSessionId: "fresh-session",
        nativeThreadId: "fresh-session", nativeTurnId: "fresh-turn" });
      expect(orchestration.nativeBoundaries.forRun(turn.runId)).toMatchObject({ attemptId: replacement!.id,
        nativeConversationId: "fresh-session" });
      expect(orchestration.backings.handoff(turn.runId)).toMatchObject({ attemptId: replacement!.id, state: "delivered" });
      runtime.provider.resolve({ status: "completed", sessionId: "fresh-session", text: "Continuing." });
      await flushTurnControllerTestPromises();
      expect(orchestration.attempts(turn.runId)).toMatchObject([
        { id: initial!.id, status: "superseded", cleanup: "confirmed" },
        { id: replacement!.id, status: "completed", cleanup: "confirmed" },
      ]);
      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ status: "completed", providerSessionAfter: "fresh-session" });
      expect(orchestration.hasPendingCleanup(runtime.conversationId)).toBe(false);
    } finally { await closeRuntime(runtime); }
  });

  it("writes nothing for a late observation from the rejected attempt", async () => {
    const { runtime, turn, rejectedRoute } = await resumingChat();
    try {
      const { orchestration } = runtime.store;
      const [initial] = orchestration.attempts(turn.runId);
      runtime.provider.freshSession();
      const replacement = orchestration.attempts(turn.runId)[1]!;
      const db = storeDatabase(runtime.store);
      const before = { entities: entities(db), turn: runtime.store.agentTurn(turn.id),
        revision: orchestration.events.revision(runtime.conversationId),
        messages: runtime.store.conversationDetail(runtime.conversationId)?.messages.length };
      const identity = turnControllerTestIdentity(runtime);
      const late = [
        { ...identity, type: "status", status: "retrying" },
        { ...identity, type: "text", text: "Late answer from the rejected session" },
        { ...identity, type: "session", sessionId: "saved-session" },
        { ...identity, type: "native-boundary", nativeConversationId: "saved-session", nativeSessionId: null,
          nativeTurnId: "late-turn", persistedHeadId: null, phase: "settled" },
        { ...identity, type: "status", status: "cancelling" },
      ] as const;
      for (const event of late) rejectedRoute(event);
      expect(runtime.controller.handleProviderEvent({ ...identity, type: "text", text: "Late" }, initial!.id)).toBe(false);
      expect(orchestration.observation(turn.runId, { attemptId: initial!.id })).toEqual({ reason: "attempt-superseded",
        runId: turn.runId, observedAttemptId: initial!.id, currentAttemptId: replacement.id });
      expect(orchestration.lifecycleIfCurrent(turn.id, { attemptId: initial!.id }, () => {
        throw new Error("A stale observation must not reach the transcript turn.");
      })).toMatchObject({ committed: false, stale: { reason: "attempt-superseded" } });
      expect(runtime.store.agentTurn(turn.id)).toEqual(before.turn);
      expect(orchestration.events.revision(runtime.conversationId)).toBe(before.revision);
      expect(entities(db)).toEqual(before.entities);
      expect(runtime.store.conversationDetail(runtime.conversationId)?.messages).toHaveLength(before.messages!);
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBeNull();

      runtime.provider.emit({ ...identity, type: "status", status: "retrying" });
      expect(runtime.store.agentTurn(turn.id).runState?.state).toBe("retrying");
    } finally { await closeRuntime(runtime); }
  });

  it("replays the replacement idempotently and refuses the whole restart for a stale expected attempt", async () => {
    const { runtime, turn } = await resumingChat();
    try {
      const { orchestration } = runtime.store;
      const [initial] = orchestration.attempts(turn.runId);
      const backing = orchestration.backings.find({ threadId: runtime.conversationId, providerId: "codex",
        workspaceKey: runtime.store.conversationPath(runtime.conversationId), identity: turn.continuationIdentity,
        nativeSessionId: "saved-session" })!;
      expect(backing.status).toBe("ready");
      const db = storeDatabase(runtime.store);
      const before = { entities: entities(db), revision: orchestration.events.revision(runtime.conversationId) };
      expect(() => orchestration.restartOnFreshSession({ turn: runtime.store.agentTurn(turn.id),
        expectedSessionId: "saved-session", expectedAttemptId: "another-attempt", prepared: undefined,
        priorCleanup: "confirmed" }, () => runtime.store.updateConversation(runtime.conversationId,
        { providerSessionId: null, continuationIdentity: null }))).toThrow("revision-conflict");
      expect(entities(db)).toEqual(before.entities);
      expect(orchestration.events.revision(runtime.conversationId)).toBe(before.revision);
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("saved-session");

      expect(runtime.provider.freshSession()).not.toBeNull();
      const replacement = orchestration.attempts(turn.runId)[1]!;
      const revision = orchestration.events.revision(runtime.conversationId);
      const request = { runId: turn.runId, turnId: turn.id, expectedAttemptId: initial!.id,
        reason: "provider_recovery" as const, priorCleanup: "confirmed" as const };
      expect(orchestration.replaceAttempt(request)).toEqual(replacement);
      expect(runtime.provider.freshSession()).toBeNull();
      expect(orchestration.events.revision(runtime.conversationId)).toBe(revision);
      expect(() => orchestration.replaceAttempt({ ...request, reason: "retry", priorCleanup: undefined }))
        .toThrow("revision-conflict");
      expect(orchestration.attempts(turn.runId)).toHaveLength(2);
      expect(orchestration.backings.get(backing.id)).toMatchObject({ status: "retired" });
    } finally { await closeRuntime(runtime); }
  });

  it("stops the replacement attempt after the fallback and declines the fallback after a Stop", async () => {
    const after = await resumingChat();
    try {
      const { orchestration } = after.runtime.store;
      after.runtime.provider.freshSession();
      const replacement = orchestration.attempts(after.turn.runId)[1]!;
      expect(after.runtime.controller.cancel(after.runtime.conversationId)).toBe(true);
      expect(orchestration.attempts(after.turn.runId)[1]).toMatchObject({ id: replacement.id,
        interruptRequestedAt: expect.any(String) });
      expect(orchestration.attempts(after.turn.runId)[0]).toMatchObject({ status: "superseded", interruptRequestedAt: null });
      after.rejectedRoute({ ...turnControllerTestIdentity(after.runtime), type: "status", status: "cancelled" });
      after.runtime.provider.resolve({ status: "cancelled" });
      await flushTurnControllerTestPromises();
      expect(after.runtime.store.agentTurn(after.turn.id).status).toBe("cancelled");
      expect(orchestration.attempts(after.turn.runId)).toMatchObject([
        { status: "superseded", cleanup: "confirmed" }, { id: replacement.id, status: "cancelled", cleanup: "confirmed" }]);
      expect(orchestration.awaitsCleanupProof(after.runtime.conversationId)).toBe(false);
    } finally { await closeRuntime(after.runtime); }

    const before = await resumingChat();
    try {
      const { orchestration } = before.runtime.store;
      expect(before.runtime.controller.cancel(before.runtime.conversationId)).toBe(true);
      expect(before.runtime.provider.freshSession()).toBeNull();
      expect(orchestration.attempts(before.turn.runId)).toMatchObject([{ ordinal: 1, reason: "initial" }]);
      before.runtime.provider.resolve({ status: "cancelled" });
      await flushTurnControllerTestPromises();
      expect(orchestration.attempts(before.turn.runId)).toMatchObject([{ status: "cancelled", cleanup: "confirmed" }]);
      expect(before.runtime.store.conversation(before.runtime.conversationId).providerSessionId).toBe("saved-session");
    } finally { await closeRuntime(before.runtime); }
  });

  it("declines the fallback once a Stop has recorded its interrupt, so the interrupt settles on its own attempt", async () => {
    const { runtime, turn } = await resumingChat();
    try {
      const { orchestration } = runtime.store;
      const [initial] = orchestration.attempts(turn.runId);
      // Stop commits its interrupt in the lane and cancels only after earlier steers settle.
      const start = await orchestration.authority.begin({
        source: { actorId: "human", commandId: "stop-before-cancel", command: { type: "agent.stop" } },
        threadId: runtime.conversationId, projectId: runtime.store.conversation(runtime.conversationId).projectId,
        commandType: "agent.stop", rejection: null,
      }, (ticket) => orchestration.runControl.recordInterrupt(ticket, orchestration.runControl.target(turn.runId)!, null, "user"));
      if (start.kind !== "lead") throw new Error("expected the Stop to lead");
      start.ticket.finish(null);
      const effectId = start.intake;

      expect(runtime.provider.freshSession()).toBeNull();
      expect(orchestration.attempts(turn.runId)).toEqual([expect.objectContaining({ id: initial!.id, status: "running" })]);
      const db = storeDatabase(runtime.store);
      const before = { entities: entities(db), revision: orchestration.events.revision(runtime.conversationId) };
      expect(() => orchestration.restartOnFreshSession({ turn: runtime.store.agentTurn(turn.id),
        expectedSessionId: "saved-session", expectedAttemptId: initial!.id, prepared: undefined,
        priorCleanup: "confirmed" }, () => runtime.store.updateConversation(runtime.conversationId,
        { providerSessionId: null, continuationIdentity: null }))).toThrow("revision-conflict");
      expect(entities(db)).toEqual(before.entities);
      expect(orchestration.events.revision(runtime.conversationId)).toBe(before.revision);
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("saved-session");
      expect(orchestration.attempts(turn.runId)).toHaveLength(1);

      runtime.controller.cancel(runtime.conversationId);
      runtime.provider.resolve({ status: "cancelled" });
      await flushTurnControllerTestPromises();
      await runtime.controller.drainSettlementTasks();
      expect(runtime.store.agentTurn(turn.id).status).toBe("cancelled");
      expect(orchestration.runControl.attemptInterrupt(initial!.id)).toMatchObject({ effectId, outcome: "settled" });
      expect(orchestration.effects.get(effectId)).toMatchObject({ state: "succeeded" });
    } finally { await closeRuntime(runtime); }
  });

  it("still rebuilds a log written before the write-time refusal, with a recovery replacement after an interrupt", async () => {
    const { runtime, turn } = await resumingChat();
    try {
      const { orchestration } = runtime.store;
      const [initial] = orchestration.attempts(turn.runId);
      const start = await orchestration.authority.begin({
        source: { actorId: "human", commandId: "stop-before-recovery", command: { type: "agent.stop" } },
        threadId: runtime.conversationId, projectId: runtime.store.conversation(runtime.conversationId).projectId,
        commandType: "agent.stop", rejection: null,
      }, (ticket) => orchestration.runControl.recordInterrupt(ticket, orchestration.runControl.target(turn.runId)!, null, "user"));
      if (start.kind !== "lead") throw new Error("expected the Stop to lead");
      start.ticket.finish(null);
      // The sequence the race used to commit: the projector accepts it, as it always did.
      const replacement = orchestration.replaceAttempt({ runId: turn.runId, turnId: turn.id, expectedAttemptId: initial!.id,
        reason: "provider_recovery", priorCleanup: "confirmed" });
      const db = storeDatabase(runtime.store);
      const types = (db.prepare(`SELECT type FROM orchestration_v2_events WHERE thread_id = ? ORDER BY sequence`)
        .all(runtime.conversationId) as Array<{ type: string }>).map(({ type }) => type);
      expect(types.indexOf("run.attempt-replaced")).toBeGreaterThan(types.indexOf("attempt.interrupt-requested"));
      const before = entities(db);
      orchestration.delegation.rebuildProjections();
      expect(entities(db)).toEqual(before);
      expect(orchestration.events.verify({ readable: true })).toMatchObject({ valid: true });
      expect(orchestration.attempts(turn.runId)).toMatchObject([
        { id: initial!.id, status: "superseded", interruptRequestedAt: expect.any(String) },
        { id: replacement.id, interruptRequestedAt: null },
      ]);
    } finally { await closeRuntime(runtime); }
  });

  it("reproduces the replaced attempts when projections are rebuilt or the store reopens", async () => {
    const { runtime, turn } = await resumingChat();
    runtime.provider.freshSession();
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "fresh-session" });
    runtime.provider.resolve({ status: "completed", sessionId: "fresh-session", text: "Done." });
    await flushTurnControllerTestPromises();
    await runtime.controller.dispose();
    const db = storeDatabase(runtime.store);
    const before = entities(db);
    db.prepare("DELETE FROM orchestration_v2_entities WHERE kind IN ('run', 'attempt', 'context-handoff', 'provider-backing')").run();
    db.prepare("UPDATE orchestration_v2_projection_metadata SET last_sequence = last_sequence - 1").run();
    expect(runtime.store.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: true });
    expect(entities(db)).toEqual(before);
    runtime.store.close();

    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace,
      { recoverInterruptedRuns: false });
    try {
      expect(entities(storeDatabase(reopened))).toEqual(before);
      expect(reopened.orchestration.attempts(turn.runId).map(({ ordinal, reason, status, cleanup }) =>
        ({ ordinal, reason, status, cleanup }))).toEqual([
        { ordinal: 1, reason: "initial", status: "superseded", cleanup: "confirmed" },
        { ordinal: 2, reason: "provider_recovery", status: "completed", cleanup: "confirmed" },
      ]);
    } finally { reopened.close(); }
  });
});
