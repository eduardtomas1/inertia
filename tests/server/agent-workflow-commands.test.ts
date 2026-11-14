import { describe, expect, it, vi } from "vitest";

import type { AgentWorkflowState, ClientCommand } from "../../src/shared/contracts";
import type { AgentWorkflowController } from "../../src/server/runtime/agent-workflow-controller";
import { ConversationWorkAuthority } from "../../src/server/runtime/conversation-work-authority";
import {
  createAgentWorkflowCommandHandler,
  type AgentWorkflowCommandDependencies,
} from "../../src/server/runtime/commands/agent-workflow-commands";

const clearCommand: Extract<
  ClientCommand,
  { type: "agent.goal.clear" }
> = {
  type: "agent.goal.clear",
  requestId: "11111111-1111-4111-8111-111111111111",
  payload: {
    conversationId: "22222222-2222-4222-8222-222222222222",
    source: "codex-native",
  },
};

const refreshCommand: Extract<ClientCommand, { type: "agent.workflow.load" }> = {
  type: "agent.workflow.load",
  requestId: clearCommand.requestId,
  payload: { conversationId: clearCommand.payload.conversationId, refresh: true },
};

function savedWorkflow(native = false): AgentWorkflowState {
  return {
    conversationId: clearCommand.payload.conversationId,
    goals: [], skills: [],
    goalCapability: native
      ? { kind: "codex-native", available: true, label: "Codex native goal" }
      : { kind: "inertia-local", available: true, label: "Inertia local goal", reason: "Local route" },
    skillsCapability: { kind: "unavailable", available: false, label: "Skills unavailable", reason: "Fixture" },
    goalRefreshWarning: null,
    skillDiscovery: { truncated: false, warningCount: 0, synchronizedAt: null },
    refreshedAt: "2030-01-01T00:00:00.000Z",
  };
}

function dependencies(
  cleared: boolean,
): AgentWorkflowCommandDependencies {
  return {
    workflows: {
      clearGoal: vi.fn(async () => cleared),
      refresh: vi.fn(),
      state: vi.fn(() => savedWorkflow()),
    } as unknown as AgentWorkflowController,
    providerTerminalResumes: { isActive: vi.fn(() => false) },
    conversationWork: {
      reserve: vi.fn(() => true),
      release: vi.fn(),
    },
    broadcast: vi.fn(),
    send: vi.fn(),
  };
}

describe("agent workflow commands", () => {
  it("loads saved workflow state without a provider refresh", async () => {
    const state = vi.fn(() => ({
      conversationId: clearCommand.payload.conversationId,
    }));
    const refresh = vi.fn();
    const runtime = {
      workflows: { state, refresh } as unknown as AgentWorkflowController,
      providerTerminalResumes: { isActive: vi.fn(() => false) },
      conversationWork: {
        reserve: vi.fn(() => true),
        release: vi.fn(),
      },
      broadcast: vi.fn(),
      send: vi.fn(),
    };
    const handler = createAgentWorkflowCommandHandler(runtime);

    await expect(handler({} as never, {
      type: "agent.workflow.saved.load",
      requestId: clearCommand.requestId,
      payload: { conversationId: clearCommand.payload.conversationId },
    })).resolves.toBe("handled");

    expect(state).toHaveBeenCalledWith(
      clearCommand.payload.conversationId,
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    { cleared: true, expectedBroadcasts: 1 },
    { cleared: false, expectedBroadcasts: 0 },
  ])(
    "broadcasts a clear only when authoritative state changed",
    async ({ cleared, expectedBroadcasts }) => {
      const runtime = dependencies(cleared);
      const handler = createAgentWorkflowCommandHandler(runtime);

      await expect(handler({} as never, clearCommand)).resolves.toBe("handled");

      expect(runtime.broadcast).toHaveBeenCalledTimes(expectedBroadcasts);
      if (cleared) {
        expect(runtime.broadcast).toHaveBeenCalledWith({
          type: "agent.goal.cleared",
          conversationId: clearCommand.payload.conversationId,
          source: "codex-native",
        });
      }
      expect(runtime.send).toHaveBeenCalledWith({}, {
        type: "request.ok",
        requestId: clearCommand.requestId,
      });
    },
  );

  it("rejects native workflow mutations while its provider terminal is active", async () => {
    const runtime = dependencies(true);
    vi.mocked(runtime.providerTerminalResumes.isActive).mockReturnValue(true);
    const handler = createAgentWorkflowCommandHandler(runtime);

    await expect(handler({} as never, clearCommand)).rejects.toThrow(
      /End the active provider session/u,
    );
    expect(runtime.workflows.clearGoal).not.toHaveBeenCalled();
  });

  describe.each([
    { native: true },
    { native: false },
  ])("saved refresh fallback (native=$native)", ({ native }) => {
    it("returns truthful saved state while its provider terminal is active", async () => {
      const runtime = dependencies(true);
      const saved = Object.freeze(savedWorkflow(native));
      vi.mocked(runtime.workflows.state).mockReturnValue(saved);
      vi.mocked(runtime.providerTerminalResumes.isActive).mockReturnValue(true);
      const handler = createAgentWorkflowCommandHandler(runtime);

      await expect(handler({} as never, refreshCommand)).resolves.toBe("handled");

      expect(runtime.workflows.state).toHaveBeenCalledWith(refreshCommand.payload.conversationId);
      expect(runtime.workflows.refresh).not.toHaveBeenCalled();
      expect(runtime.conversationWork.reserve).not.toHaveBeenCalled();
      expect(runtime.conversationWork.release).not.toHaveBeenCalled();
      expect(runtime.send).toHaveBeenCalledWith({}, {
        type: "request.result",
        requestId: refreshCommand.requestId,
        result: {
          kind: "agent.workflow",
          workflow: {
            ...saved,
            goalRefreshWarning: native
              ? "Showing saved native goal data while this chat is busy. It may be out of date."
              : null,
          },
        },
      });
      expect(saved.goalRefreshWarning).toBeNull();
    });
  });

  it("preserves an existing native refresh warning without mutating saved state", async () => {
    const runtime = dependencies(true);
    const saved = Object.freeze({ ...savedWorkflow(true), goalRefreshWarning: "Existing provider warning" });
    vi.mocked(runtime.workflows.state).mockReturnValue(saved);
    vi.mocked(runtime.providerTerminalResumes.isActive).mockReturnValue(true);
    await createAgentWorkflowCommandHandler(runtime)({} as never, refreshCommand);
    expect(runtime.send).toHaveBeenCalledWith({}, expect.objectContaining({
      result: { kind: "agent.workflow", workflow: saved },
    }));
    expect(saved.goalRefreshWarning).toBe("Existing provider warning");
  });

  it("refreshes while another conversation holds the shared checkout and leaves its reservation intact", async () => {
    const runtime = dependencies(true);
    const authority = new ConversationWorkAuthority(() => ({ projectId: "project-1", checkoutPath: process.cwd() }));
    runtime.conversationWork = authority;
    const reserve = vi.spyOn(authority, "reserve");
    const release = vi.spyOn(authority, "release");
    expect(authority.reserve("other-conversation")).toBe(true);
    reserve.mockClear();
    vi.mocked(runtime.workflows.refresh).mockImplementation(async () => {
      expect(authority.hasConversation("other-conversation")).toBe(true);
      return savedWorkflow(true);
    });
    await expect(createAgentWorkflowCommandHandler(runtime)({} as never, refreshCommand)).resolves.toBe("handled");
    expect(runtime.workflows.refresh).toHaveBeenCalledExactlyOnceWith(refreshCommand.payload.conversationId);
    expect(reserve).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(authority.reserve(refreshCommand.payload.conversationId)).toBe(false);
    authority.release("other-conversation");
    expect(authority.reserve(refreshCommand.payload.conversationId)).toBe(true);
    authority.release(refreshCommand.payload.conversationId);
  });

  it("passes a refresh rejection through without touching provider-session authority", async () => {
    const runtime = dependencies(true);
    const failure = new Error("Refresh failed");
    vi.mocked(runtime.workflows.refresh).mockRejectedValue(failure);
    await expect(createAgentWorkflowCommandHandler(runtime)({} as never, refreshCommand)).rejects.toBe(failure);
    expect(runtime.conversationWork.reserve).not.toHaveBeenCalled();
    expect(runtime.conversationWork.release).not.toHaveBeenCalled();
    expect(runtime.workflows.state).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it("lets other work reserve the checkout while a native refresh is pending", async () => {
    let settle!: () => void;
    const refresh = vi.fn(async () => await new Promise<void>((resolve) => {
      settle = resolve;
    }));
    const runtime = dependencies(true);
    const authority = new ConversationWorkAuthority(() => ({ projectId: "project-1", checkoutPath: process.cwd() }));
    runtime.conversationWork = authority;
    const reserve = vi.spyOn(authority, "reserve");
    runtime.workflows.refresh = refresh as never;
    const handler = createAgentWorkflowCommandHandler(runtime);

    const pending = handler({} as never, refreshCommand);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    expect(reserve).not.toHaveBeenCalled();
    expect(authority.hasConversation(refreshCommand.payload.conversationId)).toBe(false);
    expect(authority.reserve(refreshCommand.payload.conversationId)).toBe(true);
    authority.release(refreshCommand.payload.conversationId);
    expect(authority.reserve("other-conversation")).toBe(true);
    authority.release("other-conversation");

    settle();
    await expect(pending).resolves.toBe("handled");
    expect(authority.hasConversation(refreshCommand.payload.conversationId)).toBe(false);
  });

  it("rejects native workflow operations when provider-session authority is reserved", async () => {
    const runtime = dependencies(true);
    vi.mocked(runtime.conversationWork.reserve).mockReturnValue(false);
    const handler = createAgentWorkflowCommandHandler(runtime);

    await expect(handler({} as never, clearCommand)).rejects.toThrow(
      /End the active provider session/u,
    );
    expect(runtime.workflows.clearGoal).not.toHaveBeenCalled();
    expect(runtime.conversationWork.release).not.toHaveBeenCalled();
  });
});
