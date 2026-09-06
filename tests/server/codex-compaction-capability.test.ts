// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import type { AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { createCodexAppServerHarness } from "../../src/server/provider/codex-app-server-harness";
import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { continuationIdentityForSelection, withModelSelectionFastMode } from "../../src/shared/model-routing";
import { nativeProviderRunInput } from "./model-route-fixture";

const managers: ProviderManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

async function fixture(options: {
  selectedTier: "priority" | null;
  echoedTier: "priority" | "default" | null | undefined;
  resumedThread?: string;
}) {
  const events: AgentHarnessEvent[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const harness = createCodexAppServerHarness({
    withControlClient: async (control, run) => await run({
      request: async (method, params = {}) => {
        requests.push({ method, params });
        if (method === "thread/resume") {
          return {
            thread: { id: options.resumedThread ?? params.threadId },
            ...(options.echoedTier !== undefined ? { serviceTier: options.echoedTier } : {}),
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/compact/start") {
          const notify = control.onNotification!;
          const threadId = params.threadId;
          const turn = { id: "compaction-turn", status: "inProgress", items: [], error: null };
          const item = { id: "compaction-item", type: "contextCompaction" };
          notify("turn/started", { threadId, turn });
          notify("item/started", { threadId, turnId: turn.id, item, startedAtMs: 1 });
          notify("item/completed", { threadId, turnId: turn.id, item, completedAtMs: 2 });
          notify("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
          return {};
        }
        if (method === "thread/turns/list") {
          return { data: [{ id: "compaction-turn" }, { id: "previous-turn" }] };
        }
        throw new Error(`Unexpected compaction request: ${method}`);
      },
    }),
  });
  const manager = ProviderManager.createProduction({
    commands: { codex: process.execPath },
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    detectProvider: async () => ({
      provider: { id: "codex", name: "Codex", command: "codex" },
      available: true, version: "1.0.0", executable: process.execPath,
      installState: "installed", authState: "authenticated", canRun: true, cleanupConfirmed: true,
    }),
  }, new AgentHarnessRegistry([{
    ...harness,
    start: (startOptions) => harness.start({
      ...startOptions,
      callbacks: {
        ...startOptions.callbacks,
        onEvent: (event) => {
          events.push(event);
          startOptions.callbacks?.onEvent?.(event);
        },
      },
    }),
  }]));
  managers.push(manager);
  await manager.detect("codex");
  const base = nativeProviderRunInput({
    providerId: "codex", conversationId: "compact-capability", cwd: process.cwd(),
    prompt: "/compact", model: "model-a", sessionId: "selected-thread",
    interactionMode: "build", access: "supervised",
  });
  const modelSelection = withModelSelectionFastMode(base.modelSelection, options.selectedTier);
  const input = {
    ...base, modelSelection, supportedFastMode: "priority" as const,
    continuationIdentity: continuationIdentityForSelection(modelSelection, null, false),
  };
  return { manager, input, events, requests };
}

describe("Codex compaction exact-run performance capability", () => {
  it.each([
    { label: "Standard", selectedTier: null, echoedTier: "default" },
    { label: "Fast", selectedTier: "priority", echoedTier: "priority" },
  ] as const)("completes $label compaction under production capability enforcement", async (mode) => {
    const { manager, input, events, requests } = await fixture(mode);
    expect(manager.providerCapabilityAvailable(input, "performance-modes")).toBe(false);
    expect(manager.providerCapabilityAdmissible(input, "performance-modes")).toBe(true);

    await expect(manager.compact(input)).resolves.toMatchObject({ status: "completed" });

    expect(requests.find(({ method }) => method === "thread/resume"))
      .toMatchObject({ params: { threadId: input.sessionId, serviceTier: mode.selectedTier } });
    expect(events.filter((event) => event.type === "capability-observation"
      && event.capabilityId === "performance-modes")).toEqual([
      expect.objectContaining({ type: "capability-observation", capabilityId: "performance-modes",
        available: true, conversationId: input.conversationId, runId: input.runId, turnId: input.turnId }),
    ]);
    expect(manager.providerCapabilityAvailable(input, "performance-modes")).toBe(false);
    expect(manager.isRunning(input.conversationId)).toBe(false);
  });

  it.each([
    { selectedTier: "priority", echoedTier: null, expected: "service tier for compaction" },
    { selectedTier: null, echoedTier: "priority", expected: "service tier for compaction" },
    { selectedTier: null, echoedTier: undefined, expected: "service tier for compaction" },
    { selectedTier: "priority", echoedTier: "priority", resumedThread: "different-thread", expected: "exact thread selected for compaction" },
  ] as const)("rejects mismatched resume evidence $expected", async (mode) => {
    const { manager, input, events, requests } = await fixture(mode);

    await expect(manager.compact(input)).resolves.toMatchObject({
      status: "failed", message: expect.stringContaining(mode.expected),
    });

    expect(requests.map(({ method }) => method)).toEqual(["thread/resume"]);
    expect(events.some((event) => event.type === "capability-observation"
      && event.capabilityId === "performance-modes")).toBe(false);
    expect(manager.isRunning(input.conversationId)).toBe(false);
  });

  it("does not claim speed negotiation when the model has no supported Fast mode", async () => {
    const { manager, input, events, requests } = await fixture({
      selectedTier: null, echoedTier: "default",
    });

    await expect(manager.compact({ ...input, supportedFastMode: undefined }))
      .resolves.toMatchObject({ status: "completed" });

    expect(requests.find(({ method }) => method === "thread/resume")?.params)
      .not.toHaveProperty("serviceTier");
    expect(events.some((event) => event.type === "capability-observation"
      && event.capabilityId === "performance-modes")).toBe(false);
  });
});
