export const IMAGE_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const DOCUMENT_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

export const CHAT_ATTACHMENT_MIME_TYPES = [
  ...IMAGE_ATTACHMENT_MIME_TYPES,
  ...DOCUMENT_ATTACHMENT_MIME_TYPES,
] as const;

export type ImageAttachmentMimeType = (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number];
export type DocumentAttachmentMimeType = (typeof DOCUMENT_ATTACHMENT_MIME_TYPES)[number];
export type ChatAttachmentMimeType = (typeof CHAT_ATTACHMENT_MIME_TYPES)[number];
export type ChatAttachmentKind = "image" | "document";

export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const attachmentMimeByExtension: Readonly<Record<string, ChatAttachmentMimeType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

const attachmentTypeLabels: Readonly<Record<ChatAttachmentMimeType, string>> = {
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/webp": "WebP image",
  "image/gif": "GIF image",
  "application/pdf": "PDF document",
  "text/plain": "Text document",
  "text/markdown": "Markdown document",
  "text/csv": "CSV document",
  "application/json": "JSON document",
};

const attachmentStorageExtension: Readonly<
  Record<ChatAttachmentMimeType, string>
> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
};

export function chatAttachmentKind(
  mimeType: ChatAttachmentMimeType,
): ChatAttachmentKind {
  return (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType)
    ? "image"
    : "document";
}

export function chatAttachmentMimeTypeForName(
  name: string,
): ChatAttachmentMimeType | null {
  const extension = /\.([^.]+)$/u.exec(name.trim())?.[1]?.toLocaleLowerCase("en-US");
  return extension ? attachmentMimeByExtension[extension] ?? null : null;
}

export function isPotentialChatAttachment(
  name: string,
  declaredMimeType: string,
): boolean {
  const inferred = chatAttachmentMimeTypeForName(name);
  if (!inferred) return false;
  if (!declaredMimeType || declaredMimeType === inferred) return true;
  return inferred === "text/markdown" && declaredMimeType === "text/plain";
}

export function chatAttachmentTypeLabel(
  mimeType: ChatAttachmentMimeType,
): string {
  return attachmentTypeLabels[mimeType];
}

export function chatAttachmentStorageExtension(
  mimeType: ChatAttachmentMimeType,
): string {
  return attachmentStorageExtension[mimeType];
}
