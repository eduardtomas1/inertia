const MISSING_SESSION = /\b(?:session|conversation|resource)\b[^.\n]{0,80}\b(?:not found|does not exist|no longer exists)\b|\b(?:no such|unknown|invalid) session\b/iu;
const RESUME_UNSUPPORTED = /does not advertise session resume support/iu;
const ACP_RESUME_STEPS = new Set(["session/load", "session/resume"]);
const UNRELATED_MISSING = /\b(?:cwd|working directory|directory|folder|workspace|model|file|path|config)\b[^.\n]{0,80}\b(?:not found|does not exist|no longer exists)\b|\bmissing field\b|\bnot found:\s{0,8}file:/iu;
const NAMED_PATH = /(?:^|[\s'"`(=:,])(?:\/[^\s/]|~\/|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\[^\s\\])|\bfile:\/\//u;

export function namesUnrelatedMissingResource(detail: string): boolean {
  return UNRELATED_MISSING.test(detail) || NAMED_PATH.test(detail);
}

export function acpSessionUnavailable(terminalEvent: string, detail: string): boolean {
  return ACP_RESUME_STEPS.has(terminalEvent)
    && !namesUnrelatedMissingResource(detail)
    && (RESUME_UNSUPPORTED.test(detail) || MISSING_SESSION.test(detail));
}

export function openCodeSessionUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const data = typeof record.data === "object" && record.data !== null
    ? record.data as Record<string, unknown>
    : {};
  const messages = [record.message, data.message]
    .filter((message): message is string => typeof message === "string");
  if (messages.some(namesUnrelatedMissingResource)) return false;
  return record.name === "NotFoundError"
    || messages.some((message) => /\bsession not found\b/iu.test(message));
}
