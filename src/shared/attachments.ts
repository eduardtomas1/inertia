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
  "text/plain": ["text/x-log", "application/x-log", "application/x-text", "text/x-text"],
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

/**
 * Plain-text source, markup, data and configuration files that the live
 * import boundary accepts as text/plain. The set is additive to the lookup
 * migration 56 pins: rows written with these names are read by the live
 * stored-attachment codec, and the frozen migration parser stays unchanged.
 * Deliberately absent: SVG (an image format that can carry script), .env and
 * key or certificate files (credentials), and every binary container. The
 * import still validates bounded Unicode text before accepting them.
 */
const PLAIN_TEXT_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set((
  "log text rst tex tsv jsonl ndjson jsonc json5 ipynb mdx "
  + "yaml yml toml ini cfg conf properties xml html htm "
  + "css scss less js mjs cjs jsx ts tsx vue svelte "
  + "py rb go rs java kt kts scala c h cc cpp hpp "
  + "cs swift php lua dart r pl ex exs erl hs clj "
  + "sh bash zsh ps1 bat cmd sql graphql proto diff patch"
).split(" "));

const PLAIN_TEXT_ATTACHMENT_NAMES: ReadonlySet<string> = new Set((
  "dockerfile containerfile makefile gnumakefile justfile "
  + "readme license .gitignore .gitattributes .dockerignore .editorconfig"
).split(" "));

// Declared types platforms report for the plain-text set beyond text/*.
const PLAIN_TEXT_DECLARED_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/yaml", "application/x-yaml", "application/toml", "application/xml",
  "application/xhtml+xml", "application/javascript", "application/x-javascript",
  "application/ecmascript", "application/typescript", "application/x-typescript",
  "application/x-sh", "application/x-shellscript", "application/x-csh",
  "application/x-powershell", "application/x-bat", "application/x-msdos-program",
  "application/sql", "application/x-sql", "application/x-httpd-php", "application/x-php",
  "application/x-python", "application/x-python-code", "application/x-ruby",
  "application/x-perl", "application/x-tex", "application/x-latex",
  "application/x-ndjson", "application/jsonl", "application/json", "application/json5",
  "application/graphql", "application/x-protobuf",
  // Chromium classifies a .ts file by extension as an MPEG transport stream.
  "video/mp2t",
]);

function attachmentNameExtension(name: string): string | null {
  return /\.([^.]+)$/u.exec(name.trim())?.[1]?.toLocaleLowerCase("en-US") ?? null;
}

/**
 * Extensions the live import accepts, for native pickers: the pinned lookup's
 * names plus the plain-text set. The follow-up picker stays images only.
 */
export function chatAttachmentPickerExtensions(mode: "images" | "all"): string[] {
  const pinned = Object.keys(attachmentMimeByExtension);
  if (mode === "images") {
    return pinned.filter((extension) =>
      chatAttachmentKind(attachmentMimeByExtension[extension]!) === "image");
  }
  return [...pinned, ...PLAIN_TEXT_ATTACHMENT_EXTENSIONS];
}

function isPlainTextAttachmentName(name: string): boolean {
  if (PLAIN_TEXT_ATTACHMENT_NAMES.has(name.trim().toLowerCase())) return true;
  const extension = attachmentNameExtension(name);
  return extension !== null
    && !Object.hasOwn(attachmentMimeByExtension, extension)
    && PLAIN_TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

// The original lookup above is pinned by released migration 56. Live import
// boundaries use this own-property lookup, extended with the plain-text set;
// persisted codecs additionally require a string MIME value in the explicit
// MIME allowlist.
export function safeChatAttachmentMimeTypeForName(
  name: string,
): ChatAttachmentMimeType | null {
  const leaf = name.trim().toLowerCase();
  const extension = /\.([^.]+)$/u.exec(leaf)?.[1] ?? "";
  if (Object.hasOwn(attachmentMimeByExtension, extension)) {
    return attachmentMimeByExtension[extension]!;
  }
  return PLAIN_TEXT_ATTACHMENT_EXTENSIONS.has(extension)
    || PLAIN_TEXT_ATTACHMENT_NAMES.has(leaf) ? "text/plain" : null;
}

export function isPotentialChatAttachment(
  name: string,
  declaredMimeType: string,
): boolean {
  const inferred = safeChatAttachmentMimeTypeForName(name);
  if (!inferred) return false;
  const declared = declaredMimeType.split(";", 1)[0]!
    .trim()
    .toLocaleLowerCase("en-US");
  if (
    !declared
    || declared === inferred
    || declared === "application/octet-stream"
    || declared === "binary/octet-stream"
    || declared === "application/unknown"
  ) return true;
  if (attachmentDeclaredMimeAliases[inferred]?.includes(declared)) return true;
  return isPlainTextAttachmentName(name)
    && (declared.startsWith("text/") || PLAIN_TEXT_DECLARED_MIME_TYPES.has(declared));
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
