import type { ProviderId } from "@shared/contracts";

const DRAFT_KEY = "inertia:issue-report-draft:v1";

export interface IssueReportDraft {
  reportId: string | null;
  revision: number | null;
  view: "form" | "preview";
  description: string;
  steps: string;
  providerId: ProviderId | "";
  attachDiagnostics: boolean;
  title: string;
  body: string;
}

function validDraft(value: unknown): value is IssueReportDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (draft.reportId === null || typeof draft.reportId === "string")
    && (draft.revision === null || typeof draft.revision === "number")
    && (draft.view === "form" || draft.view === "preview")
    && typeof draft.description === "string"
    && typeof draft.steps === "string"
    && typeof draft.providerId === "string"
    && typeof draft.attachDiagnostics === "boolean"
    && typeof draft.title === "string"
    && typeof draft.body === "string";
}

export function readIssueReportDraft(reportId: string | null, revision: number | null): IssueReportDraft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    const draft: unknown = raw ? JSON.parse(raw) : null;
    return validDraft(draft) && draft.reportId === reportId && draft.revision === revision ? draft : null;
  } catch {
    return null;
  }
}

export function writeIssueReportDraft(draft: IssueReportDraft): void {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    return;
  }
}
