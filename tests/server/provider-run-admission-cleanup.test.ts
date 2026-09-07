// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHarnessRegistry } from "../../src/server/provider/agent-harness-registry";
import { createCodexAppServerHarness } from "../../src/server/provider/codex-app-server-harness";
import type { AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";
import { providerRunTerminal } from "../../src/server/provider/contracts";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { ProviderRunCoordinator } from "../../src/server/provider/run-coordinator";
import { nativeProviderRunInput } from "./model-route-fixture";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

function fixture() {
  const start = vi.fn(({ input }: AgentHarnessStartOptions) => ({
    harnessId: "codex-app-server" as const,
    providerId: "codex" as const,
    extension: {
      kind: "codex-app-server" as const,
      respondToApproval: () => false,
      respondToInput: () => false,
      setGoal: async () => { throw new Error("Goals unavailable in this fixture."); },
      clearGoal: async () => false,
    },
    cancel: vi.fn(),
    result: Promise.resolve({
      ...providerRunTerminal(input, "completed"),
      text: "Done.",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    }),
  }));
  const release = vi.fn(() => true);
  const acquireInstallationUse = vi.fn(() => ({ release, quarantine: vi.fn() }));
  const capabilityAdmissible = vi.fn(() => false);
  const resolveBackendLaunchOptions = vi.fn((_input, environment) => ({ environment }));
  const coordinator = new ProviderRunCoordinator({
    cancelGraceMs: 1,
    harnessRegistry: new AgentHarnessRegistry([{ ...createCodexAppServerHarness(), start }]),
    metadataCache: new ProviderMetadataCache(),
    resolveBackendLaunchOptions,
    commandFor: () => "never-spawned-codex",
    resolvedCommandFor: () => "never-spawned-codex",
    rememberResolvedCommand: () => undefined,
    processEnvironment: () => ({}),
    capabilityAvailable: () => true,
    capabilityAdmissible,
    acquireInstallationUse,
  });
  const input = nativeProviderRunInput({
    providerId: "codex",
    conversationId: "refused-conversation",
    cwd: process.cwd(),
    prompt: "Do the work.",
    interactionMode: "build",
    access: "supervised",
  });
  return { coordinator, input, start, capabilityAdmissible, acquireInstallationUse, resolveBackendLaunchOptions, release };
}

describe("provider admission cleanup proof", () => {
  it("settles the pre-persisted turn owner when capability admission refuses before launch", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const value = fixture();
    vi.spyOn(runtime.provider, "run").mockImplementation((input, callbacks) => {
      expect(runtime.store.providerRunOwnership.forConversation(input.conversationId))
        .toHaveLength(1);
      return value.coordinator.run(input, callbacks);
    });
    vi.spyOn(runtime.provider, "cancel").mockImplementation(() =>
      value.coordinator.cancel(runtime.conversationId));
    vi.spyOn(runtime.provider, "isRunning").mockImplementation((id) =>
      value.coordinator.isRunning(id));
    vi.spyOn(runtime.provider, "stopOwned").mockImplementation((id, owner) =>
      value.coordinator.stopOwned(id, owner));

    try {
      const first = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Refuse this unverified installation before launch.",
      });
      expect(runtime.controller.start(first.turn.id)).toBe(false);
      await flushTurnControllerTestPromises();

      expect(value.acquireInstallationUse).not.toHaveBeenCalled();
      expect(value.resolveBackendLaunchOptions).not.toHaveBeenCalled();
      expect(value.start).not.toHaveBeenCalled();
      expect(runtime.store.agentTurn(first.turn.id)).toMatchObject({
        status: "failed",
        runState: { state: "failed" },
        terminalReason: "turn-start-failed",
      });
      expect(runtime.store.providerRunOwnership.forConversation(runtime.conversationId)).toEqual([]);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.events).toContainEqual(expect.objectContaining({
        type: "agent.failed",
        message: "The exact provider installation does not attest 'text-streaming'.",
      }));

      value.capabilityAdmissible.mockReturnValue(true);
      const retry = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Retry after installation evidence is repaired.",
      });
      expect(runtime.controller.start(retry.turn.id)).toBe(true);
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(retry.turn.id).status).toBe("completed");
      expect(value.start).toHaveBeenCalledOnce();
      expect(value.release).toHaveBeenCalledOnce();
    } finally {
      runtime.store.close();
    }
  });

  it("confirms only the exact refused conversation, run, and turn", async () => {
    const { coordinator, input, start, acquireInstallationUse } = fixture();
    expect(() => coordinator.run(input)).toThrow("does not attest");
    expect(start).not.toHaveBeenCalled();
    expect(acquireInstallationUse).not.toHaveBeenCalled();
    await expect(coordinator.stopOwned(input.conversationId, input)).resolves.toBe("settled");
    await expect(coordinator.stopOwned("another-conversation", input)).resolves.toBe("missing");
    await expect(coordinator.stopOwned(input.conversationId, {
      ...input, runId: "another-run",
    })).resolves.toBe("missing");
    await expect(coordinator.stopOwned(input.conversationId, {
      ...input, turnId: "another-turn",
    })).resolves.toBe("missing");
  });

  it("also settles an explicit custom-model refusal without acquiring installation authority", async () => {
    const { coordinator, input, acquireInstallationUse, start } = fixture();
    input.backendProfile = { ...input.backendProfile, source: "custom" };
    expect(() => coordinator.run(input)).toThrow("does not match the exact probed model identity");
    expect(acquireInstallationUse).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await expect(coordinator.stopOwned(input.conversationId, input)).resolves.toBe("settled");
  });

  it("does not synthesize cleanup proof for an unexpected admission exception", async () => {
    const { coordinator, input, capabilityAdmissible } = fixture();
    capabilityAdmissible.mockImplementationOnce(() => { throw new Error("Authority unavailable."); });
    expect(() => coordinator.run(input)).toThrow("Authority unavailable.");
    await expect(coordinator.stopOwned(input.conversationId, input)).resolves.toBe("missing");
  });

  it("does not turn a post-start exception into proof of cleanup", async () => {
    const { coordinator, input, start, capabilityAdmissible, release } = fixture();
    capabilityAdmissible.mockReturnValue(true);
    start.mockImplementationOnce(() => { throw new Error("Harness failed after invocation."); });
    expect(() => coordinator.run(input)).toThrow("Harness failed after invocation.");
    capabilityAdmissible.mockReturnValue(false);
    expect(() => coordinator.run(input)).toThrow("already has an active provider run");
    await expect(coordinator.stopOwned(input.conversationId, input)).resolves.toBe("force-detached");
    expect(coordinator.isRunning(input.conversationId)).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });
});
