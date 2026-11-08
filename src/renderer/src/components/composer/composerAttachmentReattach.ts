import type { ConversationAttachmentGalleryItem } from "@shared/conversation-attachment-gallery";
import type { DesktopAttachmentImportSelection } from "@shared/desktop";
import type { ComposerAttachmentImportLease } from "../../utils/composerAttachments";

/**
 * Re-attaching a sent file adds a fresh draft copy made by the main process
 * from retained storage. The renderer never reads the bytes: it only names
 * the stored attachment id and adopts the returned import capability.
 */
export type ComposerReattachOutcome =
  | { readonly status: "attached" }
  | { readonly status: "rejected"; readonly message: string };

export type ComposerReattachTarget = (
  item: ConversationAttachmentGalleryItem,
) => Promise<ComposerReattachOutcome>;

export const COMPOSER_REATTACH_UNAVAILABLE =
  "Open this chat's message box to re-attach files.";
const ELECTRON_IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/u;

const targets = new Map<string, ComposerReattachTarget[]>();

/** The most recently mounted composer for a chat receives re-attachments. */
export function registerComposerReattachTarget(
  conversationId: string,
  target: ComposerReattachTarget,
): () => void {
  const list = targets.get(conversationId) ?? [];
  list.push(target);
  targets.set(conversationId, list);
  return () => {
    const current = targets.get(conversationId);
    if (!current) return;
    const index = current.lastIndexOf(target);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) targets.delete(conversationId);
  };
}

export function hasComposerReattachTarget(conversationId: string): boolean {
  return (targets.get(conversationId)?.length ?? 0) > 0;
}

export async function requestComposerReattach(
  conversationId: string,
  item: ConversationAttachmentGalleryItem,
): Promise<ComposerReattachOutcome> {
  const target = targets.get(conversationId)?.at(-1);
  if (!target) return { status: "rejected", message: COMPOSER_REATTACH_UNAVAILABLE };
  try {
    return await target(item);
  } catch (error) {
    return { status: "rejected", message: reattachErrorMessage(error) };
  }
}

export function reattachErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message.replace(ELECTRON_IPC_ERROR_PREFIX, "").trim()
    : "";
  return message || "This file could not be re-attached.";
}

interface ReattachBridge {
  reattachAttachment(request: { conversationId: string; attachmentId: string }): Promise<DesktopAttachmentImportSelection>;
  commitAttachmentImport(batchId: string, adoptedAttachmentIds: string[]): Promise<void>;
  cancelAttachmentImport(batchId: string): Promise<void>;
}

/** Wraps the privileged selection in the same commit/cancel lease other imports use. */
export async function openReattachLease(
  bridge: ReattachBridge,
  conversationId: string,
  attachmentId: string,
): Promise<ComposerAttachmentImportLease> {
  const selection = await bridge.reattachAttachment({ conversationId, attachmentId });
  let settled = false;
  return {
    attachments: selection.attachments,
    async commit(adoptedAttachmentIds) {
      if (settled) throw new Error("Attachment import is already settled.");
      await bridge.commitAttachmentImport(selection.batchId, [...adoptedAttachmentIds]);
      settled = true;
    },
    async cancel() {
      if (settled) return;
      await bridge.cancelAttachmentImport(selection.batchId);
      settled = true;
    },
  };
}
