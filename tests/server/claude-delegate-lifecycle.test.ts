import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudeDelegateLifecycle } from "../../src/server/provider/claude-delegate-lifecycle";
import {
  claudeBackgroundTasks,
  claudeSessionState,
  claudeSuccessResult,
  claudeSystem,
} from "../helpers/claude-agent-sdk-protocol";

describe("Claude delegated lifecycle", () => {
  it("holds a background-requested result until the parent returns a final result", () => {
    const lifecycle = new ClaudeDelegateLifecycle();

    lifecycle.observe(claudeBackgroundTasks(["agent-1"]));
    lifecycle.observe(claudeSystem("task_started", {
      task_id: "agent-1",
      description: "Inspect lifecycle",
    }));
    lifecycle.observe(
      claudeSuccessResult("Delegated work is still running", "background_requested"),
    );

    expect(lifecycle.complete()).toEqual({
      kind: "incomplete",
      reason: "delegates-abandoned",
    });

    // The level may precede the terminal edge. It is REPLACE state, not one
    // half of a task_started/task_notification pair.
    lifecycle.observe(claudeBackgroundTasks([]));
    lifecycle.observe(claudeSystem("task_notification", {
      task_id: "agent-1",
      status: "completed",
      output_file: "/tmp/agent-1",
      summary: "Lifecycle inspected",
    }));
    lifecycle.observe(claudeSessionState("running"));
    expect(lifecycle.observe(
      claudeSuccessResult("Delegate result received", "completed"),
    )).toEqual({
      turnEnded: true,
    });
    expect(lifecycle.complete()).toMatchObject({
      kind: "result",
      result: {
        subtype: "success",
        result: "Delegate result received",
        terminal_reason: "completed",
      },
    });
  });

  it("waits past the empty result Claude sends for each queued background completion", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    const ack = { ...claudeSuccessResult(""), num_turns: 0 } as SDKMessage;

    expect(lifecycle.observe(ack)).toEqual({ turnEnded: true });
    lifecycle.dispose();

    lifecycle.observe(claudeBackgroundTasks(["agent-1", "agent-2"]));
    expect(lifecycle.observe(claudeSuccessResult("Started", "completed"))).toEqual({ turnEnded: false });
    lifecycle.observe(claudeBackgroundTasks([]));
    lifecycle.observe(claudeSystem("task_notification", { task_id: "agent-1", status: "completed" }));
    lifecycle.observe(claudeSystem("task_notification", { task_id: "agent-2", status: "completed" }));
    expect(lifecycle.observe(ack)).toEqual({ turnEnded: false });
    expect(lifecycle.complete()).toEqual({ kind: "incomplete", reason: "parent-not-resumed" });
    expect(lifecycle.observe(claudeSuccessResult("Both delegates finished", "completed"))).toEqual({ turnEnded: true });
    expect(lifecycle.complete()).toMatchObject({
      kind: "result",
      result: { result: "Both delegates finished", num_turns: 1 },
    });
  });

  it("keeps a resumed turn open past the empty result for a notification queued ahead of its prompt", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    const promptUuid = "11111111-1111-4111-8111-111111111111";
    const lifecycleFrame = (state: string) =>
      ({ type: "command_lifecycle", command_uuid: promptUuid, state }) as unknown as SDKMessage;
    const ack = { ...claudeSuccessResult(""), num_turns: 0 } as SDKMessage;
    lifecycle.expectPrompt(promptUuid);

    lifecycle.observe(claudeSystem("task_notification", { task_id: "shell-1", status: "stopped" }));
    lifecycle.observe(lifecycleFrame("queued"));
    expect(lifecycle.observe(ack)).toEqual({ turnEnded: false });
    lifecycle.observe(lifecycleFrame("started"));
    expect(lifecycle.observe({
      ...claudeSuccessResult("PONG", "completed"),
      user_message_uuid: promptUuid,
      user_message_uuids: [promptUuid],
    } as SDKMessage)).toEqual({ turnEnded: true });
    expect(lifecycle.complete()).toMatchObject({ kind: "result", result: { result: "PONG" } });

    const refused = new ClaudeDelegateLifecycle();
    refused.expectPrompt(promptUuid);
    refused.observe(lifecycleFrame("queued"));
    expect(refused.observe(ack)).toEqual({ turnEnded: false });
    expect(refused.observe(lifecycleFrame("refused"))).toEqual({ turnEnded: true });
    expect(refused.complete()).toMatchObject({ kind: "result", result: { num_turns: 0 } });

    const legacy = new ClaudeDelegateLifecycle();
    legacy.expectPrompt(promptUuid);
    expect(legacy.observe(ack)).toEqual({ turnEnded: true });

    const notification = new ClaudeDelegateLifecycle();
    notification.expectPrompt(promptUuid);
    expect(notification.observe({ ...(ack as object), origin: { kind: "task-notification" } } as SDKMessage))
      .toEqual({ turnEnded: false });
    expect(notification.complete()).toMatchObject({ kind: "result", result: { num_turns: 0 } });
  });

  it("does not wedge on stale edge events or an idle event from before the result", () => {
    const lifecycle = new ClaudeDelegateLifecycle();

    expect(lifecycle.observe(claudeSessionState("idle"))).toEqual({
      turnEnded: false,
    });
    lifecycle.observe(claudeSystem("task_notification", {
      task_id: "agent-stale",
      status: "completed",
      output_file: "/tmp/agent-stale",
      summary: "Arrived before start",
    }));
    lifecycle.observe(claudeBackgroundTasks(["agent-stale"]));
    lifecycle.observe(claudeBackgroundTasks([]));
    lifecycle.observe(
      claudeSuccessResult("Fresh parent result", "completed"),
    );
    lifecycle.observe(claudeSystem("task_started", {
      task_id: "agent-stale",
      description: "Late stale edge",
    }));

    expect(lifecycle.observe(claudeSessionState("idle"))).toEqual({
      turnEnded: true,
    });
    expect(lifecycle.complete()).toMatchObject({
      kind: "result",
      result: { result: "Fresh parent result" },
    });
  });

  it("distinguishes clean process exit from a provisional delegated result", () => {
    const completed = new ClaudeDelegateLifecycle();
    expect(completed.observe(claudeSuccessResult("Done", "completed"))).toEqual({
      turnEnded: true,
    });
    expect(completed.complete()).toMatchObject({
      kind: "result",
      result: { result: "Done" },
    });

    const abandoned = new ClaudeDelegateLifecycle();
    abandoned.observe(claudeBackgroundTasks(["agent-live"]));
    abandoned.observe(claudeSuccessResult("Done", "completed"));
    expect(abandoned.complete()).toEqual({
      kind: "incomplete",
      reason: "delegates-abandoned",
    });

    expect(new ClaudeDelegateLifecycle().complete()).toEqual({
      kind: "incomplete",
      reason: "missing-result",
    });
  });

  it("requires a fresh parent result after the background level clears", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    lifecycle.observe(claudeBackgroundTasks(["agent-1"]));
    expect(lifecycle.observe(
      claudeSuccessResult("Waiting for the delegate", "completed"),
    )).toEqual({ turnEnded: false });
    expect(lifecycle.hasProvisionalResult()).toBe(true);

    expect(lifecycle.observe(claudeBackgroundTasks([]))).toEqual({
      turnEnded: false,
    });
    expect(lifecycle.complete()).toEqual({
      kind: "incomplete",
      reason: "parent-not-resumed",
    });

    expect(lifecycle.observe(
      claudeSuccessResult("Parent resumed", "completed"),
    )).toEqual({
      turnEnded: true,
    });
    expect(lifecycle.complete()).toMatchObject({
      kind: "result",
      result: { result: "Parent resumed" },
    });
  });

  it("treats a result during an exact live task trace as provisional", () => {
    const lifecycle = new ClaudeDelegateLifecycle();

    expect(lifecycle.observe(
      claudeSuccessResult("Waiting for typed work", "completed"),
      true,
    )).toEqual({ turnEnded: false });
    expect(lifecycle.hasProvisionalResult()).toBe(true);
    expect(lifecycle.complete()).toEqual({
      kind: "incomplete",
      reason: "parent-not-resumed",
    });

    expect(lifecycle.observe(
      claudeSuccessResult("Typed work incorporated", "completed"),
      false,
    )).toEqual({ turnEnded: true });
    expect(lifecycle.hasProvisionalResult()).toBe(false);
  });

  it("lets a newer authoritative empty roster override stale trace liveness", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    lifecycle.observe(claudeBackgroundTasks([]));

    expect(lifecycle.observe(
      claudeSuccessResult("Parent resumed after the roster cleared", "completed"),
      true,
    )).toEqual({ turnEnded: true });
    expect(lifecycle.hasProvisionalResult()).toBe(false);
    expect(lifecycle.complete()).toMatchObject({
      kind: "result",
      result: { result: "Parent resumed after the roster cleared" },
    });
  });

  it("resets the process-local background level on SDK init and cleanup", () => {
    const lifecycle = new ClaudeDelegateLifecycle();
    lifecycle.observe(claudeBackgroundTasks(["orphan-from-old-process"]));
    lifecycle.observe(claudeSystem("init"));
    lifecycle.observe(claudeSuccessResult("Resumed cleanly", "completed"));

    expect(lifecycle.complete()).toMatchObject({
      kind: "result",
      result: { result: "Resumed cleanly" },
    });

    lifecycle.dispose();
    expect(lifecycle.complete()).toEqual({
      kind: "incomplete",
      reason: "missing-result",
    });
  });
});
