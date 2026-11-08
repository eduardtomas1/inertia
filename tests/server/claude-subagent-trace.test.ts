import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudePromptChannel } from "../../src/server/provider/claude-prompt-channel";
import {
  ClaudeSubagentTraceTracker,
  MAX_CLAUDE_IGNORED_TASK_IDS,
  MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS,
  MAX_CLAUDE_LIVE_SUBAGENT_TASKS,
  MAX_CLAUDE_PENDING_SUBAGENT_TOOLS,
  MAX_CLAUDE_PRIVATE_SHELL_TASKS,
  MAX_CLAUDE_REMEMBERED_SHELL_CALLS,
  MAX_CLAUDE_TERMINAL_SUBAGENT_TASKS,
  MAX_CLAUDE_TRACKED_SUBAGENT_STEPS,
} from "../../src/server/provider/claude-subagent-trace";
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

  it("retains an async Agent receipt until it migrates to an exact task", () => {
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
          id: "tool-async",
          name: "Agent",
          input: {
            subagent_type: "researcher",
            description: "Research in the background",
            model: "opus",
          },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-async",
          content: "Async agent launched successfully.",
        }],
      },
      tool_use_result: {
        status: "async_launched",
        agentId: "agent-async",
        agentType: "researcher",
        description: "Research in the background",
      },
    }));

    expect(tracker.hasLiveTasks()).toBe(true);
    expect(tracker.retainedStateCounts().pendingTasksByToolUse).toBe(1);
    expect(updates.at(-1)).toMatchObject({
      providerAgentId: "agent-async",
      status: "running",
      model: "opus",
    });

    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-async",
      tool_use_id: "tool-async",
      description: "Research in the background",
      subagent_type: "researcher",
      is_backgrounded: true,
    }));

    expect(tracker.retainedStateCounts().pendingTasksByToolUse).toBe(0);
    expect(tracker.isLiveTask("task-async")).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      providerTaskId: "task-async",
      providerAgentId: "agent-async",
      providerToolUseId: "tool-async",
      status: "spawned",
      isLive: true,
      model: "opus",
    });

    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-async",
      tool_use_id: "tool-async",
      status: "completed",
      summary: "Background research complete",
    }));

    expect(tracker.hasLiveTasks()).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      providerTaskId: "task-async",
      providerAgentId: "agent-async",
      status: "completed",
      isLive: false,
      result: "Background research complete",
    });
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

  it("traces an in-process teammate like the other agent task types", () => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => {
      updates.push(event);
    });
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "teammate-task",
      task_type: "in_process_teammate",
      description: "Review the migration",
    }));
    expect(updates).toEqual([
      expect.objectContaining({ providerTaskId: "teammate-task", status: "spawned" }),
    ]);
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
        usage: expect.objectContaining({ totalTokens: 10 }),
        toolUseCount: 1,
        durationMs: 5,
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

  it("surfaces delegated tool heartbeats and retry progress on the owned trace", () => {
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
          id: "tool-retrying-agent",
          name: "Agent",
          input: {
            subagent_type: "researcher",
            description: "Inspect provider behavior",
          },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-retrying-agent",
      tool_use_id: "tool-retrying-agent",
      description: "Inspect provider behavior",
      subagent_type: "researcher",
    }));
    tracker.observe(sdkMessage({
      type: "tool_progress",
      task_id: "task-retrying-agent",
      tool_use_id: "child-bash",
      tool_name: "Bash",
      parent_tool_use_id: "tool-retrying-agent",
      elapsed_time_seconds: 30,
    }));
    tracker.observe(sdkMessage({
      type: "tool_progress",
      task_id: "task-retrying-agent",
      tool_use_id: "child-bash",
      tool_name: "Bash",
      parent_tool_use_id: "tool-retrying-agent",
      elapsed_time_seconds: 60,
      subagent_retry: {
        agent_id: "agent-retrying",
        attempt: 2,
        max_retries: 3,
        retry_delay_ms: 1_000,
        error_status: 529,
        error_category: "overloaded",
      },
    }));

    expect(updates).toEqual([
      expect.objectContaining({
        providerTaskId: "task-retrying-agent",
        status: "spawned",
      }),
      expect.objectContaining({
        providerTaskId: "task-retrying-agent",
        status: "running",
        progress: "Bash · 30 seconds elapsed",
        activity: "Bash",
      }),
      expect.objectContaining({
        providerTaskId: "task-retrying-agent",
        status: "running",
        progress: "Retrying Bash · attempt 2/3 · in 1000 ms · after overloaded",
        activity: "Bash",
      }),
    ]);
  });

  it("reports structured task telemetry while running and final numbers at the end", () => {
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
          id: "tool-telemetry",
          name: "Agent",
          input: {
            subagent_type: "researcher",
            description: "Measure delegated work",
            model: "  haiku  ",
          },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-telemetry",
      tool_use_id: "tool-telemetry",
      description: "Measure delegated work",
      subagent_type: "researcher",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-telemetry",
      tool_use_id: "tool-telemetry",
      description: "Measure delegated work",
      usage: { total_tokens: 1_200, tool_uses: 2, duration_ms: 3_000 },
      last_tool_name: "Read",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-telemetry",
      tool_use_id: "tool-telemetry",
      description: "Measure delegated work",
      usage: { total_tokens: 2_400, tool_uses: 3, duration_ms: 4_500 },
      last_tool_name: "Read",
    }));
    tracker.observe(sdkMessage({
      type: "tool_progress",
      task_id: "task-telemetry",
      tool_use_id: "child-grep",
      tool_name: "Grep",
      parent_tool_use_id: "tool-telemetry",
      elapsed_time_seconds: 4,
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-telemetry",
      tool_use_id: "tool-telemetry",
      status: "completed",
      output_file: "/tmp/task-telemetry",
      summary: "Measured",
      usage: { total_tokens: 3_100, tool_uses: 4, duration_ms: 6_000 },
    }));

    const totalOnly = (totalTokens: number) => ({
      totalTokens,
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      contextTokens: null,
      maxContextTokens: null,
    });
    expect(updates).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: "spawned",
        model: "haiku",
      }),
      expect.objectContaining({
        sequence: 2,
        status: "running",
        model: "haiku",
        progress: "Read",
        activity: "Read",
        usage: totalOnly(1_200),
        toolUseCount: 2,
        durationMs: 3_000,
      }),
      expect.objectContaining({
        sequence: 3,
        status: "running",
        progress: "Read",
        activity: "Read",
        usage: totalOnly(2_400),
        toolUseCount: 3,
        durationMs: 4_500,
      }),
      expect.objectContaining({
        sequence: 4,
        status: "running",
        progress: "Grep · 4 seconds elapsed",
        activity: "Grep",
      }),
      expect.objectContaining({
        sequence: 5,
        status: "completed",
        isLive: false,
        model: "haiku",
        result: "Measured",
        usage: totalOnly(3_100),
        toolUseCount: 4,
        durationMs: 6_000,
      }),
    ]);
    expect(updates[0]).not.toHaveProperty("usage");
    expect(updates[0]).not.toHaveProperty("activity");
    expect(updates[3]).not.toHaveProperty("usage");
    expect(updates[3]).not.toHaveProperty("toolUseCount");
    expect(updates[4]).not.toHaveProperty("activity");
  });

  it("shows the provider's progress summary as the current activity instead of the last tool name", () => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => {
      updates.push(event);
    });
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-summary",
      tool_use_id: "tool-summary",
      description: "Review the provider adapters",
      subagent_type: "reviewer",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-summary",
      tool_use_id: "tool-summary",
      description: "Review the provider adapters",
      usage: { total_tokens: 900, tool_uses: 1, duration_ms: 2_000 },
      last_tool_name: "Grep",
      summary: "Reading the provider adapters",
    }));
    tracker.observe(sdkMessage({
      type: "tool_progress",
      task_id: "task-summary",
      tool_use_id: "child-read",
      tool_name: "Read",
      parent_tool_use_id: "tool-summary",
      elapsed_time_seconds: 2,
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-summary",
      tool_use_id: "tool-summary",
      description: "Review the provider adapters",
      usage: { total_tokens: 1_800, tool_uses: 2, duration_ms: 4_000 },
      last_tool_name: "Read",
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-summary",
      tool_use_id: "tool-summary",
      description: "Review the provider adapters",
      usage: { total_tokens: 2_700, tool_uses: 3, duration_ms: 6_000 },
      last_tool_name: "Edit",
      summary: `Comparing ${"adapter ".repeat(40)}`,
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-summary",
      tool_use_id: "tool-summary",
      description: "Review the provider adapters",
      usage: { total_tokens: 3_600, tool_uses: 4, duration_ms: 8_000 },
      last_tool_name: "Bash",
      summary: "   ",
    }));

    expect(updates.slice(1)).toEqual([
      expect.objectContaining({
        progress: "Reading the provider adapters",
        activity: "Reading the provider adapters",
      }),
      expect.objectContaining({
        progress: "Read · 2 seconds elapsed",
        activity: "Read",
      }),
      expect.objectContaining({
        progress: "Read",
        activity: "Read",
      }),
      expect.objectContaining({
        progress: `Comparing ${"adapter ".repeat(40)}`.trim(),
        activity: `Comparing ${"adapter ".repeat(40)}`.slice(0, 200),
      }),
      expect.objectContaining({
        activity: "Bash",
      }),
    ]);
  });

  it("ignores malformed, negative, fractional, and oversized task numbers", () => {
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
          id: "tool-malformed",
          name: "Task",
          input: {
            subagent_type: "reviewer",
            prompt: "Review malformed numbers",
            model: 42,
          },
        }],
      },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-malformed",
      tool_use_id: "tool-malformed",
      subagent_type: "reviewer",
    }));
    const malformedUsages: unknown[] = [
      { total_tokens: -1, tool_uses: -1, duration_ms: -1 },
      { total_tokens: 1.5, tool_uses: 0.5, duration_ms: 2.5 },
      { total_tokens: "10", tool_uses: "1", duration_ms: "5" },
      {
        total_tokens: Number.POSITIVE_INFINITY,
        tool_uses: Number.NaN,
        duration_ms: Number.MAX_VALUE,
      },
      {
        total_tokens: 1_000_000_000_001,
        tool_uses: 1_000_001,
        duration_ms: 31 * 24 * 60 * 60 * 1_000 + 1,
      },
      "not an object",
      [1, 2, 3],
      null,
    ];
    for (const usage of malformedUsages) {
      tracker.observe(sdkMessage({
        type: "system",
        subtype: "task_progress",
        task_id: "task-malformed",
        tool_use_id: "tool-malformed",
        usage,
        last_tool_name: 7,
      }));
    }
    tracker.observe(sdkMessage({
      type: "tool_progress",
      task_id: "task-malformed",
      tool_use_id: "child-tool",
      tool_name: "   ",
      parent_tool_use_id: "tool-malformed",
      elapsed_time_seconds: 1,
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-malformed",
      tool_use_id: "tool-malformed",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
      last_tool_name: "x".repeat(250),
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-malformed",
      status: "completed",
      usage: { total_tokens: -5, tool_uses: 1.25, duration_ms: "late" },
    }));

    const telemetryKeys = ["model", "activity", "usage", "toolUseCount", "durationMs"];
    const running = updates.slice(1, 1 + malformedUsages.length + 1);
    expect(running).toHaveLength(malformedUsages.length + 1);
    for (const update of [updates[0]!, ...running, updates.at(-1)!]) {
      for (const key of telemetryKeys) {
        expect(update).not.toHaveProperty(key);
      }
    }
    expect(updates.at(-2)).toMatchObject({
      progress: "x".repeat(250),
      activity: "x".repeat(200),
      usage: expect.objectContaining({ totalTokens: 0 }),
      toolUseCount: 0,
      durationMs: 0,
    });
    expect(updates.map((update) => update.sequence)).toEqual(
      updates.map((_, index) => index + 1),
    );
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

  it("reclaims tool, task, and ignored correlations across long sequential runs", () => {
    const tracker = new ClaudeSubagentTraceTracker(() => undefined);
    const sequentialTasks = MAX_CLAUDE_TERMINAL_SUBAGENT_TASKS * 3;
    for (let index = 0; index < sequentialTasks; index += 1) {
      tracker.observe(sdkMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{
            type: "tool_use",
            id: `sequential-tool-${index}`,
            name: "Agent",
            input: { subagent_type: "reviewer" },
          }],
        },
      }));
      tracker.observe(sdkMessage({
        type: "system",
        subtype: "task_started",
        task_id: `sequential-task-${index}`,
        tool_use_id: `sequential-tool-${index}`,
        subagent_type: "reviewer",
      }));
      tracker.observe(sdkMessage({
        type: "system",
        subtype: "task_notification",
        task_id: `sequential-task-${index}`,
        status: "completed",
      }));
    }
    for (let index = 0; index < MAX_CLAUDE_IGNORED_TASK_IDS * 2; index += 1) {
      tracker.observe(sdkMessage({
        type: "system",
        subtype: "task_started",
        task_id: `ignored-sequential-${index}`,
        task_type: "dream",
      }));
      tracker.observe(sdkMessage({
        type: "system",
        subtype: "task_notification",
        task_id: `ignored-sequential-${index}`,
        status: "completed",
      }));
    }
    for (let index = 0; index < MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS * 2; index += 1) {
      tracker.observe(sdkMessage({
        type: "system",
        subtype: "task_started",
        task_id: `shell-sequential-${index}`,
        task_type: "local_bash",
        is_backgrounded: index % 2 === 0,
      }));
      tracker.observe(sdkMessage({
        type: "system",
        subtype: "task_notification",
        task_id: `shell-sequential-${index}`,
        status: "completed",
      }));
    }

    expect(tracker.retainedStateCounts()).toEqual({
      tools: 0,
      tasks: MAX_CLAUDE_TERMINAL_SUBAGENT_TASKS,
      pendingTasksByToolUse: 0,
      taskByToolUse: 0,
      ignoredTaskIds: 0,
      shellCalls: 0,
      stepOwners: 0,
    });
    expect(tracker.hasLiveTasks()).toBe(false);
  });

  it("fails closed when unfinished delegated trace state is flooded", () => {
    const pendingTools = new ClaudeSubagentTraceTracker(() => undefined);
    const toolMessage = (index: number) => sdkMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: `pending-tool-${index}`,
          name: "Agent",
          input: { subagent_type: "reviewer", model: "m".repeat(10_000) },
        }],
      },
    });
    for (let index = 0; index < MAX_CLAUDE_PENDING_SUBAGENT_TOOLS; index += 1) {
      pendingTools.observe(toolMessage(index));
    }
    expect(() => pendingTools.observe(
      toolMessage(MAX_CLAUDE_PENDING_SUBAGENT_TOOLS),
    )).toThrow("bounded pending-subagent trace state");
    expect(pendingTools.retainedStateCounts().tools)
      .toBe(MAX_CLAUDE_PENDING_SUBAGENT_TOOLS);

    const liveTasks = new ClaudeSubagentTraceTracker(() => undefined);
    const taskStarted = (index: number) => sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: `live-task-${index}`,
      task_type: "local_agent",
    });
    for (let index = 0; index < MAX_CLAUDE_LIVE_SUBAGENT_TASKS; index += 1) {
      liveTasks.observe(taskStarted(index));
    }
    expect(() => liveTasks.observe(
      taskStarted(MAX_CLAUDE_LIVE_SUBAGENT_TASKS),
    )).toThrow("bounded live-subagent trace state");
    expect(liveTasks.retainedStateCounts().tasks)
      .toBe(MAX_CLAUDE_LIVE_SUBAGENT_TASKS);

    const ignoredTasks = new ClaudeSubagentTraceTracker(() => undefined);
    const ignoredStarted = (index: number) => sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: `ignored-task-${index}`,
      task_type: "dream",
    });
    for (let index = 0; index < MAX_CLAUDE_IGNORED_TASK_IDS; index += 1) {
      ignoredTasks.observe(ignoredStarted(index));
    }
    expect(() => ignoredTasks.observe(
      ignoredStarted(MAX_CLAUDE_IGNORED_TASK_IDS),
    )).toThrow("bounded ignored-task trace state");
    expect(ignoredTasks.retainedStateCounts().ignoredTaskIds)
      .toBe(MAX_CLAUDE_IGNORED_TASK_IDS);
  });

  it.each([
    ["the Agent tool input", { subagent_type: "fork", prompt: "Continue.", model: "haiku" }, "fork"],
    ["the task start", { prompt: "Continue.", model: "haiku" }, "fork"],
  ])("does not report a requested model for a fork named by %s", (_label, input, startedType) => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => updates.push(event));
    tracker.observe(sdkMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "tool-fork", name: "Agent", input }] },
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-fork",
      tool_use_id: "tool-fork",
      subagent_type: startedType,
    }));
    tracker.observe(sdkMessage({
      type: "system",
      subtype: "task_progress",
      task_id: "task-fork",
      tool_use_id: "tool-fork",
      usage: { total_tokens: 30, tool_uses: 1, duration_ms: 5 },
    }));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]).toMatchObject({ providerRole: "fork" });
    for (const update of updates) expect(update).not.toHaveProperty("model");
  });
});

describe("Claude delegated task shape", () => {
  type Update = Parameters<AgentHarnessEmitter["subagent"]>[0];
  function track() {
    const updates: Update[] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => updates.push(event));
    return { tracker, updates, observe: (value: unknown) => tracker.observe(sdkMessage(value)) };
  }
  const agentCall = (id: string, input: Record<string, unknown>, parent: string | null = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name: "Agent", input }] },
  });
  const started = (taskId: string, extra: Record<string, unknown> = {}) => ({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    ...extra,
  });
  const childFrame = (parent: string, blocks: unknown[], model?: unknown) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { ...(model === undefined ? {} : { model }), content: blocks },
  });
  const childResults = (parent: string, results: Array<{ id: string; error?: boolean; content?: string }>) => ({
    type: "user",
    parent_tool_use_id: parent,
    message: {
      content: results.map(({ id, error, content }) => ({
        type: "tool_result",
        tool_use_id: id,
        is_error: error === true,
        content: content ?? "secret output body",
      })),
    },
  });

  it("prefers the resolved model, then the subagent's own frame, then the requested alias", () => {
    const { observe, updates } = track();
    observe(agentCall("tool-model", { subagent_type: "general-purpose", description: "Check", model: "haiku", effort: "high", run_in_background: false }));
    observe(started("task-model", { tool_use_id: "tool-model", task_type: "local_agent", is_backgrounded: false }));
    expect(updates.at(-1)).toMatchObject({ model: "haiku", modelSource: "requested", effort: "high", background: false, taskKind: "agent" });
    observe(childFrame("tool-model", [{ type: "text", text: "Synthetic" }], "<synthetic>"));
    expect(updates.at(-1)).toMatchObject({ model: "haiku", modelSource: "requested" });
    observe(childFrame("tool-model", [{ type: "text", text: "Working" }], "claude-haiku-4-5"));
    expect(updates.at(-1)).toMatchObject({ status: "running", model: "claude-haiku-4-5", modelSource: "observed" });
    observe({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-model", content: "launched" }] },
      tool_use_result: {
        status: "async_launched",
        agentId: "agent-model",
        description: "Check",
        resolvedModel: "claude-sonnet-4-5",
        prompt: "Check",
        outputFile: "/private/tmp/agent-output.txt",
      },
    });
    expect(updates.at(-1)).toMatchObject({ model: "claude-sonnet-4-5", background: true, isLive: true });
    observe(childFrame("tool-model", [{ type: "text", text: "Later" }], "claude-opus-4-5"));
    observe({
      type: "system",
      subtype: "task_updated",
      task_id: "task-model",
      patch: { is_backgrounded: false },
    });
    expect(updates.at(-1)).toMatchObject({ model: "claude-sonnet-4-5", background: false });
    expect(JSON.stringify(updates)).not.toContain("agent-output");
  });

  it("falls back to the last model used and never reports an alias or effort Claude ignores for a fork", () => {
    const { observe, updates } = track();
    observe(agentCall("tool-fork", { subagent_type: "fork", prompt: "Continue", model: "haiku", effort: "max" }));
    observe(started("task-fork", { tool_use_id: "tool-fork", subagent_type: "fork" }));
    expect(updates.at(-1)).not.toHaveProperty("model");
    expect(updates.at(-1)).not.toHaveProperty("effort");
    observe(childFrame("tool-fork", [], "claude-opus-4-5"));
    expect(updates.at(-1)).toMatchObject({ model: "claude-opus-4-5" });
    observe({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-fork" }] },
      tool_use_result: {
        status: "completed",
        agentId: "agent-fork",
        content: [{ type: "text", text: "Done" }],
        modelsUsed: ["claude-opus-4-5", "claude-sonnet-4-5"],
        totalToolUseCount: 4,
        totalDurationMs: 1_200,
        totalTokens: 900,
      },
    });
    expect(updates.at(-1)).toMatchObject({
      status: "completed",
      model: "claude-sonnet-4-5",
      toolUseCount: 4,
      durationMs: 1_200,
      usage: expect.objectContaining({ totalTokens: 900 }),
    });
    for (const update of updates) expect(update).not.toHaveProperty("effort");
  });

  it("keeps a remote launch as a remote task without its session link or output", () => {
    const { tracker, observe, updates } = track();
    observe(agentCall("tool-remote", { description: "Review in the cloud", isolation: "remote" }));
    observe({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-remote", content: "https://claude.ai/code/session_secret" }] },
      tool_use_result: {
        status: "remote_launched",
        taskId: "remote-task-1",
        sessionUrl: "https://claude.ai/code/session_secret",
        content: "remote transcript body",
        local_file: "/Users/me/.claude/remote.txt",
        outputFile: "/Users/me/.claude/remote-output.txt",
        size_bytes: 10,
        updated_at: null,
        truncated: false,
      },
    });
    observe({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-unrelated" }] },
      tool_use_result: { status: "remote_launched", taskId: "forged-task" },
    });
    expect(updates).toEqual([expect.objectContaining({
      providerTaskId: "remote-task-1",
      providerToolUseId: "tool-remote",
      providerStatus: "remote_launched",
      status: "running",
      isLive: true,
      taskKind: "remote",
      background: true,
      description: "Review in the cloud",
    })]);
    const serialized = JSON.stringify(updates);
    for (const leaked of ["session_secret", "remote transcript body", "remote.txt", "remote-output"]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(tracker.hasLiveTasks()).toBe(false);
    expect(tracker.isLiveTask("remote-task-1")).toBe(true);
  });

  it.each([
    ["remote_launched", ["launched"]],
    ["task_started", ["started"]],
    ["task_started without a task type", ["untyped"]],
    ["task_progress", ["progress"]],
    ["task_started, then remote_launched", ["started", "launched"]],
    ["remote_launched, then task_started", ["launched", "started"]],
  ] as const)("never lets a remote agent hold the turn when Claude reports it by %s", (_label, edges) => {
    const { tracker, observe, updates } = track();
    observe(agentCall("tool-cloud", { description: "Review in the cloud", isolation: "remote" }));
    for (const edge of edges) {
      if (edge === "launched") {
        observe({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "tool-cloud" }] },
          tool_use_result: { status: "remote_launched", taskId: "cloud-task" },
        });
      } else if (edge === "progress") {
        observe({ type: "system", subtype: "task_progress", task_id: "cloud-task", tool_use_id: "tool-cloud", summary: "Cloning" });
      } else {
        observe(started("cloud-task", {
          tool_use_id: "tool-cloud",
          ...(edge === "started" ? { task_type: "remote_agent" } : {}),
        }));
      }
      expect(tracker.hasLiveTasks()).toBe(false);
    }
    expect(updates.at(-1)).toMatchObject({
      providerTaskId: "cloud-task",
      taskKind: "remote",
      background: true,
      isLive: true,
    });
    expect(tracker.isLiveTask("cloud-task")).toBe(true);
    observe(agentCall("tool-local", { subagent_type: "general-purpose", description: "Local check" }));
    observe(started("local-task", { tool_use_id: "tool-local", task_type: "local_agent" }));
    expect(tracker.hasLiveTasks()).toBe(true);
  });

  it("shows background shells with their command and never waits on them", () => {
    const { tracker, observe, updates } = track();
    observe({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: "bash-1",
          name: "Bash",
          input: { command: "npm run dev", description: "Start the dev server", run_in_background: true },
        }],
      },
    });
    observe(started("shell-1", { tool_use_id: "bash-1", task_type: "local_bash", description: "Start the dev server", is_backgrounded: true }));
    expect(updates.at(-1)).toMatchObject({
      providerTaskId: "shell-1",
      providerToolUseId: "bash-1",
      taskKind: "shell",
      command: "npm run dev",
      background: true,
      description: "Start the dev server",
      status: "spawned",
      isLive: true,
    });
    expect(tracker.hasLiveTasks()).toBe(false);
    expect(tracker.isLiveTask("shell-1")).toBe(true);
    observe({
      type: "system",
      subtype: "task_notification",
      task_id: "shell-1",
      status: "failed",
      output_file: "/private/tmp/shell-1.log",
      summary: "Background command failed with exit code 1",
    });
    expect(updates.at(-1)).toMatchObject({
      status: "failed",
      isLive: false,
      result: "Background command failed with exit code 1",
      command: "npm run dev",
    });
    expect(JSON.stringify(updates)).not.toContain("shell-1.log");
    expect(tracker.isLiveTask("shell-1")).toBe(false);
  });

  it("keeps foreground shells private until Claude moves them to the background", () => {
    const { tracker, observe, updates } = track();
    observe({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "ps-1", name: "PowerShell", input: { command: "npm test\nnpm run lint" } }] },
    });
    observe(started("shell-fg", { tool_use_id: "ps-1", task_type: "local_bash", description: "Run tests", is_backgrounded: false }));
    observe(started("shell-quick", { task_type: "local_bash", description: "Quick" }));
    observe({ type: "system", subtype: "task_notification", task_id: "shell-quick", status: "completed", summary: "ok" });
    expect(updates).toEqual([]);
    expect(tracker.isLiveTask("shell-fg")).toBe(false);
    observe({ type: "system", subtype: "task_updated", task_id: "shell-fg", patch: { is_backgrounded: true } });
    expect(updates).toEqual([expect.objectContaining({
      providerTaskId: "shell-fg",
      status: "running",
      background: true,
      command: "npm test\nnpm run lint",
      taskKind: "shell",
    })]);
    observe({ type: "system", subtype: "task_updated", task_id: "shell-fg", patch: { status: "killed" } });
    expect(updates.at(-1)).toMatchObject({ status: "cancelled", isLive: false, providerStatus: "killed" });
  });

  it("maps each Claude task type to its kind and still ignores ambient, hidden and unknown work", () => {
    const { tracker, observe, updates } = track();
    observe(started("monitor-1", { task_type: "monitor", description: "Watch the build" }));
    observe(started("mcp-1", { task_type: "mcp_task", description: "Index docs", is_backgrounded: true }));
    observe(started("workflow-1", { task_type: "local_workflow", workflow_name: "spec" }));
    observe(started("remote-1", { task_type: "remote_agent", description: "Remote review" }));
    observe(started("ambient-1", { task_type: "monitor", ambient: true }));
    observe(started("hidden-1", { task_type: "local_agent", skip_transcript: true }));
    observe(started("unknown-1", { task_type: "dream" }));
    expect(updates.map(({ providerTaskId, taskKind }) => [providerTaskId, taskKind])).toEqual([
      ["monitor-1", "monitor"],
      ["mcp-1", "mcp"],
      ["workflow-1", "workflow"],
      ["remote-1", "remote"],
    ]);
    expect(updates[1]).toMatchObject({ background: true });
    expect(tracker.retainedStateCounts().ignoredTaskIds).toBe(3);
    observe({ type: "system", subtype: "task_notification", task_id: "workflow-1", status: "completed" });
    observe({ type: "system", subtype: "task_notification", task_id: "remote-1", status: "completed" });
    expect(tracker.hasLiveTasks()).toBe(false);
  });

  it("turns forwarded subagent tool calls into the eight most recent steps without contents or output", () => {
    const { observe, updates } = track();
    observe(agentCall("tool-steps", { subagent_type: "general-purpose", description: "Explore" }));
    observe(started("task-steps", { tool_use_id: "tool-steps", task_type: "local_agent" }));
    observe(childFrame("tool-steps", [
      { type: "tool_use", id: "s1", name: "Read", input: { file_path: "/repo/src/a.ts" } },
      { type: "tool_use", id: "s2", name: "Write", input: { file_path: "/repo/src/b.ts", content: "SECRET FILE CONTENTS" } },
      { type: "tool_use", id: "s3", name: "Edit", input: { file_path: "/repo/src/c.ts", old_string: "OLD BODY", new_string: "NEW BODY" } },
      { type: "tool_use", id: "s4", name: "Grep", input: { pattern: "TODO", path: "/repo" } },
      { type: "tool_use", id: "s5", name: "Glob", input: { pattern: "**/*.ts" } },
    ]));
    expect(updates.at(-1)).toMatchObject({ status: "running", activity: "Glob · **/*.ts" });
    observe(childResults("tool-steps", [{ id: "s1" }, { id: "s2", error: true }]));
    observe(childFrame("tool-steps", [
      { type: "tool_use", id: "s6", name: "Bash", input: { command: "npm test -- --run\nrm -rf /tmp/x" } },
      { type: "tool_use", id: "s7", name: "WebFetch", input: { url: "https://example.com/docs", prompt: "Summarise" } },
      { type: "tool_use", id: "s8", name: "mcp__docs__search", input: { query: "subagents" } },
      { type: "tool_use", id: "s9", name: "TodoWrite", input: { todos: [{ content: "private plan" }] } },
      { type: "tool_use", id: "s10", name: "Read", input: { file_path: "/repo/README.md" } },
    ]));
    observe(childResults("tool-steps", [{ id: "s6" }, { id: "s10", error: true }, { id: "unknown-step" }]));
    const steps = updates.at(-1)?.steps;
    expect(steps).toEqual([
      { label: "Edit · /repo/src/c.ts", status: "running" },
      { label: "Grep · TODO", status: "running" },
      { label: "Glob · **/*.ts", status: "running" },
      { label: "Bash · npm test -- --run", status: "completed" },
      { label: "WebFetch · https://example.com/docs", status: "running" },
      { label: "mcp__docs__search · subagents", status: "running" },
      { label: "TodoWrite", status: "running" },
      { label: "Read · /repo/README.md", status: "failed" },
    ]);
    const serialized = JSON.stringify(updates);
    for (const leaked of ["SECRET FILE CONTENTS", "OLD BODY", "NEW BODY", "rm -rf", "private plan", "secret output body", "Summarise"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("ignores malformed provider input instead of inventing tasks, steps or models", () => {
    const { tracker, observe, updates } = track();
    observe(agentCall("tool-bad", { subagent_type: 7, model: 12, effort: "extreme", run_in_background: "yes", isolation: "cloud" }));
    observe(started("task-bad", { tool_use_id: "tool-bad" }));
    expect(updates.at(-1)).toMatchObject({ taskKind: "agent", providerRole: null });
    for (const key of ["model", "effort", "background"]) expect(updates.at(-1)).not.toHaveProperty(key);
    const count = updates.length;
    observe(childFrame("tool-unknown", [{ type: "tool_use", id: "x1", name: "Read", input: { file_path: "/a" } }], "claude-x"));
    observe(childFrame("tool-bad", [
      { type: "tool_use", name: "Read", input: {} },
      { type: "tool_use", id: "x2", name: 42, input: {} },
      { type: "tool_use", id: "x3", name: "Read", input: "not an object" },
    ], { name: "not a string" }));
    expect(updates.at(-1)?.steps).toEqual([{ label: "Read", status: "running" }]);
    expect(updates.length).toBe(count + 1);
    observe({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-bad" }] },
      tool_use_result: { status: "completed", agentId: "agent-bad", resolvedModel: { id: "x" }, modelsUsed: "claude-y", content: "not blocks" },
    });
    expect(updates.at(-1)).toMatchObject({ status: "completed", result: null });
    expect(updates.at(-1)).not.toHaveProperty("model");
    expect(tracker.hasLiveTasks()).toBe(false);
  });

  it("bounds remembered shell calls and step owners without failing the turn", () => {
    const { tracker, observe } = track();
    for (let index = 0; index < MAX_CLAUDE_REMEMBERED_SHELL_CALLS + 50; index += 1) {
      observe({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: `bash-${index}`, name: "Bash", input: { command: `echo ${index}` } }] },
      });
    }
    expect(tracker.retainedStateCounts().shellCalls).toBe(MAX_CLAUDE_REMEMBERED_SHELL_CALLS);
    observe(agentCall("tool-many", { subagent_type: "general-purpose" }));
    observe(started("task-many", { tool_use_id: "tool-many", task_type: "local_agent" }));
    for (let index = 0; index < MAX_CLAUDE_TRACKED_SUBAGENT_STEPS + 20; index += 1) {
      observe(childFrame("tool-many", [{ type: "tool_use", id: `step-${index}`, name: "Read", input: { file_path: `/f${index}` } }]));
    }
    expect(tracker.retainedStateCounts().stepOwners).toBe(MAX_CLAUDE_TRACKED_SUBAGENT_STEPS);
  });

  it("settles the steps of a background agent that Claude has not given a task id yet", () => {
    const { observe, updates } = track();
    observe(agentCall("tool-async", { subagent_type: "general-purpose", description: "Survey" }));
    observe({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-async" }] },
      tool_use_result: { status: "async_launched", agentId: "agent-async", description: "Survey", prompt: "Survey" },
    });
    observe(childFrame("tool-async", [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "/r/a.ts" } }], "claude-haiku-4-5"));
    expect(updates.at(-1)).toMatchObject({ providerTaskId: null, providerAgentId: "agent-async", steps: [{ label: "Read · /r/a.ts", status: "running" }] });
    observe(childResults("tool-async", [{ id: "s1" }]));
    expect(updates.at(-1)).toMatchObject({ isLive: true, steps: [{ label: "Read · /r/a.ts", status: "completed" }] });
    observe(childFrame("tool-async", [{ type: "tool_use", id: "s2", name: "Grep", input: { pattern: "TODO" } }]));
    observe(started("task-async", { tool_use_id: "tool-async", task_type: "local_agent", is_backgrounded: true }));
    observe(childResults("tool-async", [{ id: "s2", error: true }]));
    expect(updates.at(-1)).toMatchObject({
      providerTaskId: "task-async",
      steps: [{ label: "Read · /r/a.ts", status: "completed" }, { label: "Grep · TODO", status: "failed" }],
    });
  });

  it("releases finished foreground shells so a later background dev server still shows", () => {
    const { tracker, observe, updates } = track();
    for (let index = 0; index < MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS; index += 1) {
      observe({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: `bash-${index}`, name: "Bash", input: { command: `npm test ${index}` } }] },
      });
      observe(started(`fg-${index}`, { tool_use_id: `bash-${index}`, task_type: "local_bash", is_backgrounded: false }));
      observe({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: `bash-${index}`, content: "ok" }] },
        tool_use_result: { stdout: "ok", stderr: "", interrupted: false },
      });
    }
    expect(updates).toEqual([]);
    expect(tracker.retainedStateCounts()).toMatchObject({ tasks: 0, taskByToolUse: 0, shellCalls: 0 });
    observe({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "bash-dev", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] },
    });
    observe(started("dev-task", { tool_use_id: "bash-dev", task_type: "local_bash", is_backgrounded: true, description: "Dev server" }));
    expect(updates).toEqual([expect.objectContaining({
      providerTaskId: "dev-task", taskKind: "shell", isLive: true, background: true, command: "npm run dev",
    })]);
  });

  it("shows a foreground shell that Claude backgrounded on its way to the tool result", () => {
    const { tracker, observe, updates } = track();
    observe({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "bash-slow", name: "Bash", input: { command: "npm run build" } }] },
    });
    observe(started("slow-task", { tool_use_id: "bash-slow", task_type: "local_bash", is_backgrounded: false }));
    observe({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "bash-slow", content: "moved" }] },
      tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "slow-task", timedOutAfterMs: 120_000 },
    });
    expect(updates).toEqual([expect.objectContaining({
      providerTaskId: "slow-task", status: "running", background: true, command: "npm run build",
    })]);
    expect(tracker.isLiveTask("slow-task")).toBe(true);
  });

  it("never counts private foreground shells toward shown commands and forgets the oldest past their own bound", () => {
    const { tracker, observe, updates } = track();
    for (let index = 0; index < MAX_CLAUDE_PRIVATE_SHELL_TASKS + 10; index += 1) {
      observe(started(`private-${index}`, { tool_use_id: `bash-${index}`, task_type: "local_bash", is_backgrounded: false }));
    }
    expect(tracker.retainedStateCounts().tasks).toBe(MAX_CLAUDE_PRIVATE_SHELL_TASKS);
    for (let index = 0; index < MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS; index += 1) {
      observe(started(`shown-${index}`, { task_type: "local_bash", is_backgrounded: true }));
    }
    expect(updates).toHaveLength(MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS);
    observe({ type: "system", subtype: "task_updated", task_id: `private-${MAX_CLAUDE_PRIVATE_SHELL_TASKS}`, patch: { is_backgrounded: true } });
    expect(updates).toHaveLength(MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS);
    expect(tracker.retainedStateCounts().tasks).toBe(MAX_CLAUDE_PRIVATE_SHELL_TASKS - 1 + MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS);
    observe({ type: "system", subtype: "task_notification", task_id: "shown-0", status: "completed" });
    observe({ type: "system", subtype: "task_updated", task_id: `private-${MAX_CLAUDE_PRIVATE_SHELL_TASKS + 1}`, patch: { is_backgrounded: true } });
    expect(updates.at(-1)).toMatchObject({ providerTaskId: `private-${MAX_CLAUDE_PRIVATE_SHELL_TASKS + 1}`, background: true });
  });

  it("drops background commands past their cap while agents keep their fail-closed bound", () => {
    const { tracker, observe, updates } = track();
    for (let index = 0; index < MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS; index += 1) {
      observe(started(`shell-${index}`, { task_type: "local_bash", is_backgrounded: true }));
    }
    expect(updates).toHaveLength(MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS);
    expect(() => observe(started("shell-overflow", { task_type: "local_bash", is_backgrounded: true }))).not.toThrow();
    expect(() => observe(started("monitor-overflow", { task_type: "monitor" }))).not.toThrow();
    expect(updates).toHaveLength(MAX_CLAUDE_LIVE_BACKGROUND_COMMANDS);
    expect(tracker.isLiveTask("shell-overflow")).toBe(false);
    observe(started("agent-after", { task_type: "local_agent" }));
    expect(updates.at(-1)).toMatchObject({ providerTaskId: "agent-after", taskKind: "agent" });
    expect(tracker.hasLiveTasks()).toBe(true);
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
