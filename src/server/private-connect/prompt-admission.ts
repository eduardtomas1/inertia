import type { TurnController } from "../runtime/turns/turn-controller";

interface PrivateConnectPromptAuthority {
  acquire(conversationId: string): boolean;
  release(conversationId: string): void;
}

interface PrivateConnectIsolatedRuns {
  has(conversationId: string): boolean;
}

export interface PrivateConnectPromptAdmissionDependencies {
  authority: PrivateConnectPromptAuthority;
  turns: Pick<
    TurnController,
    "failBeforeStart" | "isActive" | "queue" | "start"
  >;
  isolatedRuns: PrivateConnectIsolatedRuns;
  onQueued(conversationId: string): void;
}

export function queuePrivateConnectPrompt(
  dependencies: PrivateConnectPromptAdmissionDependencies,
  conversationId: string,
  content: string,
): { turnId: string } {
  let queued: ReturnType<TurnController["queue"]> | null = null;
  let reserved = false;
  try {
    if (!dependencies.authority.acquire(conversationId)) {
      throw new Error(
        "End the resumed provider terminal before sending a remote prompt.",
      );
    }
    reserved = true;
    if (
      dependencies.turns.isActive(conversationId)
      || dependencies.isolatedRuns.has(conversationId)
    ) {
      throw new Error("This conversation already has an active agent task.");
    }
    queued = dependencies.turns.queue({
      conversationId,
      content,
      attachments: [],
      activateConversation: false,
      skills: [],
      rendererOwnerId: null,
    });
    dependencies.onQueued(conversationId);
    if (!dependencies.turns.start(queued.turn.id)) {
      throw new Error("The remote turn could not start.");
    }
    return { turnId: queued.turn.id };
  } catch (error) {
    if (queued) {
      dependencies.turns.failBeforeStart(
        conversationId,
        error instanceof Error
          ? error.message
          : "The remote turn could not start.",
      );
    }
    throw error;
  } finally {
    if (reserved) dependencies.authority.release(conversationId);
  }
}
