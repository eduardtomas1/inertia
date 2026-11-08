import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BACKING_COVERAGE_ITEMS } from "../../src/shared/orchestration-backings";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime } from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function finish(runtime: TurnControllerTestRuntime, label: string) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: label });
  runtime.controller.start(queued.turn.id);
  for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
    type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: null, nativeTurnId: label,
    persistedHeadId: phase === "settled" ? label : null, phase });
  runtime.provider.resolve({ text: `${label} answer`, sessionId: "source-native" });
  await flushTurnControllerTestPromises();
  return queued.turn;
}

describe("rollback across complete backing history", () => {
  it.each(["portable", "native"] as const)("settles every affected backing past the first page during %s rollback", async (transfer) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      expect(runtime.store.orchestration.nativeBoundaries.forRun(first.runId)).toMatchObject({ phase: "settled", nativeTurnId: "first" });
      const second = await finish(runtime, "second");
      const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: second.continuationIdentity };
      const source = runtime.store.orchestration.backings.find({ ...lookup, nativeSessionId: "source-native" })!;
      const ids: string[] = [];
      for (let index = 0; index < 260; index += 1) {
        const nativeSessionId = `fixture-history-${index}`;
        runtime.store.orchestration.backings.observeSession(second, nativeSessionId);
        ids.push(runtime.store.orchestration.backings.find({ ...lookup, nativeSessionId })!.id);
      }
      runtime.store.orchestration.backings.observeSession(first, "source-native");
      runtime.store.orchestration.backings.observeSession(second, "source-native");
      const commandId = randomUUID();
      const payload = { conversationId: runtime.conversationId, turnId: first.id };
      const commandSource = { actorId: "human", commandId,
        command: { type: "conversation.rollback", requestId: commandId, payload } };
      if (transfer === "portable") {
        const plan = runtime.store.orchestration.history.plan(runtime.conversationId, first.id)!;
        runtime.store.orchestration.history.applyPortable({ threadId: runtime.conversationId, projectId: source.projectId,
          source: commandSource }, randomUUID(), plan, "fixture");
      } else {
        expect(runtime.store.orchestration.backings.find(lookup)).toMatchObject({ id: source.id, status: "ready" });
        expect(runtime.store.orchestration.nativeBoundaries.forRun(first.runId)).toMatchObject({
          providerInstanceId: source.providerInstanceId, workspaceKey: runtime.workspace, nativeConversationId: source.nativeSessionId,
        });
        const nativeConversation = vi.fn(async (request: NativeConversationRequest) => ({
          operationId: request.operationId, identity: request.source.identity, status: "completed" as const,
          effect: "native-revert" as const, backing: { nativeConversationId: "source-native", headId: "first", persistedHeadId: "first" },
        }));
        await expect(rollbackConversationHistory({ store: runtime.store, turns: runtime.controller,
          providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
          providers: { resolveModelRoute: runtime.provider.resolveModelRoute,
            isRunning: (id) => runtime.provider.isRunning(id), nativeConversation } },
        { ...payload, source: commandSource }, new AbortController().signal)).resolves.toMatchObject({ transfer: "native", reason: null });
        expect(nativeConversation).toHaveBeenCalledOnce();
      }
      expect(ids.every((id) => runtime.store.orchestration.backings.get(id)?.status === "retired")).toBe(true);
      expect(runtime.store.orchestration.backings.get(source.id)?.status).toBe(transfer === "native" ? "ready" : "retired");
      expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(true);
      runtime.store.orchestration.events.rebuildProjections();
      expect(ids.every((id) => runtime.store.orchestration.backings.get(id)?.status === "retired")).toBe(true);
    } finally { runtime.store.close(); }
  });
});

describe("backing coverage cap", () => {
  it("stops reusing a backing past the coverage cap and restores the full history on a fresh session", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original Codex request" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      const database = (runtime.store as unknown as { database: Database.Database }).database;
      database.transaction(() => {
        for (let index = 0; index < MAX_BACKING_COVERAGE_ITEMS; index += 1) {
          runtime.store.createMessage(runtime.conversationId, `Progress note ${index}`, "assistant", [], first.turn.id);
        }
      })();
      runtime.provider.resolve({ text: "Original Codex answer", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity };
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      expect(backing).toMatchObject({ nativeSessionId: "codex-native", status: "ready", coverageComplete: false });
      expect(backing.coveredItemIds).toHaveLength(MAX_BACKING_COVERAGE_ITEMS);

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue" });
      expect(next.turn.providerSessionBefore).toBeNull();
      const handoff = runtime.store.orchestration.backings.handoff(next.turn.runId)!;
      expect(handoff).toMatchObject({ targetBackingId: null, state: "prepared" });
      expect(handoff.itemIds).toContain(first.message.id);
      runtime.controller.start(next.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("Original Codex request");
      expect(runtime.provider.input?.prompt).toContain("restored because this provider session does not have them");
      runtime.provider.resolve({ text: "Fresh answer", sessionId: "codex-fresh" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });
});
