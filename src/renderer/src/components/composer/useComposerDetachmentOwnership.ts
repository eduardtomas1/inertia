import { useEffect, useRef } from "react";

import {
  registerComposerOwnership,
  type ComposerDetachmentPreparation,
} from "../../utils/composerOwnership";

export interface ComposerDetachmentState {
  attachmentCount: number;
  fileReferenceCount: number;
  mutationInFlight: boolean;
  pendingModelRoute: boolean;
  previewContextSelected: boolean;
  promptContextSelected: boolean;
}

interface ComposerDetachmentOwnershipOptions {
  conversationId: string;
  flushDraftPersistence: () => void;
  readState: () => ComposerDetachmentState;
}

function prepareDetachment(
  state: ComposerDetachmentState,
): ComposerDetachmentPreparation {
  if (state.mutationInFlight) {
    return {
      status: "blocked",
      blocker: "mutation-in-flight",
      reason: "Wait for the current composer action to finish before moving this chat to a window.",
    };
  }
  if (state.pendingModelRoute) {
    return {
      status: "blocked",
      blocker: "pending-model-route",
      reason: "Finish or cancel the pending model change before moving this chat to a window.",
    };
  }
  if (state.attachmentCount > 0) {
    return {
      status: "blocked",
      blocker: "attachments",
      reason: "Send or remove attachments before moving this chat to a window.",
    };
  }
  if (state.fileReferenceCount > 0) {
    return {
      status: "blocked",
      blocker: "file-references",
      reason: "Remove file references before moving this chat to a window.",
    };
  }
  if (state.promptContextSelected) {
    return {
      status: "blocked",
      blocker: "prompt-context",
      reason: "Remove the selected diff or review context before moving this chat to a window.",
    };
  }
  if (state.previewContextSelected) {
    return {
      status: "blocked",
      blocker: "preview-context",
      reason: "Remove the selected preview before moving this chat to a window.",
    };
  }
  return { status: "ready" };
}

export function useComposerDetachmentOwnership({
  conversationId,
  flushDraftPersistence,
  readState,
}: ComposerDetachmentOwnershipOptions): void {
  const prepareRef = useRef((): ComposerDetachmentPreparation => ({
    status: "ready",
  }));

  prepareRef.current = () => {
    // The detached composer reads the same origin-scoped draft. Make the exact
    // current text durable before the main composer can be unmounted.
    flushDraftPersistence();
    return prepareDetachment(readState());
  };

  useEffect(() => registerComposerOwnership(
    conversationId,
    () => prepareRef.current(),
  ), [conversationId]);
}
