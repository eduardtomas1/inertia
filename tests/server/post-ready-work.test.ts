import { describe, expect, it, vi } from "vitest";

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
});
