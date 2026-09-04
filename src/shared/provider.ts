/** Provider identities that existed before append-only migration lineage was introduced. */
export type LegacyProviderId = "codex" | "claude" | "cursor" | "kimi" | "opencode";

export type ProviderId = LegacyProviderId | "gemini";
