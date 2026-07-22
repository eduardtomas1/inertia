import { useEffect, useMemo, useState } from "react";
import { Activity, Bot, CheckCircle2, CircleDot, GitBranch, Server, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { Conversation, Project, WorkspaceRun } from "@shared/contracts";
import { IconButton } from "./ui";

type ActivityCenterProps = {
  open: boolean;
  runs: WorkspaceRun[];
  projects: Project[];
  conversations: Conversation[];
  onClose: () => void;
};

const categories: Array<{ kind: WorkspaceRun["kind"]; label: string; icon: typeof Bot }> = [
  { kind: "agent", label: "Agents", icon: Bot },
  { kind: "check", label: "Checks", icon: ShieldCheck },
  { kind: "service", label: "Services", icon: Server },
  { kind: "source-control", label: "Source Control", icon: GitBranch },
];

function duration(run: WorkspaceRun, now: number): string {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const seconds = Math.max(0, Math.floor((end - Date.parse(run.startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3_600 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusCopy(run: WorkspaceRun, now: number): string {
  if (run.status === "running") return run.port ? `:${run.port} · ${duration(run, now)}` : duration(run, now);
  if (run.status === "waiting") return `Waiting · ${duration(run, now)}`;
  if (run.status === "succeeded") return `Passed · ${duration(run, now)}`;
  if (run.status === "cancelled") return `Stopped · ${duration(run, now)}`;
  return `Failed · ${duration(run, now)}`;
}

function RunState({ run }: { run: WorkspaceRun }): React.JSX.Element {
  if (run.status === "failed") return <TriangleAlert size={12} />;
  if (run.status === "succeeded") return <CheckCircle2 size={12} />;
  return <CircleDot size={12} />;
}

export function ActivityCenter({ open, runs, projects, conversations, onClose }: ActivityCenterProps): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now());
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

  const hoverDetail = (run: WorkspaceRun): string | undefined => {
    if (run.kind === "check") return undefined;
    const project = projects.find(({ id }) => id === run.projectId);
    const conversation = conversations.find(({ id }) => id === run.conversationId);
    const location = conversation?.worktreePath ?? project?.path;
    const context = [project?.name, conversation?.title, location].filter(Boolean).join(" · ");
    return [run.detail, context].filter(Boolean).join("\n") || undefined;
  };

  return (
    <div className="activity-center-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="activity-center" aria-label="Activity center">
        <header><span><Activity size={16} /><strong>Activity Center</strong></span><IconButton label="Close activity center" onClick={onClose}><X size={15} /></IconButton></header>
        <div className="activity-center-content">
          {categories.map((category) => {
            const entries = sorted.filter(({ kind }) => kind === category.kind).slice(0, 12);
            const CategoryIcon = category.icon;
            return <section className="activity-category" key={category.kind}>
              <h2><CategoryIcon size={13} />{category.label}<span>{entries.filter(({ finishedAt }) => !finishedAt).length || ""}</span></h2>
              {entries.length === 0 ? <p>No recent activity</p> : entries.map((run) => (
                <div className={`activity-run is-${run.status}`} title={hoverDetail(run)} key={run.id}>
                  <RunState run={run} />
                  <span><strong>{run.label}</strong>{run.detail && run.kind === "check" && <small>{run.detail}</small>}</span>
                  <time dateTime={run.startedAt}>{statusCopy(run, now)}</time>
                </div>
              ))}
            </section>;
          })}
        </div>
      </aside>
    </div>
  );
}
