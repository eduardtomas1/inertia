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
