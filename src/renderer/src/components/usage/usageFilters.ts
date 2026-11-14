import type { UsageAccount, UsageLimitsSnapshot } from "@shared/provider-usage-limits";

export const ALL_USAGE_SOURCES = "all";
export const LOCAL_USAGE_SOURCE = "local";

interface UsageProviderOption {
  id: string;
  label: string;
}

const KNOWN_PROVIDERS: readonly UsageProviderOption[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "kimi", label: "Kimi Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "antigravity", label: "Antigravity" },
  { id: "grok", label: "Grok" },
];

export function accountMatchesSource(
  account: UsageAccount,
  source: string,
  sources: UsageLimitsSnapshot["sources"],
): boolean {
  if (source === ALL_USAGE_SOURCES) return true;
  if (source === LOCAL_USAGE_SOURCE) {
    return !account.id.startsWith("hub:") || account.sources.includes("This computer");
  }
  const hub = sources.find(({ id }) => id === source);
  return account.id.startsWith(`hub:${source}:`) || (hub !== undefined && account.sources.includes(hub.label));
}

export function usageProviderOptions(snapshot: UsageLimitsSnapshot | null): UsageProviderOption[] {
  const options = new Map(KNOWN_PROVIDERS.map((option) => [option.id, option]));
  for (const { providerId, providerLabel } of snapshot?.accounts ?? []) {
    if (options.has(providerId)) continue;
    options.set(providerId, { id: providerId, label: providerId === "custom" ? "Custom backends" : providerLabel });
  }
  return [...options.values()];
}
