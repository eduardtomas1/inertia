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

function duplicateKey(attachment: ChatAttachment): string {
  return [
    attachment.name.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
    attachment.mimeType,
    attachment.size,
  ].join("\0");
}

export function mergeComposerAttachments(
  current: readonly ChatAttachment[],
  incoming: readonly ChatAttachment[],
): AttachmentMergeResult {
  const attachments = [...current];
  const rejected: ChatAttachment[] = [];
  const paths = new Set(current.map(({ path }) => path));
  const metadata = new Set(current.map(duplicateKey));
  let totalBytes = current.reduce((total, { size }) => total + size, 0);

  for (const attachment of incoming) {
    const key = duplicateKey(attachment);
    if (
      attachments.length >= MAX_CHAT_ATTACHMENTS
      || totalBytes + attachment.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES
      || paths.has(attachment.path)
      || metadata.has(key)
    ) {
      rejected.push(attachment);
      continue;
    }
    attachments.push(attachment);
    paths.add(attachment.path);
    metadata.add(key);
    totalBytes += attachment.size;
  }
  return { attachments, rejected };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) {
    return `${Math.max(0.1, bytes / 1_024).toFixed(1)} KB`;
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
): AttachmentPreviewKind | null {
  if (chatAttachmentKind(attachment.mimeType) === "image") return "image";
  if (attachment.mimeType === "application/pdf") return "pdf";
  if (
    attachment.mimeType === "text/csv"
    || isSpreadsheetAttachmentMimeType(attachment.mimeType)
  ) return "spreadsheet";
  return "text";
}

export function attachmentPreviewUrl(attachment: ChatAttachment): string | null {
  if (!attachmentPreviewKind(attachment)) return null;
  return `inertia://bundle/attachment-preview/${encodeURIComponent(attachment.id)}`;
}
