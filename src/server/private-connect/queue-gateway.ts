import type { Conversation } from "../../shared/contracts";
import {
  supportsActiveParentFollowUp,
  supportsSteerAttachments,
} from "../../shared/follow-up-steer";
import type { QueueItemProjection } from "../../shared/orchestration-queue";
import type {
  PrivateConnectQueueHoldReason,
  PrivateConnectQueueItem,
  PrivateConnectQueueProjection,
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
} from "../../shared/private-connect/runtime-contract";
import {
  sanitizePrivateConnectContent,
  sanitizePrivateConnectLabel,
} from "../../shared/private-connect/sanitizer";
import type { RuntimeStore } from "../database";
import { OrchestrationConflict } from "../orchestration-v2/types";
import {
  normalizePrivateConnectText,
  privateConnectDeviceActorId,
  privateConnectPromptCommandId,
} from "./prompt-admission";

export type PrivateConnectQueueStore = Pick<
  RuntimeStore,
  "orchestration" | "latestAgentTurnForConversation" | "limitResets"
>;

export type PrivateConnectRuntimeQueueCommand = Extract<
  PrivateConnectRuntimeRequest,
  { type: "queue.send" | "queue.edit" | "queue.remove" | "queue.resume" }
>;

export interface PrivateConnectQueueCommandHandlers {
  send?(conversationId: string, itemId: string, deviceId: string, requestId: string): Promise<void> | void;
  remove?(conversationId: string, itemId: string, deviceId: string, requestId: string): Promise<void> | void;
  resume?(conversationId: string, deviceId: string, requestId: string): Promise<void> | void;
}

const MAX_PROJECTED_QUEUE_ITEMS = 30;
const MAX_QUEUE_ITEM_CONTENT_CHARS = 20_000;

export function isPrivateConnectRuntimeQueueCommand(
  type: PrivateConnectRuntimeRequest["type"],
): type is PrivateConnectRuntimeQueueCommand["type"] {
  return type === "queue.send"
    || type === "queue.edit"
    || type === "queue.remove"
    || type === "queue.resume";
}

export function isPrivateConnectRuntimeQueueRequest(
  request: PrivateConnectRuntimeRequest,
): request is PrivateConnectRuntimeQueueCommand {
  return isPrivateConnectRuntimeQueueCommand(request.type);
}

function itemAttribution(item: QueueItemProjection): PrivateConnectQueueItem["attribution"] {
  if (item.kind === "watcher-note") return "watcher";
  if (item.kind === "delegated-results") return "delegated";
  if (item.createdBy === "agent") return "agent";
  if (item.creationSource === "mobile" || item.deviceId !== undefined) return "device";
  return "user";
}

function itemModelLabel(item: QueueItemProjection): string | null {
  if (item.followsThreadSelection || !item.modelSelection) return null;
  const profile = item.modelSelection.backendProfileDisplayName;
  const model = item.modelSelection.alias || item.modelSelection.modelId;
  const raw = model ? `${profile} · ${model}` : profile;
  return sanitizePrivateConnectLabel(raw, 120);
}

function itemSendLabel(
  item: QueueItemProjection,
  isActive: boolean,
  activeHarnessId: string | null,
): PrivateConnectQueueItem["sendLabel"] {
  if (item.kind !== "message" || item.state === "dispatching") return "none";
  if (!isActive) return "send-now";
  if (item.steerFollowUpOfRunId !== undefined) return "none";
  if (
    supportsActiveParentFollowUp(activeHarnessId)
    && (item.attachmentIds.length === 0 || supportsSteerAttachments(activeHarnessId))
  ) {
    return "send-now";
  }
  return "stop-and-send";
}

function deriveHoldReason(
  store: PrivateConnectQueueStore,
  conversationId: string,
  held: boolean,
): PrivateConnectQueueHoldReason | null {
  if (!held) return null;
  const latest = store.latestAgentTurnForConversation(conversationId);
  if (!latest) return "stopped";
  if (latest.status === "cancelled") return "stopped";
  if (latest.status === "interrupted") return "restart";
  if (latest.status === "failed") {
    if (store.limitResets.usageLimited(latest.id)) return "usage-limit";
    return "failed";
  }
  return "stopped";
}

export function projectPrivateConnectQueue(
  store: PrivateConnectQueueStore,
  conversation: Conversation,
  options: { isActive: boolean; waitingForLocalAction: boolean },
): PrivateConnectQueueProjection {
  const queue = store.orchestration.queue;
  const revision = queue.revision(conversation.id);
  const activeItems = queue.listActive(conversation.id).slice(0, MAX_PROJECTED_QUEUE_ITEMS);
  const latestTurn = store.latestAgentTurnForConversation(conversation.id);
  const activeHarnessId = latestTurn?.harnessId ?? conversation.modelSelection.harnessId ?? null;
  const items: PrivateConnectQueueItem[] = activeItems.map((item) => {
    const contentRow = queue.getContent(conversation.id, item.id);
    const content = sanitizePrivateConnectContent(
      contentRow?.content ?? "",
      MAX_QUEUE_ITEM_CONTENT_CHARS,
    );
    const attachmentCount = Math.min(20, item.attachmentIds.length);
    const editable = item.kind === "message"
      && attachmentCount === 0
      && item.steerFollowUpOfRunId === undefined
      && item.state !== "dispatching";
    return {
      id: item.id,
      content,
      attachmentCount,
      state: item.state as PrivateConnectQueueItem["state"],
      queueHeld: item.queueHeld,
      editRevision: item.contentRef.editRevision,
      editable,
      sendLabel: itemSendLabel(item, options.isActive, activeHarnessId),
      attribution: itemAttribution(item),
      modelLabel: itemModelLabel(item),
      ...(item.steerWhenReadyRunId !== undefined ? { steerWaiting: true } : {}),
      error: item.state === "blocked" && item.detail
        ? sanitizePrivateConnectLabel(item.detail, 300)
        : null,
    };
  });
  const held = items.some((item) => item.queueHeld);
  const holdReason = deriveHoldReason(store, conversation.id, held);
  const canResume = held
    && !options.isActive
    && !options.waitingForLocalAction
    && items.some((item) => item.queueHeld && item.state !== "dispatching");
  return { revision, held, holdReason, canResume, items };
}

export function replayPrivateConnectPromptFromStore(
  store: PrivateConnectQueueStore,
  subject: PrivateConnectRuntimeAuthorization,
  request: Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
  normalizedContent: string,
): PrivateConnectRuntimeResponse | null {
  const identity = {
    actorId: privateConnectDeviceActorId(subject.deviceId),
    commandId: privateConnectPromptCommandId(request.deliveryId),
    projectId: store.orchestration.events.projection("thread", request.conversationId)?.projectId ?? "",
    threadId: request.conversationId,
  };
  const existingItem = store.orchestration.queue.getItem(request.deliveryId);
  if (!existingItem) return null;
  if (existingItem.threadId !== request.conversationId) {
    return {
      type: "response",
      requestId: request.requestId,
      ok: false,
      code: "invalid",
      message: "That delivery identifier was already used.",
    };
  }
  try {
    if (identity.projectId) {
      const receipt = store.orchestration.events.receipt(
        identity,
        {
          type: "message.queue.enqueue",
          conversationId: request.conversationId,
          id: request.deliveryId,
          content: normalizedContent,
          attachments: [],
        },
        "message.queue.enqueue",
      );
      if (!receipt) return null;
    }
    store.orchestration.queue.verifyEnqueueReplay(
      request.conversationId,
      request.deliveryId,
      normalizedContent,
      [],
    );
  } catch (error) {
    if (error instanceof OrchestrationConflict) {
      return {
        type: "response",
        requestId: request.requestId,
        ok: false,
        code: "invalid",
        message: "That delivery identifier was already used.",
      };
    }
    throw error;
  }
  return {
    type: "response",
    requestId: request.requestId,
    ok: true,
    result: {
      kind: "prompt.accepted",
      deliveryId: request.deliveryId,
      turnId: existingItem.delivery?.turnId ?? null,
      queuedMessageId: existingItem.id,
    },
  };
}

export async function handlePrivateConnectQueueCommand(
  store: PrivateConnectQueueStore,
  subject: PrivateConnectRuntimeAuthorization,
  conversation: Conversation,
  request: PrivateConnectRuntimeQueueCommand,
  handlers?: PrivateConnectQueueCommandHandlers,
  onMutated?: (conversationId: string) => void,
): Promise<PrivateConnectRuntimeResponse> {
  const queue = store.orchestration.queue;
  const actorId = privateConnectDeviceActorId(subject.deviceId);
  const fail = (
    code: Extract<PrivateConnectRuntimeResponse, { ok: false }>["code"],
    message: string,
  ): PrivateConnectRuntimeResponse => ({
    type: "response",
    requestId: request.requestId,
    ok: false,
    code,
    message,
  });
  const ok = (): PrivateConnectRuntimeResponse => {
    onMutated?.(conversation.id);
    return {
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "queue.updated",
        conversationId: conversation.id,
        revision: queue.revision(conversation.id),
      },
    };
  };

  if (request.type === "queue.edit") {
    const content = normalizePrivateConnectText(request.content);
    if (!content) return fail("invalid", "The edited message cannot be empty.");
    const item = queue.getItem(request.id);
    if (!item || item.threadId !== conversation.id) {
      return fail("not-found", "That queued message was not found.");
    }
    if (item.kind !== "message") {
      return fail("forbidden", "Automatic queue items cannot be edited.");
    }
    if (item.attachmentIds.length > 0) {
      return fail("forbidden", "Queued messages with attachments cannot be edited from a paired device.");
    }
    if (item.steerFollowUpOfRunId !== undefined) {
      return fail("forbidden", "Unread follow-ups cannot be edited.");
    }
    if (item.state !== "waiting" && item.state !== "blocked") {
      return fail("stale", "That queued message can no longer be edited.");
    }
    if (item.contentRef.editRevision !== request.expectedRevision) {
      return fail("stale", "That queued message changed. Refresh and try again.");
    }
    try {
      queue.edit({
        conversationId: conversation.id,
        itemId: request.id,
        expectedRevision: request.expectedRevision,
        content,
        source: {
          actorId,
          commandId: `private-connect-edit:${request.requestId}`,
          command: {
            type: "message.queue.edit",
            conversationId: conversation.id,
            id: request.id,
            expectedRevision: request.expectedRevision,
            content,
          },
        },
        commandType: "message.queue.edit",
      });
    } catch (error) {
      if (error instanceof OrchestrationConflict) {
        return fail("stale", "That queued message changed. Refresh and try again.");
      }
      throw error;
    }
    return ok();
  }

  if (request.type === "queue.remove") {
    const item = queue.getItem(request.id);
    if (!item || item.threadId !== conversation.id) {
      return fail("not-found", "That queued message was not found.");
    }
    if (item.state !== "waiting" && item.state !== "blocked") {
      return fail("stale", "That queued message has already been dispatched.");
    }
    if (handlers?.remove) {
      await handlers.remove(conversation.id, request.id, subject.deviceId, request.requestId);
    } else {
      queue.cancel({
        conversationId: conversation.id,
        itemId: request.id,
        reason: "user",
        source: {
          actorId,
          commandId: `private-connect-remove:${request.requestId}`,
          command: { type: "message.queue.remove", conversationId: conversation.id, id: request.id },
        },
        commandType: "message.queue.remove",
      });
    }
    return ok();
  }

  if (request.type === "queue.send") {
    const item = queue.getItem(request.id);
    if (!item || item.threadId !== conversation.id) {
      return fail("not-found", "That queued message was not found.");
    }
    if (item.kind !== "message") {
      return fail("forbidden", "Automatic queue items cannot be sent manually from a paired device.");
    }
    if (item.state !== "waiting" && item.state !== "blocked") {
      return fail("stale", "That queued message has already been dispatched.");
    }
    if (handlers?.send) {
      await handlers.send(conversation.id, request.id, subject.deviceId, request.requestId);
    } else {
      if (queue.listActive(conversation.id).some((entry) => entry.queueHeld)) {
        queue.release({
          conversationId: conversation.id,
          cause: "R3-resume",
          source: {
            actorId,
            commandId: `private-connect-send-release:${request.requestId}`,
            command: { type: "message.queue.send", conversationId: conversation.id, id: request.id },
          },
          commandType: "message.queue.send",
        });
      }
      queue.requestSend({
        conversationId: conversation.id,
        itemId: request.id,
        kind: "send-now",
        requestId: request.requestId,
        source: {
          actorId,
          commandId: `private-connect-send:${request.requestId}`,
          command: { type: "message.queue.send", conversationId: conversation.id, id: request.id },
        },
        commandType: "message.queue.send",
      });
    }
    return ok();
  }

  // queue.resume
  if (handlers?.resume) {
    await handlers.resume(conversation.id, subject.deviceId, request.requestId);
  } else {
    if (queue.listActive(conversation.id).some((entry) => entry.queueHeld)) {
      queue.release({
        conversationId: conversation.id,
        cause: "R3-resume",
        source: {
          actorId,
          commandId: `private-connect-resume-release:${request.requestId}`,
          command: { type: "message.queue.resume", conversationId: conversation.id },
        },
        commandType: "message.queue.resume",
      });
    }
    queue.requestSend({
      conversationId: conversation.id,
      itemId: null,
      kind: "resume",
      requestId: request.requestId,
      source: {
        actorId,
        commandId: `private-connect-resume:${request.requestId}`,
        command: { type: "message.queue.resume", conversationId: conversation.id },
      },
      commandType: "message.queue.resume",
    });
  }
  return ok();
}

export function trimPrivateConnectQueueToBudget(
  response: PrivateConnectRuntimeResponse,
  measureBytes: (value: unknown) => number,
  maxBytes: number,
): void {
  if (!response.ok || response.result.kind !== "conversation") return;
  const queue = response.result.detail.queue;
  if (!queue || measureBytes(response) <= maxBytes) return;
  for (let index = queue.items.length - 1; index >= 0 && measureBytes(response) > maxBytes; index -= 1) {
    const item = queue.items[index]!;
    if (item.content.length === 0) continue;
    let low = 0;
    let high = item.content.length;
    const original = item.content;
    item.content = "";
    if (measureBytes(response) > maxBytes) continue;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      item.content = original.slice(0, middle);
      if (measureBytes(response) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    item.content = original.slice(0, low);
  }
  while (queue.items.length > 0 && measureBytes(response) > maxBytes) {
    queue.items.pop();
  }
}
