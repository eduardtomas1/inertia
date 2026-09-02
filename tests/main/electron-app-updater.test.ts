import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    app: { quit: vi.fn() },
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
  app: updaterFixture.app,
}));

import { loadElectronAppUpdater } from "../../src/main/electron-app-updater";

const roots: string[] = [];

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
  updaterFixture.updater.downloadUpdate.mockResolvedValue(["/private/download/path"]);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
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

  it("opts Canary into prereleases while keeping its rollout identity isolated", async () => {
    await loadElectronAppUpdater("canary");
    expect(updaterFixture.updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: true,
      allowDowngrade: false,
      disableWebInstaller: true,
      requestHeaders: { "x-user-staging-id": "inertia-anonymous-canary" },
      logger: null,
    });
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

  it.skipIf(process.platform === "win32")("uses the repository-owned stable AppImage handoff on Linux", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-electron-updater-"));
    roots.push(root);
    const cache = join(root, "cache");
    await mkdir(cache);
    const active = join(root, "Inertia-0.0.46.AppImage");
    const downloaded = join(cache, "Inertia-0.0.47.AppImage");
    await Promise.all([
      writeFile(active, "old", { mode: 0o755 }),
      writeFile(downloaded, "new", { mode: 0o755 }),
    ]);
    await Promise.all([chmod(active, 0o755), chmod(downloaded, 0o755)]);
    updaterFixture.updater.downloadUpdate.mockResolvedValueOnce([downloaded]);
    const environment = { APPIMAGE: active };
    const launch = vi.fn(async () => undefined);
    const adapter = await loadElectronAppUpdater("stable", {
      platform: "linux",
      activeAppImagePath: active,
      environment,
      launchAppImage: launch,
    });
    await adapter.download({ onProgress: vi.fn(), onCancelled: vi.fn() }).promise;
    const onHandoff = vi.fn();

    await expect(adapter.quitAndInstall(onHandoff)).resolves.toBe(true);

    const stable = join(await realpath(root), "Inertia.AppImage");
    expect(await readFile(stable, "utf8")).toBe("new");
    expect(environment.APPIMAGE).toBe(stable);
    expect(launch).toHaveBeenCalledWith(stable, environment);
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(updaterFixture.app.quit).toHaveBeenCalledOnce();
    expect(updaterFixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
