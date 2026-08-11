import { useId, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  FileDiff,
  Folder,
  FolderGit2,
  GitBranch,
  GitFork,
  Globe2,
  Laptop,
  PanelLeft,
} from "lucide-react";

import type { HeaderGitAction } from "../utils/headerGitActions";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";

interface EnvironmentPanelProps {
  summary: EnvironmentSummarySnapshot;
  workspaceToolsAvailable: boolean;
  commitAction?: HeaderGitAction | null;
  pushAction?: HeaderGitAction | null;
  onOpenChanges: () => void;
  onOpenFiles: () => void;
  onOpenPreview: () => void;
  onOpenProject: () => void;
  onRevealProject: () => void;
  onRetryGit?: () => void;
  onCommit?: () => void;
  onPush?: () => void;
}

function activateWorkspaceTool(
  event: MouseEvent<HTMLButtonElement>,
  tab: "changes" | "files" | "preview",
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

export function EnvironmentPanel({
  summary,
  workspaceToolsAvailable,
  commitAction = null,
  pushAction = null,
  onOpenChanges,
  onOpenFiles,
  onOpenPreview,
  onOpenProject,
  onRevealProject,
  onRetryGit,
  onCommit,
  onPush,
}: EnvironmentPanelProps): React.JSX.Element {
  const panelId = useId();
  const repositoryHeadingId = `${panelId}-repository`;
  const editorHeadingId = `${panelId}-editor`;
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
  const branchLabel = summary.branch?.value
    ?? (summary.gitState === "loading"
      ? "Checking branch…"
      : summary.gitState === "unavailable"
        ? "No Git repository"
        : summary.gitState === "unknown"
          ? "Repository not checked"
          : "Branch unavailable");
  const repositoryLabel = summary.repository?.name
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
          : null;

  return (
    <section className="environment-panel" aria-label="Environment details">
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
            onClick={(event) => activateWorkspaceTool(event, "changes", onOpenChanges)}
            disabled={!changesAvailable}
          >
            <FileDiff size={14} aria-hidden="true" />
            <span>Changes</span>
            {summary.gitState === "ready" && summary.changes ? (
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

          <div className="environment-row">
            <GitFork size={14} aria-hidden="true" />
            <span>{summary.workspace?.label ?? "Worktree"}</span>
          </div>

          <details className="environment-disclosure">
            <summary>
              <GitBranch size={14} aria-hidden="true" />
              <span title={branchLabel}>{branchLabel}</span>
              <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
            </summary>
            <div className="environment-disclosure-content">
              <small>{summary.workspace?.label ?? "Workspace"}</small>
              <code title={summary.workspace?.path}>{summary.workspace?.path ?? "Unavailable"}</code>
            </div>
          </details>

          <details className="environment-disclosure">
            <summary>
              <CloudUpload size={14} aria-hidden="true" />
              <span>Commit and Push</span>
              <ChevronDown className="environment-disclosure-chevron" size={13} aria-hidden="true" />
            </summary>
            <div className="environment-disclosure-actions">
              <button
                type="button"
                onClick={(event) => activateWorkspaceTool(event, "changes", onOpenChanges)}
                disabled={!workspaceToolsAvailable}
              >
                <span>Review changes</span><ChevronRight size={12} aria-hidden="true" />
              </button>
              {onCommit && commitAction && (
                <button
                  type="button"
                  onClick={onCommit}
                  disabled={commitAction.disabled}
                  title={commitAction.detail}
                >
                  <span>{commitAction.label}</span><ChevronRight size={12} aria-hidden="true" />
                </button>
              )}
              {onPush && pushAction && (
                <button
                  type="button"
                  onClick={onPush}
                  disabled={pushAction.disabled}
                  title={pushAction.detail}
                >
                  <span>{pushAction.label}</span><ChevronRight size={12} aria-hidden="true" />
                </button>
              )}
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
                <p>No local servers detected.</p>
              ) : summary.localServers.map((server) => (
                <button
                  type="button"
                  onClick={(event) => activateWorkspaceTool(event, "preview", onOpenPreview)}
                  key={server.url}
                >
                  <span title={server.url}>{server.url}</span>
                  <ExternalLink size={12} aria-hidden="true" />
                </button>
              ))}
            </div>
          </details>
        </div>

        {summary.gitNotice && (
          <div className="environment-panel-notice" role="status">
            <span>{summary.gitNotice}</span>
            {onRetryGit && (
              <button type="button" onClick={onRetryGit}>Retry</button>
            )}
          </div>
        )}

        <section className="environment-panel-section" aria-labelledby={repositoryHeadingId}>
          <h3 id={repositoryHeadingId}>Repository</h3>
          <button
            type="button"
            className="environment-row"
            onClick={onOpenProject}
            disabled={!summary.workspace}
            title={summary.repository?.path ?? summary.workspace?.path}
            aria-label={`Open repository ${repositoryLabel} externally`}
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
