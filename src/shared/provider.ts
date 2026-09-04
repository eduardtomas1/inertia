/** Provider identities that existed before append-only migration lineage was introduced. */
export type LegacyProviderId = "codex" | "claude" | "cursor" | "kimi" | "opencode";

export type ProviderId = LegacyProviderId | "gemini";

export const GEMINI_EXPLICIT_COMPACTION_UNAVAILABLE_REASON =
  "Gemini ACP does not expose explicit context compaction; Gemini manages its own context automatically.";
