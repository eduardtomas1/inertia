/** Provider identities that existed before append-only migration lineage was introduced. */
export type LegacyProviderId = "codex" | "claude" | "cursor" | "kimi" | "opencode";

export type ProviderId = LegacyProviderId | "antigravity";

export const ANTIGRAVITY_IMAGE_INPUT_UNAVAILABLE_REASON =
  "Antigravity can't read images in Inertia.";

export function harnessImageInputUnavailableReason(harnessId: string): string | null {
  return harnessId === "antigravity-cli" ? ANTIGRAVITY_IMAGE_INPUT_UNAVAILABLE_REASON : null;
}

export const ANTIGRAVITY_EXPLICIT_COMPACTION_UNAVAILABLE_REASON =
  "Antigravity's headless mode does not expose explicit context compaction.";
