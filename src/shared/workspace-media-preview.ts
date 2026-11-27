import type { OpenProjectPathRequest } from "./desktop";

export type WorkspaceMediaKind = "image" | "video" | "audio" | "pdf" | "spreadsheet";

export interface WorkspaceMediaDescriptor {
  readonly kind: WorkspaceMediaKind;
  readonly mimeType: string;
  readonly extension: string;
  readonly label: string;
  readonly isTextDualView: boolean;
}

export interface WorkspaceMediaPreviewTarget {
  readonly projectId: string;
  readonly conversationId?: string;
  readonly relativePath: string;
  readonly name: string;
  readonly kind: WorkspaceMediaKind;
  readonly mimeType: string;
  readonly extension: string;
  readonly url: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_MEDIA_PATH = /^\/workspace-media\/([^/]+)\/([^/]+)\/([^/]+)$/u;

export const MAX_WORKSPACE_MEDIA_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_WORKSPACE_MEDIA_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_WORKSPACE_MEDIA_SPREADSHEET_BYTES = 25 * 1024 * 1024;
export const MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES = 10 * 1024 * 1024;
export const MAX_WORKSPACE_MEDIA_AV_BYTES = 512 * 1024 * 1024;

const MEDIA_EXTENSIONS: Readonly<Record<string, Omit<WorkspaceMediaDescriptor, "extension">>> = {
  // Images
  png: { kind: "image", mimeType: "image/png", label: "PNG image", isTextDualView: false },
  jpg: { kind: "image", mimeType: "image/jpeg", label: "JPEG image", isTextDualView: false },
  jpeg: { kind: "image", mimeType: "image/jpeg", label: "JPEG image", isTextDualView: false },
  gif: { kind: "image", mimeType: "image/gif", label: "GIF image", isTextDualView: false },
  webp: { kind: "image", mimeType: "image/webp", label: "WebP image", isTextDualView: false },
  svg: { kind: "image", mimeType: "image/svg+xml", label: "SVG image", isTextDualView: true },
  avif: { kind: "image", mimeType: "image/avif", label: "AVIF image", isTextDualView: false },
  bmp: { kind: "image", mimeType: "image/bmp", label: "BMP image", isTextDualView: false },
  ico: { kind: "image", mimeType: "image/x-icon", label: "ICO image", isTextDualView: false },
  // Videos
  mp4: { kind: "video", mimeType: "video/mp4", label: "MP4 video", isTextDualView: false },
  m4v: { kind: "video", mimeType: "video/mp4", label: "M4V video", isTextDualView: false },
  webm: { kind: "video", mimeType: "video/webm", label: "WebM video", isTextDualView: false },
  mov: { kind: "video", mimeType: "video/quicktime", label: "QuickTime video", isTextDualView: false },
  ogv: { kind: "video", mimeType: "video/ogg", label: "Ogg video", isTextDualView: false },
  mkv: { kind: "video", mimeType: "video/x-matroska", label: "MKV video", isTextDualView: false },
  // Audio
  mp3: { kind: "audio", mimeType: "audio/mpeg", label: "MP3 audio", isTextDualView: false },
  wav: { kind: "audio", mimeType: "audio/wav", label: "WAV audio", isTextDualView: false },
  ogg: { kind: "audio", mimeType: "audio/ogg", label: "Ogg audio", isTextDualView: false },
  oga: { kind: "audio", mimeType: "audio/ogg", label: "Ogg audio", isTextDualView: false },
  m4a: { kind: "audio", mimeType: "audio/mp4", label: "M4A audio", isTextDualView: false },
  flac: { kind: "audio", mimeType: "audio/flac", label: "FLAC audio", isTextDualView: false },
  aac: { kind: "audio", mimeType: "audio/aac", label: "AAC audio", isTextDualView: false },
  opus: { kind: "audio", mimeType: "audio/ogg", label: "Opus audio", isTextDualView: false },
  // PDF
  pdf: { kind: "pdf", mimeType: "application/pdf", label: "PDF document", isTextDualView: false },
  // Spreadsheets
  xlsx: {
    kind: "spreadsheet",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel workbook",
    isTextDualView: false,
  },
  xlsm: {
    kind: "spreadsheet",
    mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    label: "Excel workbook",
    isTextDualView: false,
  },
  xls: {
    kind: "spreadsheet",
    mimeType: "application/vnd.ms-excel",
    label: "Excel workbook",
    isTextDualView: false,
  },
  ods: {
    kind: "spreadsheet",
    mimeType: "application/vnd.oasis.opendocument.spreadsheet",
    label: "OpenDocument spreadsheet",
    isTextDualView: false,
  },
  csv: { kind: "spreadsheet", mimeType: "text/csv", label: "CSV spreadsheet", isTextDualView: true },
  tsv: { kind: "spreadsheet", mimeType: "text/tab-separated-values", label: "TSV spreadsheet", isTextDualView: true },
};

export function workspaceMediaExtension(path: string): string {
  const baseName = path.split(/[\\/]/u).pop() ?? "";
  const dot = baseName.lastIndexOf(".");
  if (dot <= 0 || dot === baseName.length - 1) return "";
  return baseName.slice(dot + 1).toLowerCase();
}

export function workspaceMediaFileName(path: string): string {
  return path.split(/[\\/]/u).pop() || path;
}

export function classifyWorkspaceMediaPath(path: string): WorkspaceMediaDescriptor | null {
  const extension = workspaceMediaExtension(path);
  if (!extension || !Object.hasOwn(MEDIA_EXTENSIONS, extension)) return null;
  const entry = MEDIA_EXTENSIONS[extension];
  return entry ? { ...entry, extension } : null;
}

export function isBinaryWorkspaceMediaPath(path: string): boolean {
  const descriptor = classifyWorkspaceMediaPath(path);
  return descriptor !== null && !descriptor.isTextDualView;
}

export function workspaceMediaPreviewUrl(request: {
  projectId: string;
  conversationId?: string;
  relativePath: string;
}, scheme: "inertia" | "inertia-canary" = "inertia"): string {
  const owner = request.conversationId ?? "project";
  return `${scheme}://bundle/workspace-media/${encodeURIComponent(request.projectId)}/${encodeURIComponent(owner)}/${encodeURIComponent(request.relativePath)}`;
}

export function parseWorkspaceMediaPreviewUrl(
  value: URL,
): OpenProjectPathRequest | null {
  const match = WORKSPACE_MEDIA_PATH.exec(value.pathname);
  if (!match) return null;
  let projectId: string;
  let owner: string;
  let relativePath: string;
  try {
    projectId = decodeURIComponent(match[1]!);
    owner = decodeURIComponent(match[2]!);
    relativePath = decodeURIComponent(match[3]!);
  } catch {
    return null;
  }
  if (
    !UUID_PATTERN.test(projectId)
    || (owner !== "project" && !UUID_PATTERN.test(owner))
    || relativePath.length === 0
    || relativePath.length > 4_096
    || /[\0\r\n]/u.test(relativePath)
    || /^[\\/]/u.test(relativePath)
    || /^[A-Za-z]:/u.test(relativePath)
    || relativePath.split(/[\\/]/u).some((segment) => segment === "..")
  ) return null;
  return {
    projectId,
    ...(owner === "project" ? {} : { conversationId: owner }),
    relativePath,
    action: "open-externally",
  };
}

export function buildWorkspaceMediaPreviewTarget(input: {
  projectId: string;
  conversationId?: string;
  relativePath: string;
  scheme?: "inertia" | "inertia-canary";
}): WorkspaceMediaPreviewTarget | null {
  const descriptor = classifyWorkspaceMediaPath(input.relativePath);
  if (!descriptor) return null;
  const scheme = input.scheme ?? "inertia";
  return {
    projectId: input.projectId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    relativePath: input.relativePath,
    name: workspaceMediaFileName(input.relativePath),
    kind: descriptor.kind,
    mimeType: descriptor.mimeType,
    extension: descriptor.extension,
    url: workspaceMediaPreviewUrl(input, scheme),
  };
}
