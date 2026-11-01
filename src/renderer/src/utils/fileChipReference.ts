import type { WorkspaceFileLocation } from "./workspaceFileReference";

export const MAX_FILE_CHIP_TOKEN_LENGTH = 200;
export const MAX_FILE_CHIPS_PER_DOCUMENT = 200;
export const FILE_CHIP_FOLDER_HINT_LENGTH = 40;

export type FileChipKind = "code" | "text" | "image" | "config";

const EXTENSION_KINDS: ReadonlyMap<string, FileChipKind> = new Map([
  ...[
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte",
    "css", "scss", "html", "py", "rs", "go", "java", "kt", "swift", "c", "h",
    "cpp", "hpp", "cs", "rb", "php", "lua", "dart", "sh", "ps1", "sql",
  ].map((extension) => [extension, "code"] as const),
  ...["md", "mdx", "txt"].map((extension) => [extension, "text"] as const),
  ...["svg", "png", "jpg", "jpeg", "gif", "webp"].map((extension) => [extension, "image"] as const),
  ...[
    "json", "jsonc", "yml", "yaml", "toml", "xml", "ini", "lock", "env",
    "gitignore", "editorconfig", "dockerfile",
  ].map((extension) => [extension, "config"] as const),
]);

const DOTFILE_EXTENSIONS = new Set(["env", "gitignore", "editorconfig"]);
const LOCATION_SUFFIX = /:([1-9]\d{0,8})(?::([1-9]\d{0,8}))?$/u;
const PATH_SEGMENT = /^[\p{L}\p{M}\p{N}_@+\-.()[\]$]+$/u;
const SEPARATOR = /[\\/]/u;
const WEB_HOST = /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|gov|edu)$/iu;
const LIBRARY_NAME = /^\p{Lu}\p{Ll}+\.js$/u;

export interface FileChipReference {
  token: string;
  path: string;
  name: string;
  folder: string;
  location?: WorkspaceFileLocation;
  locationLabel: string;
  kind: FileChipKind;
}

function fileChipKind(name: string): FileChipKind | null {
  const lower = name.toLocaleLowerCase("en-US");
  if (lower === "dockerfile") return "config";
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return null;
  const extension = lower.slice(dot + 1);
  if (dot === 0) return DOTFILE_EXTENSIONS.has(extension) ? "config" : null;
  return EXTENSION_KINDS.get(extension) ?? null;
}

export function fileChipReference(token: string): FileChipReference | null {
  if (!token || token.length > MAX_FILE_CHIP_TOKEN_LENGTH) return null;
  if (/\s/u.test(token) || token.includes("://")) return null;
  if (/^[-~\\@]/u.test(token) || token.startsWith("//")) return null;
  if (/^[a-z]:/iu.test(token)) return null;
  const suffix = LOCATION_SUFFIX.exec(token);
  const path = suffix ? token.slice(0, suffix.index) : token;
  const rooted = path.startsWith("/");
  const segments = (rooted ? path.slice(1) : path).split(SEPARATOR);
  let depth = 0;
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment)) return null;
    if (segment === ".") continue;
    if (segment !== "..") depth += 1;
    else if (depth === 0) return null;
    else depth -= 1;
  }
  const name = segments.at(-1) ?? "";
  if (/^\.+$/u.test(name)) return null;
  const separated = rooted || segments.length > 1;
  const kind = fileChipKind(name);
  if (kind === null) return null;
  if (!separated && LIBRARY_NAME.test(name)) return null;
  if (separated && !rooted && WEB_HOST.test(segments[0] ?? "")) return null;
  const startLine = suffix ? Number(suffix[1]) : undefined;
  const startColumn = suffix?.[2] ? Number(suffix[2]) : undefined;
  const parent = separated
    ? path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")))
    : "";
  const folder = rooted && parent === ""
    ? "/"
    : parent.replace(/^(?:\.[\\/])+/u, "").replace(/^\.$/u, "");
  return {
    token,
    path,
    name,
    folder,
    ...(startLine === undefined
      ? {}
      : {
          location: {
            startLine,
            ...(startColumn === undefined ? {} : { startColumn }),
            endLine: startLine,
          },
        }),
    locationLabel: suffix?.[0] ?? "",
    kind,
  };
}

export function middleTruncate(
  value: string,
  limit = FILE_CHIP_FOLDER_HINT_LENGTH,
): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const kept = Math.max(limit - 1, 2);
  const head = Math.floor(kept / 2);
  return `${characters.slice(0, head).join("")}…${characters.slice(head - kept).join("")}`;
}
