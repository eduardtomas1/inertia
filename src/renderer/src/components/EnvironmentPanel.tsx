import { useId } from "react";
import {
  Bot,
  ExternalLink,
  Files,
  FileText,
  FolderOpen,
  GitCompareArrows,
  Globe2,
  Image,
  Laptop,
  ListChecks,
} from "lucide-react";

import { chatAttachmentKind } from "@shared/attachments";
import type { EnvironmentSummarySnapshot } from "../utils/environmentSummary";

interface EnvironmentPanelProps {
  summary: EnvironmentSummarySnapshot;
  workspaceToolsAvailable: boolean;
  onOpenChanges: () => void;
  onOpenFiles: () => void;
  onOpenPreview: () => void;
  onOpenProject: () => void;
  onRevealProject: () => void;
}

function subagentLabel(
  trace: EnvironmentSummarySnapshot["subagents"][number],
): string {
  return trace.providerName
    ?? trace.providerRole
    ?? "Delegated agent";
}

export function EnvironmentPanel({
  summary,
  workspaceToolsAvailable,
  onOpenChanges,
  onOpenFiles,
  onOpenPreview,
  onOpenProject,
  onRevealProject,
}: EnvironmentPanelProps): React.JSX.Element {
  const panelId = useId();
  const headingId = `${panelId}-heading`;
  const changesHeadingId = `${panelId}-changes`;
  const serversHeadingId = `${panelId}-servers`;
  const activeWorkHeadingId = `${panelId}-active-work`;
  const attachmentsHeadingId = `${panelId}-attachments`;
  const changesTitle = summary.gitState === "loading"
    ? "Checking working tree"
    : summary.gitState === "error"
      ? "Repository details unavailable"
      : summary.changes
        ? summary.changes.files === 0
          ? "Working tree clean"
          : `${summary.changes.files} changed ${summary.changes.files === 1 ? "file" : "files"}`
        : "No Git repository";
  const changesDetail = summary.gitState === "loading"
    ? "Loading repository state…"
    : summary.gitState === "error"
      ? "Changes cannot be opened right now"
      : summary.changes
        ? summary.changes.files === 0
          ? "Open Changes to review the repository"
          : summary.changes.repositories > 1
            ? `Review changes across ${summary.changes.repositories} repositories`
            : "Open Changes to review the diff"
        : "Changes are unavailable for this workspace";
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
  const visibleRepository = summary.repository
    && summary.repository.path !== summary.workspace?.path
    ? summary.repository
    : null;
  const workspaceDisplay = summary.workspace?.label === "Project directory"
    ? summary.workspace.path
    : summary.workspace?.value;

  return (
    <section className="environment-panel" aria-labelledby={headingId}>
      <header className="environment-panel-heading">
        <div className="environment-panel-title">
          <small>Environment</small>
          <h2 id={headingId}>
            {summary.projectName ?? summary.workspace?.value ?? "Workspace"}
          </h2>
        </div>

        {(summary.workspace || summary.branch || visibleRepository) && (
          <dl className="environment-context" aria-label="Workspace context">
            {summary.workspace && (
              <div>
                <dt>{summary.workspace.label}</dt>
                <dd title={summary.workspace.path}>{workspaceDisplay}</dd>
              </div>
            )}
            {summary.branch && (
              <div>
                <dt>{summary.branch.label}</dt>
                <dd title={summary.branch.value}>{summary.branch.value}</dd>
              </div>
            )}
            {visibleRepository && (
              <div>
                <dt>Repository</dt>
                <dd title={visibleRepository.path}>{visibleRepository.name}</dd>
              </div>
            )}
          </dl>
        )}

        <div className="environment-panel-actions" aria-label="Environment actions">
          <button type="button" onClick={onOpenProject} disabled={!summary.workspace}>
            <FolderOpen size={14} aria-hidden="true" /><span>Open project</span>
          </button>
          <button type="button" onClick={onRevealProject} disabled={!summary.workspace}>
            <ExternalLink size={14} aria-hidden="true" /><span>Reveal</span>
          </button>
          <button type="button" onClick={onOpenFiles} disabled={!workspaceToolsAvailable}>
            <Files size={14} aria-hidden="true" /><span>Browse files</span>
          </button>
        </div>
      </header>

      <div className="environment-panel-body">
        {runtimeAttention && (
          <div
            className={`environment-runtime-attention is-${summary.runtime.status}`}
            role="status"
            aria-live="polite"
          >
            <Laptop size={15} aria-hidden="true" />
            <span><strong>{runtimeAttention.title}</strong><small>{runtimeAttention.detail}</small></span>
          </div>
        )}

        <section className="environment-panel-section" aria-labelledby={changesHeadingId}>
          <h3 id={changesHeadingId}>Working tree</h3>
          <button
            type="button"
            className="environment-fact"
            onClick={onOpenChanges}
            disabled={!workspaceToolsAvailable || summary.gitState !== "ready" || !summary.changes}
          >
            <GitCompareArrows size={16} aria-hidden="true" />
            <span>
              <strong>{changesTitle}</strong>
              <small aria-live="polite">{changesDetail}</small>
            </span>
            {summary.gitState === "ready" && summary.changes && summary.changes.files > 0 && (
              <span
                className="environment-change-stats"
                aria-label={`${summary.changes.insertions} insertions and ${summary.changes.deletions} deletions`}
              >
                <b>+{summary.changes.insertions}</b><i>−{summary.changes.deletions}</i>
              </span>
            )}
          </button>
          {summary.gitNotice && (
            <p className="environment-panel-notice" role="status">Some repository details are unavailable: {summary.gitNotice}</p>
          )}
        </section>

        {summary.localServers.length > 0 && (
          <section className="environment-panel-section" aria-labelledby={serversHeadingId}>
            <h3 id={serversHeadingId}>Local servers</h3>
            {summary.localServers.map((server) => (
              <button type="button" className="environment-link-row" onClick={onOpenPreview} key={server.url}>
                <Globe2 size={15} aria-hidden="true" />
                <span><strong>{server.url}</strong><small>Open in Preview</small></span>
                <ExternalLink size={13} aria-hidden="true" />
              </button>
            ))}
          </section>
        )}

        {(summary.checks.length > 0 || summary.subagents.length > 0) && (
          <section className="environment-panel-section" aria-labelledby={activeWorkHeadingId}>
            <h3 id={activeWorkHeadingId}>Active work</h3>
            <ul className="environment-compact-list">
              {summary.checks.map((check) => (
                <li key={check.id}>
                  <ListChecks size={14} aria-hidden="true" />
                  <span>{check.label}</span>
                  <small>{check.status === "waiting" ? "Waiting" : check.status === "failed" ? "Needs attention" : "Running"}</small>
                </li>
              ))}
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
            <ul className="environment-compact-list">
              {summary.attachments.map((attachment) => {
                const image = chatAttachmentKind(attachment.mimeType) === "image";
                return (
                  <li key={attachment.id}>
                    {image ? <Image size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
                    <span title={attachment.name}>{attachment.name}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!workspaceToolsAvailable && (
          <p className="environment-panel-notice" role="status">
            Files, changes, and Terminal will become available after this isolated worktree is created by the first message.
          </p>
        )}

      </div>
    </section>
  );
}
