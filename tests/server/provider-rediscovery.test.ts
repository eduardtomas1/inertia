// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  PROVIDER_IDS,
  PROVIDER_INFO,
  type ProviderDetection,
  type ProviderInstallationEvent,
  type ProviderManager,
} from "../../src/server/providers";
import { createProviderInfoRefresh } from "../../src/server/provider/provider-info-refresh";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";

afterEach(() => {
  vi.useRealTimers();
});

function absent(providerId: ProviderInfo["id"]): ProviderDetection {
  return {
    provider: PROVIDER_INFO[providerId],
    available: false,
    installState: "not-installed",
    authState: "unknown",
    canRun: false,
    cleanupConfirmed: true,
  };
}

function runtime(installationState: (providerId: ProviderInfo["id"]) => "current" | "changed" | "unverified" = () => "current") {
  let providerInfo = initialProviderSnapshots();
  let clock = 0;
  const listeners: Array<(event: ProviderInstallationEvent) => void> = [];
  const lifetime = new AbortController();
  const reportIncident = vi.fn();
  const detect = vi.fn(async (providerId: ProviderInfo["id"]) => absent(providerId));
  const providers = {
    detect,
    cachedMetadata: () => ({ models: [], rateLimits: [], metadataState: providerInfo[0]!.metadataState }),
    providerCapabilityContract: () => undefined,
    metadataReadTimedOut: () => false,
    providerInstallationState: installationState,
    observeInstallationEvents: (listener: (event: ProviderInstallationEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  } as unknown as ProviderManager;
  const refresh = createProviderInfoRefresh({
    enabled: true, providers, defaultWorkspacePath: "/workspace",
    lifetimeSignal: lifetime.signal,
    providerInfo: () => providerInfo,
    replaceProviderInfo: (value) => { providerInfo = value; },
    reportIncident,
    broadcastSnapshot: vi.fn(), isClosed: () => lifetime.signal.aborted,
    track: async (operation) => await operation(), onActivityChange: vi.fn(),
    now: () => clock,
  });
  return {
    refresh,
    detect,
    reportIncident,
    lifetime,
    emit: (event: ProviderInstallationEvent) => {
      for (const listener of listeners) listener(event);
    },
    advanceClock: (ms: number) => { clock += ms; },
  };
}

describe("automatic provider rediscovery", () => {
  it.each(["run-start-failed", "run-cleanup-unconfirmed"] as const)(
    "refreshes the provider once, 2 s after %s",
    async (kind) => {
      const subject = runtime();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      subject.emit({ providerId: "codex", kind });
      subject.emit({ providerId: "codex", kind });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(subject.detect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(subject.detect).toHaveBeenCalledOnce();
      expect(subject.detect).toHaveBeenCalledWith("codex", expect.objectContaining({ refreshEnvironment: true }));
    },
  );

  it("records an incident for a probe cleanup failure without refreshing", async () => {
    const subject = runtime();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    subject.emit({ providerId: "claude", kind: "probe-cleanup-unconfirmed" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(subject.reportIncident).toHaveBeenCalledWith({
      code: "provider.discovery-cleanup-unconfirmed",
      outcome: "unknown",
      context: { providerId: "claude" },
    });
    expect(subject.detect).not.toHaveBeenCalled();
  });

  it("drops a pending rediscovery when the runtime closes", async () => {
    const subject = runtime();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    subject.emit({ providerId: "codex", kind: "run-start-failed" });
    subject.lifetime.abort();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(subject.detect).not.toHaveBeenCalled();
  });

  it("refreshes unverified providers after a resume and every provider checked more than 10 minutes earlier", async () => {
    const subject = runtime((providerId) => providerId === "kimi" ? "unverified" : "current");
    for (const providerId of PROVIDER_IDS) await subject.refresh(providerId);
    subject.detect.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    subject.advanceClock(9 * 60_000);
    subject.refresh.rediscoverAfterSystemResume();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(subject.detect.mock.calls.map(([providerId]) => providerId)).toEqual(["kimi"]);

    subject.detect.mockClear();
    subject.advanceClock(2 * 60_000);
    subject.refresh.rediscoverAfterSystemResume();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(subject.detect.mock.calls.map(([providerId]) => providerId).sort())
      .toEqual([...PROVIDER_IDS].sort());
  });
});
