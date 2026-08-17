import { describe, expect, it, vi } from "vitest";

import { AppUpdateInstallCoordinator } from "../../src/main/app-update-install";
import { cleanupPrivilegedOwners } from "../../src/main/privileged-shutdown";
import type { AppUpdateInstallBlocker, AppUpdateStatus } from "../../src/shared/desktop";

function status(state: AppUpdateStatus["state"]): AppUpdateStatus {
  return {
    revision: 1,
    state,
    freshness: "fresh",
    delivery: "in-app",
    deliveryReason: null,
    installBlocker: null,
    progress: null,
    currentVersion: "0.0.35",
    latestVersion: "0.0.36",
    releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.36",
    checkedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    message: "fixture",
  };
}

function service(events: string[]) {
  let current = status("downloaded");
  return {
    current: () => current,
    beginInstall: vi.fn(() => {
      events.push("begin");
      current = { ...current, state: "installing" };
      return current;
    }),
    blockInstall: vi.fn((blocker: AppUpdateInstallBlocker) => {
      events.push(`blocked:${blocker}`);
      current = { ...current, state: "downloaded", installBlocker: blocker };
      return current;
    }),
    failInstall: vi.fn(() => {
      events.push("failed");
      current = { ...current, state: "failed", installBlocker: "shutdown" };
      return current;
    }),
    quitAndInstall: vi.fn(async (onHandoff: () => void) => {
      events.push("install");
      onHandoff();
      return true;
    }),
  };
}

describe("application update install coordination", () => {
  it("keeps the download and skips cleanup when runtime work blocks restart", async () => {
    const events: string[] = [];
    const update = service(events);
    const cleanup = vi.fn(async () => true);
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: false as const, blocker: "agent-work" as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup,
      finishNormalShutdown: vi.fn(),
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({
      state: "downloaded",
      installBlocker: "active-work",
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(update.quitAndInstall).not.toHaveBeenCalled();
  });

  it("coalesces install requests and hands off only after confirmed cleanup", async () => {
    const events: string[] = [];
    const update = service(events);
    let releasePreparation!: () => void;
    const prepared = new Promise<{ ready: true }>((resolve) => {
      releasePreparation = () => resolve({ ready: true });
    });
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: () => prepared,
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => ({
        prepareForUpdate: vi.fn(async () => true),
        releaseUpdatePreparation: vi.fn(async () => undefined),
      }),
      cleanup: vi.fn(async () => { events.push("cleanup"); return true; }),
      finishNormalShutdown: vi.fn(),
      reportError: vi.fn(),
    });

    const first = coordinator.install();
    const second = coordinator.install();
    expect(first).toBe(second);
    releasePreparation();
    await expect(first).resolves.toMatchObject({ state: "installing" });
    expect(events).toEqual(["begin", "cleanup", "install"]);
    expect(update.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(coordinator.allowBeforeQuit()).toBe(true);
  });

  it("rolls back the runtime gate when Private Connect is active", async () => {
    const events: string[] = [];
    const update = service(events);
    const releaseRuntime = vi.fn(async () => true);
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: releaseRuntime,
      }),
      privateConnect: () => ({
        prepareForUpdate: vi.fn(async () => false),
        releaseUpdatePreparation: vi.fn(async () => undefined),
      }),
      cleanup: vi.fn(async () => true),
      finishNormalShutdown: vi.fn(),
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({
      state: "downloaded",
      installBlocker: "private-connect",
    });
    expect(releaseRuntime).toHaveBeenCalledTimes(1);
    expect(update.quitAndInstall).not.toHaveBeenCalled();
  });

  it("lets a normal quit take ownership while update preparation is pending", async () => {
    const events: string[] = [];
    const update = service(events);
    let finishPreparation!: () => void;
    const preparation = new Promise<{ ready: true }>((resolve) => {
      finishPreparation = () => resolve({ ready: true });
    });
    const releaseRuntime = vi.fn(async () => true);
    const finishNormalShutdown = vi.fn(() => events.push("normal-exit"));
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: () => preparation,
        releaseUpdatePreparation: releaseRuntime,
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => { events.push("cleanup"); return true; }),
      finishNormalShutdown,
      reportError: vi.fn(),
    });

    const installing = coordinator.install();
    expect(coordinator.allowBeforeQuit()).toBe(false);
    finishPreparation();
    await installing;
    await vi.waitFor(() => expect(finishNormalShutdown).toHaveBeenCalledTimes(1));
    expect(releaseRuntime).toHaveBeenCalled();
    expect(events).toEqual(["begin", "cleanup", "normal-exit"]);
    expect(update.quitAndInstall).not.toHaveBeenCalled();
  });

  it("fails closed and exits normally when privileged cleanup is unconfirmed", async () => {
    const events: string[] = [];
    const update = service(events);
    const finishNormalShutdown = vi.fn(() => events.push("normal-exit"));
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => { events.push("cleanup"); return false; }),
      finishNormalShutdown,
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({ state: "failed" });
    expect(events).toEqual(["begin", "cleanup", "failed", "normal-exit"]);
    expect(update.quitAndInstall).not.toHaveBeenCalled();
  });

  it("fails closed when the updater never confirms its native handoff", async () => {
    const events: string[] = [];
    const update = service(events);
    update.quitAndInstall.mockImplementationOnce(async () => {
      events.push("install");
      return false;
    });
    const finishNormalShutdown = vi.fn(() => events.push("normal-exit"));
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => { events.push("cleanup"); return true; }),
      finishNormalShutdown,
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({ state: "failed" });
    expect(events).toEqual(["begin", "cleanup", "install", "failed", "normal-exit"]);
    expect(coordinator.allowBeforeQuit()).toBe(false);
  });
});

describe("privileged updater cleanup", () => {
  it("does not confirm install safety when Private Connect cannot stop", async () => {
    const onPrivateConnectError = vi.fn();
    const disposeTemporaryAttachments = vi.fn(async () => undefined);
    await expect(cleanupPrivilegedOwners({
      runtime: { stop: vi.fn(async () => true) },
      privateConnect: { shutdown: vi.fn(async () => { throw new Error("busy"); }) },
      onRuntimeStopped: vi.fn(),
      onRuntimeError: vi.fn(),
      onPrivateConnectError,
      disposeTemporaryAttachments,
      closeDurableAttachments: vi.fn(async () => undefined),
      onTemporaryAttachmentError: vi.fn(),
      onUnconfirmedRuntimeExit: vi.fn(),
    })).resolves.toBe(false);
    expect(onPrivateConnectError).toHaveBeenCalledTimes(1);
    expect(disposeTemporaryAttachments).toHaveBeenCalledTimes(1);
  });
});
