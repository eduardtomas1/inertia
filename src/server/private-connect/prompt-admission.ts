import { randomUUID } from "node:crypto";
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
  store: Pick<RuntimeStore, "conversation" | "hasConversationMessages" | "updateConversation">
    & Partial<Pick<RuntimeStore, "orchestration">>;
  authority: PrivateConnectPromptAuthority;
  turns: Pick<
    TurnController,
    "failBeforeStart" | "isActive" | "queue" | "start"
  >;
  isolatedRuns: PrivateConnectIsolatedRuns;
  compacting?(conversationId: string): boolean;
  onQueued(conversationId: string): void;
}

export interface PrivateConnectPromptAdmissionResult {
  turnId: string | null;
  queuedMessageId?: string;
}

export function normalizePrivateConnectText(content: string): string {
  return content.replace(/\r\n?/gu, "\n").trim();
}

export function privateConnectDeviceActorId(deviceId: string): string {
  return `device:${deviceId}`;
}

export function privateConnectPromptCommandId(deliveryId: string): string {
  return `private-connect:${deliveryId}`;
}

export function enqueueBusyPrivateConnectPrompt(
  store: Pick<RuntimeStore, "orchestration">,
  conversationId: string,
  content: string,
  deviceId: string,
  deliveryId: string = randomUUID(),
): { turnId: null; queuedMessageId: string } {
  if (!isMessageOriginDeviceId(deviceId)) throw new Error("The remote prompt has no valid device origin.");
  if (isHeld()) throw new Error(UPDATE_HOLD_MESSAGE);
  const normalized = normalizePrivateConnectText(content);
  if (!normalized) throw new Error("The remote prompt is empty.");
  const actorId = privateConnectDeviceActorId(deviceId);
  const queue = store.orchestration.queue;
  const active = queue.listActive(conversationId);
  const hasHeld = active.some((item) => item.queueHeld);
  if (hasHeld) {
    queue.release({
      conversationId,
      cause: "R1-user-send",
      source: {
        actorId,
        commandId: `${privateConnectPromptCommandId(deliveryId)}:release`,
        command: { type: "queue.release", conversationId, cause: "R1-user-send", deliveryId },
      },
      commandType: "queue.release",
    });
  }
  const result = queue.enqueue({
    conversationId,
    itemId: deliveryId,
    content: normalized,
    attachments: [],
    kind: "message",
    createdBy: "user",
    creationSource: "mobile",
    deviceId,
    queueHeld: false,
    skipHoldInheritance: true,
    origin: "command",
    source: {
      actorId,
      commandId: privateConnectPromptCommandId(deliveryId),
      command: {
        type: "message.queue.enqueue",
        conversationId,
        id: deliveryId,
        content: normalized,
        attachments: [],
      },
    },
    commandType: "message.queue.enqueue",
  });
  return { turnId: null, queuedMessageId: result.value.id };
}

export function queuePrivateConnectPrompt(
  dependencies: PrivateConnectPromptAdmissionDependencies,
  conversationId: string,
  content: string,
  deviceId: string,
  options?: { deliveryId?: string },
): PrivateConnectPromptAdmissionResult {
  if (!isMessageOriginDeviceId(deviceId)) throw new Error("The remote prompt has no valid device origin.");
  if (isHeld()) throw new Error(UPDATE_HOLD_MESSAGE);
  const normalized = normalizePrivateConnectText(content);
  if (!normalized) throw new Error("The remote prompt is empty.");
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
      if (!dependencies.store.orchestration?.queue) {
        throw new Error("This conversation already has an active agent task.");
      }
      const enqueued = enqueueBusyPrivateConnectPrompt(
        { orchestration: dependencies.store.orchestration },
        conversationId,
        normalized,
        deviceId,
        options?.deliveryId,
      );
      dependencies.onQueued(conversationId);
      return enqueued;
    }
    const queue = dependencies.store.orchestration?.queue;
    if (queue && queue.listActive(conversationId).some((item) => item.queueHeld)) {
      const releaseId = options?.deliveryId ?? randomUUID();
      queue.release({
        conversationId,
        cause: "R1-user-send",
        source: {
          actorId: privateConnectDeviceActorId(deviceId),
          commandId: `${privateConnectPromptCommandId(releaseId)}:release`,
          command: { type: "queue.release", conversationId, cause: "R1-user-send", deliveryId: releaseId },
        },
        commandType: "queue.release",
      });
    }
    const deriveInitialTitle = isUntitledConversationTitle(
      dependencies.store.conversation(conversationId).title,
    ) && !dependencies.store.hasConversationMessages(conversationId);
    queued = dependencies.turns.queue({
      conversationId,
      content: normalized,
      privateConnectDeviceId: deviceId,
      attachments: [],
      activateConversation: false,
      skills: [],
      rendererOwnerId: null,
    });
    const title = deriveInitialTitle ? quickConversationTitle(normalized) : "";
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
