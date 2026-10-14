import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { startRuntime, type RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import { ProjectIdentityRefresher } from
  "../../src/server/project-identity-refresh";
import { TurnGitArtifactManager } from
  "../../src/server/turn-git-artifacts";
import { DuoLaunchCoordinator } from
  "../../src/server/runtime/duo/duo-launch-coordinator";
import { RuntimeSyncHub } from "../../src/server/runtime/runtime-sync-hub";
import { PostReadyWork, type PostReadyWorkOptions } from "../../src/server/runtime/post-ready-work";

const directories: string[] = [];
const runtimes: RunningRuntime[] = [];

async function runtimePaths(): Promise<{
  dataDirectory: string;
  workspaceDirectory: string;
  runtimeGenerationId: string;
  systemBootId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inertia-post-ready-"));
  const dataDirectory = join(root, "data");
  const workspaceDirectory = join(root, "workspace");
  const runtimeGenerationId = `${randomUUID()}:1`;
  const systemBootId = `test:${randomUUID()}`;
  await Promise.all([mkdir(dataDirectory), mkdir(workspaceDirectory)]);
  if (process.platform !== "win32") await chmod(dataDirectory, 0o700);
  expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
    runtimeGenerationId,
    systemBootId,
  )).toBe(true);
  directories.push(root);
  return {
    dataDirectory,
    workspaceDirectory,
    runtimeGenerationId,
    systemBootId,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.restoreAllMocks();
  await Promise.allSettled(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("runtime post-ready work", () => {
  it("starts passive owned work once only after the ready hook", async () => {
    const paths = await runtimePaths();
    const startBackups = vi.spyOn(RuntimeStore.prototype, "startBackups");
    const refreshIdentities = vi.spyOn(
      ProjectIdentityRefresher.prototype,
      "refreshAll",
    ).mockResolvedValue();
    const reconcileArtifacts = vi.spyOn(
      TurnGitArtifactManager.prototype,
      "reconcile",
    ).mockResolvedValue(false);
    const resumeComparisons = vi.spyOn(
      DuoLaunchCoordinator.prototype,
      "resumeComparisons",
    ).mockResolvedValue();
    const providerRefresh = vi.fn(async () => {
      throw new Error("stop provider discovery after proving admission");
    });

    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: true,
      testOnlyProviderRefresh: providerRefresh,
    });
    runtimes.push(runtime);

    expect(startBackups).not.toHaveBeenCalled();
    expect(refreshIdentities).not.toHaveBeenCalled();
    expect(reconcileArtifacts).not.toHaveBeenCalled();
    expect(resumeComparisons).not.toHaveBeenCalled();
    expect(providerRefresh).not.toHaveBeenCalled();

    await runtime.startPostReadyWork();
    await vi.waitFor(() => expect(providerRefresh).toHaveBeenCalledOnce());
    expect(startBackups).toHaveBeenCalledOnce();
    expect(refreshIdentities).toHaveBeenCalledOnce();
    expect(reconcileArtifacts).toHaveBeenCalledOnce();
    expect(resumeComparisons).toHaveBeenCalledOnce();

    await runtime.startPostReadyWork();
    expect(startBackups).toHaveBeenCalledOnce();
    expect(refreshIdentities).toHaveBeenCalledOnce();
    expect(reconcileArtifacts).toHaveBeenCalledOnce();
    expect(resumeComparisons).toHaveBeenCalledOnce();
    expect(providerRefresh).toHaveBeenCalledOnce();
  });

  it("does not rebroadcast the shell snapshot when passive work changes nothing", async () => {
    const paths = await runtimePaths();
    vi.spyOn(ProjectIdentityRefresher.prototype, "refreshAll").mockResolvedValue();
    vi.spyOn(TurnGitArtifactManager.prototype, "reconcile").mockResolvedValue(false);
    vi.spyOn(DuoLaunchCoordinator.prototype, "resumeComparisons").mockResolvedValue();
    const snapshotBroadcasts = vi.spyOn(RuntimeSyncHub.prototype, "broadcastSnapshot");
    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: false,
    });
    runtimes.push(runtime);

    await runtime.startPostReadyWork();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(snapshotBroadcasts).not.toHaveBeenCalled();
  });

  it("defers passive work until the first client has received its welcome", async () => {
    const paths = await runtimePaths();
    const refreshIdentities = vi.spyOn(ProjectIdentityRefresher.prototype, "refreshAll").mockResolvedValue();
    vi.spyOn(TurnGitArtifactManager.prototype, "reconcile").mockResolvedValue(false);
    vi.spyOn(DuoLaunchCoordinator.prototype, "resumeComparisons").mockResolvedValue();
    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: false,
    });
    runtimes.push(runtime);

    runtime.startPostReadyWorkAfterFirstClient();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(refreshIdentities).not.toHaveBeenCalled();

    const socket = new WebSocket(runtime.websocketUrl, { origin: "http://localhost:5173" });
    try {
      const welcome = await new Promise<boolean>((resolve, reject) => {
        socket.once("message", (data) => resolve(String(data).startsWith('{"type":"server.welcome"')));
        socket.once("error", reject);
      });
      expect(welcome).toBe(true);
      await vi.waitFor(() => expect(refreshIdentities).toHaveBeenCalledOnce());
    } finally {
      socket.close();
    }
  });

  it("starts deferred passive work before an update preparation drains the runtime", async () => {
    const paths = await runtimePaths();
    const refreshIdentities = vi.spyOn(ProjectIdentityRefresher.prototype, "refreshAll").mockResolvedValue();
    const reconcileArtifacts = vi.spyOn(TurnGitArtifactManager.prototype, "reconcile").mockResolvedValue(false);
    vi.spyOn(DuoLaunchCoordinator.prototype, "resumeComparisons").mockResolvedValue();
    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: false,
    });
    runtimes.push(runtime);

    runtime.startPostReadyWorkAfterFirstClient();
    const operationId = randomUUID();
    await expect(runtime.prepareForUpdate(operationId)).resolves.toMatchObject({ ready: true });
    expect(refreshIdentities).toHaveBeenCalledOnce();
    expect(reconcileArtifacts).toHaveBeenCalledOnce();
    runtime.releaseUpdatePreparation(operationId);
  });

  it("leaves provider discovery to the deferred start when an update preparation promotes passive work", async () => {
    const paths = await runtimePaths();
    let finishIdentities!: () => void;
    const refreshIdentities = vi.spyOn(ProjectIdentityRefresher.prototype, "refreshAll")
      .mockImplementation(() => new Promise<void>((resolve) => { finishIdentities = resolve; }));
    const reconcileArtifacts = vi.spyOn(TurnGitArtifactManager.prototype, "reconcile").mockResolvedValue(false);
    vi.spyOn(DuoLaunchCoordinator.prototype, "resumeComparisons").mockResolvedValue();
    const providerRefresh = vi.fn(async () => {
      throw new Error("stop provider discovery after proving admission");
    });
    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: true,
      testOnlyProviderRefresh: providerRefresh,
    });
    runtimes.push(runtime);

    runtime.startPostReadyWorkAfterFirstClient();
    const operationId = randomUUID();
    let prepared = false;
    const preparation = runtime.prepareForUpdate(operationId).finally(() => { prepared = true; });
    await vi.waitFor(() => expect(refreshIdentities).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(prepared).toBe(false);
    finishIdentities();

    await expect(preparation).resolves.toMatchObject({ ready: true });
    expect(reconcileArtifacts).toHaveBeenCalledOnce();
    expect(providerRefresh).not.toHaveBeenCalled();
    runtime.releaseUpdatePreparation(operationId);
    await vi.waitFor(() => expect(providerRefresh).toHaveBeenCalledOnce(), { timeout: 2_000 });
  });

  it("starts no passive work when shutdown wins before readiness", async () => {
    const paths = await runtimePaths();
    const startBackups = vi.spyOn(RuntimeStore.prototype, "startBackups");
    const refreshIdentities = vi.spyOn(
      ProjectIdentityRefresher.prototype,
      "refreshAll",
    ).mockResolvedValue();
    const reconcileArtifacts = vi.spyOn(
      TurnGitArtifactManager.prototype,
      "reconcile",
    ).mockResolvedValue(false);
    const resumeComparisons = vi.spyOn(
      DuoLaunchCoordinator.prototype,
      "resumeComparisons",
    ).mockResolvedValue();

    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: false,
    });
    await runtime.close();
    await runtime.startPostReadyWork();

    expect(startBackups).not.toHaveBeenCalled();
    expect(refreshIdentities).not.toHaveBeenCalled();
    expect(reconcileArtifacts).not.toHaveBeenCalled();
    expect(resumeComparisons).not.toHaveBeenCalled();
  });

  it("cancels and drains an admitted provider refresh when shutdown starts", async () => {
    const paths = await runtimePaths();
    let notifyRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });
    let refreshSettled = false;
    const providerRefresh = vi.fn(async (signal: AbortSignal) => {
      notifyRefreshStarted();
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        refreshSettled = true;
      }
    });
    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: true,
      testOnlyProviderRefresh: providerRefresh,
    });
    runtimes.push(runtime);

    void runtime.startPostReadyWork();
    await refreshStarted;
    const closeDeadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Runtime close did not drain provider refresh.")),
        2_000,
      );
      timer.unref();
    });
    await expect(Promise.race([runtime.close(), closeDeadline])).resolves.toBeUndefined();

    expect(providerRefresh).toHaveBeenCalledOnce();
    expect(providerRefresh.mock.calls[0]?.[0].aborted).toBe(true);
    expect(refreshSettled).toBe(true);
    runtimes.splice(runtimes.indexOf(runtime), 1);
  });
});

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
    expect(deferred.options.startBackups).toHaveBeenCalledOnce();
    expect(deferred.options.startProviderDiscovery).not.toHaveBeenCalled();
  });

  it("starts provider discovery once the deferred start fires after a promoted preparation", async () => {
    vi.useFakeTimers();
    const deferred = work();
    deferred.postReady.startAfterFirstClient(1_000);
    deferred.postReady.beforeUpdatePreparation(() => "prepared");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deferred.options.startBackups).toHaveBeenCalledOnce();
    expect(deferred.options.startProviderDiscovery).toHaveBeenCalledOnce();
    await deferred.postReady.start();
    expect(deferred.options.startProviderDiscovery).toHaveBeenCalledOnce();
  });
});
