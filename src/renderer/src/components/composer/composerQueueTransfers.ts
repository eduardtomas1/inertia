import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";

import type { ChatAttachment } from "@shared/contracts";
import type { QueuedMessage } from "@shared/queued-messages";
import { mergeComposerAttachments } from "../../utils/composerAttachments";
import { keepComposerDraftAttachments } from "../../utils/composerDraftAttachments";
import {
  clearPersistedComposerDraft,
  persistComposerDraft,
  readComposerDraft,
} from "../../utils/composerDraftPersistence";
import { openReattachLease } from "./composerAttachmentReattach";
import type { ComposerAttachmentActions } from "./composerAttachmentActions";
import type { QueueCommandRunner } from "./runtimeQueueClient";

const QUEUED_ATTACHMENT_FALLBACKS: ReadonlySet<string> = new Set([
  "Please inspect the attached image.",
  "Please inspect the attached file.",
]);

export interface ComposerQueueHandoffOptions {
  conversationId: string;
  message: string;
  attachmentFallback: string;
  onQueueCommand: QueueCommandRunner | undefined;
  canQueue: boolean;
  documentBlocksFollowUp: boolean;
  editBlocked: { draft: boolean; busy: boolean };
  refs: {
    attachmentsRef: MutableRefObject<ChatAttachment[]>;
    conversationIdRef: MutableRefObject<string>;
    draftValueRef: MutableRefObject<string>;
    mountedRef: MutableRefObject<boolean>;
    pendingAttachmentIdsRef: MutableRefObject<Set<string>>;
    queueingRef: MutableRefObject<boolean>;
    queueOwnedAttachmentIdsRef: MutableRefObject<Set<string>>;
    releaseAttachmentRef: MutableRefObject<(attachmentId: string) => Promise<void>>;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
  };
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  setAttachmentError: Dispatch<SetStateAction<string | null>>;
  setPendingAttachmentIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setQueueEditPending: Dispatch<SetStateAction<boolean>>;
  isReferencing: () => boolean;
  flushDraftPersistence: () => void;
  markEditorChanged: () => void;
  resetHistory: (scratch?: string) => void;
  updateMessage: (message: string) => void;
  reattachAttachment: ComposerAttachmentActions["reattachAttachment"];
}

function transferContext(options: ComposerQueueHandoffOptions, snapshot: readonly ChatAttachment[] = []) {
  const {
    conversationId, message, attachmentFallback, onQueueCommand, refs,
    setAttachments, setAttachmentError, setPendingAttachmentIds, setMessage, setQueueEditPending,
    flushDraftPersistence, markEditorChanged, resetHistory, updateMessage,
  } = options;
  const { attachmentsRef, conversationIdRef, draftValueRef, mountedRef, releaseAttachmentRef, textareaRef } = refs;
  const showsConversation = (id: string): boolean => mountedRef.current && conversationIdRef.current === id;
  const returnAttachmentsToDraft = (id: string, returned: readonly ChatAttachment[]): void => {
    if (returned.length === 0) return;
    if (!showsConversation(id)) {
      keepComposerDraftAttachments(id, returned, (attachmentId) => releaseAttachmentRef.current(attachmentId));
      return;
    }
    const merged = mergeComposerAttachments(attachmentsRef.current, returned);
    const kept = new Set(merged.attachments.map(({ id: attachmentId }) => attachmentId));
    for (const { id: attachmentId } of merged.rejected) if (!kept.has(attachmentId)) void releaseAttachmentRef.current(attachmentId);
    attachmentsRef.current = merged.attachments;
    setAttachments(merged.attachments);
  };
  const queueDraft = async (stopTurnId?: string): Promise<void> => {
    const queuedConversationId = conversationId;
    const queuedMessage = message;
    const queuedAttachments = snapshot;
    const isCurrent = () => conversationIdRef.current === queuedConversationId && draftValueRef.current === queuedMessage && attachmentsRef.current === queuedAttachments;
    const { queueComposerDraft } = await import("./ComposerQueuedActions");
    const queued = await queueComposerDraft(onQueueCommand, queuedConversationId, queuedMessage.trim() || attachmentFallback, queuedAttachments, isCurrent,
      (error) => { if (conversationIdRef.current === queuedConversationId) setAttachmentError(error); }, stopTurnId);
    const present = new Set(showsConversation(queuedConversationId) ? attachmentsRef.current.map(({ id }) => id) : []);
    if (!queued) {
      returnAttachmentsToDraft(queuedConversationId, queuedAttachments.filter(({ id }) => !present.has(id)));
      return;
    }
    const current = isCurrent();
    if (showsConversation(queuedConversationId) && queuedAttachments.length > 0) {
      const transferred = new Set(queuedAttachments.map(({ id }) => id));
      const remaining = attachmentsRef.current.filter(({ id }) => !transferred.has(id));
      if (remaining.length !== attachmentsRef.current.length) {
        attachmentsRef.current = remaining;
        setAttachments(remaining);
      }
    }
    if (!current) return;
    attachmentsRef.current = []; setAttachments([]);
    setAttachmentError(null);
    refs.pendingAttachmentIdsRef.current = new Set(); setPendingAttachmentIds(new Set());
    flushDraftPersistence(); clearPersistedComposerDraft(queuedConversationId, queuedMessage);
    markEditorChanged(); resetHistory(""); draftValueRef.current = ""; setMessage(""); window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const restoreQueuedMessage = async (entry: QueuedMessage): Promise<void> => {
    const editedConversationId = entry.conversationId;
    if (showsConversation(editedConversationId)) setAttachmentError(null);
    const failed: string[] = [];
    try {
      const content = entry.attachments.length > 0 && QUEUED_ATTACHMENT_FALLBACKS.has(entry.content) ? "" : entry.content;
      if (content) {
        if (showsConversation(editedConversationId)) {
          const existing = draftValueRef.current;
          updateMessage(existing.trim() ? `${existing}\n\n${content}` : content);
        } else {
          const saved = readComposerDraft(editedConversationId);
          persistComposerDraft(editedConversationId, saved.trim() ? `${saved}\n\n${content}` : content);
        }
      }
      const bridge = typeof window === "undefined" ? undefined : window.inertia;
      for (const attachment of entry.attachments) {
        if (!bridge?.reattachAttachment) {
          failed.push(attachment.name);
          continue;
        }
        try {
          const lease = await openReattachLease(bridge, editedConversationId, attachment.id);
          try {
            const adopted = lease.attachments;
            if (adopted.length === 0) {
              await lease.cancel().catch(() => undefined);
              failed.push(attachment.name);
              continue;
            }
            await lease.commit(adopted.map(({ id }) => id));
            returnAttachmentsToDraft(editedConversationId, adopted);
          } catch {
            await lease.cancel().catch(() => undefined);
            failed.push(attachment.name);
          }
        } catch {
          failed.push(attachment.name);
        }
      }
    } finally {
      if (showsConversation(editedConversationId)) {
        setQueueEditPending(false);
        if (failed.length > 0) {
          setAttachmentError(`${failed.length === 1 ? "An attachment" : "Some attachments"} could not be restored: ${failed.join(", ")}. Attach ${failed.length === 1 ? "it" : "them"} again.`);
        }
        window.requestAnimationFrame(() => textareaRef.current?.focus());
      }
    }
  };
  return { queueDraft, restoreQueuedMessage };
}

export async function queueComposerDraftTransfer(options: ComposerQueueHandoffOptions, attachments: readonly ChatAttachment[], stopTurnId?: string): Promise<void> {
  await transferContext(options, attachments).queueDraft(stopTurnId);
}

export async function restoreQueuedMessageToDraft(options: ComposerQueueHandoffOptions, entry: QueuedMessage): Promise<void> {
  await transferContext(options).restoreQueuedMessage(entry);
}
