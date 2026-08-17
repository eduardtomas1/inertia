import { beforeEach, describe, expect, it, vi } from "vitest";

const updaterFixture = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const nativeListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  class CancellationToken {
    static latest: CancellationToken | null = null;
    readonly cancel = vi.fn();
    constructor() { CancellationToken.latest = this; }
  }
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    requestHeaders: undefined as Record<string, string> | undefined,
    logger: {},
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "0.0.36" },
    })),
    downloadUpdate: vi.fn(async () => ["/private/download/path"]),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
  };
  return {
    updater,
    listeners,
    nativeUpdater: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const group = nativeListeners.get(event) ?? new Set();
        group.add(listener);
        nativeListeners.set(event, group);
      }),
      removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        nativeListeners.get(event)?.delete(listener);
      }),
    },
    nativeListeners,
    CancellationToken,
    emit(event: string, value?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    emitNative(event: string, value?: unknown) {
      for (const listener of nativeListeners.get(event) ?? []) listener(value);
    },
  };
});

vi.mock("electron-updater", () => ({
  autoUpdater: updaterFixture.updater,
  CancellationToken: updaterFixture.CancellationToken,
}));

vi.mock("electron", () => ({
  autoUpdater: updaterFixture.nativeUpdater,
}));

import { loadElectronAppUpdater } from "../../src/main/electron-app-updater";

beforeEach(() => {
  updaterFixture.listeners.clear();
  updaterFixture.nativeListeners.clear();
  vi.clearAllMocks();
  updaterFixture.updater.autoDownload = true;
  updaterFixture.updater.autoInstallOnAppQuit = true;
  updaterFixture.updater.autoRunAppAfterInstall = false;
  updaterFixture.updater.allowPrerelease = true;
  updaterFixture.updater.allowDowngrade = true;
  updaterFixture.updater.disableWebInstaller = false;
  updaterFixture.updater.requestHeaders = undefined;
  updaterFixture.updater.logger = {};
});

describe("electron updater adapter", () => {
  it("applies the exact safe stable configuration without overriding the feed", async () => {
    const adapter = await loadElectronAppUpdater();
    expect(updaterFixture.updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
      requestHeaders: { "x-user-staging-id": "inertia-anonymous" },
      logger: null,
    });
    await expect(adapter.check()).resolves.toEqual({
      available: true,
      version: "0.0.36",
    });
    expect(updaterFixture.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updaterFixture.updater).not.toHaveProperty("setFeedURL");
  });

  it("preserves the native platform and staged-rollout eligibility decision", async () => {
    updaterFixture.updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: false,
      updateInfo: { version: "0.0.36" },
    });
    const adapter = await loadElectronAppUpdater();
    await expect(adapter.check()).resolves.toEqual({
      available: false,
      version: "0.0.36",
    });
  });

  it("contains download paths, forwards progress, cancels one token, and removes listeners", async () => {
    const adapter = await loadElectronAppUpdater();
    const onProgress = vi.fn();
    const onCancelled = vi.fn();
    const download = adapter.download({ onProgress, onCancelled });
    updaterFixture.emit("download-progress", {
      percent: 50,
      transferred: 10,
      total: 20,
      bytesPerSecond: 3,
    });
    updaterFixture.emit("update-cancelled", { version: "0.0.36" });
    download.cancel();
    await expect(download.promise).resolves.toBeUndefined();

    expect(onProgress).toHaveBeenCalledWith({
      percent: 50,
      transferred: 10,
      total: 20,
      bytesPerSecond: 3,
    });
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(updaterFixture.CancellationToken.latest?.cancel).toHaveBeenCalledTimes(1);
    expect(updaterFixture.listeners.get("download-progress")?.size ?? 0).toBe(0);
    expect(updaterFixture.listeners.get("update-cancelled")?.size ?? 0).toBe(0);
  });

  it("removes scoped listeners when the native download throws before returning", async () => {
    updaterFixture.updater.downloadUpdate.mockImplementationOnce(() => {
      throw new Error("native start failed");
    });
    const adapter = await loadElectronAppUpdater();
    const download = adapter.download({
      onProgress: vi.fn(),
      onCancelled: vi.fn(),
    });
    await expect(download.promise).rejects.toThrow("native start failed");
    expect(updaterFixture.listeners.get("download-progress")?.size ?? 0).toBe(0);
    expect(updaterFixture.listeners.get("update-cancelled")?.size ?? 0).toBe(0);
  });

  it("requests one visible restart/install handoff", async () => {
    const adapter = await loadElectronAppUpdater();
    const onHandoff = vi.fn();
    const handoff = adapter.quitAndInstall(onHandoff);
    updaterFixture.emitNative("before-quit-for-update");
    await expect(handoff).resolves.toBe(true);
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(updaterFixture.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updaterFixture.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(updaterFixture.nativeListeners.get("before-quit-for-update")?.size ?? 0).toBe(0);
    expect(updaterFixture.listeners.get("error")?.size ?? 0).toBe(0);
  });

  it("rejects handoff when the native installer reports an error", async () => {
    const adapter = await loadElectronAppUpdater();
    const handoff = adapter.quitAndInstall();
    updaterFixture.emit("error", new Error("installer failed"));
    await expect(handoff).resolves.toBe(false);
  });
});
