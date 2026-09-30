const MISSING_SESSION = /\b(?:session|conversation|resource)\b[^.\n]{0,80}\b(?:not found|does not exist|no longer exists)\b|\b(?:no such|unknown|invalid) session\b/iu;
const RESUME_UNSUPPORTED = /does not advertise session resume support/iu;

export function acpSessionUnavailable(terminalEvent: string, detail: string): boolean {
  return RESUME_UNSUPPORTED.test(detail)
    || ((terminalEvent === "session/load" || terminalEvent === "session/resume")
      && MISSING_SESSION.test(detail));
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
