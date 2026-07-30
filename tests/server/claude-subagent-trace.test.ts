import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudePromptChannel } from "../../src/server/provider/claude-prompt-channel";
import { ClaudeSubagentTraceTracker } from "../../src/server/provider/claude-subagent-trace";
import type { AgentHarnessEmitter } from "../../src/server/provider/agent-harness";

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    } as SDKUserMessage["message"],
    parent_tool_use_id: null,
  };
}

describe("Claude delegated-agent projection", () => {
  it("projects typed task edges and structured Agent output without parsing prose", () => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => {
      updates.push(event);
    });
    tracker.observe(sdkMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: "tool-parent",
          name: "Agent",
          input: {
            subagent_type: "researcher",
            name: "Evidence",
            description: "Inspect the repository",
          },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-parent",
      tool_use_id: "tool-parent",
      description: "Inspect the repository",
      subagent_type: "researcher",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-parent",
      tool_use_id: "tool-parent",
      description: "Inspect the repository",
      subagent_type: "researcher",
      summary: "Reading files",
    }));
    tracker.observe(sdkMessage({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-parent",
          content: "provider-rendered text is not parsed",
        }],
      },
      tool_use_result: {
        status: "completed",
        agentId: "agent-parent",
        agentType: "researcher",
        content: [{ type: "text", text: "Found the exact cause." }],
      },
    }));

    expect(updates).toEqual([
      expect.objectContaining({
        sequence: 1,
        providerTaskId: "task-parent",
        providerToolUseId: "tool-parent",
        providerRole: "researcher",
        status: "spawned",
      }),
      expect.objectContaining({
        sequence: 2,
        providerTaskId: "task-parent",
        status: "running",
        progress: "Reading files",
      }),
      expect.objectContaining({
        sequence: 3,
        providerTaskId: "task-parent",
        providerAgentId: "agent-parent",
        providerStatus: "completed",
        status: "completed",
        result: "Found the exact cause.",
      }),
    ]);
    expect(tracker.isLiveTask("task-parent")).toBe(false);
  });

  it("retains exact nested tool ownership and ignores unrelated background tasks", () => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => {
      updates.push(event);
    });
    tracker.observe(sdkMessage({
      type: "assistant",
      parent_tool_use_id: "tool-parent",
      message: {
        content: [{
          type: "tool_use",
          id: "tool-child",
          name: "Task",
          input: { subagent_type: "reviewer", prompt: "Review the patch" },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-child",
      tool_use_id: "tool-child",
      description: "Review the patch",
      subagent_type: "reviewer",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "bash-task",
      tool_use_id: "bash-tool",
      description: "Run tests",
      task_type: "shell",
    }));

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      providerTaskId: "task-child",
      parentProviderToolUseId: "tool-parent",
      providerToolUseId: "tool-child",
      providerRole: "reviewer",
    });
  });

  it("preserves waiting, failed, and stopped provider states exactly", () => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => {
      updates.push(event);
    });
    tracker.observe(sdkMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: "tool-stateful",
          name: "Agent",
          input: {
            subagent_type: "reviewer",
            description: "Review state handling",
          },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-stateful",
      tool_use_id: "tool-stateful",
      description: "Review state handling",
      subagent_type: "reviewer",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_updated",
      task_id: "task-stateful",
      patch: { status: "paused" },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_updated",
      task_id: "task-stateful",
      patch: { status: "future_active_state" },
    }));
    expect(tracker.hasLiveTasks()).toBe(true);
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-stateful",
      status: "failed",
      summary: "The review found a blocking error.",
    }));
    const updateCountAfterTerminalNotification = updates.length;
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_updated",
      task_id: "task-stateful",
      patch: { status: "running" },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_updated",
      task_id: "task-stateful",
      patch: { status: "future_active_state" },
    }));
    expect(updates).toHaveLength(updateCountAfterTerminalNotification);
    expect(tracker.isLiveTask("task-stateful")).toBe(false);
    expect(tracker.hasLiveTasks()).toBe(false);
    tracker.observe(sdkMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: "tool-stopped",
          name: "Agent",
          input: {
            subagent_type: "reviewer",
            description: "Review cancellation handling",
          },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-stopped",
      tool_use_id: "tool-stopped",
      description: "Review cancellation handling",
      subagent_type: "reviewer",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-stopped",
      status: "stopped",
      summary: "The provider stopped this task.",
    }));

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerTaskId: "task-stateful",
        providerStatus: "paused",
        status: "waiting",
        isLive: true,
      }),
      expect.objectContaining({
        providerTaskId: "task-stateful",
        providerStatus: "future_active_state",
        status: "unknown",
        isLive: true,
      }),
      expect.objectContaining({
        providerTaskId: "task-stateful",
        providerStatus: "failed",
        status: "failed",
        isLive: false,
        result: "The review found a blocking error.",
      }),
      expect.objectContaining({
        providerTaskId: "task-stopped",
        providerStatus: "stopped",
        status: "cancelled",
        isLive: false,
        result: "The provider stopped this task.",
      }),
    ]));
    expect(tracker.hasLiveTasks()).toBe(false);
  });
});

describe("Claude persistent parent prompt channel", () => {
  it("preserves FIFO parent-session input and closes without dropping queued work", async () => {
    const channel = new ClaudePromptChannel();
    const iterator = channel[Symbol.asyncIterator]();
    expect(channel.push(userMessage("first"))).toBe(true);
    expect(channel.push(userMessage("second"))).toBe(true);
    channel.close();

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "user" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "user" },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(channel.push(userMessage("late"))).toBe(false);
  });
});
