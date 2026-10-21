import type { AgentTurn, Conversation } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { ProviderHostToolBridge } from "../../provider/contracts";
import type { AgentContextWatcherPolicy } from "../agent-context-tool";
import type { HiddenProviderInstruction } from "../turns/request-context";
import { watcherInstruction } from "./watcher-instructions";
import { conversationOrNull } from "./watcher-link-coordinator";

export interface WatcherTurnSource {
  conversation: Conversation;
  turn: AgentTurn;
}

export interface WatcherTurnPolicy extends AgentContextWatcherPolicy {
  /** True for an attached (not detached) watcher conversation. */
  isWatcherConversation(conversationId: string): boolean;
  /**
   * The host tools of a watcher turn: only the chat context tool, or none
   * without a context bridge. Null for every other conversation.
   */
  hostToolsForTurn(source: WatcherTurnSource): ProviderHostToolBridge | null;
  /** Watchers never receive capability packs; null leaves other chats unchanged. */
  harnessInstructionsFor(input: { conversation: Conversation }): readonly HiddenProviderInstruction[] | null;
  watcherInstructionsFor(input: { conversation: Conversation; hostTools: boolean }): readonly HiddenProviderInstruction[];
  /** Forgets the per-check read counter of a settled turn. */
  forgetTurn(turnId: string): void;
}

const EMPTY_BRIDGE: ProviderHostToolBridge = Object.freeze({
  definitions: [],
  invoke: () => Promise.resolve({
    success: false,
    text: JSON.stringify({ error: "unknown_tool", message: "That Inertia host tool is not available." }),
  }),
});

/** Bounds the in-memory read counters if settlements are ever missed. */
const MAX_TRACKED_TURNS = 256;

/**
 * Watcher rules the turn layer and the context tool consult through injected
 * hooks. It is built before the watcher runtime so the TurnController and the
 * agent thread manager can receive it without importing watcher modules.
 */
export function createWatcherTurnPolicy(
  store: Pick<RuntimeStore, "watcherLinks" | "conversation">,
  contextBridge: (source: WatcherTurnSource) => ProviderHostToolBridge | undefined,
): WatcherTurnPolicy {
  const reads = new Map<string, number>();
  const isWatcherConversation = (conversationId: string): boolean => {
    const policy = store.watcherLinks.policyForConversation(conversationId);
    return policy !== null && policy.status !== "detached";
  };
  return {
    isWatcherConversation,
    watchedConversationFor(conversationId) {
      const link = store.watcherLinks.findByWatcher(conversationId);
      return link && link.status !== "detached" ? link.watchedConversationId : null;
    },
    consumeRead(turnId, budget) {
      const used = reads.get(turnId) ?? 0;
      if (!Number.isSafeInteger(budget) || used >= budget) return false;
      reads.delete(turnId);
      reads.set(turnId, used + 1);
      while (reads.size > MAX_TRACKED_TURNS) reads.delete(reads.keys().next().value!);
      return true;
    },
    hostToolsForTurn(source) {
      if (!isWatcherConversation(source.conversation.id)) return null;
      return contextBridge(source) ?? EMPTY_BRIDGE;
    },
    harnessInstructionsFor({ conversation }) {
      return isWatcherConversation(conversation.id) ? [] : null;
    },
    watcherInstructionsFor({ conversation, hostTools }) {
      const link = store.watcherLinks.findByWatcher(conversation.id);
      if (!link || link.status === "detached" || link.watchedConversationId === null) return [];
      const watched = conversationOrNull(store, link.watchedConversationId);
      if (!watched) return [];
      return [watcherInstruction(link, { title: watched.title, id: watched.id }, { contextAccess: hostTools })];
    },
    forgetTurn(turnId) {
      reads.delete(turnId);
    },
  };
}
