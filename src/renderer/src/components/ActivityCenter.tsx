import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ExternalLink,
  FolderOpen,
  GitBranch,
  MessageSquare,
  RotateCcw,
  Server,
  ShieldCheck,
  Square,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Conversation, Project, WorkspaceRun } from "@shared/contracts";
import {
  activityRunActions,
  activityStatusLabel,
  activityWaitingKind,
} from "../utils/activityCenter";
import { IconButton } from "./ui";

type ActivityCenterProps = {
  open: boolean;
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

const categories: Array<{ kind: WorkspaceRun["kind"]; label: string; icon: typeof Bot }> = [
  { kind: "agent", label: "Agents", icon: Bot },
  { kind: "check", label: "Checks", icon: ShieldCheck },
  { kind: "service", label: "Services", icon: Server },
  { kind: "source-control", label: "Source Control", icon: GitBranch },
];

function RunState({ run }: { run: WorkspaceRun }): React.JSX.Element {
  if (run.status === "failed") return <TriangleAlert size={13} aria-hidden="true" />;
  if (run.status === "succeeded") return <CheckCircle2 size={13} aria-hidden="true" />;
  return <CircleDot size={13} aria-hidden="true" />;
}

export function ActivityCenter({
  open,
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
  const [now, setNow] = useState(Date.now());
  const [expandedFailure, setExpandedFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !runs.some(({ finishedAt }) => !finishedAt)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, runs]);

  const sorted = useMemo(() => [...runs].sort((a, b) => {
    const active = Number(b.finishedAt === null) - Number(a.finishedAt === null);
    return active || b.startedAt.localeCompare(a.startedAt);
  }), [runs]);
  if (!open) return null;

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));

  return (
    <div className="activity-center-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="activity-center" aria-label="Activity center">
        <header>
          <span><Activity size={16} /><strong>Activity Center</strong></span>
          <IconButton label="Close activity center" onClick={onClose}><X size={15} /></IconButton>
        </header>
        <div className="activity-center-content">
          {categories.map((category) => {
            const entries = sorted.filter(({ kind }) => kind === category.kind).slice(0, 12);
            const CategoryIcon = category.icon;
            return (
              <section className="activity-category" key={category.kind}>
                <h2><CategoryIcon size={13} />{category.label}<span>{entries.filter(({ finishedAt }) => !finishedAt).length || ""}</span></h2>
                {entries.length === 0 ? <p>No recent activity</p> : entries.map((run) => {
                  const project = projectById.get(run.projectId);
                  const conversation = run.conversationId ? conversationById.get(run.conversationId) : undefined;
                  const actions = activityRunActions(run);
                  const waitingKind = activityWaitingKind(run, conversations);
                  const waitingClass = waitingKind ? ` is-waiting-${waitingKind}` : "";
                  const detailOpen = expandedFailure === run.id;
                  return (
                    <article className={`activity-run is-${run.status}${waitingClass}`} key={run.id}>
                      <div className="activity-run-summary">
                        <RunState run={run} />
                        <span>
                          <strong>{run.label}</strong>
                          <small>
                            {[conversation?.title, project?.name].filter(Boolean).join(" · ") || run.detail || "Workspace activity"}
                          </small>
                        </span>
                        <time dateTime={run.startedAt}>{activityStatusLabel(run, now, waitingKind)}</time>
                      </div>
                      <div className="activity-run-actions" aria-label={`Actions for ${run.label}`}>
                        {actions.openThread && conversation && (
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
                        {actions.rerun && (
                          <IconButton label={`${run.status === "failed" ? "Retry" : "Rerun"} ${run.label}`} onClick={() => onRerun(run)}>
                            <RotateCcw size={13} />
                          </IconButton>
                        )}
                        {actions.failureDetails && (
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
                      {detailOpen && run.detail && <pre className="activity-failure-detail">{run.detail}</pre>}
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
