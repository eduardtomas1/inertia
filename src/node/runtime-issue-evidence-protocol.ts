export const ISSUE_DIAGNOSTICS_MAX_BYTES = 6_000;
export const ISSUE_OS_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z .+_()-]{0,63}$/u;

export interface IssueHostEvidence {
  channel: "stable" | "canary";
  osVersion: string | null;
  diagnostics: string;
}

export interface RuntimeIssueEvidenceRequest {
  type: "runtime.issue-evidence-request";
  requestId: string;
  attachDiagnostics: boolean;
}

export type RuntimeIssueEvidenceResult =
  | { type: "runtime.issue-evidence-result"; requestId: string; ok: true; evidence: IssueHostEvidence }
  | { type: "runtime.issue-evidence-result"; requestId: string; ok: false };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function identified(value: unknown, type: string, keys: number): value is Record<string, unknown> & { requestId: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys
    && "type" in value && value.type === type
    && "requestId" in value && typeof value.requestId === "string" && UUID_PATTERN.test(value.requestId);
}

export function parseIssueHostEvidence(value: unknown): IssueHostEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 3) return null;
  const { channel, osVersion, diagnostics } = value as Record<string, unknown>;
  if (channel !== "stable" && channel !== "canary") return null;
  if (osVersion !== null && (typeof osVersion !== "string" || !ISSUE_OS_VERSION_PATTERN.test(osVersion))) return null;
  if (typeof diagnostics !== "string" || Buffer.byteLength(diagnostics) > ISSUE_DIAGNOSTICS_MAX_BYTES) return null;
  return { channel, osVersion, diagnostics };
}

export function parseRuntimeIssueEvidenceRequest(value: unknown): RuntimeIssueEvidenceRequest | null {
  if (!identified(value, "runtime.issue-evidence-request", 3) || typeof value.attachDiagnostics !== "boolean") return null;
  return { type: "runtime.issue-evidence-request", requestId: value.requestId, attachDiagnostics: value.attachDiagnostics };
}

export function parseRuntimeIssueEvidenceResult(value: unknown): RuntimeIssueEvidenceResult | null {
  if (identified(value, "runtime.issue-evidence-result", 3) && value.ok === false) {
    return { type: "runtime.issue-evidence-result", requestId: value.requestId, ok: false };
  }
  if (!identified(value, "runtime.issue-evidence-result", 4) || value.ok !== true) return null;
  const evidence = parseIssueHostEvidence(value.evidence);
  return evidence ? { type: "runtime.issue-evidence-result", requestId: value.requestId, ok: true, evidence } : null;
}
