const MAX_CLAUDE_RESULT_USER_MESSAGE_UUIDS = 64;

/**
 * Prefer the current coalesced correlation list. Older SDK producers only
 * stamp the singular field, which remains the compatibility fallback.
 */
export function claudeResultUserMessageIds(
  record: Record<string, unknown>,
  pendingIds?: ReadonlySet<string>,
): string[] {
  if (Array.isArray(record.user_message_uuids)) {
    const coalesced = new Set<string>();
    let firstUsablePluralId: string | undefined;
    for (const value of record.user_message_uuids) {
      if (typeof value !== "string" || value.length === 0) continue;
      firstUsablePluralId ??= value;
      if (pendingIds && !pendingIds.has(value)) continue;
      coalesced.add(value);
      if (!pendingIds && coalesced.size >= MAX_CLAUDE_RESULT_USER_MESSAGE_UUIDS) break;
    }
    if (coalesced.size > 0) return [...coalesced];
    if (firstUsablePluralId) return [firstUsablePluralId];
  }
  const legacy = record.user_message_uuid;
  return typeof legacy === "string" && legacy.length > 0 ? [legacy] : [];
}
