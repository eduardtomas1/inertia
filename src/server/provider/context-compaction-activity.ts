export const CLAUDE_COMPACTED_CONTEXT_TITLE = "Claude compacted context";
export const CODEX_CONTEXT_COMPACTION_TITLE = "Context compaction";
export const OPENCODE_COMPACTED_CONTEXT_TITLE = "OpenCode compacted the session context";

export function acpCompactedContextTitle(providerName: string): string {
  return `${providerName} compacted session context`;
}

export const CONTEXT_COMPACTION_ACTIVITY_TITLES: readonly string[] = Object.freeze([
  CLAUDE_COMPACTED_CONTEXT_TITLE,
  CODEX_CONTEXT_COMPACTION_TITLE,
  OPENCODE_COMPACTED_CONTEXT_TITLE,
  acpCompactedContextTitle("Cursor"),
  acpCompactedContextTitle("Kimi Code"),
]);
