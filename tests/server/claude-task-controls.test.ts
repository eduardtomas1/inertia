// @inertia-test-suite portable
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeSubagentTraceTracker,
  MAX_CLAUDE_QUEUED_TASK_STOPS,
} from "../../src/server/provider/claude-subagent-trace";
import type { AgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import {
  CLAUDE_BACKGROUND_TASK_TIMEOUT_MS,
  createClaudeTaskControls,
} from "../../src/server/provider/claude-task-controls";

function message(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function agentCall(id: string, input: Record<string, unknown> = { subagent_type: "general-purpose" }): SDKMessage {
  return message({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id, name: "Agent", input }] },
  });
}

function asyncLaunch(toolUseId: string, agentId: string): SDKMessage {
  return message({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
    tool_use_result: { status: "async_launched", agentId, description: "Survey", prompt: "Survey", outputFile: "/tmp/out" },
  });
}

function setup(query: Partial<Query>, cancelled = false) {
  const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
  const tracker = new ClaudeSubagentTraceTracker((update) => updates.push(update));
  const controls = createClaudeTaskControls({
    query: () => query as Query,
    cancelled: () => cancelled,
    tracker,
    timeoutMs: 50,
    backgroundTimeoutMs: 80,
  });
  return { tracker, controls, updates };
}

function taskStarted(taskId: string, toolUseId: string): SDKMessage {
  return message({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, task_type: "local_agent" });
}

async function settled(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
}

describe("Claude per-task controls", () => {
  it("queues a Stop that arrives before Claude issued the task id and sends it on task_started", async () => {
    const stopTask = vi.fn(async () => undefined);
    const { tracker, controls } = setup({ stopTask });
    tracker.observe(agentCall("tool-early"));
    tracker.observe(asyncLaunch("tool-early", "agent-early"));
    await expect(controls.stop(null, "tool-early")).resolves.toBe("queued");
    expect(stopTask).not.toHaveBeenCalled();
    controls.releaseQueuedStops();
    expect(stopTask).not.toHaveBeenCalled();
    tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-early", tool_use_id: "tool-early", task_type: "local_agent" }));
    controls.releaseQueuedStops();
    expect(stopTask).toHaveBeenCalledWith("task-early");
    controls.releaseQueuedStops();
    expect(stopTask).toHaveBeenCalledOnce();
  });

  it("keeps a held Stop's agent live until Claude accepts the Stop it sends on task_started", async () => {
    const stopTask = vi.fn(async () => undefined);
    const { tracker, controls, updates } = setup({ stopTask });
    tracker.observe(agentCall("tool-early"));
    tracker.observe(asyncLaunch("tool-early", "agent-early"));
    await expect(controls.stop(null, "tool-early")).resolves.toBe("queued");
    await expect(controls.stop(null, "tool-early")).resolves.toBe("queued");
    tracker.observe(message({
      type: "assistant",
      parent_tool_use_id: "tool-early",
      message: { content: [{ type: "tool_use", id: "step-1", name: "Read", input: { file_path: "/r/a.ts" } }] },
    }));
    expect(updates.at(-1)).toMatchObject({ isLive: true, progress: "Stop requested." });
    tracker.observe(taskStarted("task-early", "tool-early"));
    expect(updates.at(-1)).toMatchObject({ providerTaskId: "task-early", isLive: true, progress: "Stop requested." });
    controls.releaseQueuedStops();
    await settled();
    expect(stopTask).toHaveBeenCalledOnce();
    expect(updates.at(-1)).toMatchObject({
      providerTaskId: "task-early", status: "cancelled", isLive: false, providerStatus: "stopped", progress: "Stopped by the user.",
    });
    expect(tracker.hasLiveTasks()).toBe(false);
    tracker.observe(message({ type: "system", subtype: "task_notification", task_id: "task-early", status: "stopped", summary: "Stopped" }));
    expect(updates.at(-1)).toMatchObject({ status: "cancelled", isLive: false, result: "Stopped" });
    await expect(controls.stop(null, "tool-early")).resolves.toBe(false);
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("no such task"))],
    ["never answers", () => new Promise<void>(() => undefined)],
  ])("reports a held Stop that Claude %s and keeps the agent live", async (_label, answer) => {
    const stopTask = vi.fn(answer);
    const { tracker, controls, updates } = setup({ stopTask });
    tracker.observe(agentCall("tool-early"));
    tracker.observe(asyncLaunch("tool-early", "agent-early"));
    await expect(controls.stop(null, "tool-early")).resolves.toBe("queued");
    tracker.observe(taskStarted("task-early", "tool-early"));
    controls.releaseQueuedStops();
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({
      providerTaskId: "task-early", status: "running", isLive: true, progress: "Claude could not stop this task.",
    }));
    expect(tracker.isLiveTask("task-early")).toBe(true);
    tracker.observe(message({ type: "system", subtype: "task_progress", task_id: "task-early", summary: "Still reading" }));
    expect(updates.at(-1)).toMatchObject({ isLive: true, progress: "Still reading" });
  });

  it("ignores Claude's late answer to a held Stop once the agent settled on its own", async () => {
    let answer: () => void = () => undefined;
    const stopTask = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    const { tracker, controls, updates } = setup({ stopTask });
    tracker.observe(agentCall("tool-early"));
    tracker.observe(asyncLaunch("tool-early", "agent-early"));
    await expect(controls.stop(null, "tool-early")).resolves.toBe("queued");
    tracker.observe(taskStarted("task-early", "tool-early"));
    controls.releaseQueuedStops();
    tracker.observe(message({ type: "system", subtype: "task_notification", task_id: "task-early", status: "completed", summary: "Done" }));
    expect(updates.at(-1)).toMatchObject({ status: "completed", isLive: false });
    const count = updates.length;
    answer();
    await settled();
    expect(updates).toHaveLength(count);
  });

  it("stops a known task by its id or its tool call and refuses unknown or settled work", async () => {
    const stopTask = vi.fn(async () => undefined);
    const { tracker, controls } = setup({ stopTask });
    tracker.observe(agentCall("tool-live"));
    tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-live", tool_use_id: "tool-live", task_type: "local_agent" }));
    await expect(controls.stop(null, "tool-live")).resolves.toBe(true);
    await expect(controls.stop("task-live")).resolves.toBe(true);
    expect(stopTask.mock.calls).toEqual([["task-live"], ["task-live"]]);
    await expect(controls.stop(null, "tool-unknown")).resolves.toBe(false);
    await expect(controls.stop("task-unknown")).resolves.toBe(false);
    tracker.observe(message({ type: "system", subtype: "task_notification", task_id: "task-live", status: "completed" }));
    await expect(controls.stop(null, "tool-live")).resolves.toBe(false);
  });

  it("forgets a queued Stop when the agent finishes first and bounds the queue", async () => {
    const stopTask = vi.fn(async () => undefined);
    const { tracker, controls } = setup({ stopTask });
    tracker.observe(agentCall("tool-quick"));
    await expect(controls.stop(null, "tool-quick")).resolves.toBe("queued");
    tracker.observe(message({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-quick" }] },
      tool_use_result: { status: "completed", agentId: "agent-quick", content: [] },
    }));
    tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-quick", tool_use_id: "tool-quick", task_type: "local_agent" }));
    controls.releaseQueuedStops();
    expect(stopTask).not.toHaveBeenCalled();
    for (let index = 0; index < MAX_CLAUDE_QUEUED_TASK_STOPS; index += 1) {
      tracker.observe(agentCall(`tool-${index}`));
      await expect(controls.stop(null, `tool-${index}`)).resolves.toBe("queued");
    }
    tracker.observe(agentCall("tool-overflow"));
    await expect(controls.stop(null, "tool-overflow")).resolves.toBe(false);
  });

  it("moves only a foreground agent to the background and surfaces Claude's refusal", async () => {
    const backgroundTasks = vi.fn(async () => true);
    const { tracker, controls } = setup({ backgroundTasks });
    tracker.observe(agentCall("tool-fg"));
    tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-fg", tool_use_id: "tool-fg", task_type: "local_agent", is_backgrounded: false }));
    tracker.observe(agentCall("tool-bg"));
    tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-bg", tool_use_id: "tool-bg", task_type: "local_agent", is_backgrounded: true }));
    await expect(controls.background("tool-fg")).resolves.toEqual({ moved: true });
    expect(backgroundTasks).toHaveBeenCalledWith("tool-fg");
    await expect(controls.background("tool-bg")).resolves.toEqual({ moved: false });
    await expect(controls.background("tool-missing")).resolves.toEqual({ moved: false });
    expect(backgroundTasks).toHaveBeenCalledOnce();

    const refusing = setup({
      backgroundTasks: vi.fn(async () => {
        throw new Error("Background tasks are disabled for this session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)");
      }),
    });
    refusing.tracker.observe(agentCall("tool-fg"));
    refusing.tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-fg", tool_use_id: "tool-fg", task_type: "local_agent", is_backgrounded: false }));
    await expect(refusing.controls.background("tool-fg")).resolves.toEqual({
      moved: false,
      error: "Background tasks are disabled for this session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)",
    });
  });

  it("says when Claude declines the move, apart from a timeout", async () => {
    const backgroundTasks = vi.fn(async () => false);
    const { tracker, controls } = setup({ backgroundTasks });
    tracker.observe(agentCall("tool-fg"));
    tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-fg", tool_use_id: "tool-fg", task_type: "local_agent", is_backgrounded: false }));
    await expect(controls.background("tool-fg")).resolves.toEqual({
      moved: false,
      error: "Claude declined to move this agent to the background.",
    });
  });

  it("gives the move its own bound, longer than a Stop's, and never longer than the default", async () => {
    vi.useFakeTimers();
    try {
      let answer: (moved: boolean) => void = () => undefined;
      const backgroundTasks = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
      const tracker = new ClaudeSubagentTraceTracker(() => undefined);
      const controls = createClaudeTaskControls({
        query: () => ({ backgroundTasks }) as unknown as Query,
        cancelled: () => false,
        tracker,
        timeoutMs: 2_000,
        backgroundTimeoutMs: 60_000,
      });
      tracker.observe(agentCall("tool-fg"));
      tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-fg", tool_use_id: "tool-fg", task_type: "local_agent", is_backgrounded: false }));
      const moving = controls.background("tool-fg");
      await vi.advanceTimersByTimeAsync(2_500);
      answer(true);
      await expect(moving).resolves.toEqual({ moved: true });
      const late = controls.background("tool-fg");
      await vi.advanceTimersByTimeAsync(CLAUDE_BACKGROUND_TASK_TIMEOUT_MS);
      await expect(late).resolves.toMatchObject({ moved: false, error: expect.stringContaining("in time") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an unanswered SDK call and does nothing once the run is cancelled", async () => {
    const backgroundTasks = vi.fn(() => new Promise<boolean>(() => undefined));
    const { tracker, controls } = setup({ backgroundTasks });
    tracker.observe(agentCall("tool-fg"));
    tracker.observe(message({ type: "system", subtype: "task_started", task_id: "task-fg", tool_use_id: "tool-fg", task_type: "local_agent", is_backgrounded: false }));
    await expect(controls.background("tool-fg")).resolves.toEqual({
      moved: false,
      error: "Claude did not confirm the move to the background in time. The agent may still move there.",
    });
    const cancelled = setup({ stopTask: vi.fn(async () => undefined), backgroundTasks }, true);
    cancelled.tracker.observe(agentCall("tool-x"));
    await expect(cancelled.controls.stop(null, "tool-x")).resolves.toBe(false);
    await expect(cancelled.controls.background("tool-x")).resolves.toEqual({ moved: false });
  });
});
