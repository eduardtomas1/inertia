import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isItemCovered } from "../../src/server/orchestration-v2/backing-repository";
import { portableForkHistory } from "../../src/server/orchestration-v2/portable-fork-history";
import { coveredHistoryOccupancy } from "../../src/server/orchestration-v2/portable-history-occupancy";
import {
  hasCoverage,
  portableHistorySource,
  readPortableContinuationHistory,
} from "../../src/server/orchestration-v2/portable-history-source";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { prepareForkSession } from "../../src/server/runtime/fork-session-service";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { MAX_BACKING_COVERAGE_ITEMS, MAX_BACKING_UNCOVERED_ITEMS, type ProviderBacking } from "../../src/shared/orchestration-backings";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => {
  vi.restoreAllMocks();
  return cleanupTurnControllerTestDirectories();
});

function database(runtime: TurnControllerTestRuntime): Database.Database {
  return (runtime.store as unknown as { database: Database.Database }).database;
}

async function finishTurn(
  runtime: TurnControllerTestRuntime,
  label: string,
  sessionId = "codex-native",
  conversationId = runtime.conversationId,
) {
  const queued = runtime.controller.queue({ conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  for (const phase of ["started", "settled"] as const) {
    runtime.provider.emit({
      ...turnControllerTestIdentity(runtime),
      type: "native-boundary",
      nativeConversationId: sessionId,
      nativeSessionId: null,
      nativeTurnId: label,
      persistedHeadId: phase === "settled" ? label : null,
      phase,
    });
  }
  runtime.provider.resolve({ text: `${label} answer`, sessionId });
  await flushTurnControllerTestPromises();
  return queued;
}

describe("N18 backing coverage watermark", () => {
  it("evaluates isItemCovered with uncoveredItemIds precedence, coveredItemIds, watermark, and legacyCovered", () => {
    const base: Pick<ProviderBacking, "coveredItemIds" | "coveredThroughOrdinal" | "uncoveredItemIds" | "legacyCovered"> = {
      coveredItemIds: ["msg-explicit"],
      coveredThroughOrdinal: 3,
      uncoveredItemIds: ["msg-excepted", "msg-explicit"],
      legacyCovered: true,
    };
    expect(isItemCovered(base, "msg-excepted", 1)).toBe(false);
    expect(isItemCovered(base, "msg-excepted", null)).toBe(false);
    expect(isItemCovered(base, "msg-explicit", 5)).toBe(false);
    expect(isItemCovered({ ...base, uncoveredItemIds: ["msg-excepted"] }, "msg-explicit", 5)).toBe(true);
    expect(isItemCovered(base, "msg-turn-3", 3)).toBe(true);
    expect(isItemCovered(base, "msg-turn-4", 4)).toBe(false);
    expect(isItemCovered(base, "msg-legacy", null)).toBe(true);
    expect(isItemCovered({ ...base, legacyCovered: false }, "msg-legacy", null)).toBe(false);
    expect(isItemCovered({ coveredItemIds: [] }, "msg-any", 1)).toBe(false);

    expect(hasCoverage(null)).toBe(false);
    expect(hasCoverage({ coveredItemIds: [] })).toBe(false);
    expect(hasCoverage({ coveredItemIds: [], coveredThroughOrdinal: 0 })).toBe(false);
    expect(hasCoverage({ coveredItemIds: [], coveredThroughOrdinal: 1 })).toBe(true);
    expect(hasCoverage({ coveredItemIds: [], legacyCovered: true })).toBe(true);
    expect(hasCoverage({ coveredItemIds: [], inheritedCoverage: "complete" })).toBe(true);
    expect(hasCoverage({ coveredItemIds: [], inheritedCoverage: { forkId: "f", throughOrdinal: 0 } })).toBe(true);
  });

  it("advances coveredThroughOrdinal on settle, drops promoted IDs even past 2,048 items, and keeps coverageComplete true", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Long turn 1" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      const db = database(runtime);
      db.transaction(() => {
        for (let index = 0; index < MAX_BACKING_COVERAGE_ITEMS + 25; index += 1) {
          runtime.store.createMessage(runtime.conversationId, `Progress ${index}`, "assistant", [], first.turn.id);
        }
      })();
      runtime.provider.resolve({ text: "Turn 1 done", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();

      const lookup = {
        threadId: runtime.conversationId,
        providerId: "codex",
        workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity,
      };
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      expect(backing).toMatchObject({
        status: "ready",
        coverageComplete: true,
        coveredThroughOrdinal: 1,
        coveredItemIds: [],
      });
      expect(isItemCovered(backing, first.message.id, 1)).toBe(true);

      // Portable history source with watermark coverage excludes all turn 1 items and detects delta mode!
      const source = portableHistorySource(db, { threadId: runtime.conversationId, coverage: backing });
      expect(source.items).toEqual([]);
      expect(coveredHistoryOccupancy(db, runtime.conversationId, backing)).toBeGreaterThan(0);

      // Add a second turn and verify delta mode sees ONLY turn 2 when passed turn 1's watermark coverage!
      const second = await finishTurn(runtime, "second");
      const delta = readPortableContinuationHistory(db, {
        threadId: runtime.conversationId,
        coverage: backing,
        capacityBytes: 64_000,
        currentPromptBytes: 100,
        imageCount: 0,
      })!;
      expect(delta.selection.items.map(({ id }) => id)).toContain(second.message.id);
      expect(delta.selection.items.map(({ id }) => id)).not.toContain(first.message.id);
      expect(delta.blocks[0]?.label).toContain("Context added since this session last ran");

      // After turn 2 settles, watermark advances to 2 and coveredItemIds stays empty.
      const updated = runtime.store.orchestration.backings.find(lookup)!;
      expect(updated).toMatchObject({ coveredThroughOrdinal: 2, coveredItemIds: [], coverageComplete: true });
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.backings.find(lookup)).toEqual(updated);
    } finally {
      runtime.store.close();
    }
  });

  it("converts legacy list-only backings on next write and covers legacy + turnless messages with legacyCovered", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const db = database(runtime);
      const turnless = runtime.store.createMessage(runtime.conversationId, "Legacy turnless note", "user");
      const first = await finishTurn(runtime, "first");
      const lookup = {
        threadId: runtime.conversationId,
        providerId: "codex",
        workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity,
      };
      // Simulate an old pre-watermark backing event in the log + projection (list-only, no watermark fields).
      const current = runtime.store.orchestration.backings.find(lookup)!;
      const firstMsgs = (db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND turn_id = ?")
        .all(runtime.conversationId, first.turn.id) as { id: string }[]).map(({ id }) => id);
      const legacyBacking: ProviderBacking = {
        id: current.id, threadId: current.threadId, projectId: current.projectId, providerId: current.providerId,
        providerInstanceId: current.providerInstanceId, workspaceKey: current.workspaceKey,
        nativeSessionId: current.nativeSessionId, continuationIdentity: current.continuationIdentity,
        selection: current.selection, lastRunId: current.lastRunId, lastTurnId: current.lastTurnId,
        status: "ready", coveredItemIds: [turnless.id, ...firstMsgs], coverageComplete: true,
        createdAt: current.createdAt, updatedAt: current.updatedAt,
      };
      db.prepare(`UPDATE orchestration_v2_events SET payload_json = json_set(payload_json, '$.backing', json(?))
        WHERE thread_id = ? AND type = 'provider.backing-recorded' AND json_extract(payload_json, '$.backing.id') = ?`)
        .run(JSON.stringify(legacyBacking), runtime.conversationId, current.id);
      runtime.store.orchestration.events.rebuildProjections();
      const rebuiltLegacy = runtime.store.orchestration.backings.find(lookup)!;
      expect(rebuiltLegacy.coveredThroughOrdinal).toBeUndefined();
      expect(rebuiltLegacy.legacyCovered).toBeUndefined();

      // Next settle converts the list-only backing to watermark + legacyCovered: true and drops promoted IDs!
      await finishTurn(runtime, "second");
      const converted = runtime.store.orchestration.backings.find(lookup)!;
      expect(converted).toMatchObject({
        coveredThroughOrdinal: 2,
        legacyCovered: true,
        coveredItemIds: [],
        coverageComplete: true,
      });

      // Portable history source with legacyCovered: true excludes BOTH non-V2 turns and turnless messages!
      const source = portableHistorySource(db, { threadId: runtime.conversationId, coverage: converted });
      expect(source.items).toEqual([]);

      // Re-including turnless via uncoveredItemIds surfaces it again.
      const withException = portableHistorySource(db, {
        threadId: runtime.conversationId,
        coverage: { ...converted, uncoveredItemIds: [turnless.id] },
      });
      expect(withException.items.map(({ id }) => id)).toEqual([turnless.id]);
    } finally {
      runtime.store.close();
    }
  });

  it("emits inheritedCoverage: complete in nativeForkCoverage past 2,048 items and honors partial/complete in portableForkHistory", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first");
      const parent = runtime.store.conversation(runtime.conversationId);
      const forkInput = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: first.turn.id, activate: false };
      const child = runtime.store.orchestration.forks.create(forkInput, { actorId: "human", commandId: "fork-wm", command: { ...forkInput } });
      const db = database(runtime);

      // Prepare native fork cleanly.
      const deps = {
        store: runtime.store,
        turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: {
          resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id),
          nativeConversation: vi.fn(async (request: NativeConversationRequest) => ({
            operationId: request.operationId,
            identity: request.source.identity,
            targetConversationId: request.kind === "fork" ? request.targetConversationId : undefined,
            status: "completed" as const,
            effect: "native-fork" as const,
            backing: { nativeConversationId: "fork-native", headId: "first", persistedHeadId: "first" },
          })),
        },
      };
      await prepareForkSession(deps, child.id, new AbortController().signal);

      // Add synthetic fork-history items past 2,048 to prove nativeForkCoverage never caps!
      const sampleRow = db.prepare(`SELECT project_id, revision, payload_json FROM orchestration_v2_entities
        WHERE kind = 'fork-history' AND thread_id = ? ORDER BY revision DESC LIMIT 1`).get(child.id) as {
          project_id: string; revision: number; payload_json: string;
        };
      const basePart = JSON.parse(sampleRow.payload_json) as Record<string, unknown>;
      const startOrdinal = (basePart.ordinal as number) + 1;
      const insertPart = db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('fork-history', ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        for (let i = 0; i < MAX_BACKING_COVERAGE_ITEMS + 10; i += 1) {
          const ordinal = startOrdinal + i;
          const id = `fh-extra-${ordinal}`;
          insertPart.run(id, sampleRow.project_id, child.id, sampleRow.revision + i + 1, JSON.stringify({
            ...basePart, id, ordinal, part: 0, parts: 1, text: `Inherited item ${ordinal}`,
          }));
        }
      })();

      const childTurn = runtime.controller.queue({ conversationId: child.id, content: "Fork prompt" });
      runtime.controller.start(childTurn.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), conversationId: child.id, turnId: childTurn.turn.id, runId: childTurn.turn.runId, type: "session", sessionId: "fork-native" });
      const backing = runtime.store.orchestration.backings.find({
        threadId: child.id, providerId: "codex", workspaceKey: runtime.workspace,
        identity: childTurn.turn.continuationIdentity, nativeSessionId: "fork-native",
      })!;
      expect(backing).toMatchObject({
        inheritedCoverage: "complete",
        coverageComplete: true,
        coveredItemIds: [],
      });

      // portableForkHistory honors "complete" and partial { forkId, throughOrdinal }.
      expect(portableForkHistory(db, child.id, { inheritedCoverage: "complete" }).items).toEqual([]);
      const partial = portableForkHistory(db, child.id, { inheritedCoverage: { forkId: child.id, throughOrdinal: startOrdinal + 5 } });
      expect(partial.items.every((item) => item.id !== `fh-extra-${startOrdinal}`)).toBe(true);
      expect(partial.items.length).toBeGreaterThan(0);

      runtime.provider.resolve({ text: "Fork answer", sessionId: "fork-native" });
      await flushTurnControllerTestPromises();
    } finally {
      runtime.store.close();
    }
  });

  it("invalidates non-active backings past retainedOrdinal and rewinds watermark + uncredited handoff items on native rollback", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first", "codex-native");
      const second = await finishTurn(runtime, "second", "codex-native");
      const lookup = {
        threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity,
      };
      // Create a second non-active backing with coveredThroughOrdinal = 2 (on Claude) and a third with ordinal = 1.
      const db = database(runtime);
      const codexBacking = runtime.store.orchestration.backings.find(lookup)!;
      expect(codexBacking.coveredThroughOrdinal).toBe(2);

      // Insert a non-active backing on Claude whose coveredThroughOrdinal is 2 (should be invalidated when rolling back to 1)
      // and another whose coveredThroughOrdinal is 1 (should stay ready).
      const claudeSelection = modelSelectionSchema.parse(
        providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }),
      );
      const insertBacking = db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('provider-backing', ?, ?, ?, ?, ?)`);
      const staleOther: ProviderBacking = {
        ...codexBacking, id: "other-backing-past-retained", providerId: "claude", providerInstanceId: "claude-inst",
        nativeSessionId: "claude-s2", selection: claudeSelection, lastRunId: first.turn.runId, lastTurnId: first.turn.id,
        coveredItemIds: [], coveredThroughOrdinal: 2, coverageComplete: true,
      };
      const safeOther: ProviderBacking = {
        ...codexBacking, id: "other-backing-at-retained", providerId: "claude", providerInstanceId: "claude-inst-safe",
        nativeSessionId: "claude-s1", selection: claudeSelection, lastRunId: first.turn.runId, lastTurnId: first.turn.id,
        coveredItemIds: [], coveredThroughOrdinal: 1, coverageComplete: true,
      };
      insertBacking.run(staleOther.id, staleOther.projectId, staleOther.threadId, 1, JSON.stringify(staleOther));
      insertBacking.run(safeOther.id, safeOther.projectId, safeOther.threadId, 1, JSON.stringify(safeOther));

      // Also attach a delivered handoff on turn 2 that carried turn 1's user message into codex-native,
      // simulating an uncredited handoff item at or below retainedOrdinal = 1.
      const handoff = {
        id: "handoff-uncredited-test", threadId: runtime.conversationId, runId: second.turn.runId,
        attemptId: (runtime.store.orchestration.events.projection("run", second.turn.runId)!.value as { attemptId: string }).attemptId,
        targetBackingId: codexBacking.id, nativeSessionId: "codex-native",
        itemIds: [first.message.id], method: "inline", state: "delivered",
        createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z",
      };
      db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('context-handoff', ?, ?, ?, ?, ?)`)
        .run(handoff.id, codexBacking.projectId, codexBacking.threadId, 999, JSON.stringify(handoff));

      const deps = {
        store: runtime.store,
        turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: {
          resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id),
          nativeConversation: vi.fn(async (request: NativeConversationRequest) => ({
            operationId: request.operationId, identity: request.source.identity,
            status: "completed" as const, effect: "native-revert" as const,
            backing: { nativeConversationId: "codex-native", headId: "first", persistedHeadId: "first" },
          })),
        },
      };
      const cmdId = randomUUID();
      await expect(rollbackConversationHistory(deps, {
        conversationId: runtime.conversationId, turnId: first.turn.id,
        source: { actorId: "human", commandId: cmdId, command: { type: "conversation.rollback", requestId: cmdId, payload: { conversationId: runtime.conversationId, turnId: first.turn.id } } },
      }, new AbortController().signal)).resolves.toMatchObject({ transfer: "native", retainedTurnId: first.turn.id });

      expect(runtime.store.orchestration.backings.get(staleOther.id)?.status).toBe("retired");
      expect(runtime.store.orchestration.backings.get(safeOther.id)?.status).toBe("ready");
      const rewound = runtime.store.orchestration.backings.find(lookup)!;
      expect(rewound).toMatchObject({
        status: "ready",
        coveredThroughOrdinal: 1,
        coverageComplete: true,
      });
      expect(rewound.uncoveredItemIds).toContain(first.message.id);
      expect(isItemCovered(rewound, first.message.id, 1)).toBe(false);
    } finally {
      runtime.store.close();
    }
  });

  it("lowers coveredThroughOrdinal when uncredited handoff items on native rewind exceed 256", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first", "codex-native");
      const db = database(runtime);
      const extraIds: string[] = [];
      db.transaction(() => {
        for (let i = 0; i < MAX_BACKING_UNCOVERED_ITEMS + 5; i += 1) {
          extraIds.push(runtime.store.createMessage(runtime.conversationId, `Item ${i}`, "assistant", [], first.turn.id).id);
        }
      })();
      const second = await finishTurn(runtime, "second", "codex-native");
      const lookup = {
        threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity,
      };
      const codexBacking = runtime.store.orchestration.backings.find(lookup)!;
      const attemptId = (runtime.store.orchestration.events.projection("run", second.turn.runId)!.value as { attemptId: string }).attemptId;
      // Two delivered handoffs on turn 2 together name > 256 items from turn 1.
      const insertHandoff = db.prepare(`INSERT INTO orchestration_v2_entities (kind, id, project_id, thread_id, revision, payload_json)
        VALUES ('context-handoff', ?, ?, ?, ?, ?)`);
      insertHandoff.run("h-a", codexBacking.projectId, codexBacking.threadId, 998, JSON.stringify({
        id: "h-a", threadId: runtime.conversationId, runId: second.turn.runId, attemptId,
        targetBackingId: codexBacking.id, nativeSessionId: "codex-native",
        itemIds: extraIds.slice(0, 200), method: "inline", state: "delivered",
        createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z",
      }));
      insertHandoff.run("h-b", codexBacking.projectId, codexBacking.threadId, 999, JSON.stringify({
        id: "h-b", threadId: runtime.conversationId, runId: second.turn.runId, attemptId,
        targetBackingId: codexBacking.id, nativeSessionId: "codex-native",
        itemIds: extraIds.slice(200), method: "inline", state: "delivered",
        createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z",
      }));

      const deps = {
        store: runtime.store,
        turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: {
          resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id),
          nativeConversation: vi.fn(async (request: NativeConversationRequest) => ({
            operationId: request.operationId, identity: request.source.identity,
            status: "completed" as const, effect: "native-revert" as const,
            backing: { nativeConversationId: "codex-native", headId: "first", persistedHeadId: "first" },
          })),
        },
      };
      const cmdId = randomUUID();
      await rollbackConversationHistory(deps, {
        conversationId: runtime.conversationId, turnId: first.turn.id,
        source: { actorId: "human", commandId: cmdId, command: { type: "conversation.rollback", requestId: cmdId, payload: { conversationId: runtime.conversationId, turnId: first.turn.id } } },
      }, new AbortController().signal);

      const rewound = runtime.store.orchestration.backings.find(lookup)!;
      expect(rewound.coveredThroughOrdinal).toBe(0);
      expect(rewound.uncoveredItemIds).toBeUndefined();
      expect(rewound.coverageComplete).toBe(true);
    } finally {
      runtime.store.close();
    }
  });

  it("invalidates a brand-new backing when its run settles notDelivered without beforeDispatch (Audit 2 Bug #5)", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First prompt dropped" });
      runtime.controller.start(queued.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "brand-new-native" });
      const lookup = {
        threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: queued.turn.continuationIdentity, nativeSessionId: "brand-new-native",
      };
      expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("ready");

      // Settle as notDelivered (no turn acceptance / prompt dropped) with no prior backing to restore.
      runtime.provider.resolve({
        status: "failed",
        sessionId: "brand-new-native",
        error: "Refused before acceptance",
        failure: { reason: "codex-error", message: "Refused before acceptance", notDelivered: true },
      });
      await flushTurnControllerTestPromises();

      // The brand-new backing must be retired, never left live!
      expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("retired");
      expect(runtime.store.orchestration.backings.sessionRetired({
        threadId: runtime.conversationId, providerId: "codex",
        identity: queued.turn.continuationIdentity, nativeSessionId: "brand-new-native",
      })).toBe(true);
    } finally {
      runtime.store.close();
    }
  });

  it("rejects overlapping coveredItemIds and uncoveredItemIds in backing projector", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first");
      const lookup = {
        threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity,
      };
      const current = runtime.store.orchestration.backings.find(lookup)!;
      const run = runtime.store.orchestration.events.projection("run", first.turn.runId)!.value as { attemptId: string };
      const overlapEvent = {
        type: "provider.backing-recorded" as const,
        payload: {
          backing: { ...current, coveredItemIds: ["dup-item"], uncoveredItemIds: ["dup-item"] },
          runId: first.turn.runId,
          attemptId: run.attemptId,
        },
      };
      expect(() => runtime.store.orchestration.events.commit({
        actorId: "runtime", commandId: "overlap-test", projectId: current.projectId, threadId: current.threadId,
        command: overlapEvent, expectedRevision: runtime.store.orchestration.events.revision(current.threadId),
        events: [overlapEvent], result: null,
      })).toThrow(OrchestrationConflict);
    } finally {
      runtime.store.close();
    }
  });
});
