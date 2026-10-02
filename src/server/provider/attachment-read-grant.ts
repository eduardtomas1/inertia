import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

export const MAX_ATTACHMENT_READ_ROOTS = 4_096;

const CLAUDE_READ_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  NotebookRead: ["notebook_path"],
  LS: ["path"],
  Grep: ["path"],
  Glob: ["path"],
};
const CLAUDE_PATTERN_FIELDS = ["pattern", "glob"] as const;

function canonical(path: string): string | null {
  try {
    const target = realpathSync.native(path);
    return target === resolve(path) ? target : null;
  } catch {
    return null;
  }
}

export function isOwnAttachmentPath(
  path: unknown,
  roots: readonly string[] | undefined,
): boolean {
  if (
    !roots?.length
    || typeof path !== "string"
    || path.length < 1
    || path.length > 4_096
    || path.includes("\0")
    || !isAbsolute(path)
  ) return false;
  const target = canonical(path);
  if (!target) return false;
  return roots.some((root) => {
    const canonicalRoot = canonical(root);
    if (!canonicalRoot) return false;
    const child = relative(canonicalRoot, target);
    return child === ""
      || (child.split(sep)[0] !== ".." && !isAbsolute(child));
  });
}

function safeRelativePattern(value: unknown): boolean {
  return value === undefined || (
    typeof value === "string"
    && value.length <= 4_096
    && !value.includes("\0")
    && !isAbsolute(value)
    && !value.startsWith("~")
    && !value.split(/[\\/]/u).includes("..")
  );
}

export function claudeAttachmentReadAllowed(
  toolName: string,
  toolInput: Record<string, unknown>,
  blockedPath: string | undefined,
  roots: readonly string[] | undefined,
): boolean {
  const fields = CLAUDE_READ_TOOLS[toolName];
  if (!fields || !roots?.length) return false;
  return fields.every((field) => isOwnAttachmentPath(toolInput[field], roots))
    && CLAUDE_PATTERN_FIELDS.every((field) => safeRelativePattern(toolInput[field]))
    && (blockedPath === undefined || isOwnAttachmentPath(blockedPath, roots));
}

export function claudePermissionAccess(toolName: string): "read" | "write" {
  return Object.hasOwn(CLAUDE_READ_TOOLS, toolName) ? "read" : "write";
}

export function acpAttachmentReadAllowed(
  request: RequestPermissionRequest,
  roots: readonly string[] | undefined,
): boolean {
  const locations = request.toolCall.locations;
  return request.toolCall.kind === "read"
    && Array.isArray(locations)
    && locations.length > 0
    && locations.every((location) => isOwnAttachmentPath(location?.path, roots));
}

export function openCodeAttachmentReadAllowed(
  permission: string,
  properties: Record<string, unknown>,
  roots: readonly string[] | undefined,
): boolean {
  const targets = [properties.patterns, properties.resources]
    .filter((value): value is unknown[] => Array.isArray(value))
    .flat();
  return permission === "read"
    && targets.length > 0
    && targets.every((target) => isOwnAttachmentPath(target, roots));
}
