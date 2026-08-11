import {
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Bot,
  Check,
  ExternalLink,
  FileText,
  GitBranch,
  GitCompareArrows,
  Image,
  Laptop,
  ListChecks,
  Square,
  Trash2,
} from "lucide-react";

import { chatAttachmentKind } from "@shared/attachments";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { IconButton } from "./ui";

interface EnvironmentSummaryProps {
  summary: EnvironmentSummarySnapshot;
  onStopRun: (run: EnvironmentSummarySnapshot["checks"][number]) => void;
  onOpenRunPreview: (
    run: EnvironmentSummarySnapshot["checks"][number],
  ) => void;
  onAcknowledgeRun: (
    run: EnvironmentSummarySnapshot["checks"][number],
  ) => void;
  onDismissRun: (
    run: EnvironmentSummarySnapshot["checks"][number],
  ) => void;
  onRestoreActionFocus: () => void;
}

function subagentLabel(
  trace: EnvironmentSummarySnapshot["subagents"][number],
): string {
  return trace.providerName
    ?? trace.providerRole
    ?? "Delegated agent";
}

function runStatusLabel(
  status: EnvironmentSummarySnapshot["checks"][number]["status"],
): string {
  if (status === "waiting") return "Waiting";
  if (status === "failed") return "Needs attention";
  if (status === "succeeded") return "Completed";
  if (status === "cancelled") return "Stopped";
  return "Running";
}

export function EnvironmentSummary({
  summary,
  onStopRun,
  onOpenRunPreview,
  onAcknowledgeRun,
  onDismissRun,
  onRestoreActionFocus,
}: EnvironmentSummaryProps): React.JSX.Element {
  useNativePreviewSuspension(true);
  const pendingActionFocusRef = useRef<{
    runId: string;
    row: HTMLLIElement | null;
    source: HTMLButtonElement;
    fallback: HTMLButtonElement | null;
  } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingActionFocusRef.current;
    if (!pending || pending.source.isConnected) {
      return;
    }
    pendingActionFocusRef.current = null;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement.isConnected
    ) {
      return;
    }
    const remainingRowAction = summary.checks.some(
      (check) => check.id === pending.runId,
    ) && pending.row?.isConnected
      ? pending.row.querySelector<HTMLButtonElement>("button:not(:disabled)")
      : null;
    if (remainingRowAction) {
      remainingRowAction.focus();
      return;
    }
    if (pending.fallback?.isConnected && !pending.fallback.disabled) {
      pending.fallback.focus();
      return;
    }
    onRestoreActionFocus();
  }, [onRestoreActionFocus, summary.checks]);

  const runAndPreserveFocus = (
    event: ReactMouseEvent<HTMLButtonElement>,
    check: EnvironmentSummarySnapshot["checks"][number],
    action: (run: EnvironmentSummarySnapshot["checks"][number]) => void,
  ): void => {
    if (document.activeElement === event.currentTarget) {
      const row = event.currentTarget.closest("li");
      const siblingRows = row?.parentElement
        ? Array.from(row.parentElement.children).filter(
            (element): element is HTMLLIElement => element instanceof HTMLLIElement,
          )
        : [];
      const rowIndex = row ? siblingRows.indexOf(row) : -1;
      const candidateRows = rowIndex >= 0
        ? [
            ...siblingRows.slice(rowIndex + 1),
            ...siblingRows.slice(0, rowIndex).reverse(),
          ]
        : [];
      pendingActionFocusRef.current = {
        runId: check.id,
        row,
        source: event.currentTarget,
        fallback: candidateRows
          .map((candidate) => candidate.querySelector<HTMLButtonElement>(
            "button:not(:disabled)",
          ))
          .find((candidate) => candidate !== null) ?? null,
      };
    }
    action(check);
  };
  const hasWorkspaceDetails = Boolean(
    summary.changes
    || summary.branch
    || summary.checks.length
    || summary.subagents.length
    || summary.attachments.length,
  );

  return (
    <section
      className="environment-summary"
      role="dialog"
      aria-label="Environment summary"
    >
      <header>
        <span>
          <small>Environment</small>
          <strong>{summary.projectName ?? "Inertia"}</strong>
        </span>
      </header>

      <div className="environment-summary-rows">
        {summary.changes && (
          <div className="environment-summary-row">
            <GitCompareArrows size={15} aria-hidden="true" />
            <span>
              <strong>Changes</strong>
              <small>
                {summary.changes.files === 0
                  ? "Clean"
                  : `${summary.changes.files} ${summary.changes.files === 1 ? "file" : "files"}`}
                {summary.changes.repositories > 1
                  ? ` · ${summary.changes.repositories} repositories`
                  : ""}
              </small>
            </span>
            {summary.changes.files > 0 && (
              <span
                className="environment-change-stats"
                aria-label={`${summary.changes.insertions} insertions and ${summary.changes.deletions} deletions`}
              >
                <b>+{summary.changes.insertions}</b>
                <i>−{summary.changes.deletions}</i>
              </span>
            )}
          </div>
        )}

        <div className="environment-summary-row">
          <Laptop size={15} aria-hidden="true" />
          <span>
            <strong>Runtime</strong>
            <small>Local workspace service</small>
          </span>
          <em className={`is-${summary.runtime.status}`}>
            {summary.runtime.label}
          </em>
        </div>

        {summary.branch && (
          <div className="environment-summary-row">
            <GitBranch size={15} aria-hidden="true" />
            <span>
              <strong>{summary.branch.label}</strong>
              <small title={summary.branch.value}>{summary.branch.value}</small>
            </span>
          </div>
        )}
      </div>

      {summary.checks.length > 0 && (
        <section className="environment-summary-section">
          <h3><ListChecks size={14} aria-hidden="true" />Active work</h3>
          <ul>
            {summary.checks.map((check) => (
              <li key={check.id}>
                <span title={`${check.label}${check.contextLabel ? ` · ${check.contextLabel}` : ""}`}>
                  {check.label}
                  {check.contextLabel ? ` · ${check.contextLabel}` : ""}
                </span>
                <small>{runStatusLabel(check.status)}</small>
                <div className="environment-summary-run-actions">
                  {check.canOpenPreview && (
                    <IconButton
                      label={`Open preview for ${check.label}${check.contextLabel ? ` · ${check.contextLabel}` : ""}`}
                      onClick={() => onOpenRunPreview(check)}
                    >
                      <ExternalLink size={12} />
                    </IconButton>
                  )}
                  {check.canAcknowledge && (
                    <IconButton
                      label={`Acknowledge ${check.label}${check.contextLabel ? ` · ${check.contextLabel}` : ""}`}
                      onClick={(event) => runAndPreserveFocus(
                        event,
                        check,
                        onAcknowledgeRun,
                      )}
                    >
                      <Check size={12} />
                    </IconButton>
                  )}
                  {check.canDismiss && (
                    <IconButton
                      label={`Dismiss ${check.label}${check.contextLabel ? ` · ${check.contextLabel}` : ""}`}
                      onClick={(event) => runAndPreserveFocus(
                        event,
                        check,
                        onDismissRun,
                      )}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  )}
                  {check.canStop && (
                    <IconButton
                      label={`Stop ${check.label}${check.contextLabel ? ` · ${check.contextLabel}` : ""}`}
                      onClick={(event) => runAndPreserveFocus(
                        event,
                        check,
                        onStopRun,
                      )}
                    >
                      <Square size={12} />
                    </IconButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.subagents.length > 0 && (
        <section className="environment-summary-section">
          <h3><Bot size={14} aria-hidden="true" />Subagents</h3>
          <ul>
            {summary.subagents.map((trace) => (
              <li key={trace.id}>
                <span>{subagentLabel(trace)}</span>
                <small>{trace.status[0].toUpperCase() + trace.status.slice(1)}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.attachments.length > 0 && (
        <section className="environment-summary-section">
          <h3>Recent attachments</h3>
          <ul className="environment-attachments">
            {summary.attachments.map((attachment) => {
              const image = chatAttachmentKind(attachment.mimeType) === "image";
              return (
                <li key={attachment.id}>
                  {image
                    ? <Image size={14} aria-hidden="true" />
                    : <FileText size={14} aria-hidden="true" />}
                  <span title={attachment.name}>{attachment.name}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!hasWorkspaceDetails && (
        <p className="environment-summary-empty">
          Add or select a project to see its workspace details.
        </p>
      )}
    </section>
  );
}
