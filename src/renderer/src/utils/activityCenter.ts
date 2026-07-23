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
