import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentActivity,
  type AppSnapshot,
  type ConversationLatestTurnSummary,
  type ConversationShell,
  type ServerEvent,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

const conversationId = "11111111-1111-4111-8111-111111111111";
const turnId = "33333333-3333-4333-8333-333333333333";
const modelSelection = providerNativeModelSelection({
  providerId: "codex",
  modelId: "default",
  reasoningEffort: "medium",
});

const latestTurn: ConversationLatestTurnSummary = {
  id: turnId,
  runId: "44444444-4444-4444-8444-444444444444",
  status: "starting",
  providerId: "codex",
  harnessId: modelSelection.harnessId,
  backendProfileId: modelSelection.backendProfileId,
  modelSelection,
  continuationIdentity: continuationIdentityForSelection(modelSelection),
  model: modelSelection.modelId,
  reasoningEffort: "medium",
  requestedAt: "2026-07-28T12:00:30.000Z",
  startedAt: null,
  completedAt: null,
  terminalReason: null,
  updatedAt: "2026-07-28T12:00:30.000Z",
};

function shell(latest: ConversationLatestTurnSummary | null): ConversationShell {
  return {
    id: conversationId,
    projectId: "project",
    title: "Primary",
    providerId: "codex",
    model: "default",
    modelSelection,
    continuationIdentity: null,
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    branch: null,
    worktreePath: null,
    status: latest ? "running" : "idle",
    attentionKind: null,
    settledAt: null,
    archivedAt: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    completedAt: null,
    lastViewedAt: null,
    providerSessionId: null,
    latestTurn: latest,
    pendingApproval: false,
    pendingInput: false,
  };
}

function snapshot(latest: ConversationLatestTurnSummary | null): AppSnapshot {
  return {
    projects: [],
    conversations: [shell(latest)],
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    runs: [],
    activeProjectId: "project",
    activeConversationId: conversationId,
    settings: { ...defaultSettings },
  };
}

function emptyDetail(activities: AgentActivity[] = []): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: {
      kind: "conversation.detail",
      conversationId,
      state: "ready",
      detail: {
        conversation: shell(null),
        agentTurns: [],
        turnGitArtifacts: [],
        messages: [],
        activities,
        subagents: [],
        reasonings: [],
        usage: [],
        plans: [],
        goals: [],
        checkpoints: [],
        reviewSummaries: [],
        reviewStates: [],
        reviewNotes: [],
      },
    },
  } as unknown as ServerEvent;
}

function running(detail: string | null, extra: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: "66666666-6666-4666-8666-666666666666", conversationId, runId: latestTurn.runId, turnId,
    kind: "command", title: "npm test", detail, status: "running", createdAt: "2026-07-28T12:00:31.000Z", ...extra,
  };
}

function harness(history: AgentActivity[], full: () => string) {
  const listeners = new Set<(event: ServerEvent) => void>();
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "conversation.detail.load") return emptyDetail(history);
    if (command.type === "activity.detail.read") {
      return { type: "request.result", requestId: crypto.randomUUID(), result: {
        kind: "activity.detail", conversationId: command.payload.conversationId,
        activityId: command.payload.activityId, turnId, detail: full() } };
    }
    return { type: "request.ok", requestId: crypto.randomUUID() };
  });
  const hook = renderHook(() => useConversationProjection({
    snapshot: snapshot(latestTurn),
    status: "online",
    request,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enabled: true,
    autoOpenPlan: false,
    onOpenPlan: vi.fn(),
    onTerminal: vi.fn(),
  }));
  const emit = (event: ServerEvent) => act(() => { for (const listener of listeners) listener(event); });
  const reads = () => request.mock.calls.filter(([command]) => command.type === "activity.detail.read");
  const detail = () => hook.result.current.activities.find(({ id }) => id === running(null).id);
  return { hook, emit, reads, detail };
}

describe("streamed activity output in the conversation projection", () => {
  it("appends patches in order and reads the full output once when a patch does not fit", async () => {
    let stored = "Output:\nabcdef";
    const { hook, emit, reads, detail } = harness([], () => stored);
    await waitFor(() => expect(hook.result.current.detailState?.state).toBe("ready"));
    emit({ type: "agent.activity", activity: running("Output:\na") });
    emit({ type: "agent.activity", activity: running("b"), detailPatch: { base: 9, offset: 9 } });
    emit({ type: "agent.activity", activity: running("c"), detailPatch: { base: 10, offset: 10 } });
    expect(detail()?.detail).toBe("Output:\nabc");
    expect(reads()).toHaveLength(0);

    emit({ type: "agent.activity", activity: running("f"), detailPatch: { base: 13, offset: 13 } });
    emit({ type: "agent.activity", activity: running("g"), detailPatch: { base: 14, offset: 14 } });
    expect(detail()?.detail).toBe("Output:\nabc");
    await waitFor(() => expect(detail()?.detail).toBe("Output:\nabcdef"));
    expect(reads()).toHaveLength(1);
    expect(reads()[0]![0]).toMatchObject({ payload: { conversationId, activityId: running(null).id } });
    expect(detail()?.detailTruncated).toBeUndefined();

    stored = "unused";
    emit({ type: "agent.activity", activity: running("g"), detailPatch: { base: 14, offset: 14 } });
    expect(detail()?.detail).toBe("Output:\nabcdefg");
    emit({ type: "agent.activity", activity: running("Output:\nabcdefgh", { status: "completed" }) });
    expect(detail()).toMatchObject({ detail: "Output:\nabcdefgh", status: "completed" });
    expect(reads()).toHaveLength(1);
  });

  it("replaces a history preview with the full output before applying patches", async () => {
    const full = `Output:\n${"x".repeat(3_000)}`;
    const preview = running(full.slice(0, 2_048), { detailTruncated: true, detailBytes: 3_008 });
    const { hook, emit, reads, detail } = harness([preview], () => `${full}y`);
    await waitFor(() => expect(hook.result.current.detailState?.state).toBe("ready"));
    emit({ type: "agent.activity", activity: running("y"), detailPatch: { base: full.length, offset: full.length } });
    expect(detail()).toMatchObject({ detailTruncated: true });
    await waitFor(() => expect(detail()?.detail).toBe(`${full}y`));
    expect(reads()).toHaveLength(1);
    emit({ type: "agent.activity", activity: running("z"), detailPatch: { base: full.length + 1, offset: full.length + 1 } });
    expect(detail()?.detail).toBe(`${full}yz`);
  });
});
