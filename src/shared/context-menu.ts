import { isProjectRelativePath, UUID_PATTERN } from "./desktop";

export interface ContextMenuAnchor {
  x: number;
  y: number;
}

export type ContextMenuRequest =
  | {
      kind: "message";
      conversationId: string;
      role: "user" | "assistant";
      hasSelection: boolean;
      anchor: ContextMenuAnchor;
    }
  | {
      kind: "code";
      conversationId?: string;
      hasSelection: boolean;
      anchor: ContextMenuAnchor;
    }
  | {
      kind: "project-link" | "diff-file";
      projectId: string;
      conversationId?: string;
      relativePath: string;
      anchor: ContextMenuAnchor;
    }
  | {
      kind: "file";
      projectId: string;
      conversationId?: string;
      relativePath: string;
      directory: boolean;
      anchor: ContextMenuAnchor;
    }
  | {
      kind: "terminal";
      hasSelection: boolean;
      clearable: boolean;
      anchor: ContextMenuAnchor;
    };

export type ContextMenuAction =
  | "copy-message"
  | "copy-markdown"
  | "copy-code"
  | "open"
  | "reveal"
  | "copy-path"
  | "copy-relative-path"
  | "terminal-copy"
  | "terminal-select-all"
  | "terminal-clear";

const MAX_ANCHOR_COORDINATE = 100_000;

const REQUIRED_KEYS: Readonly<Record<ContextMenuRequest["kind"], readonly string[]>> = {
  message: ["kind", "conversationId", "role", "hasSelection", "anchor"],
  code: ["kind", "hasSelection", "anchor"],
  "project-link": ["kind", "projectId", "relativePath", "anchor"],
  "diff-file": ["kind", "projectId", "relativePath", "anchor"],
  file: ["kind", "projectId", "relativePath", "directory", "anchor"],
  terminal: ["kind", "hasSelection", "clearable", "anchor"],
};

const OPTIONAL_CONVERSATION: ReadonlySet<ContextMenuRequest["kind"]> = new Set([
  "code",
  "project-link",
  "diff-file",
  "file",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= MAX_ANCHOR_COORDINATE;
}

function parseAnchor(value: unknown): ContextMenuAnchor | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !coordinate(value.x) || !coordinate(value.y)) return null;
  return { x: value.x, y: value.y };
}

function exactKeys(value: Record<string, unknown>, kind: ContextMenuRequest["kind"]): boolean {
  const allowed = new Set(REQUIRED_KEYS[kind]);
  if (OPTIONAL_CONVERSATION.has(kind) && Object.hasOwn(value, "conversationId")) {
    allowed.add("conversationId");
  }
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

export function parseContextMenuRequest(value: unknown): ContextMenuRequest | null {
  if (!record(value) || typeof value.kind !== "string" || !Object.hasOwn(REQUIRED_KEYS, value.kind)) {
    return null;
  }
  const kind = value.kind as ContextMenuRequest["kind"];
  const anchor = parseAnchor(value.anchor);
  if (!anchor || !exactKeys(value, kind)) return null;
  if (Object.hasOwn(value, "conversationId") && !uuid(value.conversationId)) return null;
  const conversation = uuid(value.conversationId) ? { conversationId: value.conversationId } : {};
  switch (kind) {
    case "message":
      if (
        !uuid(value.conversationId)
        || (value.role !== "user" && value.role !== "assistant")
        || typeof value.hasSelection !== "boolean"
      ) return null;
      return {
        kind,
        conversationId: value.conversationId,
        role: value.role,
        hasSelection: value.hasSelection,
        anchor,
      };
    case "code":
      if (typeof value.hasSelection !== "boolean") return null;
      return { kind, ...conversation, hasSelection: value.hasSelection, anchor };
    case "project-link":
    case "diff-file":
      if (!uuid(value.projectId) || !isProjectRelativePath(value.relativePath)) return null;
      return { kind, projectId: value.projectId, ...conversation, relativePath: value.relativePath, anchor };
    case "file":
      if (
        !uuid(value.projectId)
        || !isProjectRelativePath(value.relativePath)
        || typeof value.directory !== "boolean"
      ) return null;
      return {
        kind,
        projectId: value.projectId,
        ...conversation,
        relativePath: value.relativePath,
        directory: value.directory,
        anchor,
      };
    case "terminal":
      if (typeof value.hasSelection !== "boolean" || typeof value.clearable !== "boolean") return null;
      return { kind, hasSelection: value.hasSelection, clearable: value.clearable, anchor };
  }
}
