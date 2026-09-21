import type {
  EnvironmentLocalServer,
  EnvironmentRunItem,
  EnvironmentSummaryCheck,
} from "./environmentSummary";

export interface WorkspaceRunsModel {
  localServers: EnvironmentLocalServer[];
  checks: EnvironmentSummaryCheck[];
  onStopRun: (run: EnvironmentRunItem) => void;
  onOpenRunPreview: (run: EnvironmentRunItem) => void;
  onAcknowledgeRun: (run: EnvironmentRunItem) => void;
  onDismissRun: (run: EnvironmentRunItem) => void;
}

export function workspaceRunIsLive(run: Pick<EnvironmentRunItem, "status">): boolean {
  return run.status === "running" || run.status === "waiting";
}

export function liveWorkspaceRunCount(
  runs: Pick<WorkspaceRunsModel, "localServers" | "checks"> | null,
): number {
  if (!runs) return 0;
  return [...runs.localServers, ...runs.checks].filter(workspaceRunIsLive).length;
}

export function workspaceRunStatusLabel(status: EnvironmentRunItem["status"]): string {
  if (status === "waiting") return "Waiting";
  if (status === "failed") return "Needs attention";
  if (status === "succeeded") return "Completed";
  if (status === "cancelled") return "Stopped";
  return "Running";
}
