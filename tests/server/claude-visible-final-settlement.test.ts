// @inertia-test-suite portable
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { ClaudeDelegateLifecycle } from "../../src/server/provider/claude-delegate-lifecycle";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function backgroundTasks(...tasks: Array<{ task_id: string; ambient?: boolean }>): SDKMessage {
  return claudeSystem("background_tasks_changed", {
    tasks: tasks.map((task) => ({ task_type: "local_agent", description: task.task_id, ...task })),
  });
}

describe("Claude visible final answer settlement", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

  const normalCases = (["none", "queued", "started"] as const).flatMap((state) =>
    [0, 1].flatMap((numTurns) => [false, true].map((correlated) =>
      ({ state, numTurns, correlated, emptyResult: false, ambient: "none" }))));
  const emptyCases = (["queued", "started"] as const).map((state) =>
    ({ state, numTurns: 0, correlated: true, emptyResult: true, ambient: "none" }));
  const ambientCases = ["watcher", "skip-transcript", "typed-agent"].map((ambient) =>
    ({ state: "started" as const, numTurns: 1, correlated: true, emptyResult: false, ambient }));

  it.each([...normalCases, ...emptyCases, ...ambientCases])(
    "settles final result without EOF: $state, turns=$numTurns, correlated=$correlated, empty=$emptyResult, ambient=$ambient",
    async ({ state, numTurns, correlated, emptyResult, ambient }) => {
      const root = portableFixtureRoot("Claude visible final answer");
      roots.push(root);
      let readPastTerminal!: () => void;
      const unexpectedRead = new Promise<"read-past-terminal">((resolve) => {
        readPastTerminal = () => resolve("read-past-terminal");
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const close = vi.fn();
      const visibleText: string[] = [];
      const harness = createClaudeAgentSdkHarness({
        createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          const initial = (await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next()).value!;
          if (state !== "none") {
            yield { type: "command_lifecycle", command_uuid: initial.uuid, state,
              uuid: "initial-state", session_id: CLAUDE_PROTOCOL_SESSION_ID } as unknown as SDKMessage;
          }
          if (ambient !== "none") {
            yield backgroundTasks({ task_id: "ambient-task", ambient: true });
            yield claudeSystem("task_started", {
              task_id: "ambient-task", description: "Persistent watcher",
              task_type: ambient === "watcher" ? "local_bash" : "local_agent",
              ...(ambient === "skip-transcript" ? { skip_transcript: true } : {}),
              ...(ambient === "typed-agent" ? { ambient: true } : {}),
            });
          }
          yield { type: "assistant", session_id: CLAUDE_PROTOCOL_SESSION_ID, parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "The final answer is visible." }] } } as SDKMessage;
          yield { ...claudeSuccessResult(emptyResult ? "" : "The final answer is visible.", "completed"),
            num_turns: numTurns, ...(correlated ? { user_message_uuid: initial.uuid } : {}) } as SDKMessage;
          readPastTerminal();
          await released;
        })(), { close }),
      });
      const run = harness.start({
        input: nativeProviderRunInput({ providerId: "claude", conversationId: "visible-final",
          cwd: root, prompt: "Finish the request", interactionMode: "build", access: "supervised" }),
        executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
        callbacks: { onEvent: (event) => { if (event.type === "text") visibleText.push(event.text); } },
      });
      try {
        const outcome = await Promise.race([run.result.then(() => "settled"), unexpectedRead]);
        expect(visibleText).toContain("The final answer is visible.");
        expect(outcome).toBe("settled");
        await expect(run.result).resolves.toMatchObject({
          status: "completed", text: "The final answer is visible.", cleanupConfirmed: true,
        });
        expect(close).toHaveBeenCalledOnce();
      } finally {
        run.cancel(true);
        release();
        await run.result;
      }
    },
  );

  it("bounds trace cleanup after foreground work becomes ambient without inventing a terminal task edge", async () => {
    const root = portableFixtureRoot("Claude foreground task becomes ambient");
    roots.push(root);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let waitStartedAt = 0;
    const traces: Array<{ status: string; isLive: boolean }> = [];
    const close = vi.fn(() => release());
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 25,
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield backgroundTasks({ task_id: "agent", ambient: false });
        yield claudeSystem("task_started", { task_id: "agent", task_type: "local_agent" });
        yield claudeSuccessResult("Visible provisional answer", "completed");
        yield backgroundTasks({ task_id: "agent", ambient: true });
        yield claudeSuccessResult("Fresh final answer", "completed");
        waitStartedAt = Date.now();
        await released;
      })(), { close }),
    });
    const run = harness.start({
      input: nativeProviderRunInput({ providerId: "claude", conversationId: "foreground-becomes-ambient",
        cwd: root, prompt: "Finish the request", interactionMode: "build", access: "supervised" }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
      callbacks: { onEvent: (event) => {
        if (event.type === "subagent") traces.push({ status: event.status, isLive: event.isLive });
      } },
    });
    try {
      await expect(run.result).resolves.toMatchObject({
        status: "completed", text: "Fresh final answer", cleanupConfirmed: true,
      });
      expect(waitStartedAt).toBeGreaterThan(0);
      expect(Date.now() - waitStartedAt).toBeGreaterThanOrEqual(20);
      // The turn controller still receives this known live descendant and can
      // reject completion; ambient roster flags never fabricate task completion.
      expect(traces).toEqual([{ status: "spawned", isLive: true }]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      run.cancel(true);
      release();
      await run.result;
    }
  });

  it("keeps mixed rosters provisional and bounds parent resume after only ambient work remains", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    const mixed = backgroundTasks({ task_id: "watcher", ambient: true }, { task_id: "agent" });
    lifecycle.observe(mixed);
    expect(lifecycle.observe(claudeSuccessResult("Visible provisional answer", "completed")))
      .toEqual({ turnEnded: false });
    expect(lifecycle.shouldBoundParentResumeWait(mixed, false, false)).toBe(false);
    expect(lifecycle.complete()).toEqual({ kind: "incomplete", reason: "delegates-abandoned" });

    const ambientOnly = backgroundTasks({ task_id: "watcher", ambient: true });
    expect(lifecycle.observe(ambientOnly)).toEqual({ turnEnded: false });
    expect(lifecycle.shouldBoundParentResumeWait(ambientOnly, false, false)).toBe(true);
    expect(lifecycle.complete()).toEqual({ kind: "incomplete", reason: "parent-not-resumed" });
    expect(lifecycle.observe(claudeSuccessResult("Delegate incorporated", "completed")))
      .toEqual({ turnEnded: true });
  });

  it("treats an ambient-to-foreground flag change as active work", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    lifecycle.observe(backgroundTasks({ task_id: "agent", ambient: true }));
    const foreground = backgroundTasks({ task_id: "agent", ambient: false });
    lifecycle.observe(foreground);
    expect(lifecycle.observe(claudeSuccessResult("Visible provisional answer", "completed")))
      .toEqual({ turnEnded: false });
    expect(lifecycle.shouldBoundParentResumeWait(foreground, false, false)).toBe(false);
    expect(lifecycle.complete()).toEqual({ kind: "incomplete", reason: "delegates-abandoned" });
  });

  it("bounds a foreground-to-ambient transition but requires a fresh parent result", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    lifecycle.observe(backgroundTasks({ task_id: "agent", ambient: false }));
    lifecycle.observe(claudeSuccessResult("Visible provisional answer", "completed"));
    const ambient = backgroundTasks({ task_id: "agent", ambient: true });
    expect(lifecycle.observe(ambient)).toEqual({ turnEnded: false });
    expect(lifecycle.shouldBoundParentResumeWait(ambient, true, true)).toBe(true);
    expect(lifecycle.complete()).toEqual({ kind: "incomplete", reason: "parent-not-resumed" });
    expect(lifecycle.observe(claudeSuccessResult("Fresh parent answer", "completed"), true))
      .toEqual({ turnEnded: true });
  });

  it("keeps explicit background deferral provisional even with only ambient tasks", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    lifecycle.observe(backgroundTasks({ task_id: "watcher", ambient: true }));
    expect(lifecycle.observe(claudeSuccessResult("Delegating", "background_requested")))
      .toEqual({ turnEnded: false });
    expect(lifecycle.complete()).toEqual({ kind: "incomplete", reason: "parent-not-resumed" });
  });
});
