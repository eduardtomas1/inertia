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
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-parent",
      status: "failed",
      summary: "A stale aggregate incorrectly reported failure.",
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
    expect(updates).not.toContainEqual(expect.objectContaining({
      providerTaskId: "task-parent",
      status: "failed",
    }));
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

  it("covers the SDK's exact local workflow and remote agent task variants", () => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => {
      updates.push(event);
    });

    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "workflow-task",
      task_type: "local_workflow",
      workflow_name: "quality-gate",
      description: "Run the quality workflow",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "workflow-task",
      description: "Review: provider integrations",
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
      summary: "Reviewing providers",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "workflow-task",
      status: "completed",
      output_file: "/tmp/workflow-task",
      summary: "Workflow completed",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "remote-task",
      task_type: "remote_agent",
      description: "Run a remote review",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "remote-task",
      status: "stopped",
      output_file: "/tmp/remote-task",
      summary: "Remote review stopped",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "local-bash-task",
      task_type: "local_bash",
      description: "Ambient workflow shell command",
    }));

    expect(updates).toEqual([
      expect.objectContaining({
        providerTaskId: "workflow-task",
        providerName: "quality-gate",
        status: "spawned",
      }),
      expect.objectContaining({
        providerTaskId: "workflow-task",
        status: "running",
        progress: "Reviewing providers",
      }),
      expect.objectContaining({
        providerTaskId: "workflow-task",
        providerStatus: "completed",
        status: "completed",
        result: "Workflow completed",
      }),
      expect.objectContaining({
        providerTaskId: "remote-task",
        status: "spawned",
      }),
      expect.objectContaining({
        providerTaskId: "remote-task",
        providerStatus: "stopped",
        status: "cancelled",
        result: "Remote review stopped",
      }),
    ]);
    expect(tracker.hasLiveTasks()).toBe(false);
    expect(updates).not.toContainEqual(expect.objectContaining({
      providerTaskId: "local-bash-task",
    }));
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
      subtype: "task_started",
      task_id: "task-stateful",
      tool_use_id: "tool-stateful",
      description: "A stale repeated start",
      subagent_type: "reviewer",
    }));
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
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-terminal-unknown",
      description: "Wait for a future terminal state clarification.",
      subagent_type: "reviewer",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-terminal-unknown",
      status: "future_terminal_state",
      summary: "The provider reported a future terminal state.",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-terminal-unknown",
      status: "completed",
      summary: "The provider clarified the outcome.",
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
      expect.objectContaining({
        providerTaskId: "task-terminal-unknown",
        providerStatus: "future_terminal_state",
        status: "unknown",
        isLive: false,
      }),
      expect.objectContaining({
        providerTaskId: "task-terminal-unknown",
        providerStatus: "completed",
        status: "completed",
        isLive: false,
        result: "The provider clarified the outcome.",
      }),
    ]));
    expect(tracker.hasLiveTasks()).toBe(false);
  });
});

describe("Claude persistent parent prompt channel", () => {
  it("preserves FIFO parent-session input and closes without dropping queued work", async () => {
    const channel = new ClaudePromptChannel();
    const iterator = channel[Symbol.asyncIterator]();
    expect(channel.push(userMessage("first"), channel.reserve(128)!)).toBe(true);
    expect(channel.push(userMessage("second"), channel.reserve(128)!)).toBe(true);
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
    const late = channel.reserve(128);
    expect(late).toBeNull();
  });

  it("bounds queued prompt reservations and restores capacity on consumption and cancellation", async () => {
    const channel = new ClaudePromptChannel(2, 10);
    const first = channel.reserve(6)!;
    expect(channel.push(userMessage("first"), first)).toBe(true);
    expect(channel.reserve(5)).toBeNull();

    const iterator = channel[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "user" },
    });
    const second = channel.reserve(5)!;
    expect(channel.push(userMessage("second"), second)).toBe(true);
    const third = channel.reserve(5)!;
    expect(channel.reserve(1)).toBeNull();

    channel.cancel();
    expect(channel.reserve(1)).toBeNull();
    expect(channel.push(userMessage("late"), third)).toBe(false);
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("discards reserved input when the SDK finalizes its iterator", async () => {
    const channel = new ClaudePromptChannel(1, 10);
    const iterator = channel[Symbol.asyncIterator]();
    expect(channel.push(userMessage("queued"), channel.reserve(10)!)).toBe(true);

    await expect(iterator.return!()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
