import type WebSocket from "ws";
import type { AppSnapshot, ProviderInfo, ServerEvent } from "../../../shared/contracts";
import { issueReportSchema, reportAllowsAgent, type IssueReport } from "../../../shared/issue-report";
import type { RuntimeStore } from "../../database";
import type { IssuePublisher } from "../../git/github-issue-report";
import { editReport, newIssueReport, parseReportAnswer, reportBody, reportPrompt } from "../../issue-report";
import { RuntimeRequestError } from "../../runtime-errors";
import { IsolatedRunError, type IsolatedRunController } from "../reviews/isolated-run-controller";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

interface Dependencies {
  store: Pick<RuntimeStore, "readIssueReport" | "saveIssueReport">;
  isolatedRuns: IsolatedRunController<WebSocket>;
  snapshot(): AppSnapshot;
  providerInfo(): readonly ProviderInfo[];
  publisher: IssuePublisher;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createIssueReportCommandHandler(deps: Dependencies): RuntimeCommandHandler {
  let stored: unknown = null;
  try { stored = deps.store.readIssueReport(); } catch { /* A damaged draft must not prevent runtime startup. */ }
  const parsed = issueReportSchema.safeParse(stored);
  let report: IssueReport | null = parsed.success ? parsed.data : null;
  const save = (next: IssueReport): void => {
    const validated = issueReportSchema.parse(next);
    deps.store.saveIssueReport(validated);
    report = validated;
  };
  if (report?.status === "validating") save({ ...report, status: "failed", revision: report.revision + 1, notice: "Validation was interrupted. Your draft is preserved; retry or continue manually." });
  if (report?.status === "submitting") save({ ...report, status: "uncertain", revision: report.revision + 1, notice: "Publication was interrupted. Check GitHub before starting another report." });
  const current = (id: string, revision?: number): IssueReport => {
    if (!report || report.id !== id || (revision !== undefined && revision !== report.revision)) throw new RuntimeRequestError("This report changed. Reload the saved report before continuing.");
    return report;
  };
  const editable = (value: IssueReport): void => {
    if (["validating", "submitting", "uncertain", "submitted"].includes(value.status)) throw new RuntimeRequestError("This report cannot be changed while validation or publication is pending, or after publication.");
  };
  let publicationBusy = false;
  return defineRuntimeCommandHandler([
    "support.report.get", "support.report.prepare", "support.report.validate", "support.report.cancel", "support.report.edit", "support.report.submit", "support.report.reconcile",
  ], async (socket, command) => {
    switch (command.type) {
      case "support.report.get": break;
      case "support.report.prepare": {
        if (report && (["validating", "submitting", "uncertain"].includes(report.status) || deps.isolatedRuns.has(report.id))) throw new RuntimeRequestError("Finish or cancel the pending report first. Check uncertain publication on GitHub.");
        save(newIssueReport(command.payload, deps.snapshot()));
        break;
      }
      case "support.report.validate": {
        const value = current(command.payload.id, command.payload.revision);
        editable(value);
        if (deps.isolatedRuns.has(value.id)) throw new RuntimeRequestError("The previous validation is still stopping. Retry shortly.");
        if (!reportAllowsAgent(value.selection.harnessId)) {
          save({ ...value, status: "failed", revision: value.revision + 1, notice: "This provider cannot enforce a report chat with tools disabled. Choose Claude Agent SDK, or continue with the manual preview." });
          break;
        }
        const provider = deps.providerInfo().find(({ id }) => id === "claude");
        if (!provider?.canRun) {
          save({ ...value, status: "failed", revision: value.revision + 1, notice: "Connect Claude in Settings → Providers to validate with this model, or continue with the manual preview." });
          break;
        }
        save({ ...value, status: "validating", revision: value.revision + 1, notice: "Checking your observations against the safe local evidence. Tools are disabled; this run stops after 90 seconds." });
        try {
          const completed = await deps.isolatedRuns.run({
            kind: "issue-report", projectId: value.projectId ?? value.id, conversationId: value.id, owner: socket,
            selection: { modelSelection: value.selection }, request: { visibleContent: null, executionPrompt: reportPrompt(value) },
            label: "Issue report", detail: "Bounded local validation", toolPolicy: "none", interactionPolicy: "fail-closed", timeoutMs: 90_000, outputLimitChars: 8_000,
            onResult: (output, context) => { context.assertActive(); return parseReportAnswer(output.text); },
          });
          const latest = current(value.id);
          if (latest.status === "validating") {
            const next = { ...latest, answer: completed.value, status: "preview" as const, revision: latest.revision + 1, notice: "Validation complete. The assessment is advisory; review and edit the issue before publishing." };
            save({ ...next, body: reportBody(next) });
          }
        } catch (error) {
          const latest = current(value.id);
          if (latest.status === "validating") save({ ...latest, status: "failed", revision: latest.revision + 1, notice: error instanceof IsolatedRunError && error.reason === "timeout" ? "Validation reached its 90-second limit. Retry or continue with the manual preview." : "Validation could not complete safely. Your draft is preserved. Check provider setup, retry, or continue with the manual preview." });
        }
        break;
      }
      case "support.report.cancel": {
        const value = current(command.payload.id);
        if (value.status !== "validating") break;
        deps.isolatedRuns.stopConversation(value.id, "issue-report");
        save({ ...value, status: "cancelled", revision: value.revision + 1, notice: "Validation cancelled. Your description and safe evidence are preserved." });
        break;
      }
      case "support.report.edit": {
        const value = current(command.payload.id, command.payload.revision);
        editable(value);
        save(editReport(value, command.payload.title, command.payload.body));
        break;
      }
      case "support.report.submit": {
        const value = current(command.payload.id, command.payload.revision);
        if (value.status === "submitted") break;
        if (value.status !== "preview" || publicationBusy) throw new RuntimeRequestError("Save and review the issue preview before submitting. A pending submission cannot be retried.");
        // Lock during auth/discovery too; no concurrent edits or double clicks.
        save({ ...value, status: "submitting", revision: value.revision + 1, notice: "Submitting to eduardtomas1/inertia…" });
        publicationBusy = true;
        let attempted = false;
        try {
          const url = await deps.publisher.create({ id: value.id, title: value.title, body: value.body, beforePublish: () => { attempted = true; } });
          const latest = current(value.id);
          save({ ...latest, status: "submitted", revision: latest.revision + 1, issueUrl: url, notice: "Issue published to eduardtomas1/inertia." });
        } catch {
          const latest = current(value.id);
          save({ ...latest, status: attempted ? "uncertain" : "preview", revision: latest.revision + 1, notice: attempted ? "GitHub may have received the issue. Check submission; automatic re-publication is blocked to prevent duplicates." : "GitHub CLI is unavailable or not signed in. Install gh and run gh auth login, then retry, or copy this preview and open GitHub manually." });
        } finally { publicationBusy = false; }
        break;
      }
      case "support.report.reconcile": {
        const value = current(command.payload.id, command.payload.revision);
        if (value.status !== "uncertain" || publicationBusy) break;
        publicationBusy = true;
        try {
          const url = await deps.publisher.find(value.id);
          save({ ...value, revision: value.revision + 1, status: url ? "submitted" : "uncertain", issueUrl: url, notice: url ? "Existing issue found. No duplicate was created." : "No matching issue is visible yet. GitHub search can be delayed; check again or inspect the repository's issues. Re-publication stays blocked." });
        } catch {
          save({ ...value, revision: value.revision + 1, notice: "Could not check GitHub. Reconnect GitHub CLI or inspect the repository's issues before proceeding." });
        } finally { publicationBusy = false; }
        break;
      }
      default: return "not-handled";
    }
    deps.send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "support.report", report } });
    return "handled";
  });
}
