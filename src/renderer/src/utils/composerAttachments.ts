import type {
  ChatAttachment,
} from "@shared/contracts";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentKind,
  isSpreadsheetAttachmentMimeType,
} from "@shared/attachments";

export interface AttachmentMergeResult {
  readonly attachments: ChatAttachment[];
  readonly rejected: ChatAttachment[];
}

export interface ComposerAttachmentImportLease {
  readonly attachments: readonly ChatAttachment[];
  commit(adoptedAttachmentIds: readonly string[]): Promise<void>;
  cancel(): Promise<void>;
}

export type ComposerAttachmentAdoptionResult = "adopted" | "rejected" | "cancelled";

export function mergeComposerAttachments(
  current: readonly ChatAttachment[],
  incoming: readonly ChatAttachment[],
): AttachmentMergeResult {
  const attachments = [...current];
  const rejected: ChatAttachment[] = [];
  // Native imports own content verification and digest deduplication. Equal
  // display metadata does not make two distinct capabilities the same file.
  const ids = new Set(current.map(({ id }) => id));
  let totalBytes = current.reduce((total, { size }) => total + size, 0);

  for (const attachment of incoming) {
    if (
      attachments.length >= MAX_CHAT_ATTACHMENTS
      || totalBytes + attachment.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES
      || ids.has(attachment.id)
    ) {
      rejected.push(attachment);
      continue;
    }
    attachments.push(attachment);
    ids.add(attachment.id);
    totalBytes += attachment.size;
  }
  return { attachments, rejected };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export type AttachmentPreviewKind =
  | "image"
  | "pdf"
  | "spreadsheet"
  | "text";

export function attachmentPreviewKind(
  attachment: Pick<ChatAttachment, "mimeType">,
): AttachmentPreviewKind {
  if (chatAttachmentKind(attachment.mimeType) === "image") return "image";
  if (attachment.mimeType === "application/pdf") return "pdf";
  if (
    attachment.mimeType === "text/csv"
    || isSpreadsheetAttachmentMimeType(attachment.mimeType)
  ) return "spreadsheet";
  return "text";
}

export type AttachmentPreviewSource = Pick<ChatAttachment, "id" | "name" | "mimeType" | "size" | "snapshot">;

export function attachmentPreviewUrl(attachment: Pick<ChatAttachment, "id">): string {
  const scheme = globalThis.location?.protocol === "inertia-canary:"
    ? "inertia-canary"
    : "inertia";
  return `${scheme}://bundle/attachment-preview/${encodeURIComponent(attachment.id)}`;
}
