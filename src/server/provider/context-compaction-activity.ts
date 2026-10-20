/**
 * Titles of the activities providers record when they compact a session's
 * context on their own (automatic compaction while a turn runs). Kept in one
 * place because more than the timeline depends on them: material shared with
 * a session earlier, such as the initiative brief, is no longer reliably in
 * its context once one of these is recorded, so it is sent again.
 */
export const CLAUDE_COMPACTING_CONTEXT_TITLE = "Claude is compacting context";
export const CLAUDE_COMPACTED_CONTEXT_TITLE = "Claude compacted context";
/** Codex reports compaction as one `contextCompaction` item, started then completed. */
export const CODEX_CONTEXT_COMPACTION_TITLE = "Context compaction";
export const OPENCODE_COMPACTED_CONTEXT_TITLE = "OpenCode compacted the session context";

/** Providers whose ACP integration reports negotiated context compaction. */
export const ACP_COMPACTION_PROVIDER_NAMES = ["Cursor", "Kimi Code"] as const;
export type AcpCompactionProviderName = typeof ACP_COMPACTION_PROVIDER_NAMES[number];

export function acpCompactingContextTitle(providerName: AcpCompactionProviderName): string {
  return `${providerName} is compacting session context`;
}

export function acpCompactedContextTitle(providerName: AcpCompactionProviderName): string {
  return `${providerName} compacted session context`;
}

/** The prefix a running activity receives when its turn ends before it completes. */
export const INTERRUPTED_ACTIVITY_TITLE_PREFIX = "Interrupted · ";

/**
 * Every stored title that means a compaction began or completed. A started
 * compaction counts too: once begun, the provider may already have dropped
 * earlier context. Failed and cancelled compactions leave the context as it was.
 */
export const PROVIDER_CONTEXT_COMPACTION_ACTIVITY_TITLES: readonly string[] = (() => {
  const titles = [
    CLAUDE_COMPACTING_CONTEXT_TITLE,
    CLAUDE_COMPACTED_CONTEXT_TITLE,
    CODEX_CONTEXT_COMPACTION_TITLE,
    OPENCODE_COMPACTED_CONTEXT_TITLE,
    ...ACP_COMPACTION_PROVIDER_NAMES.flatMap((name) => [
      acpCompactingContextTitle(name),
      acpCompactedContextTitle(name),
    ]),
  ];
  return [...titles, ...titles.map((title) => `${INTERRUPTED_ACTIVITY_TITLE_PREFIX}${title}`)];
})();
