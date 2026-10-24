import { objectValue, type JsonObject } from "./protocol";

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
  "tools.experimental_request_user_input.enabled",
] as const;

export function disabledCodexMcpServers(config: JsonObject): JsonObject {
  const servers = objectValue(objectValue(config.config)?.mcp_servers) ?? {};
  return Object.fromEntries(Object.keys(servers).map((name) => [name, { enabled: false }]));
}

export function codexWatcherThreadConfig(config: JsonObject): JsonObject {
  return {
    ...Object.fromEntries(CODEX_WATCHER_DISABLED_CONFIG_KEYS.map((key) => [key, false])),
    web_search: "disabled",
    default_permissions: ":read-only",
    mcp_servers: disabledCodexMcpServers(config),
  };
}
