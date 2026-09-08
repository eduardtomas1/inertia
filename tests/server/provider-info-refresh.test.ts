// @inertia-test-suite portable

import { describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  PROVIDER_IDS,
  PROVIDER_INFO,
  type ProviderDetection,
  type ProviderManager,
} from "../../src/server/providers";
import { createProviderInfoRefresh } from
  "../../src/server/provider/provider-info-refresh";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";

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
});
