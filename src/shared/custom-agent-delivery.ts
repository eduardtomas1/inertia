import type { ProviderId } from "./provider";

export const CUSTOM_AGENT_DELIVERIES = ["subagent", "in-role"] as const;
export type CustomAgentDelivery = typeof CUSTOM_AGENT_DELIVERIES[number];

const CUSTOM_AGENT_DELIVERY_BY_PROVIDER: Readonly<Record<ProviderId, CustomAgentDelivery>> = {
  claude: "subagent",
  codex: "subagent",
  opencode: "subagent",
  cursor: "subagent",
  kimi: "in-role",
  antigravity: "in-role",
  grok: "in-role",
};

export function customAgentDelivery(providerId: ProviderId): CustomAgentDelivery {
  return CUSTOM_AGENT_DELIVERY_BY_PROVIDER[providerId];
}
