// @inertia-test-suite portable
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import type { ProviderSubagentEvent } from "../../src/server/provider/contracts";
import type { SubagentBackgroundResult } from "../../src/server/provider/agent-harness";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeBackgroundTasks,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

type SubagentTraceEvent = ProviderSubagentEvent;

function rootAssistant(id: string, blocks: unknown[]): SDKMessage {
  return {
    type: "assistant",
    uuid: `assistant-${id}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: null,
    message: {
      id: `api-${id}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: blocks,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as SDKMessage;
}

function childAssistant(parent: string, id: string, model: unknown, blocks: unknown[]): SDKMessage {
  return {
    type: "assistant",
    uuid: `child-${id}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: parent,
    message: {
      id: `api-child-${id}`,
      type: "message",
      role: "assistant",
      model,
      content: blocks,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as SDKMessage;
}

function toolResults(parent: string | null, id: string, results: unknown[], toolUseResult?: unknown): SDKMessage {
  return {
    type: "user",
    uuid: `user-${id}`,
    session_id: CLAUDE_PROTOCOL_SESSION_ID,
    parent_tool_use_id: parent,
    message: { role: "user", content: results },
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
  } as unknown as SDKMessage;
}

async function runDelegatedFixture(
  label: string,
  roots: string[],
  stream: () => AsyncGenerator<SDKMessage>,
): Promise<{ result: Awaited<ReturnType<ProviderManager["run"]>>; traces: SubagentTraceEvent[]; closed: number }> {
  const root = portableFixtureRoot(label);
  roots.push(root);
  let closed = 0;
  const harness = createClaudeAgentSdkHarness({
    createQuery: () => fixtureClaudeQuery(stream(), { close: () => { closed += 1; } }),
  });
  const manager = ProviderManager.createForTests(
    { commands: { claude: process.execPath } },
    new AgentHarnessRegistry([harness]),
  );
  const traces: SubagentTraceEvent[] = [];
  const result = await manager.run(nativeProviderRunInput({
    providerId: "claude",
    conversationId: `claude-${label.toLowerCase().replaceAll(/\W+/gu, "-")}`,
    cwd: root,
    prompt: "Delegate and run commands",
    interactionMode: "build",
    access: "supervised",
  }), { onSubagent: (event) => { traces.push(event); } });
  return { result, traces, closed };
}

const latest = (traces: SubagentTraceEvent[], taskId: string) =>
  traces.filter(({ providerTaskId }) => providerTaskId === taskId).at(-1);

describe("Claude delegated task shape over the SDK protocol", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("reports the real model, effort, steps and a background shell for a successful run", async () => {
    const { result, traces } = await runDelegatedFixture("Claude SDK delegated shape success", roots, async function* () {
      yield rootAssistant("spawn", [
        { type: "tool_use", id: "tool-survey", name: "Agent", input: { subagent_type: "general-purpose", description: "Survey the repo", model: "haiku", effort: "medium" } },
        { type: "tool_use", id: "bash-dev", name: "Bash", input: { command: "npm run dev", description: "Start the dev server", run_in_background: true } },
      ]);
      yield claudeSystem("task_started", { task_id: "agent-survey", tool_use_id: "tool-survey", task_type: "local_agent", description: "Survey the repo", is_backgrounded: false });
      yield claudeSystem("task_started", { task_id: "shell-dev", tool_use_id: "bash-dev", task_type: "local_bash", description: "Start the dev server", is_backgrounded: true });
      yield childAssistant("tool-survey", "1", "claude-haiku-4-5", [
        { type: "tool_use", id: "step-read", name: "Read", input: { file_path: "src/index.ts" } },
      ]);
      yield toolResults("tool-survey", "1", [{ type: "tool_result", tool_use_id: "step-read", content: "file body" }]);
      yield claudeSystem("task_notification", { task_id: "shell-dev", tool_use_id: "bash-dev", status: "completed", output_file: "/tmp/shell-dev.log", summary: "Dev server exited cleanly" });
      yield toolResults(null, "survey", [{ type: "tool_result", tool_use_id: "tool-survey", content: "Survey done" }], {
        status: "completed",
        agentId: "agent-id-survey",
        agentType: "general-purpose",
        content: [{ type: "text", text: "Survey done" }],
        resolvedModel: "claude-haiku-4-5-20251001",
        totalToolUseCount: 1,
        totalDurationMs: 900,
        totalTokens: 1_200,
      });
      yield claudeSystem("task_notification", { task_id: "agent-survey", tool_use_id: "tool-survey", status: "completed", output_file: "/tmp/agent", summary: "Survey done" });
      yield claudeSuccessResult("Parent finished", "completed");
    });
    expect(result).toMatchObject({ status: "completed", text: "Parent finished", cleanupConfirmed: true });
    expect(traces.find(({ providerTaskId }) => providerTaskId === "agent-survey")).toMatchObject({
      status: "spawned", model: "haiku", effort: "medium", background: false, taskKind: "agent",
    });
    expect(traces).toContainEqual(expect.objectContaining({
      providerTaskId: "agent-survey", status: "running", model: "claude-haiku-4-5",
      steps: [{ label: "Read · src/index.ts", status: "running" }],
    }));
    expect(latest(traces, "agent-survey")).toMatchObject({
      status: "completed",
      model: "claude-haiku-4-5-20251001",
      steps: [{ label: "Read · src/index.ts", status: "completed" }],
    });
    expect(traces).toContainEqual(expect.objectContaining({
      providerTaskId: "agent-survey",
      providerAgentId: "agent-id-survey",
      status: "completed",
      toolUseCount: 1,
      durationMs: 900,
      usage: expect.objectContaining({ totalTokens: 1_200 }),
    }));
    expect(latest(traces, "shell-dev")).toMatchObject({
      taskKind: "shell", command: "npm run dev", background: true, status: "completed",
      isLive: false, result: "Dev server exited cleanly", providerToolUseId: "bash-dev",
    });
    expect(JSON.stringify(traces)).not.toMatch(/file body|shell-dev\.log/u);
  });

  it("reports failed and stopped background work exactly", async () => {
    const { result, traces } = await runDelegatedFixture("Claude SDK delegated shape failure", roots, async function* () {
      yield rootAssistant("spawn", [
        { type: "tool_use", id: "bash-build", name: "Bash", input: { command: "npm run build", run_in_background: true } },
        { type: "tool_use", id: "bash-watch", name: "Bash", input: { command: "npm run watch", run_in_background: true } },
      ]);
      yield claudeSystem("task_started", { task_id: "shell-build", tool_use_id: "bash-build", task_type: "local_bash", description: "Build", is_backgrounded: true });
      yield claudeSystem("task_started", { task_id: "shell-watch", tool_use_id: "bash-watch", task_type: "local_bash", description: "Watch", is_backgrounded: true });
      yield claudeSystem("task_started", { task_id: "mcp-index", task_type: "mcp_task", description: "Index", is_backgrounded: true });
      yield claudeSystem("task_notification", { task_id: "shell-build", status: "failed", output_file: "/tmp/b", summary: "Build failed with exit code 2" });
      yield claudeSystem("task_updated", { task_id: "shell-watch", patch: { status: "killed" } });
      yield claudeSystem("task_notification", { task_id: "mcp-index", status: "stopped", output_file: "/tmp/m", summary: "Stopped" });
      yield claudeSuccessResult("Reported the failures", "completed");
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(latest(traces, "shell-build")).toMatchObject({ status: "failed", isLive: false, result: "Build failed with exit code 2" });
    expect(latest(traces, "shell-watch")).toMatchObject({ status: "cancelled", isLive: false, providerStatus: "killed" });
    expect(latest(traces, "mcp-index")).toMatchObject({ status: "cancelled", taskKind: "mcp", providerStatus: "stopped" });
  });

  it("survives malformed task, frame and result shapes without inventing work", async () => {
    const { result, traces } = await runDelegatedFixture("Claude SDK delegated shape malformed", roots, async function* () {
      yield rootAssistant("spawn", [
        { type: "tool_use", id: "tool-odd", name: "Agent", input: "not an object" },
        { type: "tool_use", name: "Bash", input: { command: "no id" } },
      ]);
      yield claudeSystem("task_started", { task_id: 42, task_type: "local_bash" });
      yield claudeSystem("task_started", { task_id: "task-unknown", task_type: "dream" });
      yield claudeSystem("task_started", { task_id: "task-odd", tool_use_id: "tool-odd", task_type: { kind: "agent" } });
      yield childAssistant("tool-odd", "odd", 7, [{ type: "tool_use", id: 9, name: "Read" }, "not a block"]);
      yield childAssistant("tool-missing", "missing", "claude-x", [{ type: "tool_use", id: "s", name: "Read", input: {} }]);
      yield toolResults(null, "odd", [{ type: "tool_result", tool_use_id: "tool-odd" }], { status: "completed", agentId: ["bad"] });
      yield toolResults(null, "remote", [{ type: "tool_result", tool_use_id: "tool-odd" }], { status: "remote_launched", taskId: null });
      yield claudeSystem("task_notification", { task_id: "task-odd", status: "completed", summary: "Finished" });
      yield claudeSuccessResult("Finished despite malformed frames", "completed");
    });
    expect(result).toMatchObject({ status: "completed", text: "Finished despite malformed frames" });
    expect(new Set(traces.map(({ providerTaskId }) => providerTaskId))).toEqual(new Set(["task-odd"]));
    expect(latest(traces, "task-odd")).toMatchObject({ status: "completed", taskKind: "agent" });
    expect(latest(traces, "task-odd")).not.toHaveProperty("model");
    expect(latest(traces, "task-odd")).not.toHaveProperty("steps");
  });

  it("bounds oversized commands and step labels", async () => {
    const longCommand = `node -e "${"x".repeat(50_000)}"`;
    const { result, traces } = await runDelegatedFixture("Claude SDK delegated shape output limit", roots, async function* () {
      yield rootAssistant("spawn", [
        { type: "tool_use", id: "tool-big", name: "Agent", input: { subagent_type: "general-purpose", description: "d".repeat(20_000) } },
        { type: "tool_use", id: "bash-big", name: "Bash", input: { command: longCommand, run_in_background: true } },
      ]);
      yield claudeSystem("task_started", { task_id: "agent-big", tool_use_id: "tool-big", task_type: "local_agent" });
      yield claudeSystem("task_started", { task_id: "shell-big", tool_use_id: "bash-big", task_type: "local_bash", is_backgrounded: true });
      yield childAssistant("tool-big", "big", "m".repeat(5_000), [
        { type: "tool_use", id: "step-big", name: "Grep", input: { pattern: "p".repeat(10_000) } },
      ]);
      yield claudeSystem("task_notification", { task_id: "shell-big", status: "completed", summary: "s".repeat(40_000) });
      yield claudeSystem("task_notification", { task_id: "agent-big", status: "completed", summary: "done" });
      yield claudeSuccessResult("Bounded", "completed");
    });
    expect(result).toMatchObject({ status: "completed" });
    for (const trace of traces) {
      expect(trace.command?.length ?? 0).toBeLessThanOrEqual(4_000);
      expect(trace.description?.length ?? 0).toBeLessThanOrEqual(4_000);
      expect(trace.result?.length ?? 0).toBeLessThanOrEqual(16_000);
      expect(trace.model?.length ?? 0).toBeLessThanOrEqual(200);
      for (const step of trace.steps ?? []) expect(step.label.length).toBeLessThanOrEqual(200);
    }
    expect(latest(traces, "shell-big")?.command).toHaveLength(4_000);
    expect(latest(traces, "agent-big")?.steps?.[0]?.label.startsWith("Grep · ppp")).toBe(true);
  });

  it("stops a background shell through the task-stop path and never a private foreground one", async () => {
    const root = portableFixtureRoot("Claude SDK background shell stop");
    roots.push(root);
    let releaseParent!: () => void;
    const parentReleased = new Promise<void>((resolve) => { releaseParent = resolve; });
    const stopTaskIds: string[] = [];
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield {
            type: "assistant",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            parent_tool_use_id: null,
            message: {
              content: [
                { type: "tool_use", id: "bash-serve", name: "Bash", input: { command: "npm run serve", run_in_background: true } },
                { type: "tool_use", id: "bash-test", name: "Bash", input: { command: "npm test" } },
              ],
            },
          } as unknown as SDKMessage;
          yield claudeSystem("task_started", {
            task_id: "shell-test",
            tool_use_id: "bash-test",
            task_type: "local_bash",
            description: "Run the tests",
            is_backgrounded: false,
          });
          yield claudeSystem("task_started", {
            task_id: "shell-serve",
            tool_use_id: "bash-serve",
            task_type: "local_bash",
            description: "Serve the app",
            is_backgrounded: true,
          });
          await parentReleased;
          yield claudeSystem("task_notification", {
            task_id: "shell-serve",
            tool_use_id: "bash-serve",
            status: "stopped",
            output_file: "/tmp/shell-serve",
            summary: "Stopped",
          });
          yield claudeSystem("task_notification", { task_id: "shell-test", status: "completed", summary: "ok" });
          yield claudeSuccessResult("Parent completed", "completed");
        })(),
        { stopTask: async (taskId) => { stopTaskIds.push(taskId); } },
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traces: Array<{ providerTaskId: string | null; status: string; taskKind?: string }> = [];
    let stops: Promise<[boolean | "queued", boolean | "queued"]> | null = null;
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-background-shell-stop",
      runId: "claude-background-shell-stop-run",
      turnId: "claude-background-shell-stop-turn",
      cwd: root,
      prompt: "Serve the app",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: (event) => {
        traces.push({ providerTaskId: event.providerTaskId, status: event.status, taskKind: event.taskKind });
        if (event.providerTaskId !== "shell-serve" || stops) return;
        const owner = { runId: event.runId, turnId: event.turnId! };
        stops = Promise.all([
          manager.stopSubagent(event.conversationId, "shell-serve", owner),
          manager.stopSubagent(event.conversationId, "shell-test", owner),
        ]);
        void stops.then(() => releaseParent());
      },
    });

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Parent completed" });
    await expect(stops).resolves.toEqual([true, false]);
    expect(stopTaskIds).toEqual(["shell-serve"]);
    expect(traces).toEqual([
      { providerTaskId: "shell-serve", status: "spawned", taskKind: "shell" },
      { providerTaskId: "shell-serve", status: "cancelled", taskKind: "shell" },
    ]);
  });

  it("moves a foreground agent to the background and sends a Stop queued before the task id", async () => {
    const root = portableFixtureRoot("Claude SDK agent controls");
    roots.push(root);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const backgrounded: string[] = [];
    const stopped: string[] = [];
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield rootAssistant("spawn", [
            { type: "tool_use", id: "tool-fg", name: "Agent", input: { subagent_type: "general-purpose", description: "Audit", run_in_background: false } },
            { type: "tool_use", id: "tool-async", name: "Agent", input: { subagent_type: "general-purpose", description: "Index" } },
          ]);
          yield claudeSystem("task_started", { task_id: "task-fg", tool_use_id: "tool-fg", task_type: "local_agent", is_backgrounded: false });
          yield toolResults(null, "async", [{ type: "tool_result", tool_use_id: "tool-async" }], {
            status: "async_launched", agentId: "agent-async", description: "Index", prompt: "Index", outputFile: "/tmp/index",
          });
          await released;
          yield claudeSystem("task_started", { task_id: "task-async", tool_use_id: "tool-async", task_type: "local_agent", is_backgrounded: true });
          yield claudeSystem("task_notification", { task_id: "task-async", status: "stopped", summary: "Stopped" });
          yield claudeSystem("task_notification", { task_id: "task-fg", status: "completed", summary: "Audited" });
          yield claudeSuccessResult("Done", "completed");
        })(),
        {
          backgroundTasks: async (toolUseId?: string) => { backgrounded.push(toolUseId ?? ""); return true; },
          stopTask: async (taskId: string) => { stopped.push(taskId); },
        },
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const owner = { runId: "claude-agent-controls-run", turnId: "claude-agent-controls-turn" };
    let controls: Promise<[SubagentBackgroundResult, boolean | "queued"]> | null = null;
    const asyncUpdates: Array<{ status: string; isLive: boolean; progress: string | null }> = [];
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-agent-controls",
      ...owner,
      cwd: root,
      prompt: "Delegate",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: (event) => {
        if (event.providerToolUseId === "tool-async") {
          asyncUpdates.push({ status: event.status, isLive: event.isLive, progress: event.progress });
        }
        if (event.providerToolUseId !== "tool-async" || event.providerTaskId || controls) return;
        controls = Promise.all([
          manager.backgroundSubagent("claude-agent-controls", "tool-fg", owner),
          manager.stopSubagent("claude-agent-controls", null, owner, "tool-async"),
        ]);
        void controls.then(() => release());
      },
    });
    await expect(result).resolves.toMatchObject({ status: "completed", text: "Done" });
    await expect(controls).resolves.toEqual([{ moved: true }, "queued"]);
    expect(backgrounded).toEqual(["tool-fg"]);
    expect(stopped).toEqual(["task-async"]);
    expect(asyncUpdates.find(({ progress }) => progress === "Stop requested.")).toMatchObject({ isLive: true });
    expect(asyncUpdates.at(-1)).toMatchObject({ status: "cancelled", isLive: false });
  });

  it("finishes the turn and closes cleanly while a background shell is still running", async () => {
    const { result, traces, closed } = await runDelegatedFixture("Claude SDK delegated shape live shell", roots, async function* () {
      yield rootAssistant("spawn", [
        { type: "tool_use", id: "bash-server", name: "Bash", input: { command: "npm run serve", run_in_background: true } },
      ]);
      yield claudeSystem("task_started", { task_id: "shell-server", tool_use_id: "bash-server", task_type: "local_bash", description: "Serve the app", is_backgrounded: true });
      yield claudeSuccessResult("The server is running in the background.", "completed");
    });
    expect(result).toMatchObject({ status: "completed", text: "The server is running in the background.", cleanupConfirmed: true });
    expect(closed).toBe(1);
    expect(latest(traces, "shell-server")).toMatchObject({ status: "spawned", isLive: true, taskKind: "shell", command: "npm run serve" });
  });
});

describe("Claude delegated task telemetry", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("forwards structured delegated task telemetry without a usage suffix in progress", async () => {
    const root = portableFixtureRoot("Claude SDK delegate telemetry");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield {
            type: "assistant",
            uuid: "assistant-delegate-telemetry",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            parent_tool_use_id: null,
            message: {
              id: "api-delegate-telemetry",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [{
                type: "tool_use",
                id: "tool-agent-telemetry",
                name: "Agent",
                input: {
                  subagent_type: "researcher",
                  description: "Measure the delegate",
                  model: "sonnet",
                },
              }],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          } as unknown as SDKMessage;
          yield claudeBackgroundTasks(["agent-telemetry"]);
          yield claudeSystem("task_started", {
            task_id: "agent-telemetry",
            tool_use_id: "tool-agent-telemetry",
            description: "Measure the delegate",
            subagent_type: "researcher",
          });
          yield claudeSystem("task_progress", {
            task_id: "agent-telemetry",
            tool_use_id: "tool-agent-telemetry",
            description: "Measure the delegate",
            usage: { total_tokens: 900, tool_uses: 2, duration_ms: 1_500 },
            last_tool_name: "Read",
          });
          yield {
            type: "tool_progress",
            uuid: "progress-agent-telemetry",
            session_id: CLAUDE_PROTOCOL_SESSION_ID,
            task_id: "agent-telemetry",
            tool_use_id: "child-grep-telemetry",
            tool_name: "Grep",
            parent_tool_use_id: "tool-agent-telemetry",
            elapsed_time_seconds: 2,
          } as unknown as SDKMessage;
          yield claudeBackgroundTasks([]);
          yield claudeSystem("task_notification", {
            task_id: "agent-telemetry",
            tool_use_id: "tool-agent-telemetry",
            status: "completed",
            output_file: "/tmp/agent-telemetry",
            summary: "Delegate measured",
            usage: { total_tokens: 1_800, tool_uses: 3, duration_ms: 2_500 },
          });
          yield claudeSuccessResult("Parent finished", "completed");
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traces: Array<Record<string, unknown>> = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-delegate-telemetry",
      cwd: root,
      prompt: "Report delegate telemetry",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: ({
        sequence,
        status,
        progress,
        model,
        activity,
        usage,
        toolUseCount,
        durationMs,
      }) => {
        traces.push({
          sequence,
          status,
          progress,
          model,
          activity,
          totalTokens: usage?.totalTokens,
          toolUseCount,
          durationMs,
        });
      },
    })).resolves.toMatchObject({
      status: "completed",
      text: "Parent finished",
    });
    expect(traces).toEqual([
      {
        sequence: 1,
        status: "spawned",
        progress: null,
        model: "sonnet",
        activity: undefined,
        totalTokens: undefined,
        toolUseCount: undefined,
        durationMs: undefined,
      },
      {
        sequence: 2,
        status: "running",
        progress: "Read",
        model: "sonnet",
        activity: "Read",
        totalTokens: 900,
        toolUseCount: 2,
        durationMs: 1_500,
      },
      {
        sequence: 3,
        status: "running",
        progress: "Grep · 2 seconds elapsed",
        model: "sonnet",
        activity: "Grep",
        totalTokens: undefined,
        toolUseCount: undefined,
        durationMs: undefined,
      },
      {
        sequence: 4,
        status: "completed",
        progress: null,
        model: "sonnet",
        activity: undefined,
        totalTokens: 1_800,
        toolUseCount: 3,
        durationMs: 2_500,
      },
    ]);
  });
});
