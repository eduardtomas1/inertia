import {
  Bot,
  ExternalLink,
  Files,
  FileText,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Globe2,
  HardDrive,
  Image,
  Laptop,
  ListChecks,
  PanelsTopLeft,
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
  const changesDetail = summary.gitState === "loading"
    ? "Loading repository state…"
    : summary.changes
      ? summary.changes.files === 0
        ? "Working tree clean"
        : `${summary.changes.files} ${summary.changes.files === 1 ? "file" : "files"}${summary.changes.repositories > 1 ? ` · ${summary.changes.repositories} repositories` : ""}`
      : "No Git repository available";

  return (
    <section className="environment-panel" aria-labelledby="environment-panel-heading">
      <header className="environment-panel-heading">
        <span>
          <small>Environment</small>
          <h2 id="environment-panel-heading">{summary.projectName ?? "Workspace"}</h2>
          <p>Live facts and safe actions for this task.</p>
        </span>
        <span className={`environment-runtime-pill is-${summary.runtime.status}`} aria-live="polite">
          <i aria-hidden="true" />{summary.runtime.label}
        </span>
      </header>

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

      <div className="environment-panel-body">
        <section className="environment-panel-section" aria-labelledby="environment-workspace-heading">
          <h3 id="environment-workspace-heading">Workspace</h3>
          <div className="environment-fact-list">
            <button
              type="button"
              className="environment-fact"
              onClick={onOpenChanges}
              disabled={!workspaceToolsAvailable || summary.gitState === "loading" || !summary.changes}
            >
              <GitCompareArrows size={16} aria-hidden="true" />
              <span><strong>Changes</strong><small>{changesDetail}</small></span>
              {summary.changes && summary.changes.files > 0 && (
                <span
                  className="environment-change-stats"
                  aria-label={`${summary.changes.insertions} insertions and ${summary.changes.deletions} deletions`}
                >
                  <b>+{summary.changes.insertions}</b><i>−{summary.changes.deletions}</i>
                </span>
              )}
            </button>

            <div className="environment-fact" aria-live="polite">
              <Laptop size={16} aria-hidden="true" />
              <span><strong>Runtime</strong><small>Local workspace service</small></span>
              <em className={`is-${summary.runtime.status}`}>{summary.runtime.label}</em>
            </div>

            {summary.workspace && (
              <div className="environment-fact">
                <PanelsTopLeft size={16} aria-hidden="true" />
                <span>
                  <strong>{summary.workspace.label}</strong>
                  <small title={summary.workspace.path}>{summary.workspace.value}</small>
                </span>
              </div>
            )}

            {summary.branch && (
              <div className="environment-fact">
                <GitBranch size={16} aria-hidden="true" />
                <span><strong>{summary.branch.label}</strong><small title={summary.branch.value}>{summary.branch.value}</small></span>
              </div>
            )}
          </div>
          {summary.gitNotice && (
            <p className="environment-panel-notice" role="status">Some repository details are unavailable: {summary.gitNotice}</p>
          )}
        </section>

        {summary.repository && (
          <section className="environment-panel-section" aria-labelledby="environment-repository-heading">
            <h3 id="environment-repository-heading">Repository</h3>
            <div className="environment-link-row">
              <HardDrive size={15} aria-hidden="true" />
              <span><strong>{summary.repository.name}</strong><small title={summary.repository.path}>{summary.repository.path}</small></span>
            </div>
          </section>
        )}

        {summary.localServers.length > 0 && (
          <section className="environment-panel-section" aria-labelledby="environment-servers-heading">
            <h3 id="environment-servers-heading">Local servers</h3>
            {summary.localServers.map((server) => (
              <button type="button" className="environment-link-row" onClick={onOpenPreview} key={server.url}>
                <Globe2 size={15} aria-hidden="true" />
                <span><strong>{server.label}</strong><small>{server.url}</small></span>
                <ExternalLink size={13} aria-hidden="true" />
              </button>
            ))}
          </section>
        )}

        {(summary.checks.length > 0 || summary.subagents.length > 0) && (
          <section className="environment-panel-section" aria-labelledby="environment-active-work-heading">
            <h3 id="environment-active-work-heading">Active work</h3>
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

        <section className="environment-panel-section" aria-labelledby="environment-attachments-heading">
          <h3 id="environment-attachments-heading">Recent attachments</h3>
          {summary.attachments.length > 0 ? (
            <ul className="environment-compact-list environment-attachments">
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
          ) : (
            <p className="environment-panel-empty">No recent task attachments.</p>
          )}
        </section>

        {!workspaceToolsAvailable && (
          <p className="environment-panel-notice" role="status">
            Files, changes, and Terminal will become available after this isolated worktree is created by the first message.
          </p>
        )}

      </div>
    </section>
  );
}
