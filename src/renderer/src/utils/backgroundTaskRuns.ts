import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";

export function backgroundCommandIsLive({ status }: WorkspaceRun): boolean {
  return status === "running" || status === "waiting";
}

export function backgroundCommandRuns(
  runs: readonly WorkspaceRun[],
  conversationId: string | null,
  turns: readonly AgentTurn[],
): WorkspaceRun[] {
  if (!conversationId) return [];
  const turnRunIds = new Set(turns.map(({ runId }) => runId));
  const earliestTurn = turns.reduce<string | null>(
    (earliest, { requestedAt }) =>
      earliest === null || requestedAt < earliest ? requestedAt : earliest,
    null,
  );
  return runs.filter((run) =>
    run.conversationId === conversationId
    && workspaceRunAttentionView(run).bucket !== "hidden"
    && (run.kind !== "agent" || (
      !turnRunIds.has(run.id)
      && earliestTurn !== null
      && run.startedAt >= earliestTurn
    )));
}

export function runningBackgroundTaskCount(
  subagents: readonly SubagentTrace[],
  commands: readonly WorkspaceRun[],
): number {
  return subagents.filter(({ isLive }) => isLive).length
    + commands.filter(backgroundCommandIsLive).length;
}

export function runningBackgroundTasksLabel(count: number): string {
  return `${count} background ${count === 1 ? "task" : "tasks"} running`;
}
