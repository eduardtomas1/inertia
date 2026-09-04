import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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

import {
  loadElectronAppUpdater,
  type WindowsUpdateSupervisorLauncher,
} from "../../src/main/electron-app-updater";
import {
  launchWindowsUpdateSupervisor,
  WindowsUpdateSupervisorCleanupError,
} from
  "../../src/main/windows-update-supervisor";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  type AppUpdateHandoffSnapshot,
} from "../../src/main/app-update-handoff";
import {
  parseWindowsUpdateOperationClaim,
  windowsUpdateOperationClaimAuthenticationTag,
  windowsUpdateSupervisorExecutableName,
  windowsUpdateTerminalReceiptTemporaryName,
} from "../../src/main/windows-update-terminal-receipt";
const roots: string[] = [];

function windowsInstallerBytes(candidateDigest = "b".repeat(64)): Buffer {
  return Buffer.concat([
    Buffer.from("signed-nsis"),
    Buffer.from(
      `inertia.windows-candidate-executable-sha256.v1:${candidateDigest}`,
      "utf16le",
    ),
    Buffer.alloc(2),
  ]);
}

function decodedWindowsSupervisorRequest(request: string): Map<string, string> {
  return new Map(request.trimEnd().split("\n").slice(1).map((line) => {
    const separator = line.indexOf("=");
    return [
      line.slice(0, separator),
      Buffer.from(line.slice(separator + 1), "base64").toString("utf8"),
    ] as const;
  }));
}

function replacementPreparation(
  snapshot: AppUpdateHandoffSnapshot,
  operationId = "44444444-4444-4444-8444-444444444444",
) {
  return {
    operationId,
    platform: snapshot.platform,
    channel: snapshot.channel,
    oldVersion: snapshot.oldVersion,
    newVersion: snapshot.newVersion,
    oldRuntimeGenerationId: snapshot.oldRuntimeGenerationId,
    systemBootId: snapshot.systemBootId,
    candidateArtifactDigest: snapshot.candidateArtifactDigest,
    candidateExecutableIdentityDigest:
      snapshot.candidateExecutableIdentityDigest,
    profileIdentityDigest: snapshot.profileIdentityDigest,
    dataIdentityDigest: snapshot.dataIdentityDigest,
    handoffTokenDigest: snapshot.handoffTokenDigest,
    createdAt: snapshot.createdAt,
    deadlineAt: snapshot.deadlineAt,
  } as const;
}

function retirePreparedHandoff(
  journal: AppUpdateHandoffJournal,
  prepared: AppUpdateHandoffSnapshot,
): AppUpdateHandoffSnapshot {
  const rollingBack = prepared.platform === "linux"
    ? journal.transition(
        appUpdateHandoffOwner(prepared),
        "rollback-required",
      )
    : null;
  const completed = journal.transition(
    appUpdateHandoffOwner(rollingBack ?? prepared),
    "rollback-completed",
  )!;
  expect(journal.retire(appUpdateHandoffOwner(completed))).toBe(true);
  return completed;
}

async function preparedWindowsAdapterFixture(options: {
  readonly launchWindowsSupervisor?: WindowsUpdateSupervisorLauncher;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "inertia-electron-updater-win-"));
  roots.push(root);
  const data = join(root, "data");
  const profile = join(root, "profile");
  const install = join(root, "install");
  await Promise.all([
    mkdir(data, { mode: 0o700 }),
    mkdir(profile, { mode: 0o700 }),
    mkdir(install, { mode: 0o700 }),
  ]);
  const installer = join(root, "Inertia-1.3.0.exe");
  const executable = join(install, "Inertia.exe");
  await Promise.all([
    writeFile(installer, windowsInstallerBytes(), { mode: 0o700 }),
    writeFile(executable, "installed", { mode: 0o700 }),
  ]);
  updaterFixture.updater.downloadUpdate.mockResolvedValueOnce([installer]);
  const launchWindowsSupervisor = options.launchWindowsSupervisor
    ?? vi.fn(async () => ({
      helperPath: join(data, ".app-update-supervisor.exe"),
      helperDigest: "c".repeat(64),
    }));
  const adapter = await loadElectronAppUpdater("stable", {
    platform: "win32",
    executablePath: executable,
    launchWindowsSupervisor,
  });
  await adapter.download({ onProgress: vi.fn(), onCancelled: vi.fn() }).promise;
  await expect(adapter.prepareInstall?.({
    currentVersion: "1.2.3",
    newVersion: "1.3.0",
    handoffDirectory: data,
    profileDirectory: profile,
    dataDirectory: data,
    oldRuntimeGenerationId:
      "22222222-2222-4222-8222-222222222222:7",
    systemBootId: "win32:deadbeef",
  })).resolves.toBe(true);
  const journal = new AppUpdateHandoffJournal(data);
  return {
    adapter,
    data,
    executable,
    installer,
    journal,
    launchWindowsSupervisor,
    prepared: journal.current()!,
  };
}

async function preparedLinuxAdapterFixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-electron-updater-linux-"));
  roots.push(root);
  const cache = join(root, "cache");
  const data = join(root, "data");
  const profile = join(root, "profile");
  await Promise.all([
    mkdir(cache, { mode: 0o700 }),
    mkdir(data, { mode: 0o700 }),
    mkdir(profile, { mode: 0o700 }),
  ]);
  const active = join(root, "Inertia-1.2.3.AppImage");
  const downloaded = join(cache, "Inertia-1.3.0.AppImage");
  await Promise.all([
    writeFile(active, "old", { mode: 0o755 }),
    writeFile(downloaded, "new", { mode: 0o755 }),
  ]);
  updaterFixture.updater.downloadUpdate.mockResolvedValueOnce([downloaded]);
  let candidatePath = "";
  const abort = vi.fn(async () => undefined);
  const launchRestrictedCandidate = vi.fn(async (options) => {
    candidatePath = options.executablePath;
    const launched = options.journal.current()!;
    const acknowledgement = options.journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(launched),
      {
        operationId: launched.operationId,
        platform: launched.platform,
        channel: launched.channel,
        oldVersion: launched.oldVersion,
        newVersion: launched.newVersion,
        oldRuntimeGenerationId: launched.oldRuntimeGenerationId,
        candidateArtifactDigest: launched.candidateArtifactDigest,
        candidateExecutableIdentityDigest:
          launched.candidateExecutableIdentityDigest,
        profileIdentityDigest: launched.profileIdentityDigest,
        dataIdentityDigest: launched.dataIdentityDigest,
        handoffToken: options.handoffToken,
      },
    )!;
    return {
      pid: 42,
      acknowledgement,
      alive: () => true,
      abort,
      transferContainment: vi.fn(async () => undefined),
    };
  });
  const adapter = await loadElectronAppUpdater("stable", {
    platform: "linux",
    activeAppImagePath: active,
    environment: { APPIMAGE: active },
    launchRestrictedCandidate,
  });
  await adapter.download({ onProgress: vi.fn(), onCancelled: vi.fn() }).promise;
  await expect(adapter.prepareInstall?.({
    currentVersion: "1.2.3",
    newVersion: "1.3.0",
    handoffDirectory: data,
    profileDirectory: profile,
    dataDirectory: data,
    oldRuntimeGenerationId:
      "22222222-2222-4222-8222-222222222222:7",
    systemBootId: "linux:33333333-3333-4333-8333-333333333333",
  })).resolves.toBe(true);
  const journal = new AppUpdateHandoffJournal(data);
  return {
    abort,
    adapter,
    candidatePath,
    journal,
    prepared: journal.current()!,
  };
}

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
  updaterFixture.updater.downloadUpdate.mockReset().mockResolvedValue(["/private/download/path"]);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe("electron updater adapter", () => {
  it("applies the exact safe stable configuration without overriding the feed", async () => {
    const adapter = await loadElectronAppUpdater("stable", { platform: "darwin" });
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
    await loadElectronAppUpdater("canary", { platform: "darwin" });
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
    const adapter = await loadElectronAppUpdater("stable", { platform: "darwin" });
    await expect(adapter.check()).resolves.toEqual({
      available: false,
      version: "0.0.36",
    });
  });

  it("contains download paths, forwards progress, cancels one token, and removes listeners", async () => {
    const adapter = await loadElectronAppUpdater("stable", { platform: "darwin" });
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
    const adapter = await loadElectronAppUpdater("stable", { platform: "darwin" });
    const download = adapter.download({
      onProgress: vi.fn(),
      onCancelled: vi.fn(),
    });
    await expect(download.promise).rejects.toThrow("native start failed");
    expect(updaterFixture.listeners.get("download-progress")?.size ?? 0).toBe(0);
    expect(updaterFixture.listeners.get("update-cancelled")?.size ?? 0).toBe(0);
  });

  it("requests one visible restart/install handoff", async () => {
    const adapter = await loadElectronAppUpdater("stable", { platform: "darwin" });
    const onHandoff = vi.fn();
    const handoff = adapter.quitAndInstall(onHandoff);
    updaterFixture.emitNative("before-quit-for-update");
    await expect(handoff).resolves.toBe("handoff-confirmed");
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(updaterFixture.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updaterFixture.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(updaterFixture.nativeListeners.get("before-quit-for-update")?.size ?? 0).toBe(0);
    expect(updaterFixture.listeners.get("error")?.size ?? 0).toBe(0);
  });

  it("rejects handoff when the native installer reports an error", async () => {
    const adapter = await loadElectronAppUpdater("stable", { platform: "darwin" });
    const handoff = adapter.quitAndInstall();
    updaterFixture.emit("error", new Error("installer failed"));
    await expect(handoff).resolves.toBe("native-outcome-uncertain");
  });

  it("refuses Windows native install without a durable preparation receipt", async () => {
    const adapter = await loadElectronAppUpdater("stable", { platform: "win32" });
    const onHandoff = vi.fn();
    await expect(adapter.quitAndInstall(onHandoff)).resolves.toBe("not-invoked");

    expect(onHandoff).not.toHaveBeenCalled();
    expect(updaterFixture.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updaterFixture.nativeListeners.get("before-quit-for-update")?.size ?? 0)
      .toBe(0);
    expect(updaterFixture.listeners.get("error")?.size ?? 0).toBe(0);
  });

  it("keeps Windows at cleanup-confirmed until the exact installed candidate starts", async () => {
    const fixture = await preparedWindowsAdapterFixture();
    const prepared = fixture.journal.current();
    expect(prepared?.phase).toBe("prepared");
    expect(
      Date.parse(prepared!.deadlineAt) - Date.parse(prepared!.createdAt),
    ).toBe(24 * 60 * 60 * 1_000);

    const onHandoff = vi.fn();
    const handoff = fixture.adapter.quitAndInstall(onHandoff);
    await vi.waitFor(() => expect(fixture.launchWindowsSupervisor)
      .toHaveBeenCalledOnce());
    expect(fixture.journal.current()?.phase).toBe(
      "old-generation-cleanup-confirmed",
    );
    updaterFixture.emitNative("before-quit-for-update");

    await expect(handoff).resolves.toBe("handoff-confirmed");
    expect(onHandoff).toHaveBeenCalledOnce();
    expect(fixture.journal.current()?.phase)
      .toBe("old-generation-cleanup-confirmed");
    expect(fixture.launchWindowsSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDirectory: fixture.data,
        installerPath: fixture.installer,
        oldExecutablePath: fixture.executable,
        snapshot: expect.objectContaining({
          phase: "old-generation-cleanup-confirmed",
        }),
      }),
    );
    expect(updaterFixture.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updaterFixture.nativeUpdater.on).not.toHaveBeenCalled();
    expect(updaterFixture.app.quit).toHaveBeenCalledOnce();
    await expect(readFile(
      join(fixture.data, ".app-update-secret.json"),
      "utf8",
    ))
      .resolves.toContain("handoffToken");
  });

  it("gives concurrent Windows install callers one native owner and one handoff", async () => {
    let resolveSupervisor!: (value: {
      readonly helperPath: string;
      readonly helperDigest: string;
    }) => void;
    const launchWindowsSupervisor = vi.fn(async () => await new Promise<{
      readonly helperPath: string;
      readonly helperDigest: string;
    }>((resolve) => { resolveSupervisor = resolve; }));
    const fixture = await preparedWindowsAdapterFixture({
      launchWindowsSupervisor,
    });
    const ownerHandoff = vi.fn();
    const followerHandoff = vi.fn();

    const owner = fixture.adapter.quitAndInstall(ownerHandoff);
    const follower = fixture.adapter.quitAndInstall(followerHandoff);
    expect(follower).toBe(owner);
    await vi.waitFor(() => expect(launchWindowsSupervisor).toHaveBeenCalledOnce());
    resolveSupervisor({
      helperPath: join(fixture.data, "supervisor.exe"),
      helperDigest: "c".repeat(64),
    });

    await expect(Promise.all([owner, follower])).resolves.toEqual([
      "handoff-confirmed",
      "handoff-confirmed",
    ]);
    expect(ownerHandoff).toHaveBeenCalledOnce();
    expect(followerHandoff).not.toHaveBeenCalled();
    expect(updaterFixture.app.quit).toHaveBeenCalledOnce();
  });

  it("keeps a competing adapter from mutating the native winner's shared authority", async () => {
    let launchImplementation: WindowsUpdateSupervisorLauncher = async () => {
      throw new Error("The test native launch was not armed.");
    };
    const winnerLauncher = vi.fn(async (
      options: Parameters<WindowsUpdateSupervisorLauncher>[0],
    ) => await launchImplementation(options));
    const fixture = await preparedWindowsAdapterFixture({
      launchWindowsSupervisor: winnerLauncher,
    });
    const loserLauncher = vi.fn(async (
      options: Parameters<WindowsUpdateSupervisorLauncher>[0],
    ) => await launchImplementation(options));
    const loserAdapter = await loadElectronAppUpdater("stable", {
      platform: "win32",
      executablePath: fixture.executable,
      launchWindowsSupervisor: loserLauncher,
    });
    type AdapterWindowsState = {
      preparedWindows: Record<string, unknown> | null;
    };
    const winnerState = (
      fixture.adapter as unknown as AdapterWindowsState
    ).preparedWindows;
    if (!winnerState) throw new Error("The winner preparation is missing.");
    (loserAdapter as unknown as AdapterWindowsState).preparedWindows = {
      ...winnerState,
    };

    const runtime = join(
      await realpath(join(fixture.data, "..")),
      "runtime",
    );
    await mkdir(runtime, { mode: 0o700 });
    const assemblyPath = join(runtime, "windows-runtime-job.exe");
    const assemblyBytes = Buffer.from("shared native update supervisor");
    await writeFile(assemblyPath, assemblyBytes, { mode: 0o700 });
    const assembly = {
      path: assemblyPath,
      root: runtime,
      sha256: createHash("sha256").update(assemblyBytes).digest("hex"),
    };
    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((resolveWinner) => {
      releaseWinner = resolveWinner;
    });
    let claimPublished!: () => void;
    const claimReady = new Promise<void>((resolveClaim) => {
      claimPublished = resolveClaim;
    });
    let nativeLaunches = 0;
    launchImplementation = async (options) => await launchWindowsUpdateSupervisor({
      ...options,
      assembly,
      launchThroughExecutableLock: async (locked) => {
        nativeLaunches += 1;
        const fields = decodedWindowsSupervisorRequest(locked.request);
        const claim = {
          schemaVersion: 1 as const,
          operationId: options.snapshot.operationId,
          handoffChecksum: options.snapshot.checksum,
          launchId: fields.get("launchId")!,
          supervisorDigest: assembly.sha256,
          deadlineAt: options.snapshot.deadlineAt,
        };
        const authenticationTag =
          windowsUpdateOperationClaimAuthenticationTag(
            claim,
            options.handoffToken,
          );
        if (!authenticationTag) {
          throw new Error("The test operation claim is invalid.");
        }
        await writeFile(
          join(
            fixture.data,
            windowsUpdateTerminalReceiptTemporaryName(
              options.snapshot.operationId,
            ),
          ),
          JSON.stringify({ ...claim, authenticationTag }),
          { mode: 0o600 },
        );
        claimPublished();
        await winnerGate;
      },
    });

    const secretPath = join(fixture.data, ".app-update-secret.json");
    const secretBefore = await readFile(secretPath);
    const winnerHandoff = vi.fn();
    const loserHandoff = vi.fn();
    const winner = fixture.adapter.quitAndInstall(winnerHandoff);
    await claimReady;
    const claimPath = join(
      fixture.data,
      windowsUpdateTerminalReceiptTemporaryName(fixture.prepared.operationId),
    );
    const helperPath = join(
      fixture.data,
      windowsUpdateSupervisorExecutableName(fixture.prepared.operationId),
    );
    const claimBefore = await readFile(claimPath);
    const helperBefore = await readFile(helperPath);

    await expect(loserAdapter.quitAndInstall(loserHandoff)).resolves.toBe(
      "native-outcome-uncertain",
    );

    expect(fixture.journal.current()?.phase).toBe(
      "old-generation-cleanup-confirmed",
    );
    await expect(readFile(secretPath)).resolves.toEqual(secretBefore);
    await expect(readFile(claimPath)).resolves.toEqual(claimBefore);
    await expect(readFile(helperPath)).resolves.toEqual(helperBefore);
    expect(parseWindowsUpdateOperationClaim(claimBefore)?.operationId).toBe(
      fixture.prepared.operationId,
    );
    expect(loserHandoff).not.toHaveBeenCalled();
    expect(nativeLaunches).toBe(1);

    releaseWinner();
    await expect(winner).resolves.toBe("handoff-confirmed");
    expect(winnerHandoff).toHaveBeenCalledOnce();
    expect(updaterFixture.app.quit).toHaveBeenCalledOnce();
    await expect(readFile(secretPath)).resolves.toEqual(secretBefore);
    await expect(readFile(claimPath)).resolves.toEqual(claimBefore);
    await expect(readFile(helperPath)).resolves.toEqual(helperBefore);
  });

  it("rejects an installer without one signed candidate identity marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-electron-updater-win-"));
    roots.push(root);
    const data = join(root, "data");
    const profile = join(root, "profile");
    await Promise.all([
      mkdir(data, { mode: 0o700 }),
      mkdir(profile, { mode: 0o700 }),
    ]);
    const installer = join(root, "Inertia-1.3.0.exe");
    const executable = join(root, "Inertia.exe");
    await Promise.all([
      writeFile(installer, "installer", { mode: 0o700 }),
      writeFile(executable, "old-build", { mode: 0o700 }),
    ]);
    updaterFixture.updater.downloadUpdate.mockResolvedValueOnce([installer]);
    const adapter = await loadElectronAppUpdater("stable", {
      platform: "win32",
      executablePath: executable,
    });
    await adapter.download({ onProgress: vi.fn(), onCancelled: vi.fn() }).promise;

    await expect(adapter.prepareInstall?.({
      currentVersion: "1.2.3",
      newVersion: "1.3.0",
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      oldRuntimeGenerationId:
        "22222222-2222-4222-8222-222222222222:7",
      systemBootId: "win32:deadbeef",
    })).resolves.toBe(false);
    expect(new AppUpdateHandoffJournal(data).current()).toBeNull();
    expect(updaterFixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("retires a Windows preparation when the supervisor proves a pre-READY failure", async () => {
    const launchWindowsSupervisor = vi.fn(async () => {
      throw new Error("supervisor rejected before READY");
    });
    const fixture = await preparedWindowsAdapterFixture({
      launchWindowsSupervisor,
    });

    await expect(fixture.adapter.quitAndInstall()).resolves.toBe("not-invoked");

    expect(fixture.journal.current()).toBeNull();
    expect(updaterFixture.app.quit).not.toHaveBeenCalled();
    await expect(readFile(
      join(fixture.data, ".app-update-secret.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Windows authority unchanged when rejected-supervisor cleanup is unconfirmed", async () => {
    const launchWindowsSupervisor = vi.fn(async () => {
      throw new WindowsUpdateSupervisorCleanupError(
        new Error("helper exit not observed"),
      );
    });
    const fixture = await preparedWindowsAdapterFixture({
      launchWindowsSupervisor,
    });
    const onHandoff = vi.fn();

    await expect(fixture.adapter.quitAndInstall(onHandoff)).resolves
      .toBe("native-outcome-uncertain");

    expect(onHandoff).not.toHaveBeenCalled();
    expect(fixture.journal.current()?.phase).toBe(
      "old-generation-cleanup-confirmed",
    );
    await expect(readFile(
      join(fixture.data, ".app-update-secret.json"),
      "utf8",
    )).resolves.toContain("handoffToken");
    expect(updaterFixture.app.quit).not.toHaveBeenCalled();
  });

  it("bounds the abort race after supervisor READY without transferring ownership", async () => {
    let resolveSupervisor!: (value: {
      helperPath: string;
      helperDigest: string;
    }) => void;
    const launchWindowsSupervisor = vi.fn(async () => await new Promise<{
      helperPath: string;
      helperDigest: string;
    }>((resolve) => { resolveSupervisor = resolve; }));
    const fixture = await preparedWindowsAdapterFixture({
      launchWindowsSupervisor,
    });
    const handoff = fixture.adapter.quitAndInstall();
    await vi.waitFor(() => expect(launchWindowsSupervisor).toHaveBeenCalledOnce());

    await expect(fixture.adapter.abortInstall!()).rejects.toThrow(
      "native Windows installer retained unconfirmed authority",
    );
    resolveSupervisor({
      helperPath: join(fixture.data, "supervisor.exe"),
      helperDigest: "c".repeat(64),
    });

    await expect(handoff).resolves.toBe("native-outcome-uncertain");
    expect(fixture.journal.current()?.phase).toBe("rollback-required");
    expect(updaterFixture.app.quit).not.toHaveBeenCalled();
  });

  it("fails a post-READY journal race closed", async () => {
    let resolveSupervisor!: (value: {
      helperPath: string;
      helperDigest: string;
    }) => void;
    const launchWindowsSupervisor = vi.fn(async () => await new Promise<{
      helperPath: string;
      helperDigest: string;
    }>((resolve) => { resolveSupervisor = resolve; }));
    const fixture = await preparedWindowsAdapterFixture({
      launchWindowsSupervisor,
    });
    const onHandoff = vi.fn();
    const handoff = fixture.adapter.quitAndInstall(onHandoff);
    await vi.waitFor(() => expect(launchWindowsSupervisor).toHaveBeenCalledOnce());
    await writeFile(
      join(fixture.data, ".app-update-handoff-foreign"),
      "foreign",
      { mode: 0o600 },
    );
    resolveSupervisor({
      helperPath: join(fixture.data, "supervisor.exe"),
      helperDigest: "c".repeat(64),
    });

    await expect(handoff).resolves.toBe("native-outcome-uncertain");
    expect(onHandoff).not.toHaveBeenCalled();
    expect(updaterFixture.app.quit).not.toHaveBeenCalled();
  });

  it.each(["missing", "replacement", "advanced"] as const)(
    "never erases %s Windows authority through a stale prepared owner",
    async (state) => {
      const fixture = await preparedWindowsAdapterFixture();
      const retained = state === "advanced"
        ? fixture.journal.transition(
            appUpdateHandoffOwner(fixture.prepared),
            "old-generation-cleanup-confirmed",
          )
        : (() => {
            retirePreparedHandoff(fixture.journal, fixture.prepared);
            return state === "replacement"
              ? fixture.journal.prepare(
                  replacementPreparation(fixture.prepared),
                )
              : null;
          })();

      await expect(fixture.adapter.abortInstall!()).rejects.toThrow(
        "rollback could not be confirmed",
      );

      expect(fixture.journal.current()).toEqual(retained);
      expect(updaterFixture.updater.quitAndInstall).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32").each([
    "missing",
    "replacement",
    "advanced",
  ] as const)(
    "never erases %s Linux authority or its staged transaction through a stale owner",
    async (state) => {
      const fixture = await preparedLinuxAdapterFixture();
      const retained = state === "advanced"
        ? fixture.journal.transition(
            appUpdateHandoffOwner(fixture.prepared),
            "old-generation-cleanup-confirmed",
          )
        : (() => {
            retirePreparedHandoff(fixture.journal, fixture.prepared);
            return state === "replacement"
              ? fixture.journal.prepare(
                  replacementPreparation(fixture.prepared),
                )
              : null;
          })();

      await expect(fixture.adapter.abortInstall!()).rejects.toThrow(
        "rollback could not be confirmed",
      );

      expect(fixture.abort).toHaveBeenCalledOnce();
      expect(fixture.journal.current()).toEqual(retained);
      await expect(readFile(fixture.candidatePath, "utf8")).resolves.toBe("new");
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries only exact Linux rollback retirement after an interrupted retirement",
    async () => {
      const fixture = await preparedLinuxAdapterFixture();
      const retire = AppUpdateHandoffJournal.prototype.retire;
      const retireSpy = vi.spyOn(AppUpdateHandoffJournal.prototype, "retire")
        .mockImplementationOnce(() => false)
        .mockImplementation(function (
          this: AppUpdateHandoffJournal,
          owner,
        ) {
          return retire.call(this, owner);
        });
      try {
        await expect(fixture.adapter.abortInstall!()).rejects.toThrow(
          "candidate rollback could not be confirmed",
        );
        expect(fixture.journal.current()?.phase).toBe("rollback-completed");

        await expect(fixture.adapter.abortInstall!()).resolves.toBeUndefined();

        expect(fixture.journal.current()).toBeNull();
        expect(retireSpy).toHaveBeenCalledTimes(2);
        expect(fixture.abort).toHaveBeenCalledTimes(2);
        await expect(readFile(fixture.candidatePath, "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        retireSpy.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses the legacy spawn-only AppImage handoff on Linux",
    async () => {
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
      const adapter = await loadElectronAppUpdater("stable", {
        platform: "linux",
        activeAppImagePath: active,
        environment,
      });
      await adapter.download({
        onProgress: vi.fn(),
        onCancelled: vi.fn(),
      }).promise;
      const onHandoff = vi.fn();

      await expect(adapter.quitAndInstall(onHandoff)).resolves.toBe("not-invoked");

      const stable = join(await realpath(root), "Inertia.AppImage");
      await expect(readFile(stable, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(environment.APPIMAGE).toBe(await realpath(active));
      expect(onHandoff).not.toHaveBeenCalled();
      expect(updaterFixture.app.quit).not.toHaveBeenCalled();
      expect(updaterFixture.updater.quitAndInstall).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails the production Linux handoff closed without a candidate bootstrap ACK",
    async () => {
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
      const adapter = await loadElectronAppUpdater("stable", {
        platform: "linux",
        activeAppImagePath: active,
        environment,
      });
      await adapter.download({
        onProgress: vi.fn(),
        onCancelled: vi.fn(),
      }).promise;
      const onHandoff = vi.fn();

      await expect(adapter.quitAndInstall(onHandoff)).resolves.toBe("not-invoked");

      expect(await readFile(active, "utf8")).toBe("old");
      await expect(readFile(join(root, "Inertia.AppImage"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(environment.APPIMAGE).toBe(await realpath(active));
      expect(onHandoff).not.toHaveBeenCalled();
      expect(updaterFixture.app.quit).not.toHaveBeenCalled();
      expect(updaterFixture.updater.quitAndInstall).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "commits Linux ownership only after the exact restricted candidate ACK",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-electron-updater-"));
      roots.push(root);
      const cache = join(root, "cache");
      const data = join(root, "data");
      const profile = join(root, "profile");
      await Promise.all([
        mkdir(cache, { mode: 0o700 }),
        mkdir(data, { mode: 0o700 }),
        mkdir(profile, { mode: 0o700 }),
      ]);
      const active = join(root, "Inertia-1.2.3.AppImage");
      const downloaded = join(cache, "Inertia-1.3.0.AppImage");
      await Promise.all([
        writeFile(active, "old", { mode: 0o755 }),
        writeFile(downloaded, "new", { mode: 0o755 }),
      ]);
      await Promise.all([chmod(active, 0o755), chmod(downloaded, 0o755)]);
      updaterFixture.updater.downloadUpdate.mockResolvedValueOnce([downloaded]);
      let alive = true;
      const abort = vi.fn(async () => { alive = false; });
      const launchRestrictedCandidate = vi.fn(async (options) => {
        const launched = options.journal.current()!;
        const acknowledged = options.journal.acknowledgeCandidateBootstrap(
          appUpdateHandoffOwner(launched),
          {
            operationId: launched.operationId,
            platform: launched.platform,
            channel: launched.channel,
            oldVersion: launched.oldVersion,
            newVersion: launched.newVersion,
            oldRuntimeGenerationId: launched.oldRuntimeGenerationId,
            candidateArtifactDigest: launched.candidateArtifactDigest,
            candidateExecutableIdentityDigest:
              launched.candidateExecutableIdentityDigest,
            profileIdentityDigest: launched.profileIdentityDigest,
            dataIdentityDigest: launched.dataIdentityDigest,
            handoffToken: options.handoffToken,
          },
        )!;
        return {
          pid: 42,
          acknowledgement: acknowledged,
          alive: () => alive,
          abort,
          transferContainment: vi.fn(async () => undefined),
        };
      });
      const environment = { APPIMAGE: active };
      const adapter = await loadElectronAppUpdater("stable", {
        platform: "linux",
        activeAppImagePath: active,
        environment,
        launchRestrictedCandidate,
      });
      await adapter.download({
        onProgress: vi.fn(),
        onCancelled: vi.fn(),
      }).promise;

      await expect(adapter.prepareInstall?.({
        currentVersion: "1.2.3",
        newVersion: "1.3.0",
        handoffDirectory: data,
        profileDirectory: profile,
        dataDirectory: data,
        oldRuntimeGenerationId:
          "22222222-2222-4222-8222-222222222222:7",
        systemBootId: "linux:33333333-3333-4333-8333-333333333333",
      })).resolves.toBe(true);
      expect(new AppUpdateHandoffJournal(data).current()?.phase)
        .toBe("candidate-bootstrap-validated");
      await expect(readFile(join(root, "Inertia.AppImage"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      const onHandoff = vi.fn();
      await expect(adapter.quitAndInstall(onHandoff)).resolves.toBe("handoff-confirmed");

      expect(await readFile(join(root, "Inertia.AppImage"), "utf8")).toBe("new");
      expect(new AppUpdateHandoffJournal(data).current()?.phase)
        .toBe("ownership-transfer-committed");
      expect(onHandoff).toHaveBeenCalledOnce();
      expect(updaterFixture.app.quit).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rolls Linux back when an acknowledged candidate exits before transfer",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-electron-updater-"));
      roots.push(root);
      const cache = join(root, "cache");
      const data = join(root, "data");
      const profile = join(root, "profile");
      await Promise.all([
        mkdir(cache, { mode: 0o700 }),
        mkdir(data, { mode: 0o700 }),
        mkdir(profile, { mode: 0o700 }),
      ]);
      const active = join(root, "Inertia-1.2.3.AppImage");
      const downloaded = join(cache, "Inertia-1.3.0.AppImage");
      await Promise.all([
        writeFile(active, "old", { mode: 0o755 }),
        writeFile(downloaded, "new", { mode: 0o755 }),
      ]);
      updaterFixture.updater.downloadUpdate.mockResolvedValueOnce([downloaded]);
      const launchRestrictedCandidate = vi.fn(async (options) => {
        const launched = options.journal.current()!;
        const acknowledged = options.journal.acknowledgeCandidateBootstrap(
          appUpdateHandoffOwner(launched),
          {
            operationId: launched.operationId,
            platform: launched.platform,
            channel: launched.channel,
            oldVersion: launched.oldVersion,
            newVersion: launched.newVersion,
            oldRuntimeGenerationId: launched.oldRuntimeGenerationId,
            candidateArtifactDigest: launched.candidateArtifactDigest,
            candidateExecutableIdentityDigest:
              launched.candidateExecutableIdentityDigest,
            profileIdentityDigest: launched.profileIdentityDigest,
            dataIdentityDigest: launched.dataIdentityDigest,
            handoffToken: options.handoffToken,
          },
        )!;
        return {
          pid: 42,
          acknowledgement: acknowledged,
          alive: () => false,
          abort: vi.fn(async () => undefined),
          transferContainment: vi.fn(async () => undefined),
        };
      });
      const adapter = await loadElectronAppUpdater("stable", {
        platform: "linux",
        activeAppImagePath: active,
        environment: { APPIMAGE: active },
        launchRestrictedCandidate,
      });
      await adapter.download({ onProgress: vi.fn(), onCancelled: vi.fn() }).promise;
      await expect(adapter.prepareInstall?.({
        currentVersion: "1.2.3",
        newVersion: "1.3.0",
        handoffDirectory: data,
        profileDirectory: profile,
        dataDirectory: data,
        oldRuntimeGenerationId:
          "22222222-2222-4222-8222-222222222222:7",
        systemBootId: "linux:33333333-3333-4333-8333-333333333333",
      })).resolves.toBe(true);

      await expect(adapter.quitAndInstall()).resolves.toBe("not-invoked");

      expect(await readFile(active, "utf8")).toBe("old");
      expect(new AppUpdateHandoffJournal(data).current()).toBeNull();
      await expect(readFile(join(root, "Inertia.AppImage"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
