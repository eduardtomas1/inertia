export const IMAGE_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const SPREADSHEET_ATTACHMENT_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
] as const;

export const DOCUMENT_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  ...SPREADSHEET_ATTACHMENT_MIME_TYPES,
] as const;

export const CHAT_ATTACHMENT_MIME_TYPES = [
  ...IMAGE_ATTACHMENT_MIME_TYPES,
  ...DOCUMENT_ATTACHMENT_MIME_TYPES,
] as const;

export type ImageAttachmentMimeType = (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number];
export type SpreadsheetAttachmentMimeType =
  (typeof SPREADSHEET_ATTACHMENT_MIME_TYPES)[number];
export type DocumentAttachmentMimeType = (typeof DOCUMENT_ATTACHMENT_MIME_TYPES)[number];
export type ChatAttachmentMimeType = (typeof CHAT_ATTACHMENT_MIME_TYPES)[number];
export type ChatAttachmentKind = "image" | "document";

export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_SPREADSHEET_ATTACHMENT_EXPANDED_BYTES = 64 * 1024 * 1024;

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
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

const attachmentDeclaredMimeAliases: Readonly<
  Partial<Record<ChatAttachmentMimeType, readonly string[]>>
> = {
  "image/png": ["image/apng", "image/x-png"],
  "image/jpeg": ["image/jpe", "image/jpg", "image/pjpeg"],
  "image/webp": ["image/x-webp"],
  "image/gif": ["image/x-gif"],
  "application/pdf": [
    "application/acrobat",
    "application/vnd.pdf",
    "application/x-pdf",
    "text/pdf",
    "text/x-pdf",
  ],
  "text/plain": ["text/x-log"],
  "text/markdown": [
    "application/markdown",
    "application/x-markdown",
    "text/md",
    "text/plain",
    "text/x-markdown",
  ],
  "text/csv": [
    "application/csv",
    "application/vnd.ms-excel",
    "text/comma-separated-values",
    "text/plain",
    "text/x-csv",
  ],
  "application/json": ["application/x-json", "text/json", "text/plain"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    "application/x-xlsx",
    "application/xlsx",
    "application/vnd.ms-excel",
    "application/zip",
    "application/x-zip-compressed",
  ],
  "application/vnd.ms-excel": [
    "application/excel",
    "application/msexcel",
    "application/x-excel",
    "application/x-ms-excel",
    "application/x-msexcel",
    "application/x-dos_ms_excel",
    "application/x-xls",
    "application/xls",
  ],
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
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "Excel workbook",
  "application/vnd.ms-excel": "Legacy Excel workbook",
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
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
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
  const declared = declaredMimeType.split(";", 1)[0]!
    .trim()
    .toLocaleLowerCase("en-US");
  if (
    !declared
    || declared === inferred
    || declared === "application/octet-stream"
  ) return true;
  return attachmentDeclaredMimeAliases[inferred]?.includes(declared) ?? false;
}

export function isSpreadsheetAttachmentMimeType(
  mimeType: ChatAttachmentMimeType,
): mimeType is SpreadsheetAttachmentMimeType {
  return (SPREADSHEET_ATTACHMENT_MIME_TYPES as readonly string[])
    .includes(mimeType);
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
