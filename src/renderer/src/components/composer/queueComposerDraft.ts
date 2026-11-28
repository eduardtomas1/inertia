import type { ChatAttachment } from "@shared/contracts";
import { enqueueRuntimePrompt, type QueueCommandRunner } from "./runtimeQueueClient";

export const QUEUE_OFFLINE_ERROR =
  "The local service is offline. Reconnect to queue this message.";

export async function queueComposerDraft(
  run: QueueCommandRunner | undefined,
  conversationId: string,
  content: string,
  attachments: readonly ChatAttachment[],
  _isCurrent: () => boolean,
  onError: (message: string) => void,
  stopTurnId?: string,
): Promise<boolean> {
  if (!run) {
    onError(QUEUE_OFFLINE_ERROR);
    return false;
  }
  try {
    await enqueueRuntimePrompt(run, conversationId, content, attachments, stopTurnId);
    return true;
  } catch (error) {
    onError(error instanceof Error ? error.message : "The message could not be queued.");
    return false;
  }
}
