import type { ChatAttachment } from "@shared/contracts";
import type { MessageQueueResult } from "@shared/queued-messages";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";

export type QueueCommand = Extract<CommandWithoutId, { type: `message.queue.${string}` }>;
export type QueueCommandRunner = (command: QueueCommand) => Promise<MessageQueueResult>;
export const RUNTIME_QUEUE_CHANGED = "inertia:runtime-queue-changed";

function pendingIntents(conversationId: string): { id: string; identity: string }[] {
  const raw = window.localStorage.getItem(`inertia:queue-intent:${conversationId}`);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.filter((item): item is { id: string; identity: string } => item && typeof item === "object"
      && typeof item.identity === "string" && typeof item.id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.id)).slice(0, 3);
  } catch { return []; }
}

/** The stable intent survives a lost acknowledgement or renderer restart. */
export function queueIntent(conversationId: string, content: string, attachments: readonly ChatAttachment[]): string {
  const key = `inertia:queue-intent:${conversationId}`;
  const identity = JSON.stringify([content, attachments.map(({ id }) => id)]);
  const pending = pendingIntents(conversationId);
  const saved = pending.find((entry) => entry.identity === identity);
  if (saved) return saved.id;
  if (pending.length >= 3) throw new Error("Confirm the earlier queued drafts before queueing another message.");
  const id = window.crypto.randomUUID();
  window.localStorage.setItem(key, JSON.stringify([...pending, { id, identity }]));
  return id;
}
export function finishQueueIntent(conversationId: string, expectedId: string): void {
  try {
    const remaining = pendingIntents(conversationId).filter(({ id }) => id !== expectedId);
    if (remaining.length) window.localStorage.setItem(`inertia:queue-intent:${conversationId}`, JSON.stringify(remaining));
    else window.localStorage.removeItem(`inertia:queue-intent:${conversationId}`);
  } catch { /* The durable receipt remains safe to replay. */ }
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: conversationId }));
}

export async function enqueueRuntimePrompt(run: QueueCommandRunner, conversationId: string, content: string, attachments: readonly ChatAttachment[]): Promise<void> {
  const id = queueIntent(conversationId, content, attachments);
  let result: MessageQueueResult;
  try {
    result = await run({ type: "message.queue.enqueue", payload: {
      conversationId, id, content,
      attachments: attachments.map(({ id: attachmentId, name, path, mimeType, size }) => ({ id: attachmentId, name, path, mimeType, size })),
    } });
  } catch (error) {
    // An error can follow durable admission. Read the receipt before changing
    // identity; a missing receipt alone cannot settle unknown delivery.
    try { result = await run({ type: "message.queue.get", payload: { conversationId, id } }); }
    catch { throw error; }
    if (!result.receipt) {
      const delivery = runtimeCommandDelivery(error);
      if (delivery === "rejected" || delivery === "not-sent") finishQueueIntent(conversationId, id);
      throw error;
    }
  }
  if (!result.receipt || result.receipt.id !== id || result.receipt.conversationId !== conversationId) throw new Error("The queue did not confirm this draft. Try again to check its receipt.");
  finishQueueIntent(conversationId, id);
  if (result.receipt.state === "cancelled") throw new Error("That queued message was removed. Queue the draft again to send it.");
}
