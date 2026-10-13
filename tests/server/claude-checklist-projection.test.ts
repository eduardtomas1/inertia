// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { MAX_AGENT_PLAN_STEPS } from "../../src/shared/agent-plan";
import {
  createAgentHarnessEmitter,
  type AgentHarnessEvent,
} from "../../src/server/provider/agent-harness";
import { ClaudeMessageProjector } from "../../src/server/provider/claude-message-projector";
import { ClaudeUsageLedger } from "../../src/server/provider/claude-usage";
import { CappedProviderBuffer } from "../../src/server/provider/io";
import type { AgentPlanStep } from "../../src/server/provider/interactions";
import { CLAUDE_PROTOCOL_SESSION_ID } from "../helpers/claude-agent-sdk-protocol";

function projector(): { observe: (message: unknown) => void; plans: () => Array<{ explanation: string | null; steps: AgentPlanStep[] }> } {
  const events: AgentHarnessEvent[] = [];
  const instance = new ClaudeMessageProjector({
    emitter: createAgentHarnessEmitter(
      "claude",
      "checklist-projector",
      { onEvent: (event) => events.push(event) },
      "checklist-run",
      "checklist-turn",
    ),
    text: new CappedProviderBuffer(8 * 1024 * 1024),
    usesNativeAnthropic: false,
    usage: new ClaudeUsageLedger(false),
    contextUsage: () => undefined,
    acceptContextUsage: () => undefined,
    refreshContextUsage: () => undefined,
  });
  return {
    observe: (message) => instance.observe(message as SDKMessage, false),
    plans: () => events.flatMap((event) =>
      event.type === "extension" && event.event.type === "plan"
        ? [{ explanation: event.event.explanation, steps: event.event.steps }]
        : []),
  };
}

let sequence = 0;

function toolUse(name: string, id: string, input: unknown, parentToolUseId: string | null = null) {
  sequence += 1;
  return {
    type: "assistant",
    uuid: `assistant-${sequence}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    message: {
      id: `api-${sequence}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

function toolResult(id: string, structured: unknown, isError = false) {
  sequence += 1;
  return {
    type: "user",
    uuid: `user-${sequence}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...(isError ? { is_error: true } : {}) }],
    },
    tool_use_result: structured,
  };
}

describe("Claude checklist projection", () => {
  it("reflects each TodoWrite list as the run's plan steps", () => {
    const claude = projector();
    claude.observe({
      type: "stream_event",
      uuid: "todo-stream",
      session_id: CLAUDE_PROTOCOL_SESSION_ID,
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "todo-1", name: "TodoWrite", input: {} },
      },
    });
    expect(claude.plans()).toEqual([]);

    const first = toolUse("TodoWrite", "todo-1", {
      todos: [
        { content: "Inspect the adapter", status: "completed", activeForm: "Inspecting the adapter" },
        { content: "Write the projection", status: "in_progress", activeForm: "Writing the projection" },
        { content: "Run the tests", status: "pending", activeForm: "Running the tests" },
      ],
    });
    claude.observe(first);
    claude.observe({ ...first, uuid: "assistant-repeat" });
    claude.observe(toolUse("TodoWrite", "todo-2", {
      todos: [
        { content: "Inspect the adapter", status: "completed", activeForm: "Inspecting the adapter" },
        { content: "Write the projection", status: "completed", activeForm: "Writing the projection" },
        { content: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
      ],
    }));

    expect(claude.plans()).toEqual([
      {
        explanation: null,
        steps: [
          { step: "Inspect the adapter", status: "completed" },
          { step: "Write the projection", status: "inProgress" },
          { step: "Run the tests", status: "pending" },
        ],
      },
      {
        explanation: null,
        steps: [
          { step: "Inspect the adapter", status: "completed" },
          { step: "Write the projection", status: "completed" },
          { step: "Run the tests", status: "inProgress" },
        ],
      },
    ]);
  });

  it("ignores malformed TodoWrite input and keeps only well-formed items", () => {
    const claude = projector();
    claude.observe(toolUse("TodoWrite", "todo-bad-1", { todos: "Inspect" }));
    claude.observe(toolUse("TodoWrite", "todo-bad-2", null));
    claude.observe(toolUse("TodoWrite", "todo-bad-3", { todos: [{ content: 4, status: "pending" }, { content: "Ship", status: "shipped" }] }));
    expect(claude.plans()).toEqual([]);

    claude.observe(toolUse("TodoWrite", "todo-mixed", {
      todos: [null, { content: "  ", status: "pending" }, { content: "Ship", status: "pending" }],
    }));
    claude.observe(toolUse("TodoWrite", "todo-clear", { todos: [] }));
    expect(claude.plans()).toEqual([
      { explanation: null, steps: [{ step: "Ship", status: "pending" }] },
      { explanation: null, steps: [] },
    ]);
  });

  it("bounds the number of steps and the length of each step", () => {
    const claude = projector();
    claude.observe(toolUse("TodoWrite", "todo-large", {
      todos: Array.from({ length: 150 }, (_, index) => ({
        content: index === 0 ? "x".repeat(5_000) : `Step ${index}`,
        status: "pending",
        activeForm: `Doing ${index}`,
      })),
    }));
    const [plan] = claude.plans();
    expect(plan?.steps).toHaveLength(MAX_AGENT_PLAN_STEPS);
    expect(plan?.steps[0]?.step).toHaveLength(1_000);
    expect(plan?.steps.at(-1)).toEqual({ step: `Step ${MAX_AGENT_PLAN_STEPS - 1}`, status: "pending" });
  });

  it("does not let a subagent's checklist replace the run's plan", () => {
    const claude = projector();
    claude.observe(toolUse("TodoWrite", "child-todo", {
      todos: [{ content: "Child work", status: "in_progress", activeForm: "Working" }],
    }, "parent-agent"));
    expect(claude.plans()).toEqual([]);
  });

  it("reflects TaskCreate and TaskUpdate results as the run's plan steps", () => {
    const claude = projector();
    for (const [index, subject] of ["Inspect", "Implement", "Verify"].entries()) {
      claude.observe(toolUse("TaskCreate", `create-${index}`, { subject, description: `${subject} the change` }));
      claude.observe(toolResult(`create-${index}`, { task: { id: String(index + 1), subject } }));
    }
    claude.observe(toolUse("TaskUpdate", "update-1", { taskId: "1", status: "completed" }));
    claude.observe(toolResult("update-1", { success: true, taskId: "1", updatedFields: ["status"] }));
    claude.observe(toolUse("TaskUpdate", "update-2", { taskId: "2", status: "in_progress" }));
    claude.observe(toolResult("update-2", { success: true, taskId: "2", updatedFields: ["status"] }));

    expect(claude.plans().at(-1)).toEqual({
      explanation: null,
      steps: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
        { step: "Verify", status: "pending" },
      ],
    });
    expect(claude.plans()).toHaveLength(5);

    claude.observe(toolUse("TaskUpdate", "update-failed", { taskId: "3", status: "completed" }));
    claude.observe(toolResult("update-failed", { success: false, taskId: "3", updatedFields: [], error: "Task not found" }));
    claude.observe(toolUse("TaskUpdate", "update-error", { taskId: "3", status: "completed" }));
    claude.observe(toolResult("update-error", "Task not found", true));
    claude.observe(toolUse("TaskUpdate", "update-unknown", { taskId: "9", status: "completed" }));
    claude.observe(toolResult("update-unknown", { success: true, taskId: "9", updatedFields: ["status"] }));
    expect(claude.plans()).toHaveLength(5);

    claude.observe(toolUse("TaskUpdate", "update-delete", { taskId: "3", status: "deleted" }));
    claude.observe(toolResult("update-delete", { success: true, taskId: "3", updatedFields: ["status"] }));
    expect(claude.plans().at(-1)?.steps).toEqual([
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "inProgress" },
    ]);
  });

  it("takes the whole list from a TaskList result", () => {
    const claude = projector();
    claude.observe(toolUse("TaskList", "list-1", {}));
    claude.observe(toolResult("list-1", {
      tasks: [
        { id: "1", subject: "Inspect", status: "completed", blockedBy: [] },
        { id: "2", subject: "Implement", status: "in_progress", blockedBy: [] },
        { id: "3", subject: 7, status: "pending", blockedBy: [] },
      ],
    }));
    claude.observe(toolUse("TaskUpdate", "update-2", { taskId: "2", status: "completed" }));
    claude.observe(toolResult("update-2", { success: true, taskId: "2", updatedFields: ["status"] }));

    expect(claude.plans()).toEqual([
      {
        explanation: null,
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "inProgress" },
        ],
      },
      {
        explanation: null,
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "completed" },
        ],
      },
    ]);
  });

  it("ignores task results without the structured output", () => {
    const claude = projector();
    claude.observe(toolUse("TaskCreate", "create-text", { subject: "Inspect", description: "Inspect" }));
    claude.observe(toolResult("create-text", undefined));
    claude.observe(toolUse("TaskCreate", "create-bad", { subject: "Inspect", description: "Inspect" }));
    claude.observe(toolResult("create-bad", { task: { id: 1 } }));
    claude.observe(toolUse("TaskList", "list-bad", {}));
    claude.observe(toolResult("list-bad", { tasks: "none" }));
    expect(claude.plans()).toEqual([]);
  });
});
