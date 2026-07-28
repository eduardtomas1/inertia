import type { Conversation, WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";

export type ActivityWaitingKind = "approval" | "input" | "generic";

export interface ActivityRunActions {
  openThread: boolean;
  openLocation: boolean;
  openTerminal: boolean;
  openPreview: boolean;
  stop: boolean;
  rerun: boolean;
  acknowledge: boolean;
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

export interface ActivityRunOperationGroup {
  all: WorkspaceRun[];
  visible: WorkspaceRun[];
  hiddenCount: number;
}

export interface ActivityRunPresentation {
  sections: ActivityRunSection[];
  operationsByAgentRun: ReadonlyMap<string, ActivityRunOperationGroup>;
  summary: ActivityRunSummary;
}

const VISIBLE_AGENT_OPERATIONS = 3;

function compareStartedAtDescending(a: WorkspaceRun, b: WorkspaceRun): number {
  return b.startedAt.localeCompare(a.startedAt);
}

function compareStartedAtAscending(a: WorkspaceRun, b: WorkspaceRun): number {
  return a.startedAt.localeCompare(b.startedAt);
}

export function activityRunNeedsAttention(run: WorkspaceRun, _now = Date.now()): boolean {
  return workspaceRunAttentionView(run).needsAttention;
}

function sectionsForRuns(runs: readonly WorkspaceRun[]): ActivityRunSection[] {
  const attention = runs
    .filter((run) => workspaceRunAttentionView(run).bucket === "attention")
    .sort((a, b) => {
      const waitingFirst = Number(b.status === "waiting") - Number(a.status === "waiting");
      return waitingFirst || compareStartedAtDescending(a, b);
    });
  const active = runs
    .filter((run) => workspaceRunAttentionView(run).bucket === "active")
    .sort(compareStartedAtDescending);
  const recent = runs
    .filter((run) => workspaceRunAttentionView(run).bucket === "recent")
    .sort(compareStartedAtDescending);

  const sections: ActivityRunSection[] = [
    { id: "attention", label: "Needs attention", runs: attention },
    { id: "active", label: "In progress", runs: active },
    { id: "recent", label: "Recent", runs: recent.slice(0, 12) },
  ];
  return sections.filter(({ runs: sectionRuns }) => sectionRuns.length > 0);
}

function containingAgentRun(
  operation: WorkspaceRun,
  agentRuns: readonly WorkspaceRun[],
): WorkspaceRun | null {
  if (
    operation.kind === "agent"
    || operation.kind === "source-control"
    || operation.actionId !== null
    || operation.conversationId === null
    || operation.status === "failed"
  ) return null;
  const operationStartedAt = Date.parse(operation.startedAt);
  if (!Number.isFinite(operationStartedAt)) return null;
  return agentRuns.find((agent) => {
    if (
      agent.projectId !== operation.projectId
      || agent.conversationId !== operation.conversationId
    ) return false;
    const agentStartedAt = Date.parse(agent.startedAt);
    const agentFinishedAt = agent.finishedAt
      ? Date.parse(agent.finishedAt)
      : Number.POSITIVE_INFINITY;
    return Number.isFinite(agentStartedAt)
      && operationStartedAt >= agentStartedAt
      && operationStartedAt <= agentFinishedAt;
  }) ?? null;
}

function operationGroup(operations: WorkspaceRun[]): ActivityRunOperationGroup {
  const all = [...operations].sort(compareStartedAtAscending);
  const visible = all.slice(-VISIBLE_AGENT_OPERATIONS);
  return {
    all,
    visible,
    hiddenCount: Math.max(0, all.length - visible.length),
  };
}

/**
 * Provider command projections are already durable check/service WorkspaceRuns.
 * Group only those action-less child runs whose time range belongs to one
 * agent run. Source-control work is independently user-owned even without an
 * action ID, while explicit project actions and failures retain their own
 * controls and attention state.
 */
export function activityRunPresentation(
  runs: readonly WorkspaceRun[],
  _now = Date.now(),
): ActivityRunPresentation {
  const agentRuns = runs
    .filter(({ kind }) => kind === "agent")
    .sort(compareStartedAtDescending);
  const groupedIds = new Set<string>();
  const grouped = new Map<string, WorkspaceRun[]>();

  for (const operation of runs) {
    const owner = containingAgentRun(operation, agentRuns);
    if (!owner) continue;
    groupedIds.add(operation.id);
    const operations = grouped.get(owner.id) ?? [];
    operations.push(operation);
    grouped.set(owner.id, operations);
  }

  const primaryRuns = runs.filter(({ id }) => !groupedIds.has(id));
  return {
    sections: sectionsForRuns(primaryRuns),
    operationsByAgentRun: new Map(
      [...grouped].map(([runId, operations]) => [
        runId,
        operationGroup(operations),
      ]),
    ),
    summary: {
      attentionCount: primaryRuns.filter((run) =>
        workspaceRunAttentionView(run).needsAttention).length,
      activeCount: primaryRuns.filter(({ status }) =>
        status === "running" || status === "waiting").length,
    },
  };
}

export function activityRunSections(
  runs: readonly WorkspaceRun[],
  now = Date.now(),
): ActivityRunSection[] {
  return activityRunPresentation(runs, now).sections;
}

export function activityRunSummary(runs: readonly WorkspaceRun[], _now = Date.now()): ActivityRunSummary {
  return activityRunPresentation(runs, _now).summary;
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
  const attention = workspaceRunAttentionView(run);
  const finished = run.status !== "running" && run.status !== "waiting";
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
    acknowledge: attention.needsAttention && attention.canAcknowledge,
    dismiss: attention.canDismiss,
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
