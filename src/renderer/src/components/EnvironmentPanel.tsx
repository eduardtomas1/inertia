import {
  useId,
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  FileDiff,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  GitFork,
  Globe2,
  Image,
  Laptop,
  ListChecks,
  PanelLeft,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";

import {
  chatAttachmentKind,
  isSpreadsheetAttachmentMimeType,
} from "@shared/attachments";
import type {
  EnvironmentRunItem,
  EnvironmentSummarySnapshot,
} from "../utils/environmentSummary";
import {
  workspaceGitRepositoryLabel,
  type WorkspaceChangesRequestedAction,
} from "../utils/workspaceGit";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { IconButton } from "./ui";

export type EnvironmentRepositoryAction = WorkspaceChangesRequestedAction;

export interface EnvironmentPanelProps {
  summary: EnvironmentSummarySnapshot;
  workspaceToolsAvailable: boolean;
  onOpenChanges: (
    repositoryPath?: string,
    action?: EnvironmentRepositoryAction,
  ) => void;
  onOpenFiles: () => void;
  onOpenProject: () => void;
  onRevealProject: () => void;
  onRetryGit?: () => void;
  onRefreshUsage?: () => void;
  onStopRun: (run: EnvironmentRunItem) => void;
  onOpenRunPreview: (run: EnvironmentRunItem) => void;
  onAcknowledgeRun: (run: EnvironmentRunItem) => void;
  onDismissRun: (run: EnvironmentRunItem) => void;
}

function activateWorkspaceTool(
  event: ReactMouseEvent<HTMLButtonElement>,
  tab: "changes" | "files",
  activate: () => void,
): void {
  const keyboardActivated = event.detail === 0;
  const panel = keyboardActivated
    ? event.currentTarget.closest(".workspace-panel")
    : null;
  activate();
  if (!keyboardActivated) return;
  window.requestAnimationFrame(() => {
    panel?.querySelector<HTMLButtonElement>(`[data-workspace-tab="${tab}"]`)
      ?.focus();
  });
}

function fileManagerLabel(): string {
  const platform = window.inertia?.getPlatform?.();
  if (platform === "darwin") return "Open in Finder";
  if (platform === "win32") return "Open in Explorer";
  return "Open in file manager";
}

function runStatusLabel(status: EnvironmentRunItem["status"]): string {
  if (status === "waiting") return "Waiting";
  if (status === "failed") return "Needs attention";
  if (status === "succeeded") return "Completed";
  if (status === "cancelled") return "Stopped";
  return "Running";
}

function subagentLabel(
  trace: EnvironmentSummarySnapshot["subagents"][number],
): string {
  return trace.providerName ?? trace.providerRole ?? "Delegated agent";
}

function quotaFreshnessLabel(
  freshness: NonNullable<EnvironmentSummarySnapshot["usage"]>["quota"]["freshness"],
): string {
  if (freshness === "current") return "Current";
  if (freshness === "stale") return "Stale";
  if (freshness === "refreshing") return "Refreshing";
  return "Unavailable";
}

function quotaWindowLabel(windowMinutes: number | null): string | null {
  if (!windowMinutes || !Number.isSafeInteger(windowMinutes) || windowMinutes < 1) {
    return null;
  }
  if (windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${windowMinutes} min`;
}

function RunActions({
  run,
  onRunAction,
  onStopRun,
  onOpenRunPreview,
  onAcknowledgeRun,
  onDismissRun,
}: {
  run: EnvironmentRunItem;
  onRunAction: (
    event: ReactMouseEvent<HTMLButtonElement>,
    run: EnvironmentRunItem,
    action: (run: EnvironmentRunItem) => void,
  ) => void;
  onStopRun: (run: EnvironmentRunItem) => void;
  onOpenRunPreview: (run: EnvironmentRunItem) => void;
  onAcknowledgeRun: (run: EnvironmentRunItem) => void;
  onDismissRun: (run: EnvironmentRunItem) => void;
}): React.JSX.Element {
  const owner = run.contextLabel ? ` · ${run.contextLabel}` : "";
  return (
    <div className="environment-run-actions">
      {run.canOpenPreview && (
        <IconButton
          label={`Open preview for ${run.label}${owner}`}
          onClick={() => onOpenRunPreview(run)}
        >
          <ExternalLink size={12} />
        </IconButton>
      )}
      {run.canAcknowledge && (
        <IconButton
          label={`Acknowledge ${run.label}${owner}`}
          onClick={(event) => onRunAction(event, run, onAcknowledgeRun)}
        >
          <Check size={12} />
        </IconButton>
      )}
      {run.canDismiss && (
        <IconButton
          label={`Dismiss ${run.label}${owner}`}
          onClick={(event) => onRunAction(event, run, onDismissRun)}
        >
          <Trash2 size={12} />
        </IconButton>
      )}
      {run.canStop && (
        <IconButton
          label={`Stop ${run.label}${owner}`}
          onClick={(event) => onRunAction(event, run, onStopRun)}
        >
          <Square size={12} />
        </IconButton>
      )}
    </div>
  );
}

export function EnvironmentPanel({
  summary,
  workspaceToolsAvailable,
  onOpenChanges,
  onOpenFiles,
  onOpenProject,
  onRevealProject,
  onRetryGit,
  onRefreshUsage,
  onStopRun,
  onOpenRunPreview,
  onAcknowledgeRun,
  onDismissRun,
}: EnvironmentPanelProps): React.JSX.Element {
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const pendingActionFocusRef = useRef<{
    runId: string;
    row: HTMLLIElement | null;
    source: HTMLButtonElement;
    fallback: HTMLButtonElement | null;
  } | null>(null);
  const repositoryHeadingId = `${panelId}-repository`;
  const editorHeadingId = `${panelId}-editor`;
  const attachmentsHeadingId = `${panelId}-attachments`;
  const runtimeAttention = summary.runtime.status === "online"
    ? null
    : summary.runtime.status === "connecting"
      ? {
        title: "Connecting to workspace",
        detail: "Live environment details may be incomplete.",
      }
      : {
        title: "Workspace runtime unavailable",
        detail: "Live environment details may be out of date.",
      };
  const changesAvailable = Boolean(
    workspaceToolsAvailable
    && summary.gitState === "ready"
    && summary.changes,
  );
  const branchLabel = summary.gitState === "loading"
    ? "Checking branch…"
    : summary.branch?.value
      ?? (summary.gitState === "unavailable"
        ? "No Git repository"
        : summary.gitState === "unknown"
          ? "Repository not checked"
          : "Branch unavailable");
  const repositoryLabel = summary.openTarget?.name
    ?? summary.projectName
    ?? summary.workspace?.value
    ?? "Repository unavailable";
  const changeStateLabel = summary.gitState === "loading"
    ? "Checking…"
    : summary.gitState === "error"
      ? "Unavailable"
      : summary.gitState === "unavailable"
        ? "Not a repository"
        : summary.gitState === "unknown"
          ? "Not checked"
          : summary.changes?.files === 0
            ? "Clean"
            : null;

  useLayoutEffect(() => {
    const pending = pendingActionFocusRef.current;
    if (!pending || pending.source.isConnected) return;
    pendingActionFocusRef.current = null;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement.isConnected
    ) return;
    const remainingRowAction = [
      ...summary.checks,
      ...summary.localServers,
    ].some((run) => run.id === pending.runId) && pending.row?.isConnected
      ? pending.row.querySelector<HTMLButtonElement>("button:not(:disabled)")
      : null;
    const fallback = remainingRowAction
      ?? (pending.fallback?.isConnected && !pending.fallback.disabled
        ? pending.fallback
        : null)
      ?? panelRef.current?.querySelector<HTMLElement>(
        "summary, button:not(:disabled)",
      );
    fallback?.focus();
  }, [summary.checks, summary.localServers]);

  const runAndPreserveFocus = (
    event: ReactMouseEvent<HTMLButtonElement>,
    run: EnvironmentRunItem,
    action: (run: EnvironmentRunItem) => void,
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
        runId: run.id,
        row,
        source: event.currentTarget,
        fallback: candidateRows
          .map((candidate) => candidate.querySelector<HTMLButtonElement>(
            "button:not(:disabled)",
          ))
          .find((candidate) => candidate !== null) ?? null,
      };
    }
    action(run);
  };

  const usageSummaryLabel = summary.usage
    ? summary.usage.context.remainingPercent !== null
      ? summary.usage.context.valueLabel
      : summary.usage.quota.freshness === "refreshing"
        ? "Refreshing"
        : "Unavailable"
    : "Unavailable";

  return (
    <section
      ref={panelRef}
      className="environment-panel"
      aria-label="Environment details"
    >
      <div className="environment-panel-scroll">
        {runtimeAttention && (
          <div
            className={`environment-runtime-attention is-${summary.runtime.status}`}
            role="status"
            aria-live="polite"
          >
            <Laptop size={14} aria-hidden="true" />
            <span><strong>{runtimeAttention.title}</strong><small>{runtimeAttention.detail}</small></span>
          </div>
        )}

        <div className="environment-primary-list">
          <button
            type="button"
            className="environment-row"
            onClick={(event) => activateWorkspaceTool(
              event,
              "changes",
              () => onOpenChanges(),
            )}
            disabled={!changesAvailable}
          >
            <FileDiff size={14} aria-hidden="true" />
            <span>Changes</span>
            {summary.gitState === "ready" && summary.changes?.files ? (
              <span
                className="environment-change-stats"
                aria-label={`${summary.changes.insertions} insertions and ${summary.changes.deletions} deletions`}
              >
                <b>+{summary.changes.insertions}</b><i>−{summary.changes.deletions}</i>
              </span>
            ) : (
              <small>{changeStateLabel}</small>
            )}
          </button>

          <details className="environment-disclosure">
            <summary>
              <GitFork size={14} aria-hidden="true" />
              <span>{summary.workspace?.label ?? "Worktree"}</span>
              <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
            </summary>
            <div className="environment-disclosure-content">
              {summary.workspace ? (
                <>
                  <small>{summary.workspace.value}</small>
                  <code title={summary.workspace.path}>{summary.workspace.path}</code>
                </>
              ) : (
                <p>This task does not have a local workspace yet.</p>
              )}
            </div>
          </details>

          <details className="environment-disclosure">
            <summary>
              <GitBranch size={14} aria-hidden="true" />
              <span title={branchLabel}>{branchLabel}</span>
              <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
            </summary>
            <div className="environment-disclosure-content is-repositories">
              {summary.repositories.length === 0 ? (
                <p>No Git repository is available for this workspace.</p>
              ) : summary.repositories.map((repository) => {
                const label = workspaceGitRepositoryLabel(
                  summary.projectName ?? "Repository",
                  repository.repositoryPath,
                );
                return (
                  <button
                    type="button"
                    key={repository.repositoryPath}
                    onClick={(event) => activateWorkspaceTool(
                      event,
                      "changes",
                      () => onOpenChanges(repository.repositoryPath, "review"),
                    )}
                    disabled={!workspaceToolsAvailable || repository.state === "error"}
                    title={repository.error ?? repository.repositoryPath}
                  >
                    <span><strong>{label}</strong><small>{repository.branch ?? "Detached HEAD"}</small></span>
                    <ChevronRight size={12} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </details>

          <details className="environment-disclosure">
            <summary>
              <CloudUpload size={14} aria-hidden="true" />
              <span>Commit and Push</span>
              <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
            </summary>
            <div className="environment-disclosure-actions is-repositories">
              {summary.repositories.length === 0 ? (
                <p>No Git repository actions are available.</p>
              ) : summary.repositories.map((repository) => {
                const label = workspaceGitRepositoryLabel(
                  summary.projectName ?? "Repository",
                  repository.repositoryPath,
                );
                const unavailable = repository.state !== "ready"
                  || !workspaceToolsAvailable;
                return (
                  <section key={repository.repositoryPath}>
                    <header>
                      <span title={repository.repositoryPath}>{label}</span>
                      <small>{repository.branch ?? "Detached HEAD"}</small>
                    </header>
                    {repository.state === "error" ? (
                      <p>{repository.error ?? "Repository unavailable."}</p>
                    ) : (
                      <div>
                        <button
                          type="button"
                          onClick={(event) => activateWorkspaceTool(
                            event,
                            "changes",
                            () => onOpenChanges(repository.repositoryPath, "review"),
                          )}
                          disabled={unavailable}
                        >
                          <span>Review</span><ChevronRight size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => activateWorkspaceTool(
                            event,
                            "changes",
                            () => onOpenChanges(repository.repositoryPath, "commit"),
                          )}
                          disabled={unavailable || !repository.commitAction || repository.commitAction.disabled}
                          title={repository.commitAction?.detail}
                        >
                          <span>{repository.commitAction?.label ?? "Commit"}</span><ChevronRight size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => activateWorkspaceTool(
                            event,
                            "changes",
                            () => onOpenChanges(repository.repositoryPath, "push"),
                          )}
                          disabled={unavailable || !repository.pushAction || repository.pushAction.disabled}
                          title={repository.pushAction?.detail}
                        >
                          <span>{repository.pushAction?.label ?? "Push"}</span><ChevronRight size={12} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </details>

          <details className="environment-disclosure">
            <summary>
              <Globe2 size={14} aria-hidden="true" />
              <span>Local Servers</span>
              <small>{summary.localServers.length}</small>
              <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
            </summary>
            <div className="environment-disclosure-content is-servers">
              {summary.localServers.length === 0 ? (
                <p>No validated local service ports are active.</p>
              ) : (
                <ul className="environment-run-list">
                  {summary.localServers.map((server) => (
                    <li key={server.id}>
                      <span>
                        <strong>{server.label}</strong>
                        <small title={`${server.url}${server.contextLabel ? ` · ${server.contextLabel}` : ""}`}>
                          {server.url}{server.contextLabel ? ` · ${server.contextLabel}` : ""}
                        </small>
                      </span>
                      <RunActions
                        run={server}
                        onRunAction={runAndPreserveFocus}
                        onStopRun={onStopRun}
                        onOpenRunPreview={onOpenRunPreview}
                        onAcknowledgeRun={onAcknowledgeRun}
                        onDismissRun={onDismissRun}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>

          {summary.checks.length > 0 && (
            <details className="environment-disclosure">
              <summary>
                <ListChecks size={14} aria-hidden="true" />
                <span>Active work</span>
                <small>{summary.checks.length}</small>
                <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
              </summary>
              <div className="environment-disclosure-content">
                <ul className="environment-run-list">
                  {summary.checks.map((check) => (
                    <li key={check.id}>
                      <span>
                        <strong>{check.label}</strong>
                        <small title={check.contextLabel ?? undefined}>
                          {runStatusLabel(check.status)}{check.contextLabel ? ` · ${check.contextLabel}` : ""}
                        </small>
                      </span>
                      <RunActions
                        run={check}
                        onRunAction={runAndPreserveFocus}
                        onStopRun={onStopRun}
                        onOpenRunPreview={onOpenRunPreview}
                        onAcknowledgeRun={onAcknowledgeRun}
                        onDismissRun={onDismissRun}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}
        </div>

        {summary.gitNotice && (
          <div className="environment-panel-notice" role="status">
            <span>{summary.gitNotice}</span>
            {onRetryGit && <button type="button" onClick={onRetryGit}>Retry</button>}
          </div>
        )}

        <section className="environment-panel-section environment-usage-section">
          <details className="environment-disclosure">
            <summary>
              {summary.usage ? (
                <ProviderBrandIcon
                  providerId={summary.usage.providerId}
                  decorative
                  size={14}
                />
              ) : (
                <RefreshCw size={14} aria-hidden="true" />
              )}
              <span>Usage</span>
              <small aria-label={summary.usage?.context.accessibleLabel}>
                {usageSummaryLabel}
              </small>
              <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
            </summary>
            <div className="environment-disclosure-content is-usage">
              {summary.usage ? (
                <>
                  <div className="environment-usage-context">
                    <span><strong>{summary.usage.providerLabel}</strong><small>Context window</small></span>
                    <b>{summary.usage.context.valueLabel}</b>
                  </div>
                  <div className="environment-usage-quota-state">
                    <span>Provider limits</span>
                    <small className={`is-${summary.usage.quota.freshness}`}>
                      {summary.usage.quota.source === "isolated"
                        ? "Unavailable for this backend"
                        : quotaFreshnessLabel(summary.usage.quota.freshness)}
                    </small>
                  </div>
                  {summary.usage.quota.limits.length > 0 ? (
                    <ul className="environment-usage-limits">
                      {summary.usage.quota.limits.map((limit) => {
                        const windowLabel = quotaWindowLabel(limit.windowMinutes);
                        return (
                          <li key={limit.id}>
                            <span>{limit.label}{windowLabel ? <small>{windowLabel}</small> : null}</span>
                            <b>{limit.remainingPercent}% left</b>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p>
                      {summary.usage.quota.freshness === "refreshing"
                        ? "Refreshing provider limits…"
                        : summary.usage.quota.source === "isolated"
                          ? "Account limits are not shared with this custom backend route."
                          : "No provider limit windows are available."}
                    </p>
                  )}
                  {onRefreshUsage
                    && summary.usage.quota.source === "selected-route"
                    && summary.usage.quota.freshness !== "current" && (
                    <button
                      type="button"
                      className="environment-usage-refresh"
                      onClick={onRefreshUsage}
                      disabled={summary.usage.quota.freshness === "refreshing"}
                    >
                      <RefreshCw size={12} aria-hidden="true" />
                      <span>{summary.usage.quota.freshness === "refreshing" ? "Refreshing" : "Refresh usage"}</span>
                    </button>
                  )}
                </>
              ) : (
                <p>Usage is unavailable until this task has a selected provider route.</p>
              )}
            </div>
          </details>
        </section>

        <section className="environment-panel-section" aria-labelledby={repositoryHeadingId}>
          <h3 id={repositoryHeadingId}>Repository</h3>
          <button
            type="button"
            className="environment-row"
            onClick={onOpenProject}
            disabled={!summary.workspace}
            title={summary.openTarget?.path ?? summary.workspace?.path}
            aria-label={`Open active workspace ${repositoryLabel} externally`}
          >
            <FolderGit2 size={14} aria-hidden="true" />
            <span>{repositoryLabel}</span>
            <ExternalLink size={12} aria-hidden="true" />
          </button>
        </section>

        <section className="environment-panel-section" aria-labelledby={editorHeadingId}>
          <h3 id={editorHeadingId}>Editor</h3>
          <button
            type="button"
            className="environment-row"
            onClick={(event) => activateWorkspaceTool(event, "files", onOpenFiles)}
            disabled={!workspaceToolsAvailable}
          >
            <PanelLeft size={14} aria-hidden="true" />
            <span>Editor view</span>
          </button>
          <button
            type="button"
            className="environment-row"
            onClick={onRevealProject}
            disabled={!summary.workspace}
          >
            <Folder size={14} aria-hidden="true" />
            <span>{fileManagerLabel()}</span>
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        </section>

        {summary.subagents.length > 0 && (
          <section className="environment-panel-section" aria-label="Subagents">
            <h3>Subagents</h3>
            <ul className="environment-plain-list">
              {summary.subagents.map((trace) => (
                <li key={trace.id}>
                  <Bot size={14} aria-hidden="true" />
                  <span>{subagentLabel(trace)}</span>
                  <small>{trace.status[0].toUpperCase() + trace.status.slice(1)}</small>
                </li>
              ))}
            </ul>
          </section>
        )}

        {summary.attachments.length > 0 && (
          <section className="environment-panel-section" aria-labelledby={attachmentsHeadingId}>
            <h3 id={attachmentsHeadingId}>Recent attachments</h3>
            <ul className="environment-plain-list">
              {summary.attachments.map((attachment) => (
                <li key={attachment.id}>
                  {chatAttachmentKind(attachment.mimeType) === "image"
                    ? <Image size={14} aria-hidden="true" />
                    : isSpreadsheetAttachmentMimeType(attachment.mimeType)
                      ? <FileSpreadsheet size={14} aria-hidden="true" />
                      : <FileText size={14} aria-hidden="true" />}
                  <span title={attachment.name}>{attachment.name}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!workspaceToolsAvailable && (
          <div className="environment-panel-notice" role="status">
            <span>
              Files, changes, and Terminal become available after the first message creates this isolated worktree.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
