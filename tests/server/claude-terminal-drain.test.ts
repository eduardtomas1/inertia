// @inertia-test-suite portable
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { CLAUDE_PROTOCOL_SESSION_ID, claudeBackgroundTasks, claudeSuccessResult, claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude terminal parent-resume drain", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it.each([false, true])("keeps the existing parent-resume bound after repository notice=%s", async (notice) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const root = portableFixtureRoot("Claude parent resume bound");
    roots.push(root);
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 25,
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield claudeBackgroundTasks(["agent"]);
        yield claudeSuccessResult("Visible answer before delegate completion", "completed");
        yield claudeBackgroundTasks([]);
        if (notice) yield claudeSystem("vcs_state_changed");
        ready();
        await released;
      })(), { close: release }),
    });
    const run = harness.start({
      input: nativeProviderRunInput({ providerId: "claude", conversationId: "parent-resume-bound",
        cwd: root, prompt: "Finish the request", interactionMode: "build", access: "supervised" }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });
    let settled = false;
    void run.result.then(() => { settled = true; });
    try {
      await waiting;
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(true);
      await expect(run.result).resolves.toMatchObject({
        status: "failed", cleanupConfirmed: true,
        failure: { terminalEvent: "lifecycle/parent-not-resumed" },
      });
    } finally {
      release();
      await run.result;
    }
  });

  it.each(["quiet", "unknown", "child", "empty-roster", "ambient-roster", "queued-ack", "wall-clock-rollback"] as const)(
    "does not extend the original deadline with repeated %s frames",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const root = portableFixtureRoot("Claude quiet drain traffic");
      roots.push(root);
      let ready!: () => void;
      const waiting = new Promise<void>((resolve) => { ready = resolve; });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let closedAt: number | undefined;
      const start = performance.now();
      const message = kind === "quiet" || kind === "wall-clock-rollback" ? claudeSystem("vcs_state_changed")
        : kind === "unknown" ? claudeSystem("future_notice")
          : kind === "empty-roster" ? claudeBackgroundTasks([])
            : kind === "ambient-roster" ? claudeSystem("background_tasks_changed", {
              tasks: [{ task_id: "watcher", task_type: "local_bash", description: "Watch", ambient: true }],
            })
              : kind === "queued-ack" ? { ...claudeSuccessResult(""), num_turns: 0 } as SDKMessage
                : { type: "assistant", session_id: CLAUDE_PROTOCOL_SESSION_ID, parent_tool_use_id: "child",
                  message: { content: [{ type: "text", text: "Child progress" }] } } as SDKMessage;
      const harness = createClaudeAgentSdkHarness({
        terminalSubagentDrainTimeoutMs: 25,
        createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeBackgroundTasks(["agent"]);
          yield claudeSuccessResult("Visible provisional answer", "completed");
          yield claudeBackgroundTasks([]);
          ready();
          for (let index = 0; index < 3; index += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            if (kind === "wall-clock-rollback" && index === 0) vi.setSystemTime(Date.now() - 3_600_000);
            yield message;
          }
          await released;
        })(), { close: () => { closedAt = performance.now(); release(); } }),
      });
      const run = harness.start({
        input: nativeProviderRunInput({ providerId: "claude", conversationId: "quiet-drain",
          cwd: root, prompt: "Finish the request", interactionMode: "build", access: "supervised" }),
        executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
      });
      try {
        await waiting;
        await vi.advanceTimersByTimeAsync(50);
        expect(closedAt).toBe(start + 25);
        await expect(run.result).resolves.toMatchObject({
          status: "failed", cleanupConfirmed: true,
          failure: { terminalEvent: "lifecycle/parent-not-resumed" },
        });
      } finally {
        release();
        await vi.advanceTimersByTimeAsync(50);
        await run.result;
      }
    },
  );

  it.each(["assistant", "tool", "new-delegate", "started-prompt", "requesting"] as const)(
    "allows resumed root %s work to finish beyond the previous deadline",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const root = portableFixtureRoot("Claude resumed root work");
      roots.push(root);
      let ready!: () => void;
      const waiting = new Promise<void>((resolve) => { ready = resolve; });
      let finish!: () => void;
      const finishAllowed = new Promise<void>((resolve) => { finish = resolve; });
      const harness = createClaudeAgentSdkHarness({
        terminalSubagentDrainTimeoutMs: 25,
        createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          const initial = (await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next()).value!;
          yield claudeBackgroundTasks(["agent"]);
          yield claudeSuccessResult("Visible provisional answer", "completed");
          yield claudeBackgroundTasks([]);
          yield kind === "new-delegate" ? claudeBackgroundTasks(["new-agent"])
            : kind === "requesting" ? claudeSystem("status", { status: "requesting" })
              : kind === "started-prompt" ? { type: "command_lifecycle", command_uuid: initial.uuid,
                state: "started", uuid: "resume-command", session_id: CLAUDE_PROTOCOL_SESSION_ID } as unknown as SDKMessage
                : kind === "tool" ? { type: "tool_progress", tool_use_id: "root-tool", tool_name: "Bash",
                  elapsed_time_seconds: 1, parent_tool_use_id: null, session_id: CLAUDE_PROTOCOL_SESSION_ID } as SDKMessage
                  : { type: "assistant", session_id: CLAUDE_PROTOCOL_SESSION_ID, parent_tool_use_id: null,
                    message: { content: [{ type: "text", text: "Final answer" }] } } as SDKMessage;
          ready();
          await finishAllowed;
          if (kind === "new-delegate") yield claudeBackgroundTasks([]);
          yield claudeSuccessResult("Final answer", "completed");
        })()),
      });
      const run = harness.start({
        input: nativeProviderRunInput({ providerId: "claude", conversationId: "resumed-root",
          cwd: root, prompt: "Finish the request", interactionMode: "build", access: "supervised" }),
        executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
      });
      let settled = false;
      void run.result.then(() => { settled = true; });
      try {
        await waiting;
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(false);
        finish();
        await expect(run.result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
      } finally {
        finish();
        await run.result;
      }
    },
  );
});
