import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentActivity,
  type AgentApprovalRequest,
  type AgentInputRequest,
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

  it("does not reload an open thread for unrelated full-snapshot refreshes", async () => {
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
    expect(hook.result.current.messages).toBe(messagesBeforeRefresh);
    expect(hook.result.current.plans).toBe(plansBeforeRefresh);
    expect(request.mock.calls.filter(([command]) =>
      command.type === "conversation.detail.load")).toHaveLength(1);
  });

  it("keeps the last ready thread visible when a refresh request times out", async () => {
    const source = createEventSource();
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

    source.emit({
      type: "conversation.detail.invalidated",
      conversationId: primaryId,
    });

    await waitFor(() => expect(detailLoads).toBe(2));
    expect(hook.result.current.detailState?.state).toBe("ready");
    expect(hook.result.current.detail).not.toBeNull();
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
