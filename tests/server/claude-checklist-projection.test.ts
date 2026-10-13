// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { MAX_AGENT_PLAN_STEPS } from "../../src/shared/agent-plan";
import {
  createAgentHarnessEmitter,
  type AgentHarnessEvent,
} from "../../src/server/provider/agent-harness";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { ClaudeMessageProjector } from "../../src/server/provider/claude-message-projector";
import { ClaudeUsageLedger } from "../../src/server/provider/claude-usage";
import { CappedProviderBuffer } from "../../src/server/provider/io";
import type { AgentPlanStep } from "../../src/server/provider/interactions";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

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

function todos(...items: Array<[string, string]>) {
  return items.map(([content, status]) => ({ content, status, activeForm: content }));
}

function todoWrite(id: string, items: unknown) {
  return [toolUse("TodoWrite", id, { todos: items }), toolResult(id, { oldTodos: [], newTodos: items })] as const;
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

    const [first, firstResult] = todoWrite("todo-1", todos(
      ["Inspect the adapter", "completed"],
      ["Write the projection", "in_progress"],
      ["Run the tests", "pending"],
    ));
    claude.observe(first);
    claude.observe({ ...first, uuid: "assistant-repeat" });
    expect(claude.plans()).toEqual([]);
    claude.observe(firstResult);
    claude.observe({ ...firstResult, uuid: "user-repeat" });
    for (const message of todoWrite("todo-2", todos(
      ["Inspect the adapter", "completed"],
      ["Write the projection", "completed"],
      ["Run the tests", "in_progress"],
    ))) claude.observe(message);

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

  it("does not update the plan from a TodoWrite call that failed or has no structured result", () => {
    const claude = projector();
    claude.observe(toolUse("TodoWrite", "todo-failed", { todos: todos(["Inspect", "completed"]) }));
    claude.observe(toolResult("todo-failed", { oldTodos: [], newTodos: todos(["Inspect", "completed"]) }, true));
    claude.observe(toolUse("TodoWrite", "todo-text", { todos: todos(["Inspect", "completed"]) }));
    claude.observe(toolResult("todo-text", "<tool_use_error>InputValidationError</tool_use_error>"));
    claude.observe(toolUse("TodoWrite", "todo-pending", { todos: todos(["Inspect", "completed"]) }));
    expect(claude.plans()).toEqual([]);
  });

  it("ignores malformed TodoWrite results and keeps only well-formed items", () => {
    const claude = projector();
    for (const [id, items] of [
      ["todo-bad-1", "Inspect"],
      ["todo-bad-2", null],
      ["todo-bad-3", [{ content: 4, status: "pending" }, { content: "Ship", status: "shipped" }]],
    ] as const) for (const message of todoWrite(id, items)) claude.observe(message);
    expect(claude.plans()).toEqual([]);

    for (const message of todoWrite("todo-mixed", [null, { content: "  ", status: "pending" }, { content: "Ship", status: "pending" }])) {
      claude.observe(message);
    }
    for (const message of todoWrite("todo-clear", [])) claude.observe(message);
    expect(claude.plans()).toEqual([
      { explanation: null, steps: [{ step: "Ship", status: "pending" }] },
      { explanation: null, steps: [] },
    ]);
  });

  it("bounds the number of steps and the length of each step", () => {
    const claude = projector();
    for (const message of todoWrite("todo-large", Array.from({ length: 150 }, (_, index) => ({
      content: index === 0 ? "x".repeat(5_000) : `Step ${index}`,
      status: "pending",
      activeForm: `Doing ${index}`,
    })))) claude.observe(message);
    const [plan] = claude.plans();
    expect(plan?.steps).toHaveLength(MAX_AGENT_PLAN_STEPS);
    expect(plan?.steps[0]?.step).toHaveLength(1_000);
    expect(plan?.steps.at(-1)).toEqual({ step: `Step ${MAX_AGENT_PLAN_STEPS - 1}`, status: "pending" });
  });

  it("reads only the bounded prefix of an oversized malformed checklist", () => {
    const claude = projector();
    const read = (length: number, valid: (index: number) => unknown) => {
      let highest = -1;
      const items = new Proxy(Array.from({ length }, (_, index) => valid(index)), {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) highest = Math.max(highest, Number(key));
          return Reflect.get(target, key, receiver);
        },
      });
      return { items, highest: () => highest };
    };
    const malformedThenValid = (index: number) => index < MAX_AGENT_PLAN_STEPS
      ? { content: 7, status: "pending" }
      : { content: `Step ${index}`, status: "pending", activeForm: "Doing" };
    const todoItems = read(100_000, malformedThenValid);
    for (const message of todoWrite("todo-oversized", todoItems.items)) claude.observe(message);
    const taskItems = read(100_000, (index) => index < MAX_AGENT_PLAN_STEPS
      ? { id: String(index), subject: 7, status: "pending" }
      : { id: String(index), subject: `Task ${index}`, status: "pending" });
    claude.observe(toolUse("TaskList", "list-oversized", {}));
    claude.observe(toolResult("list-oversized", { tasks: taskItems.items }));

    expect(claude.plans()).toEqual([]);
    expect(todoItems.highest()).toBeLessThan(MAX_AGENT_PLAN_STEPS);
    expect(taskItems.highest()).toBeLessThan(MAX_AGENT_PLAN_STEPS);
  });

  it("does not attribute one structured result to several tool results in the same message", () => {
    const claude = projector();
    claude.observe(toolUse("TaskCreate", "create-a", { subject: "Inspect", description: "Inspect" }));
    claude.observe(toolUse("TaskCreate", "create-b", { subject: "Verify", description: "Verify" }));
    const combined = toolResult("create-a", { task: { id: "1", subject: "Inspect" } });
    claude.observe({
      ...combined,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "create-a", content: "ok" },
          { type: "tool_result", tool_use_id: "create-b", content: "ok" },
        ],
      },
    });
    expect(claude.plans()).toEqual([]);
  });

  it("does not let a subagent's checklist replace the run's plan", () => {
    const claude = projector();
    const items = todos(["Child work", "in_progress"]);
    claude.observe(toolUse("TodoWrite", "child-todo", { todos: items }, "parent-agent"));
    claude.observe({ ...toolResult("child-todo", { oldTodos: [], newTodos: items }), parent_tool_use_id: "parent-agent" });
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

  describe("across runs of one Claude session", () => {
    const roots: string[] = [];
    afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

    it("applies a TaskUpdate to a task created in an earlier run", async () => {
      const root = portableFixtureRoot("Claude checklist across runs");
      roots.push(root);
      const runs: SDKMessage[][] = [
        [
          toolUse("TaskCreate", "create-1", { subject: "Inspect", description: "Inspect" }),
          toolResult("create-1", { task: { id: "1", subject: "Inspect" } }),
          toolUse("TaskCreate", "create-2", { subject: "Verify", description: "Verify" }),
          toolResult("create-2", { task: { id: "2", subject: "Verify" } }),
        ] as unknown as SDKMessage[],
        [
          toolUse("TaskUpdate", "update-1", { taskId: "1", status: "completed" }),
          toolResult("update-1", { success: true, taskId: "1", updatedFields: ["status"] }),
        ] as unknown as SDKMessage[],
      ];
      let started = 0;
      const harness = createClaudeAgentSdkHarness({
        createQuery: () => {
          const messages = runs[started++]!;
          return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("init");
            yield* messages;
            yield claudeSuccessResult("Done", "completed");
          })());
        },
      });
      const manager = ProviderManager.createForTests(
        { commands: { claude: process.execPath } },
        new AgentHarnessRegistry([harness]),
      );
      const plans: AgentPlanStep[][] = [];
      const run = (index: number, sessionId?: string) => manager.run(nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-checklist-across-runs",
        cwd: root,
        prompt: `Run ${index}`,
        interactionMode: "build",
        access: "supervised",
        ...(sessionId ? { sessionId } : {}),
      }), { onPlan: ({ steps }) => plans.push(steps) });

      await expect(run(1)).resolves.toMatchObject({ status: "completed", sessionId: CLAUDE_PROTOCOL_SESSION_ID });
      await expect(run(2, CLAUDE_PROTOCOL_SESSION_ID)).resolves.toMatchObject({ status: "completed" });

      expect(plans.at(-1)).toEqual([
        { step: "Inspect", status: "completed" },
        { step: "Verify", status: "pending" },
      ]);
    });
  });
});
