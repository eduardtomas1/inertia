import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { objectValue, type JsonObject } from "./protocol";
import type {
  AgentApprovalDecision,
  AgentApprovalNetworkScope,
  AgentApprovalPermissionRoot,
  AgentApprovalRequest,
} from "../provider/interactions";

const MAX_PERMISSION_ROOTS = 12;
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export interface ParsedCodexApprovalRequest {
  request: AgentApprovalRequest;
  protocol: "decision" | "permissions";
  requestedPermissions?: JsonObject;
}

export function isCodexApprovalRequestMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}

interface PermissionProjection {
  permissions: JsonObject;
  roots: AgentApprovalPermissionRoot[];
}

function strictBoundedText(
  value: unknown,
  maxChars: number,
  rejectControlCharacters = true,
): string | undefined {
  if (
    typeof value !== "string"
    || (
      rejectControlCharacters
        ? /[\u0000-\u001f\u007f]/u.test(value)
        : value.includes("\0")
    )
    || value.length > maxChars
  ) return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function exactFilesystemPath(value: unknown): string | undefined {
  const path = strictBoundedText(value, 4_096);
  return path
    && isAbsolute(path)
    ? path
    : undefined;
}

function hasOnlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function permissionPath(value: unknown): {
  display: string;
  value: JsonObject;
} | undefined {
  const path = objectValue(value);
  if (!path) return undefined;
  if (path.type === "path") {
    if (!hasOnlyKeys(path, ["type", "path"])) return undefined;
    const exact = exactFilesystemPath(path.path);
    return exact
      ? { display: exact, value: { type: "path", path: exact } }
      : undefined;
  }
  if (path.type === "glob_pattern") {
    if (!hasOnlyKeys(path, ["type", "pattern"])) return undefined;
    const pattern = strictBoundedText(path.pattern, 4_080);
    return pattern
      ? {
          display: `glob: ${pattern}`,
          value: { type: "glob_pattern", pattern },
        }
      : undefined;
  }
  if (path.type !== "special") return undefined;
  if (!hasOnlyKeys(path, ["type", "value"])) return undefined;
  const special = objectValue(path.value);
  if (!special || !hasOnlyKeys(special, ["kind", "subpath"])) return undefined;
  const kind = strictBoundedText(special?.kind, 80);
  if (!kind || kind !== kind.trim()) return undefined;
  const base = kind === "root" ? "/" : kind.replaceAll("_", " ");
  const hasSubpath = Object.prototype.hasOwnProperty.call(special, "subpath");
  const subpath = hasSubpath
    ? strictBoundedText(special.subpath, 4_000)
    : undefined;
  if (hasSubpath && !subpath) return undefined;
  return {
    display: subpath ? `${base}: ${subpath}` : base,
    value: {
      type: "special",
      value: {
        kind,
        ...(subpath ? { subpath } : {}),
      },
    },
  };
}

function permissionProjection(value: unknown): PermissionProjection | undefined {
  const profile = objectValue(value);
  if (!profile || !hasOnlyKeys(profile, ["network", "fileSystem"])) {
    return undefined;
  }
  const permissions: JsonObject = {};
  const roots: AgentApprovalPermissionRoot[] = [];
  const seen = new Set<string>();
  const add = (
    display: string,
    access: "read" | "write",
  ): "added" | "duplicate" | "overflow" => {
    const key = `${access}\0${display}`;
    if (seen.has(key)) return "duplicate";
    if (roots.length >= MAX_PERMISSION_ROOTS) return "overflow";
    seen.add(key);
    roots.push({ path: display, access });
    return "added";
  };

  if (Object.prototype.hasOwnProperty.call(profile, "network")) {
    if (profile.network === null) {
      permissions.network = null;
    } else {
      const network = objectValue(profile.network);
      if (
        !network
        || !hasOnlyKeys(network, ["enabled"])
        || typeof network.enabled !== "boolean"
      ) return undefined;
      permissions.network = { enabled: network.enabled };
    }
  }

  if (!Object.prototype.hasOwnProperty.call(profile, "fileSystem")) {
    return { permissions, roots };
  }
  if (profile.fileSystem === null) {
    permissions.fileSystem = null;
    return { permissions, roots };
  }
  const fileSystem = objectValue(profile.fileSystem);
  if (
    !fileSystem
    || !hasOnlyKeys(fileSystem, ["read", "write", "entries"])
  ) return undefined;
  const canonicalFileSystem: JsonObject = {};

  for (const access of ["read", "write"] as const) {
    if (!Object.prototype.hasOwnProperty.call(fileSystem, access)) continue;
    const rawPaths = fileSystem[access];
    if (rawPaths === null) {
      canonicalFileSystem[access] = null;
      continue;
    }
    if (!Array.isArray(rawPaths)) return undefined;
    const paths: string[] = [];
    for (const rawPath of rawPaths) {
      const path = exactFilesystemPath(rawPath);
      if (!path) return undefined;
      const result = add(path, access);
      if (result === "overflow") return undefined;
      if (result === "added") paths.push(path);
    }
    canonicalFileSystem[access] = paths;
  }

  if (Object.prototype.hasOwnProperty.call(fileSystem, "entries")) {
    if (fileSystem.entries === null) {
      canonicalFileSystem.entries = null;
    } else {
      if (!Array.isArray(fileSystem.entries)) return undefined;
      const entries: JsonObject[] = [];
      for (const value of fileSystem.entries) {
        const entry = objectValue(value);
        if (
          !entry
          || !hasOnlyKeys(entry, ["access", "path"])
          || (entry.access !== "read" && entry.access !== "write")
        ) return undefined;
        const path = permissionPath(entry.path);
        if (!path) return undefined;
        const result = add(path.display, entry.access);
        if (result === "overflow") return undefined;
        if (result === "added") {
          entries.push({ access: entry.access, path: path.value });
        }
      }
      canonicalFileSystem.entries = entries;
    }
  }
  permissions.fileSystem = canonicalFileSystem;
  return { permissions, roots };
}

function networkScope(value: unknown): AgentApprovalNetworkScope | undefined {
  const context = objectValue(value);
  if (!context || !hasOnlyKeys(context, ["host", "protocol"])) {
    return undefined;
  }
  const host = strictBoundedText(context?.host, 512);
  const protocol = context?.protocol;
  if (
    !host
    || host !== host.trim()
    || (
      protocol !== "http"
      && protocol !== "https"
      && protocol !== "socks5Tcp"
      && protocol !== "socks5Udp"
    )
  ) return undefined;
  return { host, protocol };
}

export function parseCodexApprovalRequest(method: string, params: JsonObject): ParsedCodexApprovalRequest | undefined {
  const requestId = randomUUID();
  const command = strictBoundedText(params.command, 4_000);
  const cwd = exactFilesystemPath(params.cwd);
  const reason = strictBoundedText(params.reason, 1_000, false);
  const hasAdditionalPermissions = Object.prototype.hasOwnProperty.call(
    params,
    "additionalPermissions",
  );
  const additionalPermissions = objectValue(params.additionalPermissions);
  if (
    Object.prototype.hasOwnProperty.call(params, "command")
    && !command
  ) return undefined;
  if (
    Object.prototype.hasOwnProperty.call(params, "cwd")
    && params.cwd !== null
    && !cwd
  ) return undefined;
  if (
    hasAdditionalPermissions
    && params.additionalPermissions !== null
    && !additionalPermissions
  ) return undefined;
  const additionalPermissionProjection = additionalPermissions
    ? permissionProjection(additionalPermissions)
    : undefined;
  if (additionalPermissions && !additionalPermissionProjection) return undefined;
  const requestedNetworkScope = networkScope(params.networkApprovalContext);
  if (
    Object.prototype.hasOwnProperty.call(params, "networkApprovalContext")
    && params.networkApprovalContext !== null
    && !requestedNetworkScope
  ) return undefined;
  const requestedPermissionRoots = additionalPermissionProjection?.roots ?? [];
  const decisionMap: Record<string, AgentApprovalDecision> = {
    accept: "approve",
    decline: "deny",
    cancel: "cancel",
  };
  const hasAdvertisedDecisions = Object.prototype.hasOwnProperty.call(
    params,
    "availableDecisions",
  );
  const rawAdvertisedDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : undefined;
  if (hasAdvertisedDecisions && !rawAdvertisedDecisions) return undefined;
  if (
    rawAdvertisedDecisions
    && (
      rawAdvertisedDecisions.length === 0
      || rawAdvertisedDecisions.length > 3
      || rawAdvertisedDecisions.some(
        (value) => typeof value !== "string" || !decisionMap[value],
      )
    )
  ) return undefined;
  const advertised: AgentApprovalDecision[] = rawAdvertisedDecisions
    ? rawAdvertisedDecisions.flatMap((value): AgentApprovalDecision[] => typeof value === "string" && decisionMap[value] ? [decisionMap[value]] : [])
    : [];
  const availableDecisions: AgentApprovalDecision[] = rawAdvertisedDecisions
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
    const grantRoot = exactFilesystemPath(params.grantRoot);
    if (
      Object.prototype.hasOwnProperty.call(params, "grantRoot")
      && params.grantRoot !== null
      && !grantRoot
    ) return undefined;
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
    const projection = permissionProjection(requestedPermissions);
    if (!projection) return undefined;
    const network = objectValue(projection.permissions.network);
    return {
      protocol: "permissions",
      requestedPermissions: projection.permissions,
      request: {
        requestId,
        kind: "permissions",
        title: "Approve additional access",
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        permissionRoots: projection.roots,
        detail: reason ?? (network?.enabled === true ? "Codex requests network access." : "Codex requests additional file access."),
        availableDecisions: ["approve", "deny", "cancel"],
      },
    };
  }
  return undefined;
}
