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
