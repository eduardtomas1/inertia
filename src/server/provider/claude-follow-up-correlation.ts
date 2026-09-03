const MAX_CLAUDE_RESULT_USER_MESSAGE_UUIDS = 64;

/**
 * Prefer the current coalesced correlation list. Older SDK producers only
 * stamp the singular field, which remains the compatibility fallback.
 */
export function claudeResultUserMessageIds(
  record: Record<string, unknown>,
): string[] {
  if (Array.isArray(record.user_message_uuids)) {
    const coalesced = record.user_message_uuids
      .slice(0, MAX_CLAUDE_RESULT_USER_MESSAGE_UUIDS)
      .filter((value): value is string =>
        typeof value === "string" && value.length > 0);
    if (coalesced.length > 0) return coalesced;
  }
  const legacy = record.user_message_uuid;
  return typeof legacy === "string" && legacy.length > 0 ? [legacy] : [];
}
