import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  agentWorkflowRouteIdentity,
  agentWorkflowTargetConversation,
  useAgentWorkflows,
} from "../../src/renderer/src/hooks/useAgentWorkflows";
import type {
  AgentWorkflowState,
  Conversation,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

function workflow(
  capability: AgentWorkflowState["goalCapability"],
  conversationId = "conversation-1",
): AgentWorkflowState {
  return {
    conversationId,
    goals: [],
    goalCapability: capability,
    skills: [],
    skillsCapability: {
      kind: "codex-native",
      available: true,
      label: "Codex skills",
    },
    goalRefreshWarning: null,
    skillDiscovery: {
      truncated: false,
      warningCount: 0,
      synchronizedAt: null,
    },
    refreshedAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("useAgentWorkflows", () => {
  it("binds workflow capabilities to the effective workspace path", () => {
    const route = {
      modelSelection: {
        harnessId: "codex-app-server",
        backendProfileId: "builtin:openai",
        backendConfigurationRevision: 2,
      },
      providerSessionId: "thread-1",
      worktreePath: null,
    } as Conversation;
    const project = {
      path: "/workspace/project",
    } as Project;

    expect(agentWorkflowRouteIdentity(route, project)).toContain(
      "\0/workspace/project",
    );
    expect(agentWorkflowRouteIdentity(
      { ...route, worktreePath: "/workspace/worktrees/feature" },
      project,
    )).toContain("\0/workspace/worktrees/feature");
  });

  it("does not bind persisted workflows through a visible local draft", () => {
    const persisted = { id: "conversation-1" } as Conversation;
    const draft = { id: "draft-1" } as Conversation;

    expect(agentWorkflowTargetConversation(persisted, null)).toBe(persisted);
    expect(agentWorkflowTargetConversation(persisted, draft)).toBeNull();
  });

  it("hides and disables persisted workflows when a local draft becomes visible", async () => {
    const availableSkill = {
      id: "skill-1",
      conversationId: "conversation-1",
      name: "review",
      description: "Review this project.",
      shortDescription: null,
      scope: "repo" as const,
      enabled: true,
      source: "codex-native" as const,
    };
    const request = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: "request-1",
      result: {
        kind: "agent.workflow",
        workflow: {
          ...workflow({
            kind: "codex-native",
            available: true,
            label: "Codex native goal",
          }),
          skills: [availableSkill],
        },
      },
    }));
    const subscribe = vi.fn(() => () => undefined);
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) => useAgentWorkflows({
        conversationId: "conversation-1",
        routeIdentity: "codex-app-server\0thread-1",
        status: "online",
        enabled,
        request,
        subscribe,
      }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() =>
      expect(hook.result.current.state?.skills).toEqual([availableSkill]));
    const requestCount = request.mock.calls.length;

    act(() => hook.rerender({ enabled: false }));

    expect(hook.result.current.state).toBeNull();
    await act(async () => {
      await hook.result.current.setGoal({
        source: "codex-native",
        objective: "Must not target the old chat",
        status: "active",
      });
      await hook.result.current.clearGoal("codex-native");
      await hook.result.current.listSkills();
    });
    expect(request).toHaveBeenCalledTimes(requestCount);
  });

  it("reloads capability state when a provider session appears in place", async () => {
    let native = false;
    const request = vi.fn(async (
      _command: CommandWithoutId,
    ): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: "request-1",
      result: {
        kind: "agent.workflow",
        workflow: workflow(native
          ? {
              kind: "codex-native",
              available: true,
              label: "Codex native goal",
            }
          : {
              kind: "inertia-local",
              available: true,
              label: "Inertia local goal",
              reason: "Codex can own the goal after this chat starts a provider thread.",
            }),
      },
    }));
    const subscribe = vi.fn(() => () => undefined);
    const hook = renderHook(
      ({ routeIdentity }: { routeIdentity: string }) => useAgentWorkflows({
        conversationId: "conversation-1",
        routeIdentity,
        status: "online",
        request,
        subscribe,
      }),
      { initialProps: { routeIdentity: "codex-app-server\0new-thread" } },
    );

    await waitFor(() =>
      expect(hook.result.current.state?.goalCapability.kind)
        .toBe("inertia-local"));
    expect(request).toHaveBeenNthCalledWith(1, {
      type: "agent.workflow.load",
      payload: {
        conversationId: "conversation-1",
        refresh: true,
      },
    });
    native = true;
    act(() => {
      hook.rerender({ routeIdentity: "codex-app-server\0thread-1" });
    });
    await waitFor(() =>
      expect(hook.result.current.state?.goalCapability.kind)
        .toBe("codex-native"));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, {
      type: "agent.workflow.load",
      payload: {
        conversationId: "conversation-1",
        refresh: true,
      },
    });
  });

  it("refreshes provider-owned goals after a renderer reconnect", async () => {
    let emit!: (event: ServerEvent) => void;
    const availableSkill = {
      id: "skill-through-reconnect",
      conversationId: "conversation-1",
      name: "review",
      description: "Review this project.",
      shortDescription: null,
      scope: "repo" as const,
      enabled: true,
      source: "codex-native" as const,
    };
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type !== "agent.workflow.load") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "agent.workflow",
          workflow: {
            ...workflow({
              kind: "codex-native",
              available: true,
              label: "Codex native goal",
            }, command.payload.conversationId),
            skills: [availableSkill],
          },
        },
      };
    });
    const subscribe = vi.fn((
      listener: (event: ServerEvent) => void,
    ) => {
      emit = listener;
      return () => undefined;
    });
    renderHook(() => useAgentWorkflows({
      conversationId: "conversation-1",
      routeIdentity: "codex-app-server\0thread-1",
      status: "online",
      request,
      subscribe,
    }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    act(() => emit({ type: "server.welcome" } as ServerEvent));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith({
      type: "agent.workflow.load",
      payload: {
        conversationId: "conversation-1",
        refresh: true,
      },
    });
  });

  it("does not let an overlapping skills refresh discard reconnect workflow state", async () => {
    let emit!: (event: ServerEvent) => void;
    let resolveReconnect!: (event: ServerEvent) => void;
    const reconnect = new Promise<ServerEvent>((resolve) => {
      resolveReconnect = resolve;
    });
    let workflowLoads = 0;
    const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "agent.skills.list") {
        return Promise.resolve({
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "agent.skills",
            conversationId: "conversation-1",
            skills: [],
            skillDiscovery: {
              truncated: false,
              warningCount: 0,
              synchronizedAt: "2030-01-01T00:00:01.000Z",
            },
          },
        });
      }
      if (command.type !== "agent.workflow.load") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      workflowLoads += 1;
      if (workflowLoads > 1) return reconnect;
      return Promise.resolve({
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "agent.workflow",
          workflow: workflow({
            kind: "inertia-local",
            available: true,
            label: "Inertia local goal",
            reason: "Saved state",
          }),
        },
      });
    });
    const hook = renderHook(() => useAgentWorkflows({
      conversationId: "conversation-1",
      routeIdentity: "codex-app-server\0thread-1",
      status: "online",
      request,
      subscribe: (listener) => {
        emit = listener;
        return () => undefined;
      },
    }));
    await waitFor(() => expect(hook.result.current.state?.goalCapability.label)
      .toBe("Inertia local goal"));

    act(() => emit({ type: "server.welcome" } as ServerEvent));
    await waitFor(() => expect(workflowLoads).toBe(2));
    await act(async () => hook.result.current.listSkills(true));
    expect(hook.result.current.loading).toBe(true);
    resolveReconnect({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: {
        kind: "agent.workflow",
        workflow: workflow({
          kind: "codex-native",
          available: true,
          label: "Codex native goal",
        }),
      },
    });

    await waitFor(() => expect(hook.result.current.state?.goalCapability.label)
      .toBe("Codex native goal"));
    expect(hook.result.current.loading).toBe(false);
  });

  it("rehydrates saved goals when recovery safety blocks provider refresh", async () => {
    const saved = {
      ...workflow({
        kind: "codex-native" as const,
        available: true,
        label: "Codex native goal",
      }),
      goals: [{
        conversationId: "conversation-1",
        source: "codex-native" as const,
        providerSessionId: "thread-1",
        objective: "Survive the runtime restart",
        status: "active" as const,
        tokenBudget: 12_000,
        tokensUsed: 1_000,
        timeUsedSeconds: 5,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:05.000Z",
        synchronizedAt: "2030-01-01T00:00:05.000Z",
      }],
    };
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "agent.workflow.load") {
        throw new Error(
          "Changes are unavailable in recovery safety mode.",
        );
      }
      if (command.type !== "agent.workflow.saved.load") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: { kind: "agent.workflow", workflow: saved },
      };
    });
    const hook = renderHook(() => useAgentWorkflows({
      conversationId: "conversation-1",
      routeIdentity: "codex-app-server\0thread-1",
      status: "online",
      request,
      subscribe: () => () => undefined,
    }));

    await waitFor(() => expect(hook.result.current.state?.goals)
      .toEqual(saved.goals));
    expect(hook.result.current.error).toContain("recovery safety mode");
    expect(request).toHaveBeenNthCalledWith(1, {
      type: "agent.workflow.load",
      payload: { conversationId: "conversation-1", refresh: true },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      type: "agent.workflow.saved.load",
      payload: { conversationId: "conversation-1" },
    });
  });

  it("shares one goal-mutation latch across every surface", async () => {
    let releaseMutation!: () => void;
    const mutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const request = vi.fn(async (
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "agent.workflow.load") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "agent.workflow",
            workflow: workflow({
              kind: "codex-native",
              available: true,
              label: "Codex native goal",
            }),
          },
        };
      }
      if (command.type === "agent.goal.set") {
        await mutation;
        return { type: "request.ok", requestId: crypto.randomUUID() };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const hook = renderHook(() => useAgentWorkflows({
      conversationId: "conversation-1",
      routeIdentity: "codex-app-server\0thread-1",
      status: "online",
      request,
      subscribe: () => () => undefined,
    }));
    await waitFor(() => expect(hook.result.current.state).not.toBeNull());

    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.setGoal({
        source: "codex-native",
        status: "paused",
      });
    });
    await waitFor(() => expect(hook.result.current.mutating).toBe(true));
    await expect(hook.result.current.clearGoal("codex-native"))
      .rejects.toThrow("Another goal change is already in progress");
    expect(request).toHaveBeenCalledTimes(2);

    releaseMutation();
    await act(async () => await pending);
    expect(hook.result.current.mutating).toBe(false);
  });

  it("clears a native refresh warning when an authoritative goal event arrives", async () => {
    let emit!: (event: ServerEvent) => void;
    const request = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: "request-1",
      result: {
        kind: "agent.workflow",
        workflow: {
          ...workflow({
            kind: "codex-native",
            available: true,
            label: "Codex native goal",
          }),
          goalRefreshWarning: "Saved goal data is being shown.",
        },
      },
    }));
    const subscribe = vi.fn((
      listener: (event: ServerEvent) => void,
    ) => {
      emit = listener;
      return () => undefined;
    });
    const hook = renderHook(() => useAgentWorkflows({
      conversationId: "conversation-1",
      routeIdentity: "codex-app-server\0thread-1",
      status: "online",
      request,
      subscribe,
    }));
    await waitFor(() =>
      expect(hook.result.current.state?.goalRefreshWarning)
        .toBe("Saved goal data is being shown."));

    act(() => emit({
      type: "agent.goal.updated",
      goal: {
        conversationId: "conversation-1",
        source: "inertia-local",
        providerSessionId: null,
        objective: "Keep the local goal visible too",
        status: "active",
        tokenBudget: null,
        tokensUsed: null,
        timeUsedSeconds: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:02.000Z",
        synchronizedAt: null,
      },
    }));
    expect(hook.result.current.state?.goalRefreshWarning)
      .toBe("Saved goal data is being shown.");

    act(() => emit({
      type: "agent.goal.updated",
      goal: {
        conversationId: "conversation-1",
        source: "codex-native",
        providerSessionId: "thread-1",
        objective: "Use the recovered native goal",
        status: "active",
        tokenBudget: null,
        tokensUsed: 4,
        timeUsedSeconds: 3,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:03.000Z",
        synchronizedAt: "2030-01-01T00:00:03.000Z",
      },
    }));

    expect(hook.result.current.state?.goalRefreshWarning).toBeNull();
    expect(hook.result.current.state?.goals).toEqual([
      expect.objectContaining({
        objective: "Keep the local goal visible too",
      }),
      expect.objectContaining({
        objective: "Use the recovered native goal",
      }),
    ]);
  });

  it("never applies a delayed skills response to a newly selected conversation", async () => {
    let resolveOldSkills!: (event: ServerEvent) => void;
    const oldSkills = new Promise<ServerEvent>((resolve) => {
      resolveOldSkills = resolve;
    });
    const request = vi.fn((
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "agent.skills.list") return oldSkills;
      if (command.type !== "agent.workflow.load") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      const conversationId = command.payload.conversationId;
      return Promise.resolve({
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "agent.workflow",
          workflow: workflow({
            kind: "inertia-local",
            available: true,
            label: "Inertia local goal",
            reason: "This provider does not expose native goals.",
          }, conversationId),
        },
      });
    });
    const subscribe = vi.fn(() => () => undefined);
    const hook = renderHook(
      ({ conversationId }: { conversationId: string }) => useAgentWorkflows({
        conversationId,
        routeIdentity: conversationId,
        status: "online",
        request,
        subscribe,
      }),
      { initialProps: { conversationId: "conversation-1" } },
    );
    await waitFor(() =>
      expect(hook.result.current.state?.conversationId)
        .toBe("conversation-1"));

    let staleRequest!: Promise<void>;
    act(() => {
      staleRequest = hook.result.current.listSkills();
    });
    act(() => hook.rerender({ conversationId: "conversation-2" }));
    await waitFor(() =>
      expect(hook.result.current.state?.conversationId)
        .toBe("conversation-2"));

    resolveOldSkills({
      type: "request.result",
      requestId: "request-old-skills",
      result: {
        kind: "agent.skills",
        conversationId: "conversation-1",
        skills: [{
          id: "stale-skill",
          conversationId: "conversation-1",
          name: "stale",
          description: "Must never cross conversations.",
          shortDescription: null,
          scope: "repo",
          enabled: true,
          source: "codex-native",
        }],
        skillDiscovery: {
          truncated: false,
          warningCount: 0,
          synchronizedAt: "2030-01-01T00:00:00.000Z",
        },
      },
    });
    await act(async () => {
      await staleRequest;
    });

    expect(hook.result.current.state?.conversationId).toBe("conversation-2");
    expect(hook.result.current.state?.skills).toEqual([]);
    expect(hook.result.current.error).toBeNull();
  });
});
