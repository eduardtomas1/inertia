import type { AgentTurn, Conversation } from "../../../shared/contracts";
import type { PrivateConnectWatcherAccess } from "../../../shared/private-connect/prompt-safety";
import { watcherReadOnlyEnforcement } from "../../../shared/watcher";
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
  isWatcherConversation(conversationId: string): boolean;
  privateConnectWatcher(conversation: Conversation): PrivateConnectWatcherAccess | null;
  hostToolsForTurn(source: WatcherTurnSource): ProviderHostToolBridge | null;
  harnessInstructionsFor(input: { conversation: Conversation }): readonly HiddenProviderInstruction[] | null;
  watcherInstructionsFor(input: { conversation: Conversation; hostTools: boolean }): readonly HiddenProviderInstruction[];
  forgetTurn(turnId: string): void;
}

const EMPTY_BRIDGE: ProviderHostToolBridge = Object.freeze({
  definitions: [],
  invoke: () => Promise.resolve({
    success: false,
    text: JSON.stringify({ error: "unknown_tool", message: "That Inertia host tool is not available." }),
  }),
});

const MAX_TRACKED_TURNS = 256;

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
    privateConnectWatcher(conversation) {
      const policy = store.watcherLinks.policyForConversation(conversation.id);
      if (!policy || policy.status === "detached") return null;
      return { readOnly: policy.readOnly, interactionMode: conversation.interactionMode, accessMode: conversation.accessMode };
    },
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
      return [watcherInstruction(link, { title: watched.title, id: watched.id }, {
        contextAccess: hostTools,
        enforcement: watcherReadOnlyEnforcement(conversation.modelSelection.harnessId),
      })];
    },
    forgetTurn(turnId) {
      reads.delete(turnId);
    },
  };
}
