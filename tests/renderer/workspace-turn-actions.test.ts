import { describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import { createWorkspaceTurnActions } from "../../src/renderer/src/components/workspace-scene/createWorkspaceTurnActions";
import { taskTrace } from "./background-task-fixtures";

describe("workspace turn actions", () => {
  it("sends Stop and Move to background for the trace's own chat, as the main, split and detached scenes share them", async () => {
    const run = vi.fn(async () => ({ type: "request.ok" }) as unknown as ServerEvent);
    const actions = createWorkspaceTurnActions({
      conversation: null,
      confirmDestructiveActions: false,
      run,
      loadGit: vi.fn(async () => undefined) as never,
      openTurnDiff: vi.fn(async () => undefined),
      compareTurnArtifacts: vi.fn(async () => undefined),
    });
    const trace = taskTrace({ id: "trace-fg", conversationId: "conversation-detached" });
    await actions.backgroundSubagent(trace);
    await actions.stopSubagent(trace);
    expect(run.mock.calls).toEqual([
      ["agent.subagent.background:trace-fg", {
        type: "agent.subagent.background",
        payload: { conversationId: "conversation-detached", traceId: "trace-fg" },
      }],
      ["agent.subagent.stop:trace-fg", {
        type: "agent.subagent.stop",
        payload: { conversationId: "conversation-detached", traceId: "trace-fg" },
      }],
    ]);
  });
});
