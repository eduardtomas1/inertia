import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ConversationShell,
  type WorkspaceRun,
} from "../src/shared/contracts";
import { providerNativeModelSelection } from "../src/shared/model-routing";
import { sidebarWorkLayoutKey } from "../src/renderer/src/hooks/useSidebarWorkIndex";
import { applyConversationShellEvent } from "../src/renderer/src/utils/runtimeSnapshotProjection";
import { indexConversationWorkspaceRuns } from "../src/shared/attention";
import {
  groupWorkThreads,
  sidebarThreadView,
  sidebarThreadViewMap,
  sortSidebarThreadViews,
  type SidebarThreadView,
  type SidebarWorkSection,
} from "../src/renderer/src/utils/sidebarModel";
import { structurallyEqual } from "../src/renderer/src/utils/structuralEquality";

interface Measurement {
  case: string;
  mode: string;
  minimumMs: number;
  medianMs: number;
  maximumMs: number;
}

const THREADS = 2_000;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");

function measure(operation: () => void): Omit<Measurement, "case" | "mode"> {
  operation();
  const samples = Array.from({ length: 15 }, () => {
    const startedAt = performance.now();
    operation();
    return performance.now() - startedAt;
  }).sort((left, right) => left - right);
  return {
    minimumMs: samples[0]!,
    medianMs: samples[Math.floor(samples.length / 2)]!,
    maximumMs: samples.at(-1)!,
  };
}

function legacyDayOffset(value: string, now: number): number {
  const date = new Date(value);
  const current = new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(current.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  return Math.round((currentDay - dateDay) / 86_400_000);
}

function legacyGroupWorkThreads(
  threads: readonly SidebarThreadView[],
  now: number,
): SidebarWorkSection[] {
  const isOrdinarilySnoozed = ({ conversation, needsAttention, status }: SidebarThreadView) => Boolean(
    conversation.snoozedUntil
    && Date.parse(conversation.snoozedUntil) > now
    && !needsAttention
    && status !== "working"
  );
  const snoozed = threads.filter(isOrdinarilySnoozed);
  const active = threads.filter((thread) => !thread.settled && !thread.hidden && !isOrdinarilySnoozed(thread));
  const done = threads.filter((thread) => thread.settled && !thread.hidden && !isOrdinarilySnoozed(thread));
  const dayOffset = ({ conversation }: SidebarThreadView) => legacyDayOffset(conversation.updatedAt, now);
  const urgent = ({ needsAttention, status }: SidebarThreadView) => needsAttention || status === "working";
  return [
    { id: "recent", label: "Recent", threads: active.filter((thread) => urgent(thread) || dayOffset(thread) <= 0) },
    { id: "yesterday", label: "Yesterday", threads: active.filter((thread) => !urgent(thread) && dayOffset(thread) === 1) },
    { id: "earlier", label: "Earlier", threads: active.filter((thread) => !urgent(thread) && dayOffset(thread) > 1) },
    { id: "done", label: "Done", threads: done },
    { id: "snoozed", label: "Snoozed", threads: snoozed },
  ];
}

function legacyDescendingTimestamp(
  left: { id: string; startedAt?: string; updatedAt?: string },
  right: { id: string; startedAt?: string; updatedAt?: string },
): number {
  const leftTime = Date.parse(left.startedAt ?? left.updatedAt ?? "");
  const rightTime = Date.parse(right.startedAt ?? right.updatedAt ?? "");
  return (Number.isFinite(rightTime) ? rightTime : 0)
    - (Number.isFinite(leftTime) ? leftTime : 0)
    || left.id.localeCompare(right.id, "en");
}

type ShellEvent = Parameters<typeof applyConversationShellEvent>[1];

function legacyApplyConversationShellEvent(snapshot: AppSnapshot, event: ShellEvent): AppSnapshot {
  const current = snapshot.conversations.find(({ id }) => id === event.conversation.id);
  const currentRuns = snapshot.runs.filter(({ conversationId }) => conversationId === event.conversation.id);
  const runsById = new Map(currentRuns.map((run) => [run.id, run]));
  if (
    current
    && structurallyEqual(current, event.conversation)
    && currentRuns.length === event.runs.length
    && event.runs.every((run) => structurallyEqual(runsById.get(run.id), run))
  ) return snapshot;
  return {
    ...snapshot,
    conversations: [
      ...snapshot.conversations.filter(({ id }) => id !== event.conversation.id),
      event.conversation,
    ].sort(legacyDescendingTimestamp),
    runs: [
      ...snapshot.runs.filter(({ conversationId }) => conversationId !== event.conversation.id),
      ...event.runs,
    ].sort(legacyDescendingTimestamp).slice(0, 200),
  };
}

function conversation(index: number): ConversationShell {
  const updatedAt = new Date(NOW - index * 3_600_000).toISOString();
  return {
    id: `conversation-${String(index).padStart(5, "0")}`,
    projectId: `project-${index % 12}`,
    title: `Conversation ${index}`,
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: index === 0 ? "running" : "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: index % 3 === 0 && index > 0 ? updatedAt : null,
    completedAt: updatedAt,
    lastViewedAt: updatedAt,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: updatedAt,
    updatedAt,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  };
}

function agentRun(target: ConversationShell): WorkspaceRun {
  return {
    id: `run-${target.id}`,
    kind: "agent",
    projectId: target.projectId,
    conversationId: target.id,
    actionId: null,
    label: target.title,
    detail: null,
    status: "running",
    attentionState: "unseen",
    canStop: true,
    port: null,
    startedAt: target.updatedAt,
    finishedAt: null,
  };
}

function legacyViewMap(
  conversations: readonly ConversationShell[],
  runs: readonly WorkspaceRun[],
): ReadonlyMap<string, SidebarThreadView> {
  const runsByConversation = indexConversationWorkspaceRuns(runs);
  return new Map(conversations.map((entry) => {
    const run = runsByConversation.get(entry.id);
    return [entry.id, sidebarThreadView(entry, null, run ? [run] : [])];
  }));
}

describe("sidebar Work model benchmark", () => {
  it("measures grouping, shell projection and one agent command event at 2,000 chats", () => {
    const conversations = Array.from({ length: THREADS }, (_, index) => conversation(index));
    const live = conversations[0]!;
    const run = agentRun(live);
    const snapshot: AppSnapshot = {
      projects: [],
      conversations,
      runs: [run],
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: live.projectId,
      activeConversationId: live.id,
    };
    const views = sortSidebarThreadViews([...sidebarThreadViewMap(conversations, null, [run]).values()]);
    const command: WorkspaceRun = { ...run, id: "command", kind: "check", startedAt: new Date(NOW).toISOString() };
    const event: ShellEvent = {
      type: "conversation.shell.updated",
      conversation: structuredClone(live),
      runs: structuredClone([command, run]),
    };

    expect(groupWorkThreads(views, NOW)).toEqual(legacyGroupWorkThreads(views, NOW));
    const projected = applyConversationShellEvent(snapshot, event);
    const legacyProjected = legacyApplyConversationShellEvent(snapshot, event);
    expect(projected.conversations).toEqual(legacyProjected.conversations);
    expect(projected.runs).toEqual(legacyProjected.runs);

    const previousViews = sidebarThreadViewMap(snapshot.conversations, null, snapshot.runs);
    expect(projected.conversations).toBe(snapshot.conversations);
    expect(sidebarThreadViewMap(projected.conversations, null, projected.runs))
      .toBe(previousViews);
    const legacyEvent = () => {
      const next = legacyApplyConversationShellEvent(snapshot, event);
      const nextViews = legacyViewMap(next.conversations, next.runs);
      const sorted = sortSidebarThreadViews([...nextViews.values()]);
      const sections = legacyGroupWorkThreads(sorted, NOW);
      sidebarWorkLayoutKey(false, sections.flatMap(({ threads }) => threads.map(({ conversation: entry }) => ({ id: `thread:${entry.id}` }))));
    };
    const currentEvent = () => {
      const next = applyConversationShellEvent(snapshot, event);
      const nextViews = sidebarThreadViewMap(next.conversations, null, next.runs);
      if (nextViews === previousViews && next.conversations === snapshot.conversations) return;
      const sorted = sortSidebarThreadViews([...nextViews.values()]);
      const sections = groupWorkThreads(sorted, NOW);
      sidebarWorkLayoutKey(false, sections.flatMap(({ threads }) => threads.map(({ conversation: entry }) => ({ id: `thread:${entry.id}` }))));
    };

    const measurements: Measurement[] = [];
    for (const [label, mode, operation] of [
      [`groupWorkThreads × ${THREADS}`, "legacy", () => legacyGroupWorkThreads(views, NOW)],
      [`groupWorkThreads × ${THREADS}`, "current", () => groupWorkThreads(views, NOW)],
      [`shell projection × ${THREADS}`, "legacy", () => legacyApplyConversationShellEvent(snapshot, event)],
      [`shell projection × ${THREADS}`, "current", () => applyConversationShellEvent(snapshot, event)],
      [`command run event chain × ${THREADS}`, "legacy", legacyEvent],
      [`command run event chain × ${THREADS}`, "current", currentEvent],
    ] as const) {
      measurements.push({ case: label, mode, ...measure(operation) });
    }

    console.table(measurements.map((measurement) => ({
      case: measurement.case,
      mode: measurement.mode,
      "minimum ms": measurement.minimumMs.toFixed(2),
      "median ms": measurement.medianMs.toFixed(2),
      "maximum ms": measurement.maximumMs.toFixed(2),
    })));
  });
});
