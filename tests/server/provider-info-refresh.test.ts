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
  it("keeps a newer targeted result while an older broad refresh updates other providers", async () => {
    let providerInfo = initialProviderSnapshots();
    const metadata = {
      models: providerInfo[0]!.models,
      rateLimits: providerInfo[0]!.rateLimits,
      metadataState: providerInfo[0]!.metadataState,
    };
    const broadEnrichmentStarted = deferred<void>();
    const finishBroadEnrichment = deferred<typeof metadata>();
    const broadDetections = PROVIDER_IDS.map((providerId) => providerId === "codex"
      ? detection(providerId, "stale-unauthenticated", "unauthenticated", false)
      : detection(providerId, `broad-${providerId}`, "authenticated", true));
    const providers = {
      detectAll: vi.fn(async () => broadDetections),
      detect: vi.fn(async () =>
        detection("codex", "new-authenticated", "authenticated", true)),
      cachedMetadata: vi.fn(() => metadata),
      metadata: vi.fn(async (providerId: ProviderInfo["id"]) => {
        if (providerId !== "claude") return metadata;
        broadEnrichmentStarted.resolve();
        return await finishBroadEnrichment.promise;
      }),
      providerCapabilityContract: vi.fn(() => undefined),
    } as unknown as ProviderManager;
    const broadcastSnapshot = vi.fn();
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
      version: "stale-unauthenticated",
      authState: "unauthenticated",
      canRun: false,
    });
    await refresh("codex", true, true);

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
    expect(broadcastSnapshot).toHaveBeenCalledTimes(4);
  });
});
