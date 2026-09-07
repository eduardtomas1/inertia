// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";
import { parseRuntimeWorkerEvent, type RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import {
  RUNTIME_STARTUP_FAILURE_CATEGORIES,
  RuntimeStartupBlockerError,
  categorizedRuntimeStartupFailureMessage,
} from "../../src/shared/runtime-startup-diagnostics";
import { GitError, GIT_PROCESS_TREE_TERMINATION_FAILURE } from "../../src/server/git/types";
import type { RunningRuntime } from "../../src/server/index";
import { completeRuntimeWorkerShutdown } from "../../src/server/runtime-worker-shutdown";
import {
  observeRuntimeStartup,
  runtimeStartupErrorEvent,
  runtimeStartupFailureCategory,
} from "../../src/server/runtime-worker-startup-failure";

const privateText = "private /home/person/project token=synthetic-private-value";

describe("bounded runtime startup failure evidence", () => {
  it.each([
    [new GitError("timeout", privateText), "git-timeout"],
    [new GitError("operation-failed", GIT_PROCESS_TREE_TERMINATION_FAILURE), "git-cleanup-unconfirmed"],
    [new GitError("git-unavailable", privateText), "git-unavailable"],
    [new GitError("operation-failed", privateText), "git-operation-failed"],
    [new TypeError(privateText), "type-error"],
    [new RangeError(privateText), "range-error"],
    [Object.assign(new Error(privateText), { code: "EACCES" }), "filesystem-permission"],
    [Object.assign(new Error(privateText), { code: "ENOENT" }), "filesystem-missing"],
    [Object.assign(new Error(privateText), { code: "EIO" }), "filesystem-io"],
    [Object.assign(new Error(privateText), { code: privateText }), "unknown"],
    [new Error(privateText, { cause: new GitError("timeout", privateText) }), "unknown"],
    [{ code: "timeout", message: privateText }, "unknown"],
  ])("classifies known types and codes without copying private details (%#)", (error, category) => {
    expect(runtimeStartupFailureCategory(error)).toBe(category);
    const event = runtimeStartupErrorEvent(error, "initialization");
    expect(parseRuntimeWorkerEvent(event)).toEqual(event);
    expect(JSON.stringify(event)).not.toContain(privateText);
    expect(event.message.length).toBeLessThan(100);
  });

  it("admits only the fixed phase/category vocabulary and no extra fields", () => {
    for (const phase of ["initialization", "startup completion"] as const) {
      for (const category of RUNTIME_STARTUP_FAILURE_CATEGORIES) {
        const event = { type: "runtime.startup-failed", message: categorizedRuntimeStartupFailureMessage(phase, category) };
        expect(parseRuntimeWorkerEvent(event)).toEqual(event);
        expect(parseRuntimeWorkerEvent({ ...event, details: privateText })).toBeNull();
      }
    }
    expect(parseRuntimeWorkerEvent({ type: "runtime.startup-failed", message: `Runtime initialization failed (${privateText}).` })).toBeNull();
  });

  it("retains the existing authoritative blocker without its private error text", () => {
    const event = runtimeStartupErrorEvent(new RuntimeStartupBlockerError(
      "prior-runtime-cleanup-unconfirmed", privateText,
    ), "initialization");
    expect(event).toEqual({
      type: "runtime.startup-failed",
      message: "Runtime startup is blocked because prior process cleanup remains unconfirmed.",
      blockerCode: "prior-runtime-cleanup-unconfirmed",
    });
    expect(parseRuntimeWorkerEvent(event)).toEqual(event);
  });

  it("reports the initiating rejection before incomplete-startup cleanup remains fatal", async () => {
    const events: RuntimeWorkerEvent[] = [];
    const exit = vi.fn();
    const started = vi.fn();
    const awaitStoppedAcknowledgement = vi.fn(async () => undefined);
    await observeRuntimeStartup(Promise.reject(new GitError("timeout", privateText)), started, async (event) => {
      events.push(event);
      await completeRuntimeWorkerShutdown({ runtime: null, cause: "runtime-crash", exitCode: 1,
        closeBrokers: vi.fn(), post: (next) => events.push(next), exit, awaitStoppedAcknowledgement });
    });
    expect(events).toEqual([
      { type: "runtime.startup-failed", message: "Runtime initialization failed (git-timeout)." },
      { type: "runtime.shutdown-unconfirmed", reason: "incomplete-startup" },
    ]);
    expect(started).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(awaitStoppedAcknowledgement).not.toHaveBeenCalled();
  });

  it("retains the async startup-completion category when broker shutdown throws", async () => {
    const events: RuntimeWorkerEvent[] = [];
    const exit = vi.fn();
    const close = vi.fn(async () => undefined);
    const runtime = { close } as unknown as RunningRuntime;
    const closeBrokers = vi.fn().mockImplementationOnce(() => { throw new TypeError(privateText); });
    const awaitStoppedAcknowledgement = vi.fn(async () => undefined);
    const shutdown = (active: RunningRuntime | null) => completeRuntimeWorkerShutdown({
      runtime: active, cause: "runtime-crash", exitCode: 1, closeBrokers,
      post: (event) => events.push(event), exit, awaitStoppedAcknowledgement,
    });
    await observeRuntimeStartup(Promise.resolve(runtime), async (active) => {
      await shutdown(active);
    }, async (event) => {
      events.push(event);
      await shutdown(null);
    });
    expect(events).toEqual([
      { type: "runtime.startup-failed", message: "Runtime startup completion failed (type-error)." },
      { type: "runtime.shutdown-unconfirmed", reason: "incomplete-startup" },
    ]);
    expect(close).toHaveBeenCalledExactlyOnceWith("runtime-crash");
    expect(closeBrokers).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
    expect(awaitStoppedAcknowledgement).not.toHaveBeenCalled();
  });

  it("does not swallow a rejection in the existing failure cleanup path", async () => {
    const cleanupError = new Error(privateText);
    await expect(observeRuntimeStartup(Promise.reject(new Error(privateText)), vi.fn(),
      () => Promise.reject(cleanupError))).rejects.toBe(cleanupError);
  });
});
