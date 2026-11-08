import { describe, expect, it } from "vitest";

import {
  sameSubagentRevisions,
  turnAgentStatus,
  turnAgentStatusText,
  type TurnAgentStatus,
} from "../../src/renderer/src/utils/turnAgentStatus";
import { taskTrace } from "./background-task-fixtures";

function status(overrides: Partial<TurnAgentStatus>): TurnAgentStatus {
  return {
    live: 0,
    running: 0,
    total: 0,
    failed: 0,
    agents: 0,
    liveAgents: 0,
    commands: 0,
    liveCommands: 0,
    ...overrides,
  };
}

describe("turn agent status", () => {
  it("is absent for a turn without delegated agents", () => {
    expect(turnAgentStatus([])).toBeNull();
  });

  it("counts live, finished and failed agents", () => {
    expect(turnAgentStatus([
      taskTrace({ id: "a" }),
      taskTrace({ id: "b", status: "waiting" }),
      taskTrace({ id: "c", status: "completed" }),
      taskTrace({ id: "d", status: "failed" }),
    ])).toEqual(status({ live: 2, running: 1, total: 4, failed: 1, agents: 4, liveAgents: 2 }));
    expect(turnAgentStatus([
      taskTrace({ id: "a", status: "completed" }),
      taskTrace({ id: "b", status: "failed" }),
      taskTrace({ id: "c", status: "interrupted" }),
      taskTrace({ id: "d", status: "lost", isLive: false }),
      taskTrace({ id: "e", status: "cancelled" }),
    ])).toEqual(status({ live: 0, running: 0, total: 5, failed: 3, agents: 5 }));
  });

  it("counts background commands, monitors and MCP tasks apart from agents", () => {
    expect(turnAgentStatus([
      taskTrace({ id: "agent" }),
      taskTrace({ id: "workflow", taskKind: "workflow", status: "completed" }),
      taskTrace({ id: "remote", taskKind: "remote", status: "completed" }),
      taskTrace({ id: "shell", taskKind: "shell", background: true }),
      taskTrace({ id: "monitor", taskKind: "monitor", status: "completed" }),
      taskTrace({ id: "mcp", taskKind: "mcp", status: "failed" }),
    ])).toEqual(status({ live: 2, running: 2, total: 6, failed: 1, agents: 3, liveAgents: 1, commands: 3, liveCommands: 1 }));
  });

  it("says how many agents are working or finished, how many background commands run, and how many failed", () => {
    expect(turnAgentStatusText(status({ live: 1, total: 3, failed: 1, agents: 3, liveAgents: 1 })))
      .toEqual({ text: "1 agent working", failed: "1 failed" });
    expect(turnAgentStatusText(status({ live: 2, total: 2, agents: 2, liveAgents: 2 })))
      .toEqual({ text: "2 agents working", failed: null });
    expect(turnAgentStatusText(status({ total: 1, agents: 1 })))
      .toEqual({ text: "1 agent finished", failed: null });
    expect(turnAgentStatusText(status({ total: 4, failed: 1, agents: 4 })))
      .toEqual({ text: "4 agents finished", failed: "1 failed" });
    expect(turnAgentStatusText(status({ live: 2, total: 3, agents: 1, liveAgents: 1, commands: 2, liveCommands: 1 })))
      .toEqual({ text: "1 agent working · 1 background command running", failed: null });
    expect(turnAgentStatusText(status({ total: 2, commands: 2 })))
      .toEqual({ text: "2 background commands", failed: null });
  });

  it("treats traces as unchanged only when every identity and sequence matches", () => {
    const first = taskTrace({ id: "a", sequence: 1 });
    const second = taskTrace({ id: "b", sequence: 4 });
    expect(sameSubagentRevisions(undefined, [])).toBe(true);
    expect(sameSubagentRevisions([first, second], [{ ...first }, { ...second, progress: "same revision" }])).toBe(true);
    expect(sameSubagentRevisions([first, second], [first, { ...second, sequence: 5 }])).toBe(false);
    expect(sameSubagentRevisions([first, second], [first, { ...second, status: "cancelled", updatedAt: "2030-01-01T00:01:00.000Z" }])).toBe(false);
    expect(sameSubagentRevisions([first, second], [second, first])).toBe(false);
    expect(sameSubagentRevisions([first], [first, second])).toBe(false);
  });
});
