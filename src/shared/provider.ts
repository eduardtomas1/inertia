/** Provider identities that existed before append-only migration lineage was introduced. */
export type LegacyProviderId = "codex" | "claude" | "cursor" | "kimi" | "opencode";

export type ProviderId = LegacyProviderId | "gemini" | "antigravity";

export const GEMINI_EXPLICIT_COMPACTION_UNAVAILABLE_REASON =
  "Gemini ACP does not expose explicit context compaction; Gemini manages its own context automatically.";
export const GEMINI_INDIVIDUAL_ACCESS_RETIRED_MESSAGE =
  "Gemini CLI no longer serves individual Google accounts. Google moved them to Antigravity: switch this chat to Antigravity, or keep Gemini CLI with a Gemini API key or a Code Assist Standard or Enterprise license.";
export const ANTIGRAVITY_EXPLICIT_COMPACTION_UNAVAILABLE_REASON =
  "Antigravity's headless mode does not expose explicit context compaction.";
