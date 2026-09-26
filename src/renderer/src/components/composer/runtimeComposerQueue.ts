import type { MessageQueueResult } from "@shared/contracts";
import { resultEvent } from "../../lib/runtimeCommands";
import type { ComposerQueuedPrompt, MessageQueueCommandRunner } from "./types";
import {
  enqueueComposerPrompt,
  markComposerQueuedPromptRuntimeOwned,
  readComposerQueue,
  removeComposerQueuedPrompt,
} from "./composerQueuedPrompts";

const transfers = new Map<string, Promise<MessageQueueResult>>();

export function stageRuntimeComposerPrompt(
  conversationId: string,
  content: string,
  afterTurnId: string | null,
): ComposerQueuedPrompt {
  // A failed/unknown acknowledgement keeps its original id even after reload.
  // Retrying the same outbox entry therefore cannot create another turn.
  const existing = readComposerQueue(conversationId).find((prompt) =>
    prompt.runtimeQueue && prompt.content === content && !prompt.dispatchedAt);
  if (existing) return existing;
  if (!enqueueComposerPrompt(conversationId, content, [], { afterTurnId })) {
    throw new Error("The message could not be saved to the queue. Keep this draft and try again.");
  }
  const staged = readComposerQueue(conversationId).find((prompt) =>
    prompt.runtimeQueue && prompt.content === content && !prompt.dispatchedAt);
  if (!staged) throw new Error("The queued message could not be saved.");
  return staged;
}

export function transferRuntimeComposerPrompt(
  conversationId: string,
  prompt: ComposerQueuedPrompt,
  afterTurnId: string | null,
  run: MessageQueueCommandRunner,
): Promise<MessageQueueResult> {
  const key = `${conversationId}:${prompt.id}`;
  const inFlight = transfers.get(key);
  if (inFlight) return inFlight;
  const transfer = async (): Promise<MessageQueueResult> => {
    if (!markComposerQueuedPromptRuntimeOwned(conversationId, prompt.id, afterTurnId)) {
      throw new Error("The queued message could not be saved. Keep this draft and try again.");
    }
    const result = resultEvent(await run("message.queue", {
      type: "message.queue",
      payload: {
        action: "enqueue", conversationId, id: prompt.id, content: prompt.content,
        afterTurnId: prompt.runtimeQueue ? prompt.runtimeQueue.afterTurnId : afterTurnId,
      },
    })).result;
    if (result.kind !== "message.queue" || result.conversationId !== conversationId) {
      throw new Error("The local service did not confirm this queue.");
    }
    removeComposerQueuedPrompt(conversationId, prompt.id);
    return result;
  };
  const pending = transfer().finally(() => transfers.delete(key));
  transfers.set(key, pending);
  return pending;
}
