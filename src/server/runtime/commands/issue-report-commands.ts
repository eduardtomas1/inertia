import type WebSocket from "ws";
import type { AppSnapshot, ProviderInfo, ServerEvent } from "../../../shared/contracts";
import { ISSUE_GITHUB_MESSAGES, ISSUE_UNCERTAIN_REASONS } from "../../../shared/issue-report-github";
import { ISSUE_REPOSITORY, issueReportSchema, type IssueGitHubState, type IssueReport } from "../../../shared/issue-report";
import type { RuntimeStore } from "../../database";
import { IssuePublicationError, type IssuePublisher } from "../../git/github-issue-report";
import { editReport, newIssueReport } from "../../issue-report";
import { RuntimeRequestError } from "../../runtime-errors";
import type { RuntimeIssueEvidenceSource } from "../issue-evidence-broker-client";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

interface Dependencies {
  store: Pick<RuntimeStore, "readIssueReport" | "saveIssueReport">;
  snapshot(): AppSnapshot;
  providerInfo(): readonly ProviderInfo[];
  publisher: IssuePublisher;
  evidence?: RuntimeIssueEvidenceSource;
  send(socket: WebSocket, event: ServerEvent): void;
}

const UNCERTAIN_NOTICE = "GitHub may still have received the issue. Check submission before trying again; a second issue is never created automatically.";

export function createIssueReportCommandHandler(deps: Dependencies): RuntimeCommandHandler {
  let stored: unknown = null;
  try { stored = deps.store.readIssueReport(); } catch { stored = null; }
  const parsed = issueReportSchema.safeParse(stored);
  let report: IssueReport | null = parsed.success ? parsed.data : null;
  const save = (next: IssueReport): void => {
    const validated = issueReportSchema.parse(next);
    deps.store.saveIssueReport(validated);
    report = validated;
  };
  if (report?.status === "submitting") save({ ...report, status: "uncertain", revision: report.revision + 1, notice: UNCERTAIN_NOTICE });
  const current = (id: string, revision?: number): IssueReport => {
    if (!report || report.id !== id || (revision !== undefined && revision !== report.revision)) throw new RuntimeRequestError("This report changed. Open it again before continuing.");
    return report;
  };
  let publicationBusy = false;
  const assertReplaceable = (): void => {
    if (publicationBusy || (report && ["submitting", "uncertain"].includes(report.status))) throw new RuntimeRequestError("Check the pending GitHub submission before starting another report.");
  };
  return defineRuntimeCommandHandler([
    "support.report.get", "support.report.github", "support.report.prepare", "support.report.edit", "support.report.submit", "support.report.reconcile", "support.report.retire",
  ], async (socket, command) => {
    let github: IssueGitHubState | undefined;
    switch (command.type) {
      case "support.report.get": break;
      case "support.report.github": {
        github = await deps.publisher.status();
        break;
      }
      case "support.report.prepare": {
        assertReplaceable();
        const host = await deps.evidence?.collect(command.payload.attachDiagnostics) ?? null;
        assertReplaceable();
        save(newIssueReport(command.payload, { snapshot: deps.snapshot(), providers: deps.providerInfo(), host }));
        break;
      }
      case "support.report.edit": {
        const value = current(command.payload.id, command.payload.revision);
        if (!["preview", "failed"].includes(value.status) || publicationBusy) throw new RuntimeRequestError("This report cannot be changed while publication is pending, or after publication or retirement.");
        save(editReport(value, command.payload.title, command.payload.body));
        break;
      }
      case "support.report.submit": {
        const value = current(command.payload.id, command.payload.revision);
        if (value.status === "submitted") break;
        if (!["preview", "failed"].includes(value.status) || publicationBusy) throw new RuntimeRequestError("Review the issue before creating it. A pending submission cannot be retried.");
        const scrubbed = editReport(value, value.title, value.body);
        if (scrubbed.title !== value.title || scrubbed.body !== value.body) {
          save(scrubbed);
          break;
        }
        save({ ...value, status: "submitting", revision: value.revision + 1, notice: "Creating the issue on GitHub…" });
        publicationBusy = true;
        let attempted = false;
        try {
          const url = await deps.publisher.create({ id: value.id, title: value.title, body: value.body, beforePublish: () => { attempted = true; } });
          const latest = current(value.id);
          save({ ...latest, status: "submitted", revision: latest.revision + 1, issueUrl: url, notice: `Issue created in ${ISSUE_REPOSITORY}.` });
        } catch (error) {
          const reason = error instanceof IssuePublicationError ? error.reason : "unknown";
          const latest = current(value.id);
          save({ ...latest, status: attempted ? "uncertain" : "failed", revision: latest.revision + 1, notice: attempted ? `${ISSUE_UNCERTAIN_REASONS[reason]}${UNCERTAIN_NOTICE}` : ISSUE_GITHUB_MESSAGES[reason] });
        } finally { publicationBusy = false; }
        break;
      }
      case "support.report.reconcile": {
        const value = current(command.payload.id, command.payload.revision);
        if (value.status === "retired") throw new RuntimeRequestError("This report was retired and cannot be checked or submitted again.");
        if (value.status !== "uncertain" || publicationBusy) break;
        publicationBusy = true;
        try {
          const url = await deps.publisher.find(value.id);
          save({ ...value, revision: value.revision + 1, status: url ? "submitted" : "uncertain", issueUrl: url, notice: url ? "Existing issue found. No duplicate was created." : "No matching issue is visible yet. GitHub search can be delayed; check again or look at the repository's issues. Resubmission stays blocked." });
        } catch (error) {
          const reason = error instanceof IssuePublicationError ? error.reason : "unknown";
          save({ ...value, revision: value.revision + 1, notice: `GitHub could not be checked. ${reason === "unknown" ? "Try again later or look at the repository's issues." : ISSUE_GITHUB_MESSAGES[reason]}` });
        } finally { publicationBusy = false; }
        break;
      }
      case "support.report.retire": {
        const value = current(command.payload.id, command.payload.revision);
        if (value.status !== "uncertain" || publicationBusy) throw new RuntimeRequestError("Wait for pending publication or checks to finish before retiring an uncertain report.");
        save({ ...value, status: "retired", revision: value.revision + 1, notice: "Publication tracking retired. The original issue may already exist on GitHub. This report cannot be checked or submitted again. Its preview stays saved until you start another report." });
        break;
      }
      default: return "not-handled";
    }
    deps.send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "support.report", report, ...(github ? { github } : {}) } });
    return "handled";
  });
}
