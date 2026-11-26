import type { z } from "zod";
import type { ChatAttachment } from "@shared/contracts";
import type { phase5QueueCommandSchemas } from "@shared/contracts/client-command/agent";
import type { ModelSelection } from "@shared/model-routing";
import {
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  type MessageQueueResult,
  type QueuedMessage,
} from "@shared/queued-messages";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";
import {
  announceRuntimeQueueChanged,
  RUNTIME_QUEUE_CHANGED,
} from "./runtimeQueueEvents";

export { RUNTIME_QUEUE_CHANGED };

type Phase5QueueCommand = Omit<
  z.infer<(typeof phase5QueueCommandSchemas)[number]>,
  "requestId"
>;

export type QueueCommand =
  | Extract<CommandWithoutId, { type: `message.queue.${string}` }>
  | Phase5QueueCommand;

export interface QueueCommandOptions {
  /** Only newly staged attachment IDs that require a main-process handoff token. */
  readonly handoffAttachmentIds?: readonly string[];
}

export type QueueCommandRunner = (
  command: QueueCommand,
  options?: QueueCommandOptions,
) => Promise<MessageQueueResult>;

export const MAX_PENDING_QUEUE_INTENTS = MAX_QUEUED_USER_AND_AGENT_ITEMS;

interface StoredQueueIntent {
  id: string;
  identity: string;
  content?: string;
  attachmentCount?: number;
  createdAt?: string;
}

export interface PendingQueueIntent {
  readonly id: string;
  readonly content: string;
  readonly attachmentCount: number;
  readonly createdAt: string;
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function intentKey(conversationId: string): string {
  return `inertia:queue-intent:${conversationId}`;
}

function pendingIntents(conversationId: string): StoredQueueIntent[] {
  try {
    const raw = window.localStorage.getItem(intentKey(conversationId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter((item): item is StoredQueueIntent => Boolean(
        item
        && typeof item === "object"
        && typeof (item as StoredQueueIntent).identity === "string"
        && typeof (item as StoredQueueIntent).id === "string"
        && UUID_V4_PATTERN.test((item as StoredQueueIntent).id),
      ))
      .slice(0, MAX_PENDING_QUEUE_INTENTS);
  } catch {
    return [];
  }
}

export function getPendingQueueIntents(conversationId: string): PendingQueueIntent[] {
  return pendingIntents(conversationId).map((item) => {
    let fallbackContent = "";
    let fallbackAttachments = 0;
    if (typeof item.content !== "string" || typeof item.attachmentCount !== "number") {
      try {
        const parsed = JSON.parse(item.identity) as unknown;
        if (Array.isArray(parsed)) {
          if (typeof parsed[0] === "string") fallbackContent = parsed[0];
          if (Array.isArray(parsed[1])) fallbackAttachments = parsed[1].length;
        }
      } catch {
        // Keep empty fallbacks.
      }
    }
    return {
      id: item.id,
      content: typeof item.content === "string" ? item.content : fallbackContent,
      attachmentCount: typeof item.attachmentCount === "number" ? item.attachmentCount : fallbackAttachments,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    };
  });
}

export function serializeQueueAttachment(attachment: ChatAttachment): ChatAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    mimeType: attachment.mimeType,
    size: attachment.size,
    ...(attachment.snapshot ? { snapshot: attachment.snapshot } : {}),
    ...(attachment.previewAnnotation ? { previewAnnotation: attachment.previewAnnotation } : {}),
  };
}

export function queueIntent(
  conversationId: string,
  content: string,
  attachments: readonly ChatAttachment[],
): string {
  const key = intentKey(conversationId);
  const identity = JSON.stringify([content, attachments.map(({ id }) => id)]);
  const pending = pendingIntents(conversationId);
  const saved = pending.find((entry) => entry.identity === identity);
  if (saved) return saved.id;
  if (pending.length >= MAX_PENDING_QUEUE_INTENTS) {
    throw new Error("Confirm the earlier queued drafts before queueing another message.");
  }
  const id = window.crypto.randomUUID();
  const next: StoredQueueIntent = {
    id,
    identity,
    content,
    attachmentCount: attachments.length,
    createdAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(key, JSON.stringify([...pending, next]));
  } catch {
    return id;
  }
  return id;
}

function forgetQueueIntent(conversationId: string, expectedId: string): void {
  try {
    const remaining = pendingIntents(conversationId).filter(({ id }) => id !== expectedId);
    if (remaining.length) window.localStorage.setItem(intentKey(conversationId), JSON.stringify(remaining));
    else window.localStorage.removeItem(intentKey(conversationId));
  } catch {
    return;
  }
}

export function finishQueueIntent(conversationId: string, expectedId: string, revision?: number): void {
  forgetQueueIntent(conversationId, expectedId);
  announceRuntimeQueueChanged(conversationId, revision);
}

export async function enqueueRuntimePrompt(
  run: QueueCommandRunner,
  conversationId: string,
  content: string,
  attachments: readonly ChatAttachment[],
  stopTurnId?: string,
): Promise<void> {
  const id = queueIntent(conversationId, content, attachments);
  const payload = {
    conversationId,
    id,
    content,
    attachments: attachments.map(serializeQueueAttachment),
  };
  let result: MessageQueueResult;
  try {
    result = await run(stopTurnId
      ? { type: "message.queue.stop-and-send", payload: { ...payload, turnId: stopTurnId } }
      : { type: "message.queue.enqueue", payload });
  } catch (error) {
    try {
      result = await run({ type: "message.queue.get", payload: { conversationId, id } });
    } catch {
      throw error;
    }
    if (!result.receipt) {
      const delivery = runtimeCommandDelivery(error);
      if (delivery === "rejected" || delivery === "not-sent") finishQueueIntent(conversationId, id);
      throw error;
    }
  }
  if (!result.receipt || result.receipt.id !== id || result.receipt.conversationId !== conversationId) {
    throw new Error("The queue did not confirm this draft. Try again to check its receipt.");
  }
  finishQueueIntent(conversationId, id, result.revision);
  if (result.receipt.state === "cancelled") {
    throw new Error("That queued message was removed. Queue the draft again to send it.");
  }
}

export async function editRuntimeQueuedMessage(
  run: QueueCommandRunner,
  input: {
    conversationId: string;
    id: string;
    expectedRevision: number;
    content: string;
    attachments?: readonly ChatAttachment[];
    modelSelection?: ModelSelection | null;
    stagedAttachmentIds?: readonly string[];
  },
): Promise<MessageQueueResult> {
  const result = await run(
    {
      type: "message.queue.edit",
      payload: {
        conversationId: input.conversationId,
        id: input.id,
        expectedRevision: input.expectedRevision,
        content: input.content,
        ...(input.attachments !== undefined
          ? { attachments: input.attachments.map(serializeQueueAttachment) }
          : {}),
        ...(input.modelSelection !== undefined
          ? { modelSelection: input.modelSelection }
          : {}),
      },
    },
    { handoffAttachmentIds: input.stagedAttachmentIds ?? [] },
  );
  announceRuntimeQueueChanged(input.conversationId, result.revision);
  return result;
}

export async function resumeRuntimeQueue(
  run: QueueCommandRunner,
  conversationId: string,
): Promise<MessageQueueResult> {
  const result = await run({
    type: "message.queue.resume",
    payload: { conversationId },
  });
  announceRuntimeQueueChanged(conversationId, result.revision);
  return result;
}

export interface QueuedMessageEditSessionView {
  readonly entry: QueuedMessage;
  readonly dirty: boolean;
  readonly isCleared: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly modelLabel: string | null;
  onSave(): Promise<void>;
  onDiscard(): Promise<void>;
  onCancel(): void;
}

export interface QueuedMessageEdit {
  readonly blockedReason: string | null;
  readonly editingId?: string | null;
  readonly session?: QueuedMessageEditSessionView | null;
  readonly notice?: string | null;
  onStartEdit?(entry: QueuedMessage, trigger?: HTMLButtonElement | null): void;
  onEntriesObserved?(entries: readonly QueuedMessage[]): void;
  /** Legacy pull-back callback retained for backwards compatibility with older callers. */
  onEdit?(entry: QueuedMessage): Promise<void>;
}
