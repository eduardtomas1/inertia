import type { QueuedMessage } from "@shared/queued-messages";
import { DOCUMENT_FOLLOW_UP_UNQUEUEABLE, DOCUMENT_FOLLOW_UP_UNSUPPORTED } from "./composerAttachmentActions";
import type { ComposerQueueHandoffOptions } from "./composerQueueTransfers";

export const QUEUE_EDIT_DRAFT_PRESENT = "Send or clear the current draft first";
export const QUEUE_EDIT_BUSY = "Wait for the current message to finish";

export function composerQueueHandoff(options: ComposerQueueHandoffOptions): {
  queueCurrentMessage(stopTurnId?: string): Promise<void>;
  restoreQueuedMessage(entry: QueuedMessage): Promise<void>;
  queueEditBlockedReason: string | null;
} {
  const { canQueue, documentBlocksFollowUp, editBlocked, onQueueCommand, refs, setAttachmentError } = options;
  const queueAcceptsDocuments = Boolean(onQueueCommand);
  const transfers = () => import("./composerQueueTransfers");
  const queueCurrentMessage = async (stopTurnId?: string): Promise<void> => {
    if (documentBlocksFollowUp && !queueAcceptsDocuments) {
      setAttachmentError(DOCUMENT_FOLLOW_UP_UNSUPPORTED);
      return;
    }
    if (documentBlocksFollowUp && !canQueue && !refs.queueingRef.current) {
      setAttachmentError(DOCUMENT_FOLLOW_UP_UNQUEUEABLE);
      return;
    }
    if (!canQueue || refs.queueingRef.current || options.isReferencing()) return;
    refs.queueingRef.current = true;
    const attachments = refs.attachmentsRef.current;
    const owned = refs.queueOwnedAttachmentIdsRef.current;
    for (const { id } of attachments) owned.add(id);
    try {
      await (await transfers()).queueComposerDraftTransfer(options, attachments, stopTurnId);
    } finally {
      for (const { id } of attachments) owned.delete(id);
      refs.queueingRef.current = false;
    }
  };
  const restoreQueuedMessage = async (entry: QueuedMessage): Promise<void> => {
    if (entry.conversationId !== options.conversationId) return;
    options.setQueueEditPending(true);
    await (await transfers()).restoreQueuedMessageToDraft(options, entry);
  };
  return {
    queueCurrentMessage,
    restoreQueuedMessage,
    queueEditBlockedReason: editBlocked.draft ? QUEUE_EDIT_DRAFT_PRESENT : editBlocked.busy ? QUEUE_EDIT_BUSY : null,
  };
}
