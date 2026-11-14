import type { RuntimeStore } from "../database";
import type { BackendProfileController } from "../runtime/backends/backend-profile-controller";
import { isUntitledConversationTitle, quickConversationTitle } from "../runtime/conversation-title";
import type { TurnController } from "../runtime/turns/turn-controller";
import { isHeld, UPDATE_HOLD_MESSAGE } from "../runtime/update-hold";
import { isMessageOriginDeviceId } from "../../shared/contracts/chat-message-schema";
import type { Conversation, ProviderInfo } from "../../shared/contracts";

interface PrivateConnectPromptAuthority {
  acquire(conversationId: string): boolean;
  release(conversationId: string): void;
}

interface PrivateConnectIsolatedRuns {
  has(conversationId: string): boolean;
}

export interface PrivateConnectPromptAdmissionDependencies {
  store: Pick<RuntimeStore, "conversation" | "hasConversationMessages" | "updateConversation">;
  authority: PrivateConnectPromptAuthority;
  turns: Pick<
    TurnController,
    "failBeforeStart" | "isActive" | "queue" | "start"
  >;
  isolatedRuns: PrivateConnectIsolatedRuns;
  compacting?(conversationId: string): boolean;
  onQueued(conversationId: string): void;
}

export function queuePrivateConnectPrompt(
  dependencies: PrivateConnectPromptAdmissionDependencies,
  conversationId: string,
  content: string,
  deviceId: string,
): { turnId: string } {
  if (!isMessageOriginDeviceId(deviceId)) throw new Error("The remote prompt has no valid device origin.");
  if (isHeld()) throw new Error(UPDATE_HOLD_MESSAGE);
  let queued: ReturnType<TurnController["queue"]> | null = null;
  let reserved = false;
  try {
    if (!dependencies.authority.acquire(conversationId)) {
      throw new Error(dependencies.compacting?.(conversationId)
        ? "This chat is compacting its context. Send the prompt again when it finishes."
        : "End the resumed provider terminal before sending a remote prompt.");
    }
    reserved = true;
    if (
      dependencies.turns.isActive(conversationId)
      || dependencies.isolatedRuns.has(conversationId)
    ) {
      throw new Error("This conversation already has an active agent task.");
    }
    const deriveInitialTitle = isUntitledConversationTitle(
      dependencies.store.conversation(conversationId).title,
    ) && !dependencies.store.hasConversationMessages(conversationId);
    queued = dependencies.turns.queue({
      conversationId,
      content,
      privateConnectDeviceId: deviceId,
      attachments: [],
      activateConversation: false,
      skills: [],
      rendererOwnerId: null,
    });
    const title = deriveInitialTitle ? quickConversationTitle(content) : "";
    if (
      title
      && isUntitledConversationTitle(dependencies.store.conversation(conversationId).title)
    ) {
      dependencies.store.updateConversation(conversationId, { title });
    }
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

export interface PrivateConnectPromptReadinessDependencies {
  enableProviders: boolean;
  providerInfo(): readonly ProviderInfo[];
  backends: Pick<BackendProfileController, "readiness" | "validateSelection">;
}

export async function assertPrivateConnectPromptRunnable(
  dependencies: PrivateConnectPromptReadinessDependencies,
  conversation: Conversation,
): Promise<void> {
  if (!dependencies.enableProviders) {
    throw new Error("Provider execution is disabled.");
  }
  const selectedProvider = dependencies.providerInfo().find(
    ({ id }) => id === conversation.providerId,
  );
  dependencies.backends.validateSelection(conversation.modelSelection);
  const backendReadiness = await dependencies.backends.readiness(
    conversation.modelSelection,
    selectedProvider,
  );
  if (backendReadiness && !backendReadiness.ready) {
    throw new Error(
      backendReadiness.message ?? "The selected model backend is unavailable.",
    );
  }
  if (!backendReadiness && !selectedProvider?.canRun) {
    throw new Error(
      selectedProvider?.statusMessage
        ?? "This agent is not ready on the desktop.",
    );
  }
}
