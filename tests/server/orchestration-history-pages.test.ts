import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeConversationHistory } from "../../src/renderer/src/utils/conversationHistory";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import type { ConversationDetail } from "../../src/shared/contracts";
import { CONVERSATION_HISTORY_PAGE_SIZE } from "../../src/shared/conversation-history";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  type TurnControllerTestRuntime } from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

async function finish(runtime: TurnControllerTestRuntime, label: string) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  runtime.provider.resolve({ text: `${label} answer` });
  await flushTurnControllerTestPromises();
  return queued.turn;
}

function page(runtime: TurnControllerTestRuntime, before?: ConversationDetail["history"]): ConversationDetail {
  const detail = runtime.store.conversationHistory(runtime.conversationId, before?.older ? { before: before.older } : {});
  if (!detail) throw new Error("History page is unavailable.");
  return detail;
}

function unmarkedRolledBackTurns(runtime: TurnControllerTestRuntime, detail: ConversationDetail): string[] {
  const marked = new Set(detail.rolledBackTurnIds ?? []);
  return detail.agentTurns.filter(({ id }) => runtime.store.orchestration.history.rolledBack(id) && !marked.has(id)).map(({ id }) => id);
}

describe("rolled-back markers across cached history pages", () => {
  it("drops stale cached pages when a rollback reaches into older history and keeps reloaded pages consistent", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turns = [];
      for (let index = 0; index < CONVERSATION_HISTORY_PAGE_SIZE + 6; index += 1) turns.push(await finish(runtime, `turn-${index}`));
      const latest = page(runtime);
      expect(latest.history?.older).not.toBeNull();
      const olderBeforeRollback = page(runtime, latest.history);
      let cache = mergeConversationHistory(latest, olderBeforeRollback, "older");
      expect(cache.agentTurns.map(({ id }) => id)).toEqual(expect.arrayContaining([turns[0]!.id, turns.at(-1)!.id]));
      expect(cache.rollbackRevision).toBe(0);

      const retained = turns[2]!;
      await expect(rollbackConversationHistory({ store: runtime.store, turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: { resolveModelRoute: runtime.provider.resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
          nativeConversation: vi.fn(async (request: NativeConversationRequest) => ({ operationId: request.operationId,
            identity: request.source.identity, status: "unsupported" as const, reason: "fixture" })) } },
      { conversationId: runtime.conversationId, turnId: retained.id, source: { actorId: "human", commandId: "page-rollback",
        command: { type: "conversation.rollback", requestId: "page-rollback", payload: { conversationId: runtime.conversationId, turnId: retained.id } } } },
      new AbortController().signal)).resolves.toMatchObject({ rolledBackTurns: turns.length - 3 });

      const refreshed = page(runtime);
      expect(refreshed.rollbackRevision).toBe(turns.length - 3);
      expect(unmarkedRolledBackTurns(runtime, mergeConversationHistory(cache, refreshed, "refresh"))).toEqual([]);
      cache = mergeConversationHistory(cache, refreshed, "refresh");
      expect(cache.agentTurns.map(({ id }) => id)).toEqual(refreshed.agentTurns.map(({ id }) => id));
      expect(mergeConversationHistory(cache, olderBeforeRollback, "older")).toBe(cache);

      const reloadedOlder = page(runtime, cache.history);
      cache = mergeConversationHistory(cache, reloadedOlder, "older");
      expect(cache.agentTurns.map(({ id }) => id)).toEqual(turns.map(({ id }) => id));
      expect(unmarkedRolledBackTurns(runtime, cache)).toEqual([]);
      expect(cache.rolledBackTurnIds).toHaveLength(turns.length - 3);
      expect(cache.rolledBackTurnIds).not.toContain(retained.id);
    } finally { runtime.store.close(); }
  });
});
