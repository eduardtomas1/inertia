import { useEffect, useRef } from "react";

import {
  registerComposerOwnership,
  type ComposerDetachmentPreparation,
} from "../../utils/composerOwnership";

export interface ComposerDetachmentState {
  attachmentCount: number;
  conversationContextPending: boolean;
  fileReferenceCount: number;
  mutationInFlight: boolean;
  pendingModelRoute: boolean;
  previewContextSelected: boolean;
  promptContextSelected: boolean;
}

interface ComposerDetachmentOwnershipOptions {
  conversationId: string;
  flushDraftPersistence: () => void;
  readDraft: () => string;
  readState: () => ComposerDetachmentState;
}

function prepareDetachment(
  state: ComposerDetachmentState,
  draft: string,
): ComposerDetachmentPreparation {
  if (state.mutationInFlight) {
    return {
      status: "blocked",
      blocker: "mutation-in-flight",
      reason: "Wait for the current composer action to finish before moving this chat to a window.",
      draft,
    };
  }
  if (state.pendingModelRoute) {
    return {
      status: "blocked",
      blocker: "pending-model-route",
      reason: "Finish or cancel the pending model change before moving this chat to a window.",
      draft,
    };
  }
  if (state.conversationContextPending) {
    return {
      status: "blocked",
      blocker: "conversation-context",
      reason: "Send or remove shared chat context before moving this chat to a window.",
      draft,
    };
  }
  if (state.attachmentCount > 0) {
    return {
      status: "blocked",
      blocker: "attachments",
      reason: "Send or remove attachments before moving this chat to a window.",
      draft,
    };
  }
  if (state.fileReferenceCount > 0) {
    return {
      status: "blocked",
      blocker: "file-references",
      reason: "Remove file references before moving this chat to a window.",
      draft,
    };
  }
  if (state.promptContextSelected) {
    return {
      status: "blocked",
      blocker: "prompt-context",
      reason: "Remove the selected diff or review context before moving this chat to a window.",
      draft,
    };
  }
  if (state.previewContextSelected) {
    return {
      status: "blocked",
      blocker: "preview-context",
      reason: "Remove the selected preview before moving this chat to a window.",
      draft,
    };
  }
  return { status: "ready", draft };
}

export function useComposerDetachmentOwnership({
  conversationId,
  flushDraftPersistence,
  readDraft,
  readState,
}: ComposerDetachmentOwnershipOptions): void {
  const prepareRef = useRef((): ComposerDetachmentPreparation => ({
    status: "ready",
    draft: "",
  }));

  prepareRef.current = () => {
    // The detached composer reads the same origin-scoped draft. Make the exact
    // current text durable before the main composer can be unmounted, then
    // return it for the privileged cross-session handoff.
    flushDraftPersistence();
    return prepareDetachment(readState(), readDraft());
  };

  useEffect(() => registerComposerOwnership(
    conversationId,
    () => prepareRef.current(),
  ), [conversationId]);
}
