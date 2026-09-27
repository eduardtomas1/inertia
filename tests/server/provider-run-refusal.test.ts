// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  type AgentHarness,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/providers";
import { providerRunTerminal } from "../../src/server/provider/contracts";
import { PROCESS_LIFECYCLE_CAPABILITIES_FOR_TESTS } from "../helpers/providers/process-lifecycle-harness";
import { nativeProviderRunFields } from "./model-route-fixture";

function input(overrides: Partial<ProviderRunInput> = {}): ProviderRunInput {
  return {
    ...nativeProviderRunFields("claude", "provider-default", "", "claude-cli"),
    conversationId: "refusal-conversation",
    runId: "run-live",
    turnId: "turn-live",
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

function pendingManager() {
  const cancelCalls: boolean[] = [];
  const harness: AgentHarness = {
    id: "claude-cli",
    providerId: "claude",
    capabilities: PROCESS_LIFECYCLE_CAPABILITIES_FOR_TESTS.claude,
    supports: () => true,
    start: (options) => {
      let resolveResult!: (result: ProviderRunResult) => void;
      const result = new Promise<ProviderRunResult>((resolve) => { resolveResult = resolve; });
      return {
        harnessId: "claude-cli",
        providerId: "claude",
        result,
        cancel: (force) => {
          cancelCalls.push(force);
          resolveResult({
            ...providerRunTerminal(options.input, "cancelled"),
            text: "",
            textTruncated: false,
            exitCode: null,
            signal: null,
            cleanupConfirmed: true,
          });
        },
        extension: { kind: "cli", providerId: "claude" },
      };
    },
  };
  const manager = ProviderManager.createForTests(
    { cancelGraceMs: 100 },
    new AgentHarnessRegistry([harness]),
  );
  return { manager, cancelCalls };
}

describe("provider run refusals before admission", () => {
  it("settles the exact owner of a run refused by input validation", async () => {
    const { manager } = pendingManager();
    const refused = input({ runId: "run-invalid", turnId: "turn-invalid", prompt: "   " });

    expect(() => manager.run(refused)).toThrow("A prompt is required.");

    await expect(manager.stopOwned(
      "refusal-conversation",
      { runId: "run-invalid", turnId: "turn-invalid" },
    )).resolves.toBe("settled");
    await manager.disposeAll();
  });

  it("settles a refused concurrent owner without disturbing the active run", async () => {
    const { manager, cancelCalls } = pendingManager();
    const live = manager.run(input());
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(() => manager.run(input({ runId: "run-refused", turnId: "turn-refused" })))
      .toThrow("This conversation already has an active provider run.");

    await expect(manager.stopOwned(
      "refusal-conversation",
      { runId: "run-refused", turnId: "turn-refused" },
    )).resolves.toBe("settled");
    expect(cancelCalls).toEqual([]);
    expect(manager.ownsRun("refusal-conversation", { runId: "run-live", turnId: "turn-live" })).toBe(true);

    await expect(manager.stopOwned(
      "refusal-conversation",
      { runId: "run-live", turnId: "turn-live" },
    )).resolves.toBe("settled");
    await expect(live).resolves.toMatchObject({ status: "cancelled" });
  });

  it.each([
    ["B then C", ["b", "c"]],
    ["C then B", ["c", "b"]],
  ] as const)("settles every concurrently refused owner without disturbing the active run (%s)", async (_order, stopOrder) => {
    const { manager, cancelCalls } = pendingManager();
    const live = manager.run(input());
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    for (const owner of ["b", "c"]) {
      expect(() => manager.run(input({ runId: `run-${owner}`, turnId: `turn-${owner}` })))
        .toThrow("This conversation already has an active provider run.");
    }
    for (const owner of stopOrder) {
      await expect(manager.stopOwned(
        "refusal-conversation",
        { runId: `run-${owner}`, turnId: `turn-${owner}` },
      )).resolves.toBe("settled");
    }

    expect(cancelCalls).toEqual([]);
    expect(manager.ownsRun("refusal-conversation", { runId: "run-live", turnId: "turn-live" })).toBe(true);
    expect(manager.cancel("refusal-conversation")).toBe(true);
    await expect(live).resolves.toMatchObject({ status: "cancelled" });
  });

  it("never disturbs the active run once more owners are refused than it can record", async () => {
    const { manager, cancelCalls } = pendingManager();
    const live = manager.run(input());
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const owners = Array.from({ length: 65 }, (_, index) => ({
      runId: `run-refused-${index}`,
      turnId: `turn-refused-${index}`,
    }));

    for (const owner of owners) {
      expect(() => manager.run(input(owner))).toThrow("already has an active provider run");
    }
    const stops = [];
    for (const owner of owners) {
      stops.push(await manager.stopOwned("refusal-conversation", owner));
    }

    expect(stops.slice(0, 64)).toEqual(Array.from({ length: 64 }, () => "settled"));
    expect(stops[64]).toBe("identity-mismatch");
    await expect(manager.stopOwned(
      "refusal-conversation",
      { runId: "run-unknown", turnId: "turn-unknown" },
    )).resolves.toBe("identity-mismatch");
    expect(cancelCalls).toEqual([]);
    expect(manager.cancel("refusal-conversation")).toBe(true);
    await expect(live).resolves.toMatchObject({ status: "cancelled" });
  });

  it("does not let a refusal recorded against an earlier run settle a later run", async () => {
    const { manager, cancelCalls } = pendingManager();
    const first = manager.run(input());
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const retried = { runId: "run-retried", turnId: "turn-retried" };
    expect(() => manager.run(input(retried))).toThrow("already has an active provider run");
    await expect(manager.stopOwned(
      "refusal-conversation",
      { runId: "run-live", turnId: "turn-live" },
    )).resolves.toBe("settled");
    await expect(first).resolves.toMatchObject({ status: "cancelled" });

    const later = manager.run(input(retried));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(manager.ownsRun("refusal-conversation", retried)).toBe(true);

    await expect(manager.stopOwned("refusal-conversation", retried)).resolves.toBe("settled");
    expect(cancelCalls).toEqual([false, false]);
    await expect(later).resolves.toMatchObject({ status: "cancelled" });
  });

  it("keeps the fail-closed mismatch for an unrecognized owner of the active run", async () => {
    const { manager, cancelCalls } = pendingManager();
    const live = manager.run(input());
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    await expect(manager.stopOwned(
      "refusal-conversation",
      { runId: "run-unknown", turnId: "turn-unknown" },
    )).resolves.toBe("identity-mismatch");
    expect(cancelCalls).toEqual([false]);
    expect(manager.cancel("refusal-conversation")).toBe(false);
    await expect(live).resolves.toMatchObject({ status: "cancelled" });
  });

  it("does not treat a repeated start of the live owner as a refusal receipt", async () => {
    const { manager, cancelCalls } = pendingManager();
    const live = manager.run(input());
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(() => manager.run(input())).toThrow("This conversation already has an active provider run.");
    expect(manager.ownsRun("refusal-conversation", { runId: "run-live", turnId: "turn-live" })).toBe(true);

    await expect(manager.stopOwned(
      "refusal-conversation",
      { runId: "run-live", turnId: "turn-live" },
    )).resolves.toBe("settled");
    expect(cancelCalls).toEqual([false]);
    await expect(live).resolves.toMatchObject({ status: "cancelled" });
  });
});
