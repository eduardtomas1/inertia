import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeStore } from "../../src/server/database";
import { createBackgroundTaskCommandHandler } from "../../src/server/runtime/commands/background-task-commands";
import type { BackgroundTasksResult } from "../../src/shared/background-tasks";
import type { ServerEvent, WorkspaceRun } from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";

function run(id: string, status: WorkspaceRun["status"]): WorkspaceRun {
  return {
    id, kind: "service", projectId: "project", conversationId, actionId: "dev", label: id, detail: null,
    status, attentionState: "acknowledged", canStop: false, port: null,
    startedAt: "2030-01-01T00:00:00.000Z", finishedAt: null,
  };
}

describe("background tasks read command", () => {
  it("reports Stop for the runs the runtime can stop, with the same check as the snapshot", async () => {
    const result: BackgroundTasksResult = {
      kind: "conversation.background-tasks", conversationId, subagents: [],
      runs: [run("owned", "running"), run("foreign", "running"), run("done", "succeeded")],
      finishedCount: 1, failedCount: 0, next: null,
    };
    const sent: ServerEvent[] = [];
    const canStopWorkspaceRun = vi.fn((candidate: WorkspaceRun) => candidate.id === "owned");
    const handler = createBackgroundTaskCommandHandler({
      store: { backgroundTasks: vi.fn(() => result) } as unknown as RuntimeStore,
      send: (_socket, event) => { sent.push(event); },
      canStopWorkspaceRun,
    });
    await expect(handler({} as WebSocket, {
      type: "conversation.background-tasks.get", requestId: "request", payload: { conversationId, before: null },
    })).resolves.toBe("handled");
    const event = sent[0] as Extract<ServerEvent, { type: "request.result" }>;
    expect((event.result as BackgroundTasksResult).runs.map(({ id, canStop }) => [id, canStop]))
      .toEqual([["owned", true], ["foreign", false], ["done", false]]);
    expect(canStopWorkspaceRun).toHaveBeenCalledTimes(3);
  });
});
