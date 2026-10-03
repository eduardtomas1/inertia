import { z } from "zod";

export const REPORT_PROVIDER_IDS = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity"] as const;
const providerIdSchema = z.enum(REPORT_PROVIDER_IDS);

export const ISSUE_REPOSITORY = "eduardtomas1/inertia";
export const ISSUE_REPOSITORY_URL = `https://github.com/${ISSUE_REPOSITORY}/issues`;
export const REPORT_TEXT_LIMIT = 8_000;
export const REPORT_BODY_LIMIT = 24_000;
export const issueReportInputSchema = z.object({
  description: z.string().trim().min(10).max(REPORT_TEXT_LIMIT),
  steps: z.string().trim().max(REPORT_TEXT_LIMIT),
  providerId: providerIdSchema.nullable(),
  attachDiagnostics: z.boolean(),
}).strict();
export const issueReportSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  status: z.enum(["preview", "failed", "submitting", "uncertain", "submitted", "retired"]),
  description: z.string().max(REPORT_TEXT_LIMIT),
  steps: z.string().max(REPORT_TEXT_LIMIT),
  providerId: providerIdSchema.nullable(),
  attachDiagnostics: z.boolean(),
  title: z.string().max(200),
  body: z.string().max(REPORT_BODY_LIMIT),
  notice: z.string().max(600),
  issueUrl: z.string().regex(/^https:\/\/github\.com\/eduardtomas1\/inertia\/issues\/[1-9][0-9]*$/u).nullable(),
}).strict();
export const ISSUE_GITHUB_STATES = ["ready", "missing", "signed-out", "offline", "rate-limited", "repository", "timeout", "unknown"] as const;
export const issueGitHubStateSchema = z.enum(ISSUE_GITHUB_STATES);
export type IssueGitHubState = typeof ISSUE_GITHUB_STATES[number];
export type IssuePublicationFailure = Exclude<IssueGitHubState, "ready">;
export type IssueReport = z.infer<typeof issueReportSchema>;
export type IssueReportInput = z.infer<typeof issueReportInputSchema>;

export function issueReportResult(value: Record<string, unknown>): boolean {
  return (value.report === null || issueReportSchema.safeParse(value.report).success)
    && (value.github === undefined || issueGitHubStateSchema.safeParse(value.github).success);
}

const SENSITIVE_REPORT_KEY = /^(?:api[_ -]?(?:key|token)|(?:access|refresh)[_ -]?token|client[_ -]?secret|password|authorization|cookies?|credentials?|secret[_ -]?(?:access[_ -]?)?key|secrets?|tokens?)$/iu;

/** Decode only short JSON field names, never arbitrary prose or field values. */
function exposeSensitiveJsonKeys(text: string): string {
  return text.replace(/"(?:\\.|[^"\\\r\n]){1,128}"(?=\s*:)/gu, (literal) => {
    try {
      const key: unknown = JSON.parse(literal);
      return typeof key === "string" && SENSITIVE_REPORT_KEY.test(key)
        ? JSON.stringify(key.toLowerCase()) : literal;
    } catch { return literal; }
  });
}

const SECRET_NAME_PART = /^(?:[A-Z0-9]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE)S?|PASS|PWD|AUTHORIZATION)$/u;
const ASSIGNMENT_NAME = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)["']?[ \t]*[:=][ \t]*/gu;
const ASSIGNMENT_VALUE = /(?!\[redacted)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\n]+)/uy;

function redactSecretAssignments(text: string): string {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(ASSIGNMENT_NAME)) {
    if (match.index < last || !match[1]!.toUpperCase().split(/[_-]/u).some((part) => SECRET_NAME_PART.test(part))) continue;
    ASSIGNMENT_VALUE.lastIndex = match.index + match[0].length;
    if (!ASSIGNMENT_VALUE.exec(text)) continue;
    result += `${text.slice(last, match.index)}[redacted secret]`;
    last = ASSIGNMENT_VALUE.lastIndex;
  }
  return result + text.slice(last);
}

/** Deliberately lossy scrub for user-authored text, never a raw-log sanitizer. */
export function scrubReportText(text: string, limit = REPORT_TEXT_LIMIT): string {
  return redactSecretAssignments(exposeSensitiveJsonKeys(text.slice(0, limit))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[redacted key]")
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/giu, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted token]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/giu, "[redacted authorization]"))
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/giu, "[redacted URL]")
    .replace(/(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|(?<![\w.~-])~?\/)[^\s<>"']+/gu, "[private path]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, "[redacted email]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, limit).trim();
}
