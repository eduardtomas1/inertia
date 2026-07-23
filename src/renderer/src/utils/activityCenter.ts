import type { Conversation, WorkspaceRun } from "@shared/contracts";

export type ActivityWaitingKind = "approval" | "input" | "generic";

export interface ActivityRunActions {
  openThread: boolean;
  openLocation: boolean;
  openTerminal: boolean;
  openPreview: boolean;
  stop: boolean;
  rerun: boolean;
  dismiss: boolean;
  failureDetails: boolean;
}

export type ActivityRunSectionId = "attention" | "active" | "recent";

export interface ActivityRunSection {
  id: ActivityRunSectionId;
  label: string;
  runs: WorkspaceRun[];
}

export interface ActivityRunSummary {
  attentionCount: number;
  activeCount: number;
}

const FAILED_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1_000;

function compareStartedAtDescending(a: WorkspaceRun, b: WorkspaceRun): number {
  return b.startedAt.localeCompare(a.startedAt);
}

export function activityRunNeedsAttention(run: WorkspaceRun, now = Date.now()): boolean {
  if (run.status === "waiting") return true;
  if (run.status !== "failed") return false;
  const failureTime = Date.parse(run.finishedAt ?? run.startedAt);
  return Number.isFinite(failureTime) && now - failureTime <= FAILED_ATTENTION_WINDOW_MS;
}

export function activityRunSections(runs: readonly WorkspaceRun[], now = Date.now()): ActivityRunSection[] {
  const attention = runs
    .filter((run) => activityRunNeedsAttention(run, now))
    .sort((a, b) => {
      const waitingFirst = Number(b.status === "waiting") - Number(a.status === "waiting");
      return waitingFirst || compareStartedAtDescending(a, b);
    });
  const active = runs
    .filter((run) => run.finishedAt === null && !activityRunNeedsAttention(run, now))
    .sort(compareStartedAtDescending);
  const recent = runs
    .filter((run) => run.finishedAt !== null && !activityRunNeedsAttention(run, now))
    .sort(compareStartedAtDescending);

  const sections: ActivityRunSection[] = [
    { id: "attention", label: "Needs attention", runs: attention },
    { id: "active", label: "In progress", runs: active },
    { id: "recent", label: "Recent", runs: recent.slice(0, 12) },
  ];
  return sections.filter(({ runs: sectionRuns }) => sectionRuns.length > 0);
}

export function activityRunSummary(runs: readonly WorkspaceRun[], now = Date.now()): ActivityRunSummary {
  return {
    attentionCount: runs.filter((run) => activityRunNeedsAttention(run, now)).length,
    activeCount: runs.filter(({ finishedAt }) => finishedAt === null).length,
  };
}

export function activityWaitingKind(
  run: WorkspaceRun,
  conversations: readonly Conversation[],
): ActivityWaitingKind | null {
  if (run.status !== "waiting") return null;
  const conversation = conversations.find(({ id }) => id === run.conversationId);
  return conversation?.attentionKind ?? "generic";
}

export function activityRunActions(run: WorkspaceRun): ActivityRunActions {
  const finished = run.finishedAt !== null
    && run.status !== "running"
    && run.status !== "waiting";
  return {
    openThread: run.conversationId !== null,
    openLocation: true,
    openTerminal: true,
    openPreview: run.kind === "service" && run.port !== null && !finished,
    stop: run.canStop && (run.kind === "agent" || run.kind === "check" || run.kind === "service"),
    rerun: Boolean(
      run.actionId
      && (run.kind === "check" || run.kind === "service")
      && (run.status === "failed" || run.status === "succeeded" || run.status === "cancelled"),
    ),
    dismiss: finished,
    failureDetails: run.status === "failed" && Boolean(run.detail),
  };
}

export function activityStatusLabel(
  run: WorkspaceRun,
  now: number,
  waitingKind: ActivityWaitingKind | null,
): string {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const seconds = Math.max(0, Math.floor((end - Date.parse(run.startedAt)) / 1_000));
  const elapsed = seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  if (run.status === "running") return run.port ? `Running · :${run.port} · ${elapsed}` : `Running · ${elapsed}`;
  if (run.status === "waiting") {
    const reason = waitingKind === "approval"
      ? "Waiting for approval"
      : waitingKind === "input"
        ? "Waiting for input"
        : "Waiting";
    return `${reason} · ${elapsed}`;
  }
  if (run.status === "succeeded") return `Completed · ${elapsed}`;
  if (run.status === "cancelled") return `Stopped · ${elapsed}`;
  return `Failed · ${elapsed}`;
}
