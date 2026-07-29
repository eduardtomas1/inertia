import { describe, expect, it, vi } from "vitest";

import type { ClientCommand } from "../../src/shared/contracts";
import type { AgentWorkflowController } from "../../src/server/runtime/agent-workflow-controller";
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

function dependencies(
  cleared: boolean,
): AgentWorkflowCommandDependencies {
  return {
    workflows: {
      clearGoal: vi.fn(async () => cleared),
    } as unknown as AgentWorkflowController,
    broadcast: vi.fn(),
    send: vi.fn(),
  };
}

describe("agent workflow commands", () => {
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
});
