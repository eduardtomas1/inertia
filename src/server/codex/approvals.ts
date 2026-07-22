import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { boundedText, objectValue, type JsonObject } from "./protocol";
import type {
  CodexApprovalDecision,
  CodexApprovalNetworkScope,
  CodexApprovalPermissionRoot,
  CodexApprovalRequest,
} from "./types";

const MAX_PERMISSION_ROOTS = 12;

export interface ParsedCodexApprovalRequest {
  request: CodexApprovalRequest;
  protocol: "decision" | "permissions";
  requestedPermissions?: JsonObject;
}

function normalizedFilesystemPath(value: unknown): string | undefined {
  const path = boundedText(value, 4_096);
  return path && isAbsolute(path) ? normalize(path) : path;
}

function permissionPath(value: unknown): string | undefined {
  const path = objectValue(value);
  if (!path) return undefined;
  if (path.type === "path") return normalizedFilesystemPath(path.path);
  if (path.type === "glob_pattern") {
    const pattern = boundedText(path.pattern, 4_080);
    return pattern ? `glob: ${pattern}` : undefined;
  }
  if (path.type !== "special") return undefined;
  const special = objectValue(path.value);
  const kind = boundedText(special?.kind, 80);
  if (!kind) return undefined;
  const base = kind === "root" ? "/" : kind.replaceAll("_", " ");
  const subpath = boundedText(special?.subpath, 4_000);
  return subpath ? `${base}: ${subpath}` : base;
}

function permissionRoots(value: unknown): CodexApprovalPermissionRoot[] {
  const profile = objectValue(value);
  const fileSystem = objectValue(profile?.fileSystem);
  if (!fileSystem) return [];
  const roots: CodexApprovalPermissionRoot[] = [];
  const seen = new Set<string>();
  const add = (path: unknown, access: "read" | "write", filesystemPath = true): void => {
    const bounded = filesystemPath ? normalizedFilesystemPath(path) : boundedText(path, 4_096);
    if (!bounded || roots.length >= MAX_PERMISSION_ROOTS) return;
    const key = `${access}\0${bounded}`;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path: bounded, access });
  };
  for (const path of Array.isArray(fileSystem.read) ? fileSystem.read : []) add(path, "read");
  for (const path of Array.isArray(fileSystem.write) ? fileSystem.write : []) add(path, "write");
  for (const value of Array.isArray(fileSystem.entries) ? fileSystem.entries : []) {
    if (roots.length >= MAX_PERMISSION_ROOTS) break;
    const entry = objectValue(value);
    if (entry?.access !== "read" && entry?.access !== "write") continue;
    const typedPath = objectValue(entry.path);
    add(permissionPath(entry.path), entry.access, typedPath?.type === "path");
  }
  return roots;
}

function networkScope(value: unknown): CodexApprovalNetworkScope | undefined {
  const context = objectValue(value);
  const host = boundedText(context?.host, 512);
  const protocol = context?.protocol;
  if (!host || (protocol !== "http" && protocol !== "https" && protocol !== "socks5Tcp" && protocol !== "socks5Udp")) return undefined;
  return { host, protocol };
}

export function parseCodexApprovalRequest(method: string, params: JsonObject): ParsedCodexApprovalRequest | undefined {
  const requestId = randomUUID();
  const command = boundedText(params.command, 4_000);
  const cwd = normalizedFilesystemPath(params.cwd);
  const reason = boundedText(params.reason, 1_000);
  const additionalPermissions = objectValue(params.additionalPermissions);
  const requestedNetworkScope = networkScope(params.networkApprovalContext);
  const requestedPermissionRoots = permissionRoots(additionalPermissions);
  const decisionMap: Record<string, CodexApprovalDecision> = {
    accept: "approve",
    decline: "deny",
    cancel: "cancel",
  };
  const rawAdvertisedDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
  const advertised: CodexApprovalDecision[] = rawAdvertisedDecisions
    ? rawAdvertisedDecisions.flatMap((value): CodexApprovalDecision[] => typeof value === "string" && decisionMap[value] ? [decisionMap[value]] : [])
    : [];
  const availableDecisions: CodexApprovalDecision[] = rawAdvertisedDecisions
    ? [...new Set(advertised)]
    : ["approve", "deny", "cancel"];

  if (method === "item/commandExecution/requestApproval") {
    return {
      protocol: "decision",
      request: {
        requestId,
        kind: "command",
        title: "Approve command",
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        ...(requestedNetworkScope ? { networkScope: requestedNetworkScope } : {}),
        permissionRoots: requestedPermissionRoots,
        detail: command ?? reason ?? "Codex wants to run a command.",
        availableDecisions,
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const grantRoot = normalizedFilesystemPath(params.grantRoot);
    return {
      protocol: "decision",
      request: {
        requestId,
        kind: "file-change",
        title: "Approve file changes",
        ...(grantRoot ? { cwd: grantRoot } : {}),
        ...(reason ? { reason } : {}),
        permissionRoots: grantRoot ? [{ path: grantRoot, access: "write" }] : [],
        detail: reason ?? (grantRoot ? `Allow changes under ${grantRoot}` : "Codex wants to change project files."),
        availableDecisions,
      },
    };
  }
  if (method === "item/permissions/requestApproval") {
    const requestedPermissions = objectValue(params.permissions);
    if (!requestedPermissions) return undefined;
    const roots = permissionRoots(requestedPermissions);
    const network = objectValue(requestedPermissions.network);
    return {
      protocol: "permissions",
      requestedPermissions,
      request: {
        requestId,
        kind: "permissions",
        title: "Approve additional access",
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        permissionRoots: roots,
        detail: reason ?? (network?.enabled === true ? "Codex requests network access." : "Codex requests additional file access."),
        availableDecisions: ["approve", "deny", "cancel"],
      },
    };
  }
  return undefined;
}
