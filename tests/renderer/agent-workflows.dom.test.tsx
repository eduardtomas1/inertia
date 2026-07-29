import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAgentWorkflows } from "../../src/renderer/src/hooks/useAgentWorkflows";
import type {
  AgentWorkflowState,
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
    skillDiscovery: {
      truncated: false,
      warningCount: 0,
      synchronizedAt: null,
    },
    refreshedAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("useAgentWorkflows", () => {
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
    native = true;
    act(() => {
      hook.rerender({ routeIdentity: "codex-app-server\0thread-1" });
    });
    await waitFor(() =>
      expect(hook.result.current.state?.goalCapability.kind)
        .toBe("codex-native"));
    expect(request).toHaveBeenCalledTimes(2);
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
