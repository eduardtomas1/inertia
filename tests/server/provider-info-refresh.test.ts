// @inertia-test-suite portable

import { describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  PROVIDER_IDS,
  PROVIDER_INFO,
  ProviderManager,
  type ProviderDetection,
} from "../../src/server/providers";
import { createProviderInfoRefresh } from
  "../../src/server/provider/provider-info-refresh";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { RuntimeUpdatePreparationGate } from "../../src/server/runtime-update-preparation";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function detection(
  providerId: ProviderInfo["id"],
  version: string,
  authState: ProviderDetection["authState"],
  canRun: boolean,
): ProviderDetection {
  return {
    provider: PROVIDER_INFO[providerId],
    available: true,
    version,
    executable: `/provider/${providerId}`,
    installState: "installed",
    authState,
    canRun,
    cleanupConfirmed: true,
  };
}

describe("provider info refresh ownership", () => {
  it("publishes a completed catalog while another provider read is still pending", async () => {
    let providerInfo = initialProviderSnapshots();
    const empty = {
      models: [],
      rateLimits: [],
      metadataState: providerInfo[0]!.metadataState,
    };
    const catalog = {
      ...empty,
      models: [{
        id: "ready-model", label: "Ready model", description: "Fixture model",
        isDefault: true, inputModalities: ["text"] as const,
        reasoningOptions: [], defaultReasoningEffort: "",
      }],
    };
    const otherRead = deferred<typeof empty>();
    const started = deferred<void>();
    const providers = {
      detectAll: vi.fn(async () => [
        detection("codex", "1", "authenticated", true),
        detection("claude", "1", "authenticated", true),
      ]),
      cachedMetadata: vi.fn(() => empty),
      metadata: vi.fn(async (id: ProviderInfo["id"]) => {
        if (id === "codex") return catalog;
        started.resolve();
        return await otherRead.promise;
      }),
      providerCapabilityContract: vi.fn(() => undefined),
      metadataReadFailed: () => false,
    } as unknown as ProviderManager;
    const published: ProviderInfo[][] = [];
    const activity = vi.fn();
    const refresh = createProviderInfoRefresh({
      enabled: true, providers, defaultWorkspacePath: "/workspace",
      lifetimeSignal: new AbortController().signal,
      providerInfo: () => providerInfo,
      replaceProviderInfo: (value) => { providerInfo = value; },
      broadcastSnapshot: () => { published.push(structuredClone(providerInfo)); },
      isClosed: () => false, track: async (operation) => await operation(),
      onActivityChange: activity,
    });
    const refreshing = refresh();
    try {
      await started.promise;
      await vi.waitFor(() => {
        expect(published.at(-1)?.find(({ id }) => id === "codex")?.models)
          .toEqual(catalog.models);
      });
      expect(providerInfo.find(({ id }) => id === "claude")?.models).toEqual([]);
      // Publishing one provider must not finish the operation or release the
      // activity owner while an admitted metadata read remains outstanding.
      expect(activity.mock.calls).toEqual([[1]]);
    } finally {
      otherRead.resolve(empty);
      await refreshing;
    }
    expect(activity.mock.calls).toEqual([[1], [-1]]);
    expect(providerInfo.find(({ id }) => id === "codex")?.models).toEqual(catalog.models);
  });

  it("keeps a newer targeted result while an older broad refresh updates other providers", async () => {
    let providerInfo = initialProviderSnapshots();
    const metadata = {
      models: providerInfo[0]!.models,
      rateLimits: providerInfo[0]!.rateLimits,
      metadataState: providerInfo[0]!.metadataState,
    };
    const broadEnrichmentStarted = deferred<void>();
    const finishBroadEnrichment = deferred<typeof metadata>();
    let codexReads = 0;
    const broadDetections = PROVIDER_IDS.map((providerId) => providerId === "codex"
      ? detection(providerId, "old-authenticated", "authenticated", true)
      : detection(providerId, `broad-${providerId}`, "authenticated", true));
    const providers = {
      detectAll: vi.fn(async () => broadDetections),
      detect: vi.fn(async () =>
        detection("codex", "new-authenticated", "authenticated", true)),
      cachedMetadata: vi.fn(() => metadata),
      metadata: vi.fn(async (providerId: ProviderInfo["id"]) => {
        const olderCodex = providerId === "codex" && ++codexReads === 1;
        if (providerId !== "claude" && !olderCodex) return metadata;
        broadEnrichmentStarted.resolve();
        return await finishBroadEnrichment.promise;
      }),
      providerCapabilityContract: vi.fn(() => undefined),
      metadataReadFailed: () => false,
    } as unknown as ProviderManager;
    const broadcastSnapshot = vi.fn(() => structuredClone(providerInfo));
    const refresh = createProviderInfoRefresh({
      enabled: true,
      providers,
      defaultWorkspacePath: "/workspace",
      lifetimeSignal: new AbortController().signal,
      providerInfo: () => providerInfo,
      replaceProviderInfo: (value) => { providerInfo = value; },
      broadcastSnapshot,
      isClosed: () => false,
      track: async (operation) => await operation(),
      onActivityChange: vi.fn(),
    });

    const startupRefresh = refresh(undefined, true);
    await broadEnrichmentStarted.promise;
    expect(providers.detectAll).toHaveBeenCalledOnce();
    expect(providerInfo.find(({ id }) => id === "codex")).toMatchObject({
      version: "old-authenticated",
      authState: "authenticated",
      canRun: true,
    });
    await refresh("codex", true, true);
    const targetedPublication = broadcastSnapshot.mock.results.length;

    finishBroadEnrichment.resolve(metadata);
    await startupRefresh;

    expect(providerInfo.find(({ id }) => id === "codex")).toMatchObject({
      version: "new-authenticated",
      authState: "authenticated",
      canRun: true,
    });
    expect(providerInfo.find(({ id }) => id === "claude")).toMatchObject({
      version: "broad-claude",
      authState: "authenticated",
      canRun: true,
    });
    expect(broadcastSnapshot.mock.results.slice(targetedPublication).length).toBeGreaterThan(0);
    for (const publication of broadcastSnapshot.mock.results.slice(targetedPublication)) {
      expect(publication.value.find(({ id }: ProviderInfo) => id === "codex"))
        .toMatchObject({ version: "new-authenticated", canRun: true });
    }
  });

  it("publishes a forced retry after an initial settled read failure in the same cache", async () => {
    let providerInfo = initialProviderSnapshots();
    const recoveredModel = {
      id: "recovered", label: "Recovered", description: "Fixture model",
      isDefault: true, inputModalities: ["text" as const],
      reasoningOptions: [], defaultReasoningEffort: "",
    };
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("Injected settled metadata read failure"))
      .mockResolvedValueOnce({ models: [recoveredModel] });
    const cache = new ProviderMetadataCache({ read });
    const detected = detection("codex", "1", "authenticated", true);
    const metadata = vi.fn(async (
      id: ProviderInfo["id"], cwd: string, options: { force: boolean },
    ) => await cache.metadata(id, detected.executable!, {}, cwd, options));
    const providers = {
      detectAll: vi.fn(async () => [detected]),
      detect: vi.fn(async () => detected),
      cachedMetadata: (id: ProviderInfo["id"]) => cache.current(id),
      metadata,
      providerCapabilityContract: () => undefined,
      metadataReadFailed: () => false,
    } as unknown as ProviderManager;
    const refresh = createProviderInfoRefresh({
      enabled: true, providers, defaultWorkspacePath: "/workspace",
      lifetimeSignal: new AbortController().signal,
      providerInfo: () => providerInfo,
      replaceProviderInfo: (value) => { providerInfo = value; },
      broadcastSnapshot: vi.fn(), isClosed: () => false,
      track: async (operation) => await operation(), onActivityChange: vi.fn(),
    });
    await refresh();
    expect(providerInfo.find(({ id }) => id === "codex")).toMatchObject({
      canRun: true, models: [],
      metadataState: { models: {
        lastAttemptedAt: expect.any(String), refreshing: false, freshness: "unavailable",
      } },
    });
    await refresh("codex", true, true);
    expect(metadata.mock.calls.map(([, , options]) => options.force)).toEqual([false, true]);
    expect(providers.detect).toHaveBeenCalledWith("codex", expect.objectContaining({ refreshEnvironment: true }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(providerInfo.find(({ id }) => id === "codex")).toMatchObject({
      models: [recoveredModel], metadataState: { models: { freshness: "fresh", refreshing: false } },
    });
  });

  it("retries a failed catalog read in the background with a longer deadline", async () => {
    let providerInfo = initialProviderSnapshots();
    const recoveredModel = {
      id: "recovered", label: "Recovered", description: "Fixture model",
      isDefault: true, inputModalities: ["text" as const],
      reasoningOptions: [], defaultReasoningEffort: "",
    };
    const deadlines: number[] = [];
    const read = vi.fn(async (...args: unknown[]) => {
      deadlines.push(args[6] as number);
      if (deadlines.length === 1) throw new Error("Claude metadata discovery timed out.");
      return { models: [recoveredModel] };
    });
    const cache = new ProviderMetadataCache({ read });
    const detected = detection("claude", "1", "authenticated", true);
    const providers = {
      detect: vi.fn(async () => detected),
      cachedMetadata: (id: ProviderInfo["id"]) => cache.current(id),
      metadata: vi.fn(async (id: ProviderInfo["id"], cwd: string, options: object) => (
        await cache.metadata(id, detected.executable!, {}, cwd, options)
      )),
      metadataReadFailed: (id: ProviderInfo["id"]) => cache.lastReadFailed(id),
      providerCapabilityContract: () => undefined,
    } as unknown as ProviderManager;
    const refresh = createProviderInfoRefresh({
      enabled: true, providers, defaultWorkspacePath: "/workspace",
      lifetimeSignal: new AbortController().signal,
      providerInfo: () => providerInfo,
      replaceProviderInfo: (value) => { providerInfo = value; },
      broadcastSnapshot: vi.fn(), isClosed: () => false,
      track: async (operation) => await operation(), onActivityChange: vi.fn(),
      detectionRetryDelaysMs: [10, 10, 10],
    });

    await refresh("claude", true, true);
    expect(providerInfo.find(({ id }) => id === "claude")).toMatchObject({ canRun: true, models: [] });

    await vi.waitFor(() => {
      expect(providerInfo.find(({ id }) => id === "claude")?.models).toMatchObject([recoveredModel]);
    }, { timeout: 1_000 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(deadlines[1]).toBeGreaterThan(deadlines[0]!);
  });

  it("scales the catalog read deadline with the measured version probe latency", async () => {
    let providerInfo = initialProviderSnapshots();
    const empty = { models: [], rateLimits: [], metadataState: providerInfo[0]!.metadataState };
    const providers = {
      detect: vi.fn(async () => ({ ...detection("claude", "1", "authenticated", true), probeLatencyMs: 2_400 })),
      cachedMetadata: vi.fn(() => empty),
      metadata: vi.fn(async () => empty),
      providerCapabilityContract: vi.fn(() => undefined),
      metadataReadFailed: () => false,
    } as unknown as ProviderManager;
    const refresh = createProviderInfoRefresh({
      enabled: true, providers, defaultWorkspacePath: "/workspace",
      lifetimeSignal: new AbortController().signal,
      providerInfo: () => providerInfo,
      replaceProviderInfo: (value) => { providerInfo = value; },
      broadcastSnapshot: vi.fn(), isClosed: () => false,
      track: async (operation) => await operation(), onActivityChange: vi.fn(),
    });

    await refresh("claude", true, true);

    expect(providers.metadata).toHaveBeenCalledWith("claude", "/workspace", expect.objectContaining({
      force: true, timeoutMs: 28_800,
    }));
  });

  describe("broad refreshes", () => {
    function broadRuntime(detect: (providerId: ProviderInfo["id"]) => Promise<ProviderDetection>) {
      let providerInfo = initialProviderSnapshots();
      const lifetime = new AbortController();
      const manager = ProviderManager.createForTests({
        lifetimeSignal: lifetime.signal,
        metadataCache: new ProviderMetadataCache({ read: async () => ({}) }),
        detectProvider: async (providerId) => await detect(providerId),
      });
      const refresh = createProviderInfoRefresh({
        enabled: true, providers: manager, defaultWorkspacePath: "/workspace",
        lifetimeSignal: lifetime.signal,
        providerInfo: () => providerInfo,
        replaceProviderInfo: (value) => { providerInfo = value; },
        broadcastSnapshot: vi.fn(), isClosed: () => lifetime.signal.aborted,
        track: async (operation) => await operation(), onActivityChange: vi.fn(),
      });
      return {
        refresh,
        provider: (id: ProviderInfo["id"]) => providerInfo.find((candidate) => candidate.id === id)!,
        close: () => lifetime.abort(new Error("The runtime is shutting down.")),
      };
    }
    const absent = (providerId: ProviderInfo["id"]): ProviderDetection => ({
      provider: PROVIDER_INFO[providerId], available: false, installState: "not-installed",
      authState: "unknown", canRun: false, cleanupConfirmed: true, statusMessage: "CLI not found",
    });

    it("publishes each provider as soon as its own detection completes", async () => {
      const slow = deferred<ProviderDetection>();
      const runtime = broadRuntime(async (providerId) => providerId === "cursor"
        ? await slow.promise
        : providerId === "claude"
          ? detection("claude", "2.1.200", "authenticated", true)
          : absent(providerId));

      const refreshing = runtime.refresh(undefined, true);
      await vi.waitFor(() => {
        expect(runtime.provider("claude")).toMatchObject({ authState: "authenticated", canRun: true });
      }, { timeout: 1_000 });
      expect(runtime.provider("cursor")).toMatchObject({ installState: "checking", authState: "checking" });
      slow.resolve(absent("cursor"));
      await refreshing;
      expect(runtime.provider("cursor")).toMatchObject({ installState: "not-installed" });
      runtime.close();
    });

    it("keeps every other provider's result when one provider's detection fails", async () => {
      const runtime = broadRuntime(async (providerId) => {
        if (providerId === "kimi") throw new Error("Injected Kimi discovery failure");
        return providerId === "claude"
          ? detection("claude", "2.1.200", "authenticated", true)
          : absent(providerId);
      });

      await runtime.refresh(undefined, true).catch(() => undefined);

      expect(runtime.provider("claude")).toMatchObject({ authState: "authenticated", canRun: true });
      expect(runtime.provider("codex")).toMatchObject({ installState: "not-installed" });
      expect(runtime.provider("kimi")).toMatchObject({
        installState: "error", authState: "error", canRun: false, statusMessage: "Agent discovery failed",
      });
      runtime.close();
    });
  });

  describe("background detection retries", () => {
    const empty = {
      models: [],
      rateLimits: [],
      metadataState: initialProviderSnapshots()[0]!.metadataState,
    };
    const timedOut = (version = "1"): ProviderDetection => ({
      ...detection("codex", version, "error", false),
      probeTimedOut: true,
      statusMessage: "Codex did not answer the sign-in check in time; refresh to try again",
    });

    function setup(options: {
      retryDelaysMs: readonly number[];
      detect: (call: number) => Promise<ProviderDetection>;
      gate?: RuntimeUpdatePreparationGate;
      activity?: { count: number };
    }) {
      let providerInfo = initialProviderSnapshots();
      const lifetime = new AbortController();
      let closed = false;
      let calls = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      const detect = vi.fn(async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await options.detect(calls);
        } finally {
          inFlight -= 1;
        }
      });
      const providers = {
        detectAll: vi.fn(async () => [
          await detect(),
          detection("claude", "1", "authenticated", true),
        ]),
        detect,
        cachedMetadata: vi.fn(() => empty),
        metadata: vi.fn(async () => empty),
        providerCapabilityContract: vi.fn(() => undefined),
        metadataReadFailed: () => false,
      } as unknown as ProviderManager;
      const refresh = createProviderInfoRefresh({
        enabled: true, providers, defaultWorkspacePath: "/workspace",
        lifetimeSignal: lifetime.signal,
        providerInfo: () => providerInfo,
        replaceProviderInfo: (value) => { providerInfo = value; },
        broadcastSnapshot: vi.fn(),
        isClosed: () => closed,
        track: options.gate
          ? async (operation) => await options.gate!.track(operation)
          : async (operation) => await operation(),
        onActivityChange: (delta) => {
          if (options.activity) options.activity.count += delta;
        },
        detectionRetryDelaysMs: options.retryDelaysMs,
      });
      return {
        refresh,
        detect,
        maxInFlight: () => maxInFlight,
        codex: () => providerInfo.find(({ id }) => id === "codex")!,
        close: () => {
          closed = true;
          lifetime.abort(new Error("The runtime is shutting down."));
        },
      };
    }

    it("resolves after the first timed-out attempt and retries in the background until ready", async () => {
      const runtime = setup({
        retryDelaysMs: [20, 20, 20],
        detect: async (call) => call < 3 ? timedOut() : detection("codex", "2", "authenticated", true),
      });

      await runtime.refresh();

      expect(runtime.detect).toHaveBeenCalledOnce();
      expect(runtime.codex()).toMatchObject({
        installState: "installed",
        authState: "checking",
        canRun: false,
        statusMessage: "Codex is slow to respond; checking again",
      });
      await vi.waitFor(() => {
        expect(runtime.codex()).toMatchObject({ version: "2", authState: "authenticated", canRun: true });
      });
      expect(runtime.detect).toHaveBeenCalledTimes(3);
      const retries = runtime.detect.mock.calls.slice(1) as unknown as Array<[string, { timeoutMs: number; refreshEnvironment: boolean }]>;
      expect(retries.map(([providerId]) => providerId)).toEqual(["codex", "codex"]);
      expect(retries.map(([, options]) => options)).toMatchObject([
        { timeoutMs: 8_000, refreshEnvironment: false },
        { timeoutMs: 16_000, refreshEnvironment: false },
      ]);
    });

    it("ends bounded background retries with an honest connection issue", async () => {
      const runtime = setup({ retryDelaysMs: [5, 5, 5], detect: async () => timedOut() });

      await runtime.refresh("codex");

      await vi.waitFor(() => {
        expect(runtime.codex().authState).toBe("error");
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runtime.detect).toHaveBeenCalledTimes(4);
      expect(runtime.codex()).toMatchObject({
        installState: "installed",
        canRun: false,
        statusMessage: "Codex did not answer the sign-in check in time; refresh to try again",
      });
    });

    it("cancels a pending background retry when the runtime shuts down", async () => {
      const runtime = setup({ retryDelaysMs: [30], detect: async () => timedOut() });

      await runtime.refresh("codex");
      runtime.close();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(runtime.detect).toHaveBeenCalledOnce();
      expect(runtime.codex().authState).toBe("checking");
    });

    it("lets a newer refresh supersede a pending retry", async () => {
      const runtime = setup({
        retryDelaysMs: [40],
        detect: async (call) => call === 1 ? timedOut() : detection("codex", "2", "authenticated", true),
      });

      await runtime.refresh("codex");
      await runtime.refresh("codex");
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(runtime.detect).toHaveBeenCalledTimes(2);
      expect(runtime.codex()).toMatchObject({ version: "2", canRun: true });
    });

    it("waits for an in-flight retry before a newer refresh probes the same provider", async () => {
      const retryProbe = deferred<ProviderDetection>();
      const retryStarted = deferred<void>();
      const runtime = setup({
        retryDelaysMs: [5, 5],
        detect: async (call) => {
          if (call === 1) return timedOut();
          if (call === 2) {
            retryStarted.resolve();
            return await retryProbe.promise;
          }
          return detection("codex", "3", "authenticated", true);
        },
      });

      await runtime.refresh("codex");
      await retryStarted.promise;
      const newer = runtime.refresh("codex");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runtime.detect).toHaveBeenCalledTimes(2);
      retryProbe.resolve(timedOut("2"));
      await newer;
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(runtime.maxInFlight()).toBe(1);
      expect(runtime.detect).toHaveBeenCalledTimes(3);
      expect(runtime.codex()).toMatchObject({ version: "3", canRun: true });
    });

    it("does not hold update preparation while a retry is pending", async () => {
      const activity = { count: 0 };
      const gate = new RuntimeUpdatePreparationGate({
        isClosed: () => false, activeRuntimeCommands: () => 0, databaseRecoveryActive: () => false,
        agentWorkActive: () => false, terminalActivity: () => false, providerMaintenanceActive: () => false,
        providerRefreshActive: () => activity.count > 0, artifactReconciliationActive: () => false,
        holdTerminalAdmission: () => {}, releaseTerminalAdmission: () => {}, drainAdditionalOperations: async () => {},
      });
      const runtime = setup({ retryDelaysMs: [30], detect: async () => timedOut(), gate, activity });

      await runtime.refresh("codex");
      const startedAt = Date.now();
      await expect(gate.prepare("update")).resolves.toEqual({ ready: true });
      expect(Date.now() - startedAt).toBeLessThan(20);
      await vi.waitFor(() => {
        expect(runtime.codex().authState).toBe("error");
      });

      expect(runtime.detect).toHaveBeenCalledOnce();
      expect(runtime.codex()).toMatchObject({
        installState: "installed",
        canRun: false,
        statusMessage: "Codex did not answer the sign-in check in time; refresh to try again",
      });
      expect(gate.release("update")).toBe(true);
    });
  });
});
