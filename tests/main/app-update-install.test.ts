import { describe, expect, it, vi } from "vitest";

import { AppUpdateInstallCoordinator } from "../../src/main/app-update-install";
import type { AppUpdaterInstallResult } from
  "../../src/main/electron-app-updater";
import {
  cleanupPrivilegedOwners,
  finishNormalShutdownAfterCleanup,
} from "../../src/main/privileged-shutdown";
import type { AppUpdateInstallBlocker, AppUpdateStatus } from "../../src/shared/desktop";

function status(state: AppUpdateStatus["state"]): AppUpdateStatus {
  return {
    revision: 1,
    channel: "stable",
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
    quitAndInstall: vi.fn(async (
      onHandoff: () => void,
    ): Promise<AppUpdaterInstallResult> => {
      events.push("install");
      onHandoff();
      return "handoff-confirmed" as const;
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

  it("validates the exact update candidate before privileged cleanup", async () => {
    const events: string[] = [];
    const update = {
      ...service(events),
      prepareInstall: vi.fn(async () => {
        events.push("candidate-validated");
        return true;
      }),
      abortInstall: vi.fn(async () => {
        events.push("candidate-aborted");
      }),
    };
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => ({
        prepareForUpdate: vi.fn(async () => true),
        releaseUpdatePreparation: vi.fn(async () => undefined),
      }),
      handoffContext: () => ({
        handoffDirectory: "/data",
        profileDirectory: "/profile",
        dataDirectory: "/data",
        oldRuntimeGenerationId:
          "22222222-2222-4222-8222-222222222222:7",
        systemBootId: "test:boot",
      }),
      cleanup: vi.fn(async () => { events.push("cleanup"); return true; }),
      finishNormalShutdown: vi.fn(),
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({
      state: "installing",
    });
    expect(events).toEqual([
      "begin",
      "candidate-validated",
      "cleanup",
      "install",
    ]);
    expect(update.abortInstall).not.toHaveBeenCalled();
  });

  it("releases admission holds without cleanup when candidate validation fails", async () => {
    const events: string[] = [];
    const releaseRuntime = vi.fn(async () => true);
    const releasePrivateConnect = vi.fn(async () => undefined);
    const update = {
      ...service(events),
      prepareInstall: vi.fn(async () => {
        events.push("candidate-rejected");
        return false;
      }),
      abortInstall: vi.fn(async () => {
        events.push("candidate-aborted");
      }),
    };
    const cleanup = vi.fn(async () => true);
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: releaseRuntime,
      }),
      privateConnect: () => ({
        prepareForUpdate: vi.fn(async () => true),
        releaseUpdatePreparation: releasePrivateConnect,
      }),
      handoffContext: () => ({
        handoffDirectory: "/data",
        profileDirectory: "/profile",
        dataDirectory: "/data",
        oldRuntimeGenerationId:
          "22222222-2222-4222-8222-222222222222:7",
        systemBootId: "test:boot",
      }),
      cleanup,
      finishNormalShutdown: vi.fn(),
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({ state: "failed" });
    expect(events).toEqual([
      "begin",
      "candidate-rejected",
      "candidate-aborted",
      "failed",
    ]);
    expect(cleanup).not.toHaveBeenCalled();
    expect(releaseRuntime).toHaveBeenCalled();
    expect(releasePrivateConnect).toHaveBeenCalled();
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

  it("does not exit when normal quit takes ownership of unconfirmed install cleanup", async () => {
    const events: string[] = [];
    const update = service(events);
    let resolveCleanup!: (confirmed: boolean) => void;
    const cleanupResult = new Promise<boolean>((resolve) => {
      resolveCleanup = resolve;
    });
    const cleanup = vi.fn(() => cleanupResult);
    const finishNormalShutdown = vi.fn();
    const onUnconfirmedShutdown = vi.fn();
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup,
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError: vi.fn(),
    });

    const installing = coordinator.install();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(coordinator.allowBeforeQuit()).toBe(false);
    resolveCleanup(false);

    await expect(installing).resolves.toMatchObject({ state: "failed" });
    await vi.waitFor(() => expect(onUnconfirmedShutdown).toHaveBeenCalledOnce());
    expect(finishNormalShutdown).not.toHaveBeenCalled();
    expect(update.quitAndInstall).not.toHaveBeenCalled();
  });

  it("fails closed without exiting when privileged cleanup is unconfirmed", async () => {
    const events: string[] = [];
    const update = service(events);
    const finishNormalShutdown = vi.fn(() => events.push("normal-exit"));
    const onUnconfirmedShutdown = vi.fn(() => events.push("cleanup-unconfirmed"));
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => { events.push("cleanup"); return false; }),
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({ state: "failed" });
    expect(events).toEqual(["begin", "cleanup", "failed", "cleanup-unconfirmed"]);
    expect(finishNormalShutdown).not.toHaveBeenCalled();
    expect(update.quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps a normal quit fail-closed when privileged cleanup is unconfirmed", async () => {
    const events: string[] = [];
    const finishNormalShutdown = vi.fn(() => events.push("normal-exit"));
    const onUnconfirmedShutdown = vi.fn(() => events.push("cleanup-unconfirmed"));
    const coordinator = new AppUpdateInstallCoordinator({
      service: service(events),
      runtime: () => null,
      privateConnect: () => null,
      cleanup: vi.fn(async () => { events.push("cleanup"); return false; }),
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError: vi.fn(),
    });

    expect(coordinator.allowBeforeQuit()).toBe(false);
    await vi.waitFor(() => expect(onUnconfirmedShutdown).toHaveBeenCalledOnce());
    expect(events).toEqual(["cleanup", "cleanup-unconfirmed"]);
    expect(finishNormalShutdown).not.toHaveBeenCalled();
  });

  it("keeps a normal quit fail-closed when privileged cleanup rejects", async () => {
    const cleanupError = new Error("cleanup rejected");
    const finishNormalShutdown = vi.fn();
    const onUnconfirmedShutdown = vi.fn();
    const reportError = vi.fn();
    const coordinator = new AppUpdateInstallCoordinator({
      service: service([]),
      runtime: () => null,
      privateConnect: () => null,
      cleanup: vi.fn(async () => { throw cleanupError; }),
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError,
    });

    expect(coordinator.allowBeforeQuit()).toBe(false);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(cleanupError));
    expect(onUnconfirmedShutdown).toHaveBeenCalledOnce();
    expect(finishNormalShutdown).not.toHaveBeenCalled();
  });

  it("exits only after the updater proves native installation was not invoked", async () => {
    const events: string[] = [];
    const update = service(events);
    update.quitAndInstall.mockImplementationOnce(async () => {
      events.push("install");
      return "not-invoked" as const;
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

  it("keeps the old generation resident when native installer outcome is uncertain", async () => {
    const events: string[] = [];
    const update = service(events);
    update.quitAndInstall.mockImplementationOnce(async () => {
      events.push("install");
      return "native-outcome-uncertain";
    });
    const finishNormalShutdown = vi.fn();
    const onUnconfirmedShutdown = vi.fn(() => events.push("outcome-unconfirmed"));
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => { events.push("cleanup"); return true; }),
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError: vi.fn(),
    });

    await expect(coordinator.install()).resolves.toMatchObject({ state: "failed" });
    expect(events).toEqual([
      "begin",
      "cleanup",
      "install",
      "failed",
      "outcome-unconfirmed",
    ]);
    expect(finishNormalShutdown).not.toHaveBeenCalled();
    expect(coordinator.allowBeforeQuit()).toBe(false);
    expect(finishNormalShutdown).not.toHaveBeenCalled();
    expect(onUnconfirmedShutdown).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown native install request as ambiguous after cleanup", async () => {
    const events: string[] = [];
    const update = service(events);
    update.quitAndInstall.mockImplementationOnce(async (onHandoff) => {
      events.push("install");
      onHandoff();
      throw new Error("native invocation threw");
    });
    const finishNormalShutdown = vi.fn();
    const onUnconfirmedShutdown = vi.fn();
    const reportError = vi.fn();
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => true),
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError,
    });

    await expect(coordinator.install()).resolves.toMatchObject({ state: "failed" });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "native invocation threw",
    }));
    expect(onUnconfirmedShutdown).toHaveBeenCalledOnce();
    expect(finishNormalShutdown).not.toHaveBeenCalled();
    expect(coordinator.allowBeforeQuit()).toBe(false);
    expect(finishNormalShutdown).not.toHaveBeenCalled();
  });

  it("does not exit when exact pre-invocation rollback cannot be confirmed", async () => {
    const events: string[] = [];
    const update = {
      ...service(events),
      abortInstall: vi.fn(async () => {
        throw new Error("rollback authority changed");
      }),
    };
    update.quitAndInstall.mockImplementationOnce(async () => {
      events.push("install");
      return "not-invoked";
    });
    const finishNormalShutdown = vi.fn();
    const onUnconfirmedShutdown = vi.fn();
    const reportError = vi.fn();
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => true),
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError,
    });

    await expect(coordinator.install()).resolves.toMatchObject({ state: "failed" });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "rollback authority changed",
    }));
    expect(onUnconfirmedShutdown).toHaveBeenCalledOnce();
    expect(finishNormalShutdown).not.toHaveBeenCalled();
  });

  it("blocks a normal quit racing an unresolved native installer invocation", async () => {
    const events: string[] = [];
    const update = {
      ...service(events),
      abortInstall: vi.fn(async () => {
        throw new Error("native installer outcome remains unresolved");
      }),
    };
    let settleInstall!: (result: AppUpdaterInstallResult) => void;
    update.quitAndInstall.mockImplementationOnce(() => {
      events.push("install");
      return new Promise<AppUpdaterInstallResult>((resolve) => {
        settleInstall = resolve;
      });
    });
    const finishNormalShutdown = vi.fn();
    const onUnconfirmedShutdown = vi.fn();
    const reportError = vi.fn();
    const coordinator = new AppUpdateInstallCoordinator({
      service: update,
      runtime: () => ({
        prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
        releaseUpdatePreparation: vi.fn(async () => true),
      }),
      privateConnect: () => null,
      cleanup: vi.fn(async () => true),
      finishNormalShutdown,
      onUnconfirmedShutdown,
      reportError,
    });

    const installing = coordinator.install();
    await vi.waitFor(() => expect(update.quitAndInstall).toHaveBeenCalledOnce());
    expect(coordinator.allowBeforeQuit()).toBe(false);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "native installer outcome remains unresolved",
      }),
    ));
    settleInstall("native-outcome-uncertain");
    await installing;

    expect(onUnconfirmedShutdown).toHaveBeenCalledOnce();
    expect(finishNormalShutdown).not.toHaveBeenCalled();
  });
});

describe("privileged updater cleanup", () => {
  it("refuses normal process exit when privileged cleanup is unconfirmed", () => {
    const finish = vi.fn();
    const onUnconfirmed = vi.fn();

    expect(finishNormalShutdownAfterCleanup({
      cleanupConfirmed: false,
      finish,
      onUnconfirmed,
    })).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(onUnconfirmed).toHaveBeenCalledOnce();

    expect(finishNormalShutdownAfterCleanup({
      cleanupConfirmed: true,
      finish,
      onUnconfirmed,
    })).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
  });

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
