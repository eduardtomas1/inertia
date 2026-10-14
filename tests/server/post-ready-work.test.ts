import { afterEach, describe, expect, it, vi } from "vitest";

import { PostReadyWork, type PostReadyWorkOptions } from "../../src/server/runtime/post-ready-work";

function work(overrides: Partial<PostReadyWorkOptions> = {}) {
  const broadcastSnapshot = vi.fn();
  const options: PostReadyWorkOptions = {
    isClosed: () => false,
    isBlocked: () => false,
    track: (operation) => operation(),
    startBackups: vi.fn(),
    refreshProjectIdentities: async () => undefined,
    afterProjectIdentityRefresh: () => undefined,
    reconcileWorkspaces: async () => undefined,
    reconcileArtifacts: async () => false,
    startProviderDiscovery: vi.fn(),
    snapshotDigest: () => "unchanged",
    broadcastSnapshot,
    ...overrides,
  };
  return { postReady: new PostReadyWork(options), broadcastSnapshot, options };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("post-ready work", () => {
  it("broadcasts after each passive task that changed the shell snapshot", async () => {
    let digest = "before";
    let finishWorkspaces!: () => void;
    const { postReady, broadcastSnapshot } = work({
      snapshotDigest: () => digest,
      refreshProjectIdentities: async () => {
        digest = "identity";
      },
      reconcileWorkspaces: () => new Promise<void>((resolve) => {
        finishWorkspaces = resolve;
      }),
      reconcileArtifacts: async () => true,
    });

    const started = postReady.start();
    await postReady.identityRefresh;
    await postReady.artifactReconciliation;
    expect(broadcastSnapshot).toHaveBeenCalledTimes(2);
    finishWorkspaces();
    await started;
    expect(broadcastSnapshot).toHaveBeenCalledTimes(3);
    expect(postReady.artifactReconciliationActive).toBe(false);
  });

  it("skips the snapshot broadcast after shutdown and survives a failing backup start", async () => {
    let closed = false;
    const { postReady, broadcastSnapshot, options } = work({
      isClosed: () => closed,
      snapshotDigest: () => (closed ? "after" : "before"),
      startBackups: () => {
        throw new Error("backups unavailable");
      },
      refreshProjectIdentities: async () => {
        closed = true;
      },
    });

    await postReady.start();
    await postReady.identityRefresh;
    expect(broadcastSnapshot).not.toHaveBeenCalled();
    expect(options.startProviderDiscovery).toHaveBeenCalledOnce();
  });

  it("starts after the first client, or after the wait when none connects", async () => {
    vi.useFakeTimers();
    const fallback = work();
    fallback.postReady.startAfterFirstClient(1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(fallback.options.startProviderDiscovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback.options.startProviderDiscovery).toHaveBeenCalledOnce();

    const connected = work();
    connected.postReady.startAfterFirstClient(1_000);
    connected.postReady.clientConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(connected.options.startProviderDiscovery).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connected.options.startProviderDiscovery).toHaveBeenCalledOnce();
  });

  it("promotes only a deferred start when an update preparation begins", () => {
    const idle = work();
    expect(idle.postReady.beforeUpdatePreparation(() => "prepared")).toBe("prepared");
    expect(idle.options.startProviderDiscovery).not.toHaveBeenCalled();

    const deferred = work();
    deferred.postReady.startAfterFirstClient(1_000);
    deferred.postReady.beforeUpdatePreparation(() => "prepared");
    expect(deferred.options.startProviderDiscovery).toHaveBeenCalledOnce();
  });
});
