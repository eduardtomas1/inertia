import { z } from "zod";
import { modelSelectionSchema } from "./model-routing";

export const ISSUE_REPOSITORY = "eduardtomas1/inertia";
export const ISSUE_REPOSITORY_URL = `https://github.com/${ISSUE_REPOSITORY}/issues`;
export const REPORT_TEXT_LIMIT = 8_000;
export const REPORT_BODY_LIMIT = 24_000;
export const issueReportInputSchema = z.object({
  description: z.string().trim().min(10).max(REPORT_TEXT_LIMIT),
  projectId: z.string().uuid().nullable(),
  selection: modelSelectionSchema,
}).strict();
export const issueReportSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  status: z.enum(["draft", "validating", "preview", "cancelled", "failed", "submitting", "uncertain", "submitted", "retired"]),
  description: z.string().max(REPORT_TEXT_LIMIT),
  projectId: z.string().uuid().nullable(),
  selection: modelSelectionSchema,
  evidence: z.string().max(8_000),
  answer: z.string().max(REPORT_TEXT_LIMIT),
  title: z.string().max(200),
  body: z.string().max(REPORT_BODY_LIMIT),
  notice: z.string().max(600),
  issueUrl: z.string().regex(/^https:\/\/github\.com\/eduardtomas1\/inertia\/issues\/[1-9][0-9]*$/u).nullable(),
}).strict();
export type IssueReport = z.infer<typeof issueReportSchema>;
export type IssueReportInput = z.infer<typeof issueReportInputSchema>;

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

/** Deliberately lossy scrub for user-authored text, never a raw-log sanitizer. */
export function scrubReportText(text: string, limit = REPORT_TEXT_LIMIT): string {
  return exposeSensitiveJsonKeys(text.slice(0, limit))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[redacted key]")
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/giu, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted token]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/giu, "[redacted authorization]")
    .replace(/^.*\b(?:[A-Z][A-Z0-9_]{2,}|(?:api[_ -]?(?:key|token)|(?:access|refresh)[_ -]?token|client[_ -]?secret|password|authorization|cookies?|credentials?|secret[_ -]?(?:access[_ -]?)?key|secrets?|tokens?))["']?\s*[:=].*$/gmu, "[redacted configuration]")
    .replace(/\b(?:api[_ -]?(?:key|token)|(?:access|refresh)[_ -]?token|client[_ -]?secret|password|authorization|cookies?|credentials?|secret[_ -]?(?:access[_ -]?)?key|secrets?|tokens?)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;]+)/giu, "[redacted secret]")
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/giu, "[redacted URL]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^\s<>"']+/gu, "[private path]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, "[redacted email]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, limit).trim();
}

export function reportAllowsAgent(harnessId: string): boolean {
  // This harness has an audited native empty tools list and deny-all callback.
  return harnessId === "claude-agent-sdk";
}
