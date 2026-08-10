import type { Conversation, ProviderId, WorkspaceRun } from "@shared/contracts";
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

export type ActivityRunSectionId = "recent" | "yesterday" | "earlier";

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

const CANONICAL_PROVIDER_LABELS: ReadonlyArray<readonly [ProviderId, string]> = [
  ["codex", "Codex"],
  ["claude", "Claude"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
];

function providerIdFromCanonicalProjection(value: string | null): ProviderId | null {
  if (!value) return null;
  const normalized = value.trim();
  for (const [providerId, label] of CANONICAL_PROVIDER_LABELS) {
    if (normalized === label || normalized.startsWith(`${label} · `)) {
      return providerId;
    }
  }
  return null;
}

/**
 * Workspace runs do not persist a provider column. Attribute only the two
 * producer-owned projections whose canonical prefix is captured when work is
 * created. Never infer historical identity from the mutable conversation
 * route.
 */
export function activityRunProviderId(run: WorkspaceRun): ProviderId | null {
  if (run.kind === "agent") {
    return providerIdFromCanonicalProjection(run.label);
  }
  if (
    (run.kind === "check" || run.kind === "service")
    && run.actionId === null
  ) {
    return providerIdFromCanonicalProjection(run.detail);
  }
  return null;
}

function runActivityAt(run: WorkspaceRun): string {
  return run.finishedAt ?? run.startedAt;
}

function compareActivityAtDescending(a: WorkspaceRun, b: WorkspaceRun): number {
  return runActivityAt(b).localeCompare(runActivityAt(a));
}

function compareStartedAtAscending(a: WorkspaceRun, b: WorkspaceRun): number {
  return a.startedAt.localeCompare(b.startedAt);
}

export function activityRunNeedsAttention(run: WorkspaceRun, _now = Date.now()): boolean {
  return workspaceRunAttentionView(run).needsAttention;
}

function calendarDayOffset(value: string, now: number): number {
  const date = new Date(value);
  const current = new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(current.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  const dateDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const currentDay = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  ).getTime();
  return Math.round((currentDay - dateDay) / 86_400_000);
}

function sectionsForRuns(
  runs: readonly WorkspaceRun[],
  now: number,
): ActivityRunSection[] {
  const attention = runs
    .filter((run) => workspaceRunAttentionView(run).bucket === "attention")
    .sort(compareActivityAtDescending);
  const active = runs
    .filter((run) => workspaceRunAttentionView(run).bucket === "active")
    .sort(compareActivityAtDescending);
  const recent = runs
    .filter((run) => workspaceRunAttentionView(run).bucket === "recent")
    .sort(compareActivityAtDescending)
    .slice(0, 12);

  const visible = new Map<string, WorkspaceRun>();
  for (const run of [...attention, ...active, ...recent]) visible.set(run.id, run);
  const chronological = [...visible.values()].sort(compareActivityAtDescending);

  const sections: ActivityRunSection[] = [
    {
      id: "recent",
      label: "Recent",
      runs: chronological.filter((run) =>
        calendarDayOffset(runActivityAt(run), now) <= 0),
    },
    {
      id: "yesterday",
      label: "Yesterday",
      runs: chronological.filter((run) =>
        calendarDayOffset(runActivityAt(run), now) === 1),
    },
    {
      id: "earlier",
      label: "Earlier",
      runs: chronological.filter((run) =>
        calendarDayOffset(runActivityAt(run), now) > 1),
    },
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
  now = Date.now(),
): ActivityRunPresentation {
  const agentRuns = runs
    .filter(({ kind }) => kind === "agent")
    .sort(compareActivityAtDescending);
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
    sections: sectionsForRuns(primaryRuns, now),
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
  const seconds = Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 1_000));
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
  const occurredAt = Date.parse(run.finishedAt ?? run.startedAt);
  const ageSeconds = Number.isFinite(occurredAt)
    ? Math.max(0, Math.floor((now - occurredAt) / 1_000))
    : 0;
  const age = ageSeconds < 5
    ? "now"
    : ageSeconds < 60
      ? `${ageSeconds}s ago`
      : ageSeconds < 3_600
        ? `${Math.floor(ageSeconds / 60)}m ago`
        : ageSeconds < 86_400
          ? `${Math.floor(ageSeconds / 3_600)}h ago`
          : ageSeconds < 2_592_000
            ? `${Math.floor(ageSeconds / 86_400)}d ago`
            : ageSeconds < 31_536_000
              ? `${Math.floor(ageSeconds / 2_592_000)}mo ago`
              : `${Math.floor(ageSeconds / 31_536_000)}y ago`;
  if (run.status === "succeeded") return `Completed · ${age}`;
  if (run.status === "cancelled") return `Stopped · ${age}`;
  return `Failed · ${age}`;
}
