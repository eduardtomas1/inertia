// @inertia-test-suite portable
import { expect, it, vi } from "vitest";
import { IsolatedRunController, type IsolatedRunProviderRuntime, type IsolatedRunStore } from "../../src/server/runtime/reviews/isolated-run-controller";
import { RuntimeUpdatePreparationGate } from "../../src/server/runtime-update-preparation";
import { runRuntimeShutdownPhases } from "../../src/server/runtime-shutdown";
import { providerRunTerminal, type ProviderRunInput, type ProviderRunResult } from "../../src/server/provider/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { resolveNativeModelRoute } from "./model-route-fixture";

it.each(["settled", "force-detached"] as const)("cancels a tracked isolated review before quiescence and retains %s cleanup proof", async (stopResult) => {
  vi.useFakeTimers();
  let input: ProviderRunInput | undefined;
  let resolveProvider!: (result: ProviderRunResult) => void;
  const providerResult = new Promise<ProviderRunResult>((resolve) => { resolveProvider = resolve; });
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const stopOwned = vi.fn(async () => {
    if (!input) throw new Error("The fixture provider did not start.");
    await stopGate;
    resolveProvider({ ...providerRunTerminal(input, "cancelled"), text: "", textTruncated: false,
      exitCode: 0, signal: null, cleanupConfirmed: stopResult === "settled" });
    return stopResult;
  });
  const provider: IsolatedRunProviderRuntime = {
    resolveModelRoute: resolveNativeModelRoute,
    harnessIdFor: (value) => value.harnessId,
    run: (value) => { input = value; started(); return providerResult; },
    isRunning: () => true,
    ownsRun: () => true,
    stopOwned,
  };
  const store = { createWorkspaceRun: vi.fn(), updateWorkspaceRun: vi.fn() } as unknown as IsolatedRunStore;
  const runtimeLifetimeAbort = new AbortController();
  const isolated = new IsolatedRunController(store, provider, "/unused-fixture-directory", () => {}, {
    lifetimeSignal: runtimeLifetimeAbort.signal,
    fileSystem: { create: async () => "/unused-fixture-task", protect: async () => {}, remove: async () => {} },
  });
  let closed = false;
  const gate = new RuntimeUpdatePreparationGate({
    isClosed: () => closed, activeRuntimeCommands: () => 1, databaseRecoveryActive: () => false,
    agentWorkActive: () => true, terminalActivity: () => false, providerMaintenanceActive: () => false,
    providerRefreshActive: () => false, artifactReconciliationActive: () => false,
    holdTerminalAdmission: () => {}, releaseTerminalAdmission: () => {}, drainAdditionalOperations: async () => {},
  });
  const trackedReview = gate.track(() => isolated.run({
    kind: "diff-summary", projectId: "project", conversationId: "conversation", owner: {},
    selection: { modelSelection: providerNativeModelSelection({ providerId: "codex" }) },
    request: { visibleContent: null, executionPrompt: "Summarize this fixed in-memory fixture." },
    label: "Review", detail: "In-memory fixture", toolPolicy: "none", interactionPolicy: "fail-closed",
    onResult: () => undefined,
  }));
  const observedReview = trackedReview.catch((error: unknown) => error);
  const drains = vi.fn();
  const stopIsolated = vi.fn(() => isolated.dispose("runtime-shutdown"));
  const closeStore = vi.fn();
  try {
    await providerStarted;
    closed = true;
    runtimeLifetimeAbort.abort(new Error("The runtime is shutting down."));
    const closing = runRuntimeShutdownPhases({
      quiesceRuntimeWork: () => gate.drainTracked(), independentDrains: [drains],
      stopIsolatedRuns: stopIsolated, disposeTurnsAndProviders: drains,
      settleArtifacts: drains, terminateClients: drains, closeServer: drains, closeStore,
    }, 100);
    const observedClose = closing.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(isolated.activeCount()).toBe(1);
    expect(stopOwned).toHaveBeenCalledExactlyOnceWith(
      input!.conversationId, { runId: input!.runId, turnId: input!.turnId }, 2_500,
    );
    expect(stopIsolated).not.toHaveBeenCalled();
    expect(drains).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();
    releaseStop();
    await vi.advanceTimersByTimeAsync(1);
    if (stopResult === "settled") {
      await expect(observedClose).resolves.toBeNull();
      expect(closeStore).toHaveBeenCalledOnce();
      expect(isolated.activeCount()).toBe(0);
    } else {
      await expect(observedClose).resolves.toMatchObject({ message: "Isolated provider cleanup remains unconfirmed." });
      expect(closeStore).not.toHaveBeenCalled();
      expect(isolated.activeCount()).toBe(1);
    }
    expect(stopIsolated).toHaveBeenCalledOnce();
    expect(store.updateWorkspaceRun).not.toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ status: "succeeded" }));
  } finally {
    releaseStop();
    await observedReview;
    await gate.drainTracked();
    expect(stopOwned).toHaveBeenCalledOnce();
    vi.useRealTimers();
  }
});
