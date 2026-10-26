import {
  IDLE_CONVERSATION_COMPACTION,
  type ConversationCompactionState,
} from "../../shared/compact-on-return";
import type { ContextCompactionTrigger } from "../../shared/context-compaction";

export class ConversationCompactionStates {
  private readonly active = new Map<string, ConversationCompactionState>();
  private readonly listeners = new Set<(conversationId: string) => void>();

  state(conversationId: string): ConversationCompactionState {
    return this.active.get(conversationId) ?? { ...IDLE_CONVERSATION_COMPACTION };
  }

  isCompacting(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  begin(
    conversationId: string,
    trigger: ContextCompactionTrigger,
    startedAt = new Date().toISOString(),
  ): boolean {
    if (this.active.has(conversationId)) return false;
    this.active.set(conversationId, { state: "compacting", trigger, startedAt });
    return true;
  }

  end(conversationId: string): void {
    if (!this.active.delete(conversationId)) return;
    for (const listener of this.listeners) {
      try {
        listener(conversationId);
      } catch {
        continue;
      }
    }
  }

  onSettled(listener: (conversationId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
