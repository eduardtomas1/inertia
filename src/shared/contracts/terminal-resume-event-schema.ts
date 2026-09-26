/** The session and conversation identities are always supplied together. */
export function optionalTerminalResumeEvent(value: Record<string, unknown>): boolean {
  if (value.providerResume === undefined) return value.providerResumeConversationId === undefined;
  const resume = value.providerResume;
  if (!resume || typeof resume !== "object" || Array.isArray(resume)) return false;
  const fields = resume as Record<string, unknown>;
  return typeof fields.providerId === "string"
    && ["codex", "claude", "cursor", "kimi", "opencode", "antigravity"].includes(fields.providerId)
    && typeof fields.providerLabel === "string" && fields.providerLabel.length > 0
    && typeof fields.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(fields.sessionId)
    && typeof value.providerResumeConversationId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.providerResumeConversationId);
}
