const MISSING_SESSION = /\b(?:not found|no such|unknown session|does not exist|invalid session)\b/iu;

export function acpSessionUnavailable(terminalEvent: string, detail: string): boolean {
  return (terminalEvent === "session/load" || terminalEvent === "session/resume")
    && MISSING_SESSION.test(detail);
}

export function openCodeSessionUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const data = typeof record.data === "object" && record.data !== null
    ? record.data as Record<string, unknown>
    : {};
  return record.name === "NotFoundError"
    || [record.message, data.message].some((message) =>
      typeof message === "string" && /\bsession not found\b/iu.test(message));
}
