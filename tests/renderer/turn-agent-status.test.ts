import { describe, expect, it } from "vitest";

import {
  turnAgentStatus,
  turnAgentStatusText,
} from "../../src/renderer/src/utils/turnAgentStatus";
import { taskTrace } from "./background-task-fixtures";

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
    ])).toEqual({ live: 2, total: 4, failed: 1 });
    expect(turnAgentStatus([
      taskTrace({ id: "a", status: "completed" }),
      taskTrace({ id: "b", status: "failed" }),
      taskTrace({ id: "c", status: "interrupted" }),
      taskTrace({ id: "d", status: "lost", isLive: false }),
      taskTrace({ id: "e", status: "cancelled" }),
    ])).toEqual({ live: 0, total: 5, failed: 3 });
  });

  it("says how many agents are working, or how many finished and failed", () => {
    expect(turnAgentStatusText({ live: 1, total: 3, failed: 1 })).toEqual({ text: "1 agent working", failed: null });
    expect(turnAgentStatusText({ live: 2, total: 2, failed: 0 })).toEqual({ text: "2 agents working", failed: null });
    expect(turnAgentStatusText({ live: 0, total: 1, failed: 0 })).toEqual({ text: "1 agent finished", failed: null });
    expect(turnAgentStatusText({ live: 0, total: 4, failed: 1 })).toEqual({ text: "4 agents finished", failed: "1 failed" });
  });
});
