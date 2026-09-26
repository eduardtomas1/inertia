import type { RefObject } from "react";
import type { ChatAttachment } from "@shared/contracts";
import type { MessageQueueCommandRunner } from "./types";

/** Holds the draft until local media persistence or runtime text acceptance succeeds. */
export async function queueComposerMessage(options: {
  canQueue: boolean;
  pending: RefObject<symbol | null>;
  conversationId: string;
  content: string;
  attachments: ChatAttachment[];
  afterTurnId: string | null;
  run?: MessageQueueCommandRunner;
  isCurrent: () => boolean;
  setSaving: (saving: boolean) => void;
  onError: (message: string) => void;
  onSaved: () => void;
}): Promise<void> {
  if (!options.canQueue || options.pending.current) return;
  const token = Symbol();
  options.pending.current = token;
  options.setSaving(true);
  try {
    if (options.run && options.attachments.length === 0) {
      const { stageRuntimeComposerPrompt, transferRuntimeComposerPrompt } = await import("./runtimeComposerQueue");
      if (!options.isCurrent()) return;
      const staged = stageRuntimeComposerPrompt(options.conversationId, options.content, options.afterTurnId);
      await transferRuntimeComposerPrompt(options.conversationId, staged, options.afterTurnId, options.run);
    } else {
      const { enqueueComposerPrompt } = await import("./ComposerQueuedActions");
      if (!options.isCurrent() || !enqueueComposerPrompt(options.conversationId, options.content, options.attachments)) return;
    }
    if (options.isCurrent()) options.onSaved();
  } catch (error) {
    if (options.isCurrent()) options.onError(error instanceof Error ? error.message : "The message could not be queued.");
  } finally {
    if (options.pending.current === token) {
      options.pending.current = null;
      options.setSaving(false);
    }
  }
}
