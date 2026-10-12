import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ChatMessage,
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
import { buildResponseTimeline } from "../../src/renderer/src/utils/response-timeline/model";

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

const userMessage: ChatMessage = {
  id: "55555555-5555-4555-8555-555555555555",
  conversationId,
  turnId,
  role: "user",
  content: "Fix the loader.",
  attachments: [],
  createdAt: "2026-07-28T12:00:30.000Z",
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

function emptyDetail(): ServerEvent {
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
        activities: [],
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

describe("useConversationProjection new turn", () => {
  it("shows a persisted new-turn message as that turn's request before detail reloads", async () => {
    const listeners = new Set<(event: ServerEvent) => void>();
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> =>
      command.type === "conversation.detail.load"
        ? emptyDetail()
        : { type: "request.ok", requestId: crypto.randomUUID() });
    const hook = renderHook(
      ({ current }: { current: AppSnapshot }) => useConversationProjection({
        snapshot: current,
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
      }),
      { initialProps: { current: snapshot(null) } },
    );
    await waitFor(() => expect(hook.result.current.detailState?.state).toBe("ready"));
    const loads = request.mock.calls.length;

    act(() => {
      for (const listener of listeners) {
        listener({ type: "conversation.message.persisted", message: userMessage });
      }
    });
    expect(hook.result.current.turns).toEqual([]);
    hook.rerender({ current: snapshot(latestTurn) });

    const { turns, messages } = hook.result.current;
    expect(turns).toEqual([expect.objectContaining({
      id: turnId,
      conversationId,
      runId: latestTurn.runId,
      userMessageId: userMessage.id,
      status: "starting",
      association: "authoritative",
    })]);
    const timeline = buildResponseTimeline({
      turns,
      messages,
      activities: [],
      reasonings: [],
      checkpoints: [],
    });
    expect(timeline.map(({ kind }) => kind)).toEqual(["turn"]);
    expect(timeline[0]).toMatchObject({ kind: "turn", turn: { userMessage: { id: userMessage.id } } });
    expect(request).toHaveBeenCalledTimes(loads);
  });
});
