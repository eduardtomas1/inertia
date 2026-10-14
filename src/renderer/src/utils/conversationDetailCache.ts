import type { ConversationDetail, ConversationShell } from "@shared/contracts";
import { isAgentTurnTerminalStatus } from "@shared/turn-lifecycle";

export const MAX_CACHED_CONVERSATION_DETAILS = 3;

export function conversationDetailVersion(shell: ConversationShell | null): string | null {
  if (!shell) return null;
  const turn = shell.latestTurn;
  if (turn && !isAgentTurnTerminalStatus(turn.status)) return null;
  return JSON.stringify([shell.updatedAt, shell.archivedAt, shell.settledAt,
    turn?.id ?? null, turn?.status ?? null, turn?.updatedAt ?? null, turn?.completedAt ?? null]);
}

export function createConversationDetailCache(limit = MAX_CACHED_CONVERSATION_DETAILS) {
  const entries = new Map<string, { version: string; detail: ConversationDetail }>();
  return {
    read(conversationId: string, version: string | null): ConversationDetail | null {
      const entry = entries.get(conversationId);
      if (!entry) return null;
      entries.delete(conversationId);
      if (version === null || entry.version !== version) return null;
      entries.set(conversationId, entry);
      return entry.detail;
    },
    remember(conversationId: string, version: string | null, detail: ConversationDetail): void {
      entries.delete(conversationId);
      if (version === null) return;
      entries.set(conversationId, { version, detail });
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    forget(conversationId: string): void {
      entries.delete(conversationId);
    },
    clear(): void {
      entries.clear();
    },
  };
}
