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
