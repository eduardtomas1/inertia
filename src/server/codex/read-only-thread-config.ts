import { objectValue, type JsonObject } from "./protocol";

/**
 * Codex extensions that run outside the turn's read-only sandbox or widen what
 * a read-only watcher thread can reach. The shell stays available, so the
 * watcher can still run known-safe read commands inside the sandbox.
 */
export const CODEX_WATCHER_DISABLED_CONFIG_KEYS = [
  "cloud.skills.enabled",
  "features.apps",
  "features.enable_fanout",
  "features.hooks",
  "features.image_generation",
  "features.memories",
  "features.multi_agent",
  "features.multi_agent_v2",
  "features.plugins",
  "features.request_permissions_tool",
  "features.standalone_web_search",
  "features.tool_suggest",
] as const;

/** Every MCP server the user's Codex configuration defines, disabled for this thread. */
export function disabledCodexMcpServers(config: JsonObject): JsonObject {
  const servers = objectValue(objectValue(config.config)?.mcp_servers) ?? {};
  return Object.fromEntries(Object.keys(servers).map((name) => [name, { enabled: false }]));
}

/** Thread configuration overrides for a read-only watcher thread, from the effective `config/read` result. */
export function codexWatcherThreadConfig(config: JsonObject): JsonObject {
  return {
    ...Object.fromEntries(CODEX_WATCHER_DISABLED_CONFIG_KEYS.map((key) => [key, false])),
    web_search: "disabled",
    default_permissions: ":read-only",
    mcp_servers: disabledCodexMcpServers(config),
  };
}
