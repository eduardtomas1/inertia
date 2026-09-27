import type { ChatAttachment } from "@shared/contracts";
import { enqueueRuntimePrompt, type QueueCommandRunner } from "./runtimeQueueClient";
import { enqueueComposerPrompt } from "./composerQueuedPrompts";

export async function queueComposerDraft(run: QueueCommandRunner | undefined, conversationId: string, content: string, attachments: readonly ChatAttachment[], isCurrent: () => boolean, onError: (message: string) => void): Promise<boolean> {
  try {
    if (run) { await enqueueRuntimePrompt(run, conversationId, content, attachments); return true; }
    return isCurrent() && enqueueComposerPrompt(conversationId, content, attachments);
  } catch (error) {
    onError(error instanceof Error ? error.message : "The message could not be queued.");
    return false;
  }
}
