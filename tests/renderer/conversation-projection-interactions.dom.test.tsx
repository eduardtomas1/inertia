import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentActivity,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AgentTurn,
  type AppSnapshot,
  type ChatMessage,
  type ConversationShell,
  type ServerEvent,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

const primaryId = "11111111-1111-4111-8111-111111111111";
const secondaryId = "22222222-2222-4222-8222-222222222222";

function conversation(id: string): ConversationShell {
  return {
    id,
    projectId: `${id}-project`,
    title: id === primaryId ? "Primary" : "Secondary",
    providerId: "codex",
    model: "default",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    branch: null,
    worktreePath: null,
    status: "needs-input",
    attentionKind: "approval",
    settledAt: null,
    archivedAt: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    completedAt: null,
    lastViewedAt: null,
    providerSessionId: null,
    latestTurn: null,
    pendingApproval: true,
    pendingInput: true,
  };
}

const snapshot: AppSnapshot = {
  projects: [],
  conversations: [
    conversation(primaryId),
    conversation(secondaryId),
  ],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: `${primaryId}-project`,
  activeConversationId: primaryId,
  settings: { ...defaultSettings },
};

function runningTurn(conversationId = primaryId): AgentTurn {
  const modelSelection = nativeModelSelection({
    providerId: "codex",
    modelId: "default",
    reasoningEffort: "medium",
  });
  return {
    id: `${conversationId}-turn`,
    conversationId,
    runId: `${conversationId}-run`,
    userMessageId: `${conversationId}-user`,
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection),
    harnessId: modelSelection.harnessId,
    backendProfileId: modelSelection.backendProfileId,
    model: modelSelection.modelId,
    modelAlias: modelSelection.alias,
    reasoningEffort: modelSelection.reasoningEffort ?? "medium",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2026-07-28T12:00:30.000Z",
    startedAt: "2026-07-28T12:00:31.000Z",
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
    createdAt: "2026-07-28T12:00:30.000Z",
    updatedAt: "2026-07-28T12:00:31.000Z",
  };
}

function approval(
  conversationId: string,
  id = `${conversationId}-approval`,
): AgentApprovalRequest {
  return {
    id,
    providerId: "codex",
    conversationId,
    runId: `${conversationId}-run`,
    turnId: `${conversationId}-turn`,
    kind: "command",
    title: "Run tests",
    detail: null,
    command: "npm test",
    cwd: "/workspace",
    reason: null,
    networkScope: null,
    permissionRoots: [],
    availableDecisions: ["approve", "deny"],
  };
}

function inputRequest(conversationId: string): AgentInputRequest {
  return {
    id: `${conversationId}-input`,
    providerId: "codex",
    conversationId,
    runId: `${conversationId}-run`,
    turnId: `${conversationId}-turn`,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: [{
        id: "yes",
        label: "Yes",
        description: "Continue the run.",
      }],
    }],
    autoResolutionMs: null,
  };
}

function createEventSource() {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = vi.fn((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return {
    subscribe,
    emit(event: ServerEvent) {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
  };
}

function renderProjection(
  source: ReturnType<typeof createEventSource>,
  initialProps: {
    enabled: boolean;
    targetConversationId: string | null;
  },
) {
  const request = vi.fn(
    async (_command: CommandWithoutId): Promise<ServerEvent> => {
      throw new Error("Offline projections must not load detail.");
    },
  );
  return renderHook(
    (props: {
      enabled: boolean;
      targetConversationId: string | null;
    }) => useConversationProjection({
      snapshot,
      status: "offline",
      request,
      subscribe: source.subscribe,
      targetConversationId: props.targetConversationId,
      enabled: props.enabled,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }),
    { initialProps },
  );
}

describe("useConversationProjection pending interactions", () => {
  it("keeps the runtime listener stable across unrelated shell refreshes", () => {
    const source = createEventSource();
    const request = vi.fn(
      async (_command: CommandWithoutId): Promise<ServerEvent> => ({
        type: "request.ok",
        requestId: crypto.randomUUID(),
      }),
    );
    const hook = renderHook(
      ({ currentSnapshot }: { currentSnapshot: AppSnapshot }) =>
        useConversationProjection({
          snapshot: currentSnapshot,
          status: "offline",
          request,
          subscribe: source.subscribe,
          enabled: true,
          autoOpenPlan: false,
          onOpenPlan: vi.fn(),
          onTerminal: vi.fn(),
        }),
      { initialProps: { currentSnapshot: snapshot } },
    );

    expect(source.subscribe).toHaveBeenCalledTimes(1);
    hook.rerender({
      currentSnapshot: {
        ...snapshot,
        conversations: snapshot.conversations.map((item) =>
          item.id === primaryId
            ? { ...item, updatedAt: "2026-07-28T12:01:00.000Z" }
            : item),
      },
    });
    expect(source.subscribe).toHaveBeenCalledTimes(1);
  });

  it("reloads only explicit authoritative detail invalidations without rebinding", async () => {
    const source = createEventSource();
    let messages: ChatMessage[] = [];
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
              agentTurns: [],
              turnGitArtifacts: [],
              messages,
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
        }
      : {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
    const hook = renderHook(
      ({ currentSnapshot }: { currentSnapshot: AppSnapshot }) =>
        useConversationProjection({
          snapshot: currentSnapshot,
          status: "online",
          request,
          subscribe: source.subscribe,
          enabled: true,
          autoOpenPlan: false,
          onOpenPlan: vi.fn(),
          onTerminal: vi.fn(),
        }),
      { initialProps: { currentSnapshot: snapshot } },
    );
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());

    messages = [{
      id: "durable-user-message",
      conversationId: primaryId,
      turnId: null,
      role: "user",
      content: "A newly persisted request",
      attachments: [],
      createdAt: "2026-07-28T12:01:00.000Z",
    }];
    source.emit({
      type: "conversation.detail.invalidated",
      conversationId: primaryId,
    });

    await waitFor(() =>
      expect(hook.result.current.messages).toEqual(messages));
    expect(source.subscribe).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([command]) =>
      command.type === "conversation.detail.load")).toHaveLength(2);
  });

  it("projects a follow-up without reloading or duplicating live commentary", async () => {
    const source = createEventSource();
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
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
        }
      : {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
    const hook = renderHook(() => useConversationProjection({
      snapshot,
      status: "online",
      request,
      subscribe: source.subscribe,
      enabled: true,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());

    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: "I am checking the current implementation.",
    });
    const followUp: ChatMessage = {
      id: "durable-follow-up",
      conversationId: primaryId,
      turnId: `${primaryId}-turn`,
      role: "user",
      content: "Check the Windows edge too.",
      attachments: [],
      createdAt: "2026-07-28T12:01:00.000Z",
    };
    source.emit({
      type: "conversation.message.persisted",
      message: followUp,
    });

    await waitFor(() => {
      expect(hook.result.current.messages).toEqual([followUp]);
      expect(hook.result.current.streamingText)
        .toBe("I am checking the current implementation.");
    });
    expect(request.mock.calls.filter(([command]) =>
      command.type === "conversation.detail.load")).toHaveLength(1);
  });

  it("does not reload an open thread for unrelated full-snapshot refreshes", async () => {
    const source = createEventSource();
    const loadedPlan: AgentPlan = {
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      explanation: "Keep the planned timeline stable.",
      steps: [{
        step: "Preserve the current projection",
        status: "inProgress",
      }],
    };
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
              agentTurns: [],
              turnGitArtifacts: [],
              messages: [],
              activities: [],
              subagents: [],
              reasonings: [],
              usage: [],
              plans: [loadedPlan],
              goals: [],
              checkpoints: [],
              reviewSummaries: [],
              reviewStates: [],
              reviewNotes: [],
            },
          },
        }
      : {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
    const hook = renderHook(
      ({ currentSnapshot }: { currentSnapshot: AppSnapshot }) =>
        useConversationProjection({
          snapshot: currentSnapshot,
          status: "online",
          request,
          subscribe: source.subscribe,
          enabled: true,
          autoOpenPlan: false,
          onOpenPlan: vi.fn(),
          onTerminal: vi.fn(),
        }),
      { initialProps: { currentSnapshot: snapshot } },
    );
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    expect(hook.result.current.plans).toEqual([loadedPlan]);
    const messagesBeforeRefresh = hook.result.current.messages;
    const plansBeforeRefresh = hook.result.current.plans;

    const latestSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    });
    const refreshedSnapshot: AppSnapshot = {
      ...snapshot,
      conversations: snapshot.conversations.map((item) =>
        item.id === primaryId
          ? {
              ...item,
              updatedAt: "2026-07-28T12:01:00.000Z",
              latestTurn: {
                id: `${primaryId}-turn`,
                runId: `${primaryId}-run`,
                providerId: "codex",
                harnessId: latestSelection.harnessId,
                backendProfileId: latestSelection.backendProfileId,
                modelSelection: latestSelection,
                continuationIdentity:
                  continuationIdentityForSelection(latestSelection),
                model: "default",
                reasoningEffort: "medium",
                status: "running",
                requestedAt: "2026-07-28T12:00:30.000Z",
                startedAt: "2026-07-28T12:00:31.000Z",
                completedAt: null,
                terminalReason: null,
                updatedAt: "2026-07-28T12:01:00.000Z",
              },
            }
          : item),
    };
    source.emit({
      type: "snapshot.updated",
      snapshot: refreshedSnapshot,
    });
    hook.rerender({ currentSnapshot: refreshedSnapshot });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hook.result.current.detailState?.state).toBe("ready");
    expect(hook.result.current.latestTurnSummary)
      .toEqual(refreshedSnapshot.conversations[0]?.latestTurn);
    expect(hook.result.current.messages).toBe(messagesBeforeRefresh);
    expect(hook.result.current.plans).toBe(plansBeforeRefresh);
    expect(request.mock.calls.filter(([command]) =>
      command.type === "conversation.detail.load")).toHaveLength(1);
  });

  it("keeps the mounted thread visible while fresh hydration races its detail replacement", async () => {
    const source = createEventSource();
    const persistedMessage: ChatMessage = {
      id: "persisted-before-reconnect",
      conversationId: primaryId,
      turnId: `${primaryId}-turn`,
      role: "assistant",
      content: "Persisted before reconnect.",
      attachments: [],
      createdAt: "2026-07-28T12:01:00.000Z",
    };
    let detailLoads = 0;
    let resolveReconnect: ((event: ServerEvent) => void) | null = null;
    const detailResult = (): ServerEvent => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "conversation.detail",
        conversationId: primaryId,
        state: "ready",
        detail: {
          conversation: conversation(primaryId),
          agentTurns: [],
          turnGitArtifacts: [],
          messages: [persistedMessage],
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
    });
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type !== "conversation.detail.load") {
        return Promise.resolve({
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
      }
      detailLoads += 1;
      if (detailLoads === 1) return Promise.resolve(detailResult());
      return new Promise((resolve) => {
        resolveReconnect = resolve;
      });
    });
    const hook = renderHook(
      ({ status }: { status: "online" | "offline" }) =>
        useConversationProjection({
          snapshot,
          status,
          request,
          subscribe: source.subscribe,
          enabled: true,
          autoOpenPlan: false,
          onOpenPlan: vi.fn(),
          onTerminal: vi.fn(),
        }),
      {
        initialProps: {
          status: "online" as "online" | "offline",
        },
      },
    );
    await waitFor(() => expect(hook.result.current.detailState?.state)
      .toBe("ready"));

    const pendingApproval = approval(primaryId, "approval-through-reconnect");
    source.emit({
      type: "agent.approval.requested",
      request: pendingApproval,
    });
    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: "Visible before reconnect.",
    });
    hook.rerender({ status: "offline" });
    expect(hook.result.current.streamingChannel).toBeNull();
    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
      sync: {
        runtimeGeneration: "runtime-after-reconnect",
        latestSequence: 8,
      },
    });

    expect(hook.result.current.detailState?.state).toBe("ready");
    expect(hook.result.current.messages).toEqual([persistedMessage]);
    expect(hook.result.current.streamingText)
      .toBe("Visible before reconnect.");
    expect(hook.result.current.pendingApprovals).toEqual([pendingApproval]);

    source.emit({
      type: "agent.approval.requested",
      request: pendingApproval,
    });
    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: " Visible after reconnect.",
    });
    source.emit({
      type: "runtime.sync.completed",
      sync: {
        runtimeGeneration: "runtime-after-reconnect",
        latestSequence: 8,
      },
    });
    expect(hook.result.current.pendingApprovals).toEqual([pendingApproval]);

    hook.rerender({ status: "online" });
    await waitFor(() => expect(detailLoads).toBe(2));
    await act(async () => {
      resolveReconnect?.(detailResult());
      await Promise.resolve();
    });

    expect(hook.result.current.detailState?.state).toBe("ready");
    expect(hook.result.current.messages).toEqual([persistedMessage]);
    expect(hook.result.current.streamingText)
      .toBe(" Visible after reconnect.");
  });

  it("keeps only post-welcome streaming deltas when hydration rolls the buffer", async () => {
    const source = createEventSource();
    const saturatedStreamingText = "t".repeat(500_000);
    const saturatedStreamingReasoning = "r".repeat(500_000);
    const textDelta = "Text after reconnect.";
    const reasoningDelta = "Reasoning after reconnect.";
    let detailLoads = 0;
    let resolveReconnect: ((event: ServerEvent) => void) | null = null;
    const detailResult: ServerEvent = {
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "conversation.detail",
        conversationId: primaryId,
        state: "ready",
        detail: {
          conversation: conversation(primaryId),
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
    };
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type !== "conversation.detail.load") {
        return Promise.resolve({
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
      }
      detailLoads += 1;
      if (detailLoads === 1) return Promise.resolve(detailResult);
      return new Promise((resolve) => {
        resolveReconnect = resolve;
      });
    });
    const hook = renderHook(
      ({ status }: { status: "online" | "offline" }) =>
        useConversationProjection({
          snapshot,
          status,
          request,
          subscribe: source.subscribe,
          enabled: true,
          autoOpenPlan: false,
          onOpenPlan: vi.fn(),
          onTerminal: vi.fn(),
        }),
      { initialProps: { status: "online" as "online" | "offline" } },
    );
    await waitFor(() => expect(hook.result.current.detailState?.state)
      .toBe("ready"));

    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: saturatedStreamingText,
    });
    source.emit({
      type: "agent.reasoning",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: saturatedStreamingReasoning,
    });
    hook.rerender({ status: "offline" });
    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
      sync: {
        runtimeGeneration: "runtime-after-reconnect",
        latestSequence: 8,
      },
    });
    expect(hook.result.current.streamingChannel).toBeNull();
    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: textDelta,
    });
    source.emit({
      type: "agent.reasoning",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: reasoningDelta,
    });

    expect(hook.result.current.streamingText).toHaveLength(500_000);
    expect(hook.result.current.streamingText.endsWith(textDelta)).toBe(true);
    expect(hook.result.current.streamingReasoning).toHaveLength(500_000);
    expect(hook.result.current.streamingReasoning.endsWith(reasoningDelta))
      .toBe(true);
    expect(hook.result.current.streamingChannel).toBe("reasoning");

    hook.rerender({ status: "online" });
    await waitFor(() => expect(detailLoads).toBe(2));
    await act(async () => {
      resolveReconnect?.(detailResult);
      await Promise.resolve();
    });

    expect(hook.result.current.streamingText).toBe(textDelta);
    expect(hook.result.current.streamingReasoning).toBe(reasoningDelta);
    expect(hook.result.current.streamingChannel).toBe("reasoning");

    act(() => source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: "latest text",
    }));
    expect(hook.result.current.streamingChannel).toBe("text");
  });

  it("scopes live phase authority to the current provider segment", async () => {
    const source = createEventSource();
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
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
        }
      : { type: "request.ok", requestId: crypto.randomUUID() });
    const hook = renderHook(() => useConversationProjection({
      snapshot,
      status: "online",
      request,
      subscribe: source.subscribe,
      enabled: true,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    const owner = {
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
    };
    const emitReasoning = (text: string): void => source.emit({
      type: "agent.reasoning",
      ...owner,
      text,
    });
    const emitText = (text: string): void => source.emit({
      type: "agent.text",
      ...owner,
      text,
    });

    emitReasoning("Reasoning before a tool.");
    expect(hook.result.current.streamingChannel).toBe("reasoning");
    source.emit({
      type: "agent.activity",
      activity: {
        id: "segment-activity",
        ...owner,
        kind: "tool",
        title: "Inspect repository",
        detail: null,
        status: "running",
        createdAt: "2026-08-12T12:00:01.000Z",
      },
    });
    expect(hook.result.current.streamingChannel).toBeNull();

    emitText("Text before a completed activity.");
    expect(hook.result.current.streamingChannel).toBe("text");
    source.emit({
      type: "agent.activity",
      activity: {
        id: "segment-activity",
        ...owner,
        kind: "tool",
        title: "Inspect repository",
        detail: null,
        status: "completed",
        createdAt: "2026-08-12T12:00:01.000Z",
      },
    });
    expect(hook.result.current.streamingChannel).toBeNull();

    emitReasoning("Reasoning before a plan.");
    source.emit({
      type: "agent.plan.updated",
      plan: {
        ...owner,
        explanation: "Use the current provider evidence.",
        steps: [{ step: "Verify segment ownership", status: "inProgress" }],
      },
    });
    expect(hook.result.current.streamingChannel).toBeNull();

    emitText("Commentary before persistence.");
    source.emit({
      type: "agent.commentary.persisted",
      message: {
        id: "segment-commentary",
        conversationId: primaryId,
        turnId: owner.turnId,
        role: "assistant",
        content: "Commentary before persistence.",
        attachments: [],
        createdAt: "2026-08-12T12:00:02.000Z",
      },
    });
    expect(hook.result.current.streamingChannel).toBeNull();

    emitReasoning("Reasoning before approval.");
    source.emit({ type: "agent.approval.requested", request: approval(primaryId) });
    expect(hook.result.current.streamingChannel).toBeNull();
    source.emit({
      type: "agent.approval.resolved",
      ...owner,
      requestId: approval(primaryId).id,
      decision: "approve",
    });
    expect(hook.result.current.streamingChannel).toBeNull();
    emitText("Provider resumed after approval.");
    expect(hook.result.current.streamingChannel).toBe("text");

    source.emit({
      type: "agent.input.requested",
      request: inputRequest(primaryId),
    });
    expect(hook.result.current.streamingChannel).toBeNull();
    source.emit({
      type: "agent.input.resolved",
      ...owner,
      requestId: inputRequest(primaryId).id,
    });
    expect(hook.result.current.streamingChannel).toBeNull();
    emitReasoning("Provider resumed after input.");
    expect(hook.result.current.streamingChannel).toBe("reasoning");

    source.emit({
      type: "agent.completed",
      ...owner,
      status: "completed",
      terminalReason: "provider-completed",
    });
    expect(hook.result.current.streamingChannel).toBeNull();
  });

  it("keeps streaming text when fresh hydration replays the current plan", async () => {
    const source = createEventSource();
    const baselinePlan: AgentPlan = {
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      explanation: "Keep the active plan visible.",
      steps: [{ step: "Reconnect safely", status: "inProgress" }],
    };
    let detailLoads = 0;
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type !== "conversation.detail.load") {
        return { type: "request.ok", requestId: crypto.randomUUID() };
      }
      detailLoads += 1;
      if (detailLoads > 1) throw new Error("Detail refresh failed.");
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "conversation.detail",
          conversationId: primaryId,
          state: "ready",
          detail: {
            conversation: conversation(primaryId),
            agentTurns: [],
            turnGitArtifacts: [],
            messages: [],
            activities: [],
            subagents: [],
            reasonings: [],
            usage: [],
            plans: [baselinePlan],
            goals: [],
            checkpoints: [],
            reviewSummaries: [],
            reviewStates: [],
            reviewNotes: [],
          },
        },
      };
    });
    const onOpenPlan = vi.fn();
    const hook = renderHook(
      ({ status }: { status: "online" | "offline" }) =>
        useConversationProjection({
          snapshot,
          status,
          request,
          subscribe: source.subscribe,
          enabled: true,
          autoOpenPlan: true,
          onOpenPlan,
          onTerminal: vi.fn(),
        }),
      { initialProps: { status: "online" as "online" | "offline" } },
    );
    await waitFor(() => expect(hook.result.current.detailState?.state)
      .toBe("ready"));

    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: baselinePlan.runId,
      turnId: baselinePlan.turnId!,
      text: "Visible through plan hydration.",
    });
    hook.rerender({ status: "offline" });
    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
      sync: {
        runtimeGeneration: "runtime-after-reconnect",
        latestSequence: 8,
      },
    });
    source.emit({ type: "agent.plan.updated", plan: { ...baselinePlan } });
    source.emit({
      type: "runtime.sync.completed",
      sync: {
        runtimeGeneration: "runtime-after-reconnect",
        latestSequence: 8,
      },
    });

    expect(hook.result.current.streamingText)
      .toBe("Visible through plan hydration.");
    expect(hook.result.current.streamingChannel).toBeNull();
    expect(onOpenPlan).not.toHaveBeenCalled();

    hook.rerender({ status: "online" });
    await waitFor(() => expect(detailLoads).toBe(2));
    expect(hook.result.current.detailState?.state).toBe("ready");
    expect(hook.result.current.streamingText)
      .toBe("Visible through plan hydration.");
    expect(hook.result.current.streamingChannel).toBeNull();

    source.emit({
      type: "agent.plan.updated",
      plan: {
        ...baselinePlan,
        explanation: "This plan really changed after synchronization.",
      },
    });
    expect(hook.result.current.streamingText).toBe("");
    expect(onOpenPlan).toHaveBeenCalledWith(primaryId);
  });

  for (const scenario of [
    {
      label: "cancellation",
      status: "cancelled" as const,
      exactStatus: "cancelled" as const,
      exactConversationStatus: "idle" as const,
      exactReason: "The user stopped the turn.",
      event: {
        type: "agent.completed" as const,
        conversationId: primaryId,
        runId: `${primaryId}-run-current`,
        turnId: `${primaryId}-turn-current`,
        status: "cancelled" as const,
        terminalReason: "The user stopped the turn.",
        terminalAssistantMessageId: null,
      },
    },
    {
      label: "failure or interruption",
      status: "interrupted" as const,
      exactStatus: "interrupted" as const,
      exactConversationStatus: "failed" as const,
      exactReason: "The agent turn was interrupted.",
      event: {
        type: "agent.failed" as const,
        conversationId: primaryId,
        runId: `${primaryId}-run-current`,
        turnId: `${primaryId}-turn-current`,
        status: "interrupted" as const,
        terminalReason: "The agent turn was interrupted.",
        message: "The agent turn was interrupted.",
        terminalAssistantMessageId: null,
      },
    },
  ]) {
    it(`projects terminal ${scenario.label} while its detail refresh fails`, async () => {
      const source = createEventSource();
      const staleTurn = runningTurn();
      const turn: AgentTurn = {
        ...runningTurn(),
        id: `${primaryId}-turn-current`,
        runId: `${primaryId}-run-current`,
        userMessageId: `${primaryId}-user-current`,
        createdAt: "2026-07-28T12:01:30.000Z",
        requestedAt: "2026-07-28T12:01:30.000Z",
        startedAt: "2026-07-28T12:01:31.000Z",
        updatedAt: "2026-07-28T12:01:31.000Z",
        terminalAssistantMessageId: "stale-terminal-message",
      };
      const staleApproval = {
        ...approval(primaryId, "stale-turn-approval"),
        runId: staleTurn.runId,
        turnId: staleTurn.id,
      };
      const currentApproval = {
        ...approval(primaryId, "current-turn-approval"),
        runId: turn.runId,
        turnId: turn.id,
      };
      const staleInput = {
        ...inputRequest(primaryId),
        id: "stale-turn-input",
        runId: staleTurn.runId,
        turnId: staleTurn.id,
      };
      const currentInput = {
        ...inputRequest(primaryId),
        id: "current-turn-input",
        runId: turn.runId,
        turnId: turn.id,
      };
      const runningSnapshot: AppSnapshot = {
        ...snapshot,
        conversations: snapshot.conversations.map((item) =>
          item.id === primaryId
            ? {
                ...item,
                status: "running",
                attentionKind: null,
                latestTurn: {
                  id: turn.id,
                  runId: turn.runId,
                  status: turn.status,
                  providerId: turn.providerId,
                  harnessId: turn.harnessId,
                  backendProfileId: turn.backendProfileId,
                  modelSelection: turn.modelSelection,
                  continuationIdentity: turn.continuationIdentity,
                  model: turn.model,
                  reasoningEffort: turn.reasoningEffort,
                  requestedAt: turn.requestedAt,
                  startedAt: turn.startedAt,
                  completedAt: turn.completedAt,
                  terminalReason: turn.terminalReason,
                  updatedAt: turn.updatedAt,
                },
              }
            : item),
      };
      let detailLoads = 0;
      const request = vi.fn(async (
        command: CommandWithoutId,
      ): Promise<ServerEvent> => {
        if (command.type !== "conversation.detail.load") {
          return {
            type: "request.ok",
            requestId: crypto.randomUUID(),
          };
        }
        detailLoads += 1;
        if (detailLoads > 1) {
          throw new Error("The request took too long to complete.");
        }
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
              // A failed earlier refresh can retain stale active turn A while
              // the shell authoritatively names newer active turn B.
              agentTurns: [staleTurn, turn],
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
        };
      });
      const onTerminal = vi.fn();
      const hook = renderHook(
        ({ currentSnapshot }: { currentSnapshot: AppSnapshot }) =>
          useConversationProjection({
            snapshot: currentSnapshot,
            status: "online",
            request,
            subscribe: source.subscribe,
            enabled: true,
            autoOpenPlan: false,
            onOpenPlan: vi.fn(),
            onTerminal,
          }),
        { initialProps: { currentSnapshot: runningSnapshot } },
      );
      await waitFor(() => expect(hook.result.current.detailState?.state)
        .toBe("ready"));
      expect(hook.result.current.turns.find(({ id }) => id === turn.id)?.status)
        .toBe("running");

      source.emit({ type: "agent.approval.requested", request: staleApproval });
      source.emit({ type: "agent.approval.requested", request: currentApproval });
      source.emit({ type: "agent.input.requested", request: staleInput });
      source.emit({ type: "agent.input.requested", request: currentInput });
      expect(hook.result.current.pendingApprovals.map(({ id }) => id).sort())
        .toEqual(["current-turn-approval", "stale-turn-approval"]);
      expect(hook.result.current.pendingInputs.map(({ id }) => id).sort())
        .toEqual(["current-turn-input", "stale-turn-input"]);

      source.emit({
        type: "agent.text",
        conversationId: primaryId,
        runId: turn.runId,
        turnId: turn.id,
        text: "Provider output before settlement.",
      });
      expect(hook.result.current.streamingChannel).toBe("text");
      source.emit({
        ...scenario.event,
        runId: staleTurn.runId,
        turnId: staleTurn.id,
      });
      expect(hook.result.current.streamingChannel).toBe("text");
      expect(hook.result.current.turns.find(({ id }) => id === staleTurn.id)?.status)
        .toBe("running");
      expect(hook.result.current.turns.find(({ id }) => id === turn.id)?.status)
        .toBe("running");
      expect(hook.result.current.conversation?.status).toBe("running");
      expect(hook.result.current.pendingApprovals.map(({ id }) => id).sort())
        .toEqual(["current-turn-approval", "stale-turn-approval"]);
      expect(hook.result.current.pendingInputs.map(({ id }) => id).sort())
        .toEqual(["current-turn-input", "stale-turn-input"]);
      expect(onTerminal).not.toHaveBeenCalled();
      source.emit(scenario.event);

      expect(hook.result.current.streamingChannel).toBeNull();
      expect(hook.result.current.terminalProjections[`${turn.runId}\0${turn.id}`]
        ?.terminalAssistantMessageId).toBeNull();
      expect(hook.result.current.turns.find(({ id }) => id === turn.id))
        .toMatchObject({
        id: turn.id,
        runId: turn.runId,
        status: scenario.status,
      });
      expect(hook.result.current.turns.find(({ id }) => id === turn.id)
        ?.terminalReason).toBe(
        scenario.event.terminalReason,
      );
      expect(hook.result.current.turns.find(({ id }) => id === turn.id)
        ?.terminalAssistantMessageId).toBeNull();
      expect(hook.result.current.pendingApprovals.map(({ id }) => id))
        .toEqual(["stale-turn-approval"]);
      expect(hook.result.current.pendingInputs.map(({ id }) => id))
        .toEqual(["stale-turn-input"]);
      expect(hook.result.current.conversation).toMatchObject({
        id: primaryId,
        status: scenario.exactConversationStatus,
        attentionKind: null,
        latestTurn: {
          id: turn.id,
          runId: turn.runId,
          status: scenario.status,
        },
      });
      expect(onTerminal).toHaveBeenCalledOnce();

      source.emit({
        type: "conversation.detail.invalidated",
        conversationId: primaryId,
      });
      await waitFor(() => expect(detailLoads).toBe(2));

      expect(hook.result.current.detailState?.state).toBe("ready");
      expect(hook.result.current.turns.find(({ id }) => id === turn.id)?.status)
        .toBe(scenario.status);
      expect(hook.result.current.streamingChannel).toBeNull();
      expect(hook.result.current.conversation?.status)
        .toBe(scenario.exactConversationStatus);

      const completedAt = "2026-07-28T12:02:00.000Z";
      hook.rerender({
        currentSnapshot: {
          ...runningSnapshot,
          conversations: runningSnapshot.conversations.map((item) =>
            item.id === primaryId
              ? {
                  ...item,
                  status: scenario.exactConversationStatus,
                  latestTurn: {
                    id: turn.id,
                    runId: turn.runId,
                    status: scenario.exactStatus,
                    providerId: turn.providerId,
                    harnessId: turn.harnessId,
                    backendProfileId: turn.backendProfileId,
                    modelSelection: turn.modelSelection,
                    continuationIdentity: turn.continuationIdentity,
                    model: turn.model,
                    reasoningEffort: turn.reasoningEffort,
                    requestedAt: turn.requestedAt,
                    startedAt: turn.startedAt,
                    completedAt,
                    terminalReason: scenario.exactReason,
                    updatedAt: completedAt,
                  },
                }
              : item),
        },
      });
      expect(hook.result.current.turns.find(({ id }) => id === turn.id))
        .toMatchObject({
        id: turn.id,
        status: scenario.exactStatus,
        completedAt,
        terminalReason: scenario.exactReason,
      });
      expect(hook.result.current.conversation?.status)
        .toBe(scenario.exactConversationStatus);
    });
  }

  it("keeps the last ready thread visible when a refresh request times out", async () => {
    const source = createEventSource();
    let detailLoads = 0;
    let authoritativeMessages: ChatMessage[] = [];
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type !== "conversation.detail.load") {
        return {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        };
      }
      detailLoads += 1;
      if (detailLoads === 2) {
        throw new Error("The request took too long to complete.");
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "conversation.detail",
          conversationId: primaryId,
          state: "ready",
          detail: {
            conversation: conversation(primaryId),
            agentTurns: [runningTurn()],
            turnGitArtifacts: [],
            messages: authoritativeMessages,
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
      };
    });
    const hook = renderHook(() => useConversationProjection({
      snapshot,
      status: "online",
      request,
      subscribe: source.subscribe,
      enabled: true,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.detailState?.state).toBe("ready"));

    const terminalAssistantMessage: ChatMessage = {
      id: "terminal-assistant-message",
      conversationId: primaryId,
      turnId: `${primaryId}-turn`,
      role: "assistant",
      content: "The final answer remains visible.",
      attachments: [],
      createdAt: "2026-07-28T12:02:00.000Z",
    };
    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      text: "The final answer remains visible.",
    });
    source.emit({
      type: "conversation.message.persisted",
      message: terminalAssistantMessage,
    });
    source.emit({
      type: "agent.completed",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      status: "completed",
      terminalReason: "provider-completed",
      terminalAssistantMessageId: terminalAssistantMessage.id,
    });
    expect(hook.result.current.messages).toEqual([terminalAssistantMessage]);
    expect(hook.result.current.turns[0]?.terminalAssistantMessageId)
      .toBe(terminalAssistantMessage.id);
    source.emit({
      type: "conversation.detail.invalidated",
      conversationId: primaryId,
    });

    await waitFor(() => expect(detailLoads).toBe(2));
    expect(hook.result.current.detailState?.state).toBe("ready");
    expect(hook.result.current.detail).not.toBeNull();
    expect(hook.result.current.messages).toEqual([terminalAssistantMessage]);
    expect(hook.result.current.streamingText)
      .toBe("The final answer remains visible.");

    authoritativeMessages = [terminalAssistantMessage];
    source.emit({
      type: "conversation.detail.invalidated",
      conversationId: primaryId,
    });

    await waitFor(() => {
      expect(detailLoads).toBe(3);
      expect(hook.result.current.streamingText).toBe("");
      expect(hook.result.current.messages).toEqual(authoritativeMessages);
    });
  });

  it("does not reload detail for bounded activity-shell refreshes", async () => {
    const source = createEventSource();
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
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
        }
      : {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
    const hook = renderHook(() => useConversationProjection({
      snapshot,
      status: "online",
      request,
      subscribe: source.subscribe,
      enabled: true,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());

    source.emit({
      type: "conversation.shell.updated",
      conversation: {
        ...conversation(primaryId),
        updatedAt: "2026-07-28T12:01:00.000Z",
      },
      runs: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request.mock.calls.filter(([command]) =>
      command.type === "conversation.detail.load")).toHaveLength(1);
  });

  it("projects persisted commentary without waiting for a detail reload", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: true,
      targetConversationId: primaryId,
    });
    const commentary: ChatMessage = {
      id: "commentary-message",
      conversationId: primaryId,
      turnId: `${primaryId}-turn`,
      role: "assistant",
      content: "The provider route is safe; now I am checking the renderer.",
      attachments: [],
      createdAt: "2026-07-28T12:00:01.000Z",
    };

    source.emit({
      type: "agent.commentary.persisted",
      message: commentary,
    });
    source.emit({
      type: "agent.activity",
      activity: {
        id: "commentary-activity",
        conversationId: primaryId,
        runId: `${primaryId}-run`,
        turnId: `${primaryId}-turn`,
        kind: "command",
        title: "Run focused tests",
        detail: null,
        status: "running",
        createdAt: "2026-07-28T12:00:02.000Z",
      },
    });

    expect(hook.result.current.messages).toEqual([commentary]);
    expect(hook.result.current.activities).toHaveLength(1);
  });

  it("atomically replaces stale active-turn text with the durable canonical message", async () => {
    const source = createEventSource();
    const turn = runningTurn();
    const userMessage: ChatMessage = {
      id: turn.userMessageId,
      conversationId: primaryId,
      turnId: turn.id,
      role: "user",
      content: "Correct the response.",
      attachments: [],
      createdAt: "2026-07-28T12:00:30.000Z",
    };
    const staleFirst: ChatMessage = {
      id: "stale-first",
      conversationId: primaryId,
      turnId: turn.id,
      role: "assistant",
      content: "Stale first segment.",
      attachments: [],
      createdAt: "2026-07-28T12:00:32.000Z",
    };
    const staleSecond: ChatMessage = {
      ...staleFirst,
      id: "stale-second",
      content: "Stale second segment.",
      createdAt: "2026-07-28T12:00:33.000Z",
    };
    const canonical: ChatMessage = {
      ...staleSecond,
      content: "Authoritative replacement.",
    };
    let authoritativeMessages = [userMessage, staleFirst, staleSecond];
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
              agentTurns: [turn],
              turnGitArtifacts: [],
              messages: authoritativeMessages,
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
        }
      : {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
    const hook = renderHook(() => useConversationProjection({
      snapshot,
      status: "online",
      request,
      subscribe: source.subscribe,
      enabled: true,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());

    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: turn.runId,
      turnId: turn.id,
      text: "Stale live suffix.",
    });
    expect(hook.result.current.streamingText).toBe("Stale live suffix.");

    source.emit({
      type: "agent.text.replaced",
      conversationId: primaryId,
      runId: turn.runId,
      turnId: turn.id,
      message: canonical,
    });

    expect(hook.result.current.streamingText).toBe("");
    expect(hook.result.current.messages).toEqual([userMessage, canonical]);

    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: turn.runId,
      turnId: turn.id,
      text: " Fresh suffix.",
    });
    expect(hook.result.current.streamingText).toBe(" Fresh suffix.");

    authoritativeMessages = [userMessage, canonical];
    source.emit({
      type: "conversation.detail.invalidated",
      conversationId: primaryId,
    });
    await waitFor(() => {
      expect(request.mock.calls.filter(([command]) =>
        command.type === "conversation.detail.load")).toHaveLength(2);
      expect(hook.result.current.messages).toEqual([userMessage, canonical]);
      expect(hook.result.current.streamingText).toBe(" Fresh suffix.");
    });
  });

  it("does not clear a newer turn stream for a delayed older replacement", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: true,
      targetConversationId: primaryId,
    });
    source.emit({
      type: "agent.started",
      conversationId: primaryId,
      runId: "new-run",
      turnId: "new-turn",
    });
    source.emit({
      type: "agent.text",
      conversationId: primaryId,
      runId: "new-run",
      turnId: "new-turn",
      text: "New turn text",
    });
    const olderCanonical: ChatMessage = {
      id: "older-canonical",
      conversationId: primaryId,
      turnId: "older-turn",
      role: "assistant",
      content: "Corrected older answer",
      attachments: [],
      createdAt: "2026-07-28T12:00:00.000Z",
    };

    source.emit({
      type: "agent.text.replaced",
      conversationId: primaryId,
      runId: "older-run",
      turnId: "older-turn",
      message: olderCanonical,
    });

    expect(hook.result.current.streamingText).toBe("New turn text");
    expect(hook.result.current.messages).toContainEqual(olderCanonical);
  });

  it("retains every unhydrated commentary segment until detail catches up", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: true,
      targetConversationId: primaryId,
    });

    for (let index = 0; index < 70; index += 1) {
      source.emit({
        type: "agent.commentary.persisted",
        message: {
          id: `commentary-${index}`,
          conversationId: primaryId,
          turnId: `${primaryId}-turn`,
          role: "assistant",
          content: `Commentary ${index}`,
          attachments: [],
          createdAt: new Date(
            Date.parse("2026-07-28T12:00:00.000Z") + index,
          ).toISOString(),
        },
      });
    }

    expect(hook.result.current.messages).toHaveLength(70);
    expect(hook.result.current.messages[0]?.content).toBe("Commentary 0");
    expect(hook.result.current.messages.at(-1)?.content).toBe("Commentary 69");
  });

  it("retains every unhydrated activity until detail catches up", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: true,
      targetConversationId: primaryId,
    });

    for (let index = 0; index < 110; index += 1) {
      source.emit({
        type: "agent.activity",
        activity: {
          id: `activity-${index}`,
          conversationId: primaryId,
          runId: `${primaryId}-run`,
          turnId: `${primaryId}-turn`,
          kind: "command",
          title: `Command ${index}`,
          detail: null,
          status: "completed",
          createdAt: new Date(
            Date.parse("2026-07-28T12:00:00.000Z") + index,
          ).toISOString(),
        },
      });
    }

    expect(hook.result.current.activities).toHaveLength(110);
    expect(hook.result.current.activities[0]?.title).toBe("Command 0");
    expect(hook.result.current.activities.at(-1)?.title).toBe("Command 109");
  });

  it("retires a live activity once authoritative detail catches up", async () => {
    const source = createEventSource();
    const liveActivity: AgentActivity = {
      id: "retired-live-activity",
      conversationId: primaryId,
      runId: `${primaryId}-run`,
      turnId: `${primaryId}-turn`,
      kind: "command",
      title: "Run focused tests",
      detail: null,
      status: "running",
      createdAt: "2026-07-28T12:00:02.000Z",
    };
    let authoritativeActivities: AgentActivity[] = [];
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId: primaryId,
            state: "ready",
            detail: {
              conversation: conversation(primaryId),
              agentTurns: [],
              turnGitArtifacts: [],
              messages: [],
              activities: authoritativeActivities,
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
        }
      : {
          type: "request.ok",
          requestId: crypto.randomUUID(),
        });
    const hook = renderHook(() => useConversationProjection({
      snapshot,
      status: "online",
      request,
      subscribe: source.subscribe,
      enabled: true,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());

    source.emit({ type: "agent.activity", activity: liveActivity });
    expect(hook.result.current.activities[0]?.status).toBe("running");

    authoritativeActivities = [liveActivity];
    act(() => hook.result.current.refreshDetail());
    await waitFor(() =>
      expect(request.mock.calls.filter(([command]) =>
        command.type === "conversation.detail.load")).toHaveLength(2));
    await waitFor(() =>
      expect(hook.result.current.activities[0]).toBe(liveActivity));

    authoritativeActivities = [{
      ...liveActivity,
      status: "completed",
    }];
    act(() => hook.result.current.refreshDetail());
    await waitFor(() =>
      expect(hook.result.current.activities[0]?.status).toBe("completed"));
  });

  it("does not let a newly reported plan steal focus unless the user opted in", () => {
    expect(defaultSettings.autoOpenPlan).toBe(false);
    for (const autoOpenPlan of [false, true]) {
      const source = createEventSource();
      const onOpenPlan = vi.fn();
      const request = vi.fn(async (
        _command: CommandWithoutId,
      ): Promise<ServerEvent> => ({
        type: "request.ok",
        requestId: crypto.randomUUID(),
      }));
      const hook = renderHook(() => useConversationProjection({
        snapshot,
        status: "offline",
        request,
        subscribe: source.subscribe,
        enabled: true,
        autoOpenPlan,
        onOpenPlan,
        onTerminal: vi.fn(),
      }));

      source.emit({
        type: "agent.plan.updated",
        plan: {
          conversationId: primaryId,
          runId: `${primaryId}-run`,
          turnId: `${primaryId}-turn`,
          explanation: "Keep the current workspace panel focused.",
          steps: [{ step: "Publish the plan", status: "inProgress" }],
        },
      });

      expect(onOpenPlan).toHaveBeenCalledTimes(autoOpenPlan ? 1 : 0);
      hook.unmount();
    }
  });

  it("subscribes and unsubscribes the mounted secondary pane explicitly", () => {
    const source = createEventSource();
    const request = vi.fn(
      async (_command: CommandWithoutId): Promise<ServerEvent> => ({
        type: "request.ok",
        requestId: crypto.randomUUID(),
      }),
    );
    const initialProps: {
      enabled: boolean;
      targetConversationId: string | null;
    } = {
      enabled: true,
      targetConversationId: secondaryId,
    };
    const hook = renderHook(
      (props: {
        enabled: boolean;
        targetConversationId: string | null;
      }) => useConversationProjection({
        snapshot,
        status: "offline",
        request,
        subscribe: source.subscribe,
        targetConversationId: props.targetConversationId,
        enabled: props.enabled,
        autoOpenPlan: false,
        onOpenPlan: vi.fn(),
        onTerminal: vi.fn(),
      }),
      {
        initialProps,
      },
    );

    expect(request).toHaveBeenLastCalledWith({
      type: "conversation.detail.subscription",
      payload: {
        owner: "secondary",
        conversationId: secondaryId,
      },
    });

    hook.rerender({
      enabled: false,
      targetConversationId: null,
    });
    expect(request).toHaveBeenLastCalledWith({
      type: "conversation.detail.subscription",
      payload: {
        owner: "secondary",
        conversationId: null,
      },
    });

    hook.rerender({
      enabled: true,
      targetConversationId: primaryId,
    });
    expect(request).toHaveBeenLastCalledWith({
      type: "conversation.detail.subscription",
      payload: {
        owner: "secondary",
        conversationId: primaryId,
      },
    });
  });

  it("retains hydrated requests while a secondary pane is closed and reopened", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: false,
      targetConversationId: null,
    });
    const pendingApproval = approval(secondaryId);
    const pendingInput = inputRequest(secondaryId);

    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
    });
    source.emit({
      type: "agent.approval.requested",
      request: pendingApproval,
    });
    source.emit({
      type: "agent.input.requested",
      request: pendingInput,
    });

    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([pendingApproval]);
    expect(hook.result.current.pendingInputs).toEqual([pendingInput]);

    hook.rerender({
      enabled: false,
      targetConversationId: null,
    });
    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([pendingApproval]);
    expect(hook.result.current.pendingInputs).toEqual([pendingInput]);

    hook.rerender({
      enabled: false,
      targetConversationId: null,
    });
    source.emit({
      type: "agent.approval.resolved",
      conversationId: secondaryId,
      runId: pendingApproval.runId,
      turnId: pendingApproval.turnId,
      requestId: pendingApproval.id,
      decision: "approve",
    });
    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.pendingInputs).toEqual([pendingInput]);

    hook.rerender({
      enabled: false,
      targetConversationId: null,
    });
    source.emit({
      type: "agent.input.resolved",
      conversationId: secondaryId,
      runId: pendingInput.runId,
      turnId: pendingInput.turnId,
      requestId: pendingInput.id,
    });
    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.pendingInputs).toEqual([]);
  });

  it("retains hydrated background requests without exposing another chat's controls", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: true,
      targetConversationId: primaryId,
    });
    const primaryApproval = approval(primaryId);
    const secondaryApproval = approval(secondaryId);
    const secondaryInput = inputRequest(secondaryId);

    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
    });
    source.emit({
      type: "agent.approval.requested",
      request: primaryApproval,
    });
    source.emit({
      type: "agent.approval.requested",
      request: secondaryApproval,
    });
    source.emit({
      type: "agent.input.requested",
      request: secondaryInput,
    });

    expect(hook.result.current.pendingApprovals).toEqual([primaryApproval]);
    expect(hook.result.current.pendingInputs).toEqual([]);

    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([
      secondaryApproval,
    ]);
    expect(hook.result.current.pendingInputs).toEqual([secondaryInput]);

    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.pendingInputs).toEqual([]);

    source.emit({
      type: "agent.approval.requested",
      request: secondaryApproval,
    });
    hook.rerender({
      enabled: true,
      targetConversationId: primaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);

    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([
      secondaryApproval,
    ]);
  });
});
