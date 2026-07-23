import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ExternalLink,
  FolderOpen,
  MessageSquare,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Conversation, Project, WorkspaceRun } from "@shared/contracts";
import {
  activityRunActions,
  activityRunSections,
  activityRunSummary,
  activityStatusLabel,
  activityWaitingKind,
} from "../utils/activityCenter";
import { IconButton } from "./ui";

type ActivityCenterProps = {
  open: boolean;
  now: number;
  runs: WorkspaceRun[];
  projects: Project[];
  conversations: Conversation[];
  onClose: () => void;
  onOpenThread: (conversation: Conversation) => void;
  onOpenLocation: (run: WorkspaceRun) => void;
  onOpenTerminal: (run: WorkspaceRun) => void;
  onOpenPreview: (run: WorkspaceRun) => void;
  onStop: (run: WorkspaceRun) => void;
  onRerun: (run: WorkspaceRun) => void;
  onDismiss: (run: WorkspaceRun) => void;
};

type PrimaryRunAction = {
  kind: "open-thread" | "rerun" | "failure-details";
  label: string;
  run: () => void;
};

function RunState({ run }: { run: WorkspaceRun }): React.JSX.Element {
  if (run.status === "failed") return <TriangleAlert size={13} aria-hidden="true" />;
  if (run.status === "succeeded") return <CheckCircle2 size={13} aria-hidden="true" />;
  return <CircleDot size={13} aria-hidden="true" />;
}

function runKindLabel(kind: WorkspaceRun["kind"]): string {
  if (kind === "source-control") return "Source control";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function ActivityCenter({
  open,
  now,
  runs,
  projects,
  conversations,
  onClose,
  onOpenThread,
  onOpenLocation,
  onOpenTerminal,
  onOpenPreview,
  onStop,
  onRerun,
  onDismiss,
}: ActivityCenterProps): React.JSX.Element | null {
  const [expandedFailure, setExpandedFailure] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [open]);

  const sections = useMemo(() => activityRunSections(runs, now), [now, runs]);
  const summary = useMemo(() => activityRunSummary(runs, now), [now, runs]);
  if (!open) return null;

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));

  return (
    <div className="activity-center-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside
        ref={panelRef}
        className="activity-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="runs-title"
        tabIndex={-1}
      >
        <header>
          <span>
            <Activity size={16} aria-hidden="true" />
            <span>
              <h2 id="runs-title">Runs</h2>
              <small>
                {summary.attentionCount > 0
                  ? `${summary.attentionCount} ${summary.attentionCount === 1 ? "item needs" : "items need"} attention`
                  : summary.activeCount > 0
                    ? `${summary.activeCount} active`
                    : "Agents, checks, and services"}
              </small>
            </span>
          </span>
          <IconButton label="Close runs" onClick={onClose}><X size={15} /></IconButton>
        </header>
        <div className="activity-center-content">
          {sections.length === 0 ? (
            <div className="activity-empty" role="status">
              <CheckCircle2 size={20} aria-hidden="true" />
              <strong>All clear</strong>
              <p>Active agents, checks, and services will appear here.</p>
            </div>
          ) : sections.map((section) => (
            <section className={`activity-category is-${section.id}`} key={section.id}>
              <h2>{section.label}<span>{section.runs.length}</span></h2>
              {section.runs.map((run) => {
                  const project = projectById.get(run.projectId);
                  const conversation = run.conversationId ? conversationById.get(run.conversationId) : undefined;
                  const actions = activityRunActions(run);
                  const waitingKind = activityWaitingKind(run, conversations);
                  const waitingClass = waitingKind ? ` is-waiting-${waitingKind}` : "";
                  const detailOpen = expandedFailure === run.id;
                  const primaryAction: PrimaryRunAction | null = waitingKind && conversation
                    ? {
                        kind: "open-thread",
                        label: waitingKind === "approval"
                          ? "Review approval"
                          : waitingKind === "input"
                            ? "Answer request"
                            : "Open request",
                        run: () => onOpenThread(conversation),
                      }
                    : run.status === "failed" && actions.rerun
                      ? { kind: "rerun", label: "Retry", run: () => onRerun(run) }
                      : run.status === "failed" && actions.failureDetails
                        ? {
                            kind: "failure-details",
                            label: detailOpen ? "Hide details" : "View details",
                            run: () => setExpandedFailure(detailOpen ? null : run.id),
                          }
                        : null;
                  const context = [conversation?.title, project?.name].filter(Boolean).join(" · ")
                    || run.detail
                    || "Workspace";
                  return (
                    <article className={`activity-run is-${run.status}${waitingClass}`} key={run.id}>
                      <div className="activity-run-summary">
                        <RunState run={run} />
                        <span>
                          <strong>{run.label}</strong>
                          <small>{runKindLabel(run.kind)} · {context}</small>
                        </span>
                        <time dateTime={run.startedAt}>{activityStatusLabel(run, now, waitingKind)}</time>
                      </div>
                      <div className="activity-run-controls">
                        {primaryAction && (
                          <button type="button" className="activity-primary-action" onClick={primaryAction.run}>
                            {primaryAction.label}
                          </button>
                        )}
                        <div className="activity-run-actions" aria-label={`Actions for ${run.label}`}>
                          {actions.openThread && conversation && primaryAction?.kind !== "open-thread" && (
                            <IconButton label={`Open thread: ${conversation.title}`} onClick={() => onOpenThread(conversation)}>
                              <MessageSquare size={13} />
                            </IconButton>
                          )}
                          {actions.openLocation && project && (
                            <IconButton label={`Open ${conversation?.worktreePath ? "worktree" : "project"} folder`} onClick={() => onOpenLocation(run)}>
                              <FolderOpen size={13} />
                            </IconButton>
                          )}
                          {actions.openTerminal && project && (
                            <IconButton label={`Open terminal for ${conversation?.title ?? project.name}`} onClick={() => onOpenTerminal(run)}>
                              <TerminalSquare size={13} />
                            </IconButton>
                          )}
                          {actions.openPreview && (
                            <IconButton label={`Open preview on port ${run.port}`} onClick={() => onOpenPreview(run)}>
                              <ExternalLink size={13} />
                            </IconButton>
                          )}
                          {actions.stop && (
                            <IconButton label={`Stop ${run.label}`} onClick={() => onStop(run)}>
                              <Square size={12} />
                            </IconButton>
                          )}
                          {actions.rerun && primaryAction?.kind !== "rerun" && (
                            <IconButton label={`${run.status === "failed" ? "Retry" : "Rerun"} ${run.label}`} onClick={() => onRerun(run)}>
                              <RotateCcw size={13} />
                            </IconButton>
                          )}
                          {actions.failureDetails && primaryAction?.kind !== "failure-details" && (
                            <IconButton
                              label={`${detailOpen ? "Hide" : "Reveal"} failure details for ${run.label}`}
                              aria-expanded={detailOpen}
                              onClick={() => setExpandedFailure(detailOpen ? null : run.id)}
                            >
                              <ChevronDown size={13} />
                            </IconButton>
                          )}
                          {actions.dismiss && (
                            <IconButton label={`Dismiss ${run.label}`} onClick={() => onDismiss(run)}>
                              <Trash2 size={13} />
                            </IconButton>
                          )}
                        </div>
                      </div>
                      {detailOpen && run.detail && <pre className="activity-failure-detail">{run.detail}</pre>}
                    </article>
                  );
                })}
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
