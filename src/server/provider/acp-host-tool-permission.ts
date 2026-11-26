import type {
  PermissionOption,
  RequestPermissionRequest,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";

import { INERTIA_HOST_MCP_NAME } from "./host-tool-mcp-config";

const DISALLOWED_KINDS = new Set<ToolKind>(["execute", "edit", "delete", "move"]);
const NAME_PREFIXES = [
  `mcp__${INERTIA_HOST_MCP_NAME}__`,
  `${INERTIA_HOST_MCP_NAME}_`,
  `${INERTIA_HOST_MCP_NAME}/`,
] as const;
const SERVER_META_KEYS = ["server", "serverName", "mcpServer", "mcp_server", "server_name"] as const;
const TOOL_META_KEYS = ["tool", "toolName", "mcpTool", "mcp_tool", "tool_name"] as const;

type MetaVerdict = "match" | "conflict" | "none";

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function registeredToolFromNormalizedName(
  raw: unknown,
  registeredToolNames: ReadonlySet<string>,
): string | null {
  const value = nonEmptyString(raw);
  if (!value) return null;
  for (const prefix of NAME_PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const tool = value.slice(prefix.length);
    return registeredToolNames.has(tool) ? tool : null;
  }
  return null;
}

function firstMetaString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function inspectMetaRecord(
  record: Record<string, unknown>,
  registeredToolNames: ReadonlySet<string>,
  allowNameAsTool: boolean,
): MetaVerdict {
  const server = firstMetaString(record, SERVER_META_KEYS);
  const tool = firstMetaString(
    record,
    allowNameAsTool ? [...TOOL_META_KEYS, "name"] : TOOL_META_KEYS,
  );
  if (server !== null) {
    if (server !== INERTIA_HOST_MCP_NAME) return "conflict";
    if (tool === null) return "none";
    return registeredToolNames.has(tool)
      || registeredToolFromNormalizedName(tool, registeredToolNames) !== null
      ? "match"
      : "conflict";
  }
  if (tool !== null) {
    return registeredToolFromNormalizedName(tool, registeredToolNames) !== null
      ? "match"
      : "conflict";
  }
  return "none";
}

function inspectMeta(
  meta: unknown,
  registeredToolNames: ReadonlySet<string>,
): MetaVerdict {
  const record = plainRecord(meta);
  if (!record) return "none";
  const top = inspectMetaRecord(record, registeredToolNames, false);
  const nestedMcp = plainRecord(record.mcp);
  const nested = nestedMcp ? inspectMetaRecord(nestedMcp, registeredToolNames, true) : "none";
  if (top === "conflict" || nested === "conflict") return "conflict";
  if (top === "match" || nested === "match") return "match";
  return "none";
}

/**
 * Returns true only when an ACP permission request unambiguously identifies an
 * exact registered Inertia host MCP tool on `inertia-chat-manager`, resisting
 * spoofed titles, foreign servers, and dangerous execution/mutation kinds.
 */
export function isInertiaHostMcpPermissionRequest(
  params: Pick<RequestPermissionRequest, "toolCall" | "_meta">,
  registeredToolNames: ReadonlySet<string>,
): boolean {
  if (registeredToolNames.size === 0) return false;
  if (params.toolCall.kind && DISALLOWED_KINDS.has(params.toolCall.kind)) return false;

  const toolMeta = inspectMeta(params.toolCall._meta, registeredToolNames);
  const requestMeta = inspectMeta(params._meta, registeredToolNames);
  if (toolMeta === "conflict" || requestMeta === "conflict") return false;
  const metaMatched = toolMeta === "match" || requestMeta === "match";

  const programmaticName = nonEmptyString(params.toolCall.name);
  if (programmaticName !== null) {
    if (registeredToolFromNormalizedName(programmaticName, registeredToolNames) !== null) {
      return true;
    }
    return metaMatched && registeredToolNames.has(programmaticName);
  }
  return metaMatched;
}

/** Selects `allow_once` (falling back to `allow_always`) for Inertia host MCP auto-allow. */
export function acpHostMcpAllowOption(
  options: readonly PermissionOption[],
): PermissionOption | undefined {
  return options.find(({ kind }) => kind === "allow_once")
    ?? options.find(({ kind }) => kind === "allow_always");
}
