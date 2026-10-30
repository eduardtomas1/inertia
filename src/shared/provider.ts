/** Provider identities that existed before append-only migration lineage was introduced. */
export type LegacyProviderId = "codex" | "claude" | "cursor" | "kimi" | "opencode";

export type ProviderId = LegacyProviderId | "antigravity" | "pi";

export const PROVIDER_AUTH_METHODS = ["account", "console"] as const;

export const PROVIDER_ACCOUNT_KINDS = [
  "Claude account",
  "Console API key",
  "ChatGPT account",
  "OpenAI API key",
] as const;

export type ProviderAccountKind = (typeof PROVIDER_ACCOUNT_KINDS)[number];

export type ProviderAuthMethod = (typeof PROVIDER_AUTH_METHODS)[number];

export function providerSupportsAuthMethod(
  providerId: ProviderId,
  method: ProviderAuthMethod,
): boolean {
  return method === "account" || providerId === "claude";
}

export const ANTIGRAVITY_IMAGE_INPUT_UNAVAILABLE_REASON =
  "Antigravity can't read images in Inertia.";

export function harnessImageInputUnavailableReason(harnessId: string): string | null {
  return harnessId === "antigravity-cli" ? ANTIGRAVITY_IMAGE_INPUT_UNAVAILABLE_REASON : null;
}

export const ANTIGRAVITY_EXPLICIT_COMPACTION_UNAVAILABLE_REASON =
  "Antigravity's headless mode does not expose explicit context compaction.";

export const KIMI_EXPLICIT_COMPACTION_UNAVAILABLE_REASON =
  "Kimi Code compacts context in the background and does not report when it finishes, so Inertia can't confirm explicit compaction.";
