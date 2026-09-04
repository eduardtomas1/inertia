// @inertia-test-suite portable

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appUpdateDirectoryIdentityDigest,
  windowsAppUpdateExecutableLineageDigest,
} from "../../src/main/app-update-bootstrap";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenDigest,
  type AppUpdateHandoffSnapshot,
} from "../../src/main/app-update-handoff";
import { AppUpdateHandoffTokenVault } from
  "../../src/main/app-update-handoff-token-vault";
import {
  createWindowsUpdateTerminalReceipt,
  serializeWindowsUpdateTerminalReceipt,
  windowsUpdateSupervisorExecutableName,
  windowsUpdateTerminalReceiptName,
  type WindowsUpdateTerminalOutcome,
} from "../../src/main/windows-update-terminal-receipt";
import {
  finalizeAppImageUpdate,
  prepareAppImageUpdate,
  recoverAppImageUpdateForHandoff,
  type PreparedAppImageUpdate,
} from "../../src/main/appimage-installed-identity";
import {
  beginAppUpdateRollback,
  completeWindowsUpdateRollback,
  retireAppUpdateRollback,
  startApplicationWithUpdateHandoff,
  type AppUpdateStartupOptions,
} from "../../src/main/app-update-startup";
import { LinuxAppUpdateCandidateClaimJournal } from
  "../../src/main/linux-app-update-candidate-claim";

const roots: string[] = [];
const operationId = "11111111-1111-4111-8111-111111111111";
const token = "A".repeat(43);

interface WindowsFixture {
  readonly root: string;
  readonly dataDirectory: string;
  readonly profileDirectory: string;
  readonly executablePath: string;
  readonly journal: AppUpdateHandoffJournal;
  readonly vault: AppUpdateHandoffTokenVault;
  readonly prepared: AppUpdateHandoffSnapshot;
}

interface LinuxFixture {
  readonly dataDirectory: string;
  readonly profileDirectory: string;
  readonly activePath: string;
  readonly journal: AppUpdateHandoffJournal;
  readonly prepared: AppUpdateHandoffSnapshot;
  readonly transaction: PreparedAppImageUpdate;
}

async function windowsFixture(): Promise<WindowsFixture> {
  const root = await mkdtemp(join(tmpdir(), "inertia-update-startup-"));
  roots.push(root);
  const dataDirectory = join(root, "data");
  const profileDirectory = join(root, "profile");
  await Promise.all([
    mkdir(dataDirectory, { mode: 0o700 }),
    mkdir(profileDirectory, { mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(dataDirectory, 0o700),
    chmod(profileDirectory, 0o700),
  ]);
  const executablePath = join(root, "Inertia.exe");
  await writeFile(executablePath, "new executable", { mode: 0o755 });
  const artifactDigest = "a".repeat(64);
  const now = Date.now();
  const journal = new AppUpdateHandoffJournal(dataDirectory);
  const prepared = journal.prepare({
    operationId,
    platform: "win32",
    channel: "stable",
    oldVersion: "1.2.3",
    newVersion: "1.3.0",
    oldRuntimeGenerationId:
      "22222222-2222-4222-8222-222222222222:7",
    systemBootId: "win32:deadbeef",
    candidateArtifactDigest: artifactDigest,
    candidateExecutableIdentityDigest:
      windowsAppUpdateExecutableLineageDigest({
        artifactDigest,
        candidateExecutableDigest: createHash("sha256")
          .update("new executable")
          .digest("hex"),
        executablePath,
        version: "1.3.0",
      }),
    profileIdentityDigest: appUpdateDirectoryIdentityDigest(
      profileDirectory,
      "profile",
    ),
    dataIdentityDigest: appUpdateDirectoryIdentityDigest(
      dataDirectory,
      "data",
    ),
    handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
  })!;
  const vault = new AppUpdateHandoffTokenVault(dataDirectory);
  expect(vault.publish(prepared, token)).toBe(true);
  return {
    root,
    dataDirectory,
    profileDirectory,
    executablePath,
    journal,
    vault,
    prepared,
  };
}

async function linuxFixture(options: {
  readonly transactionOperationId?: string;
  readonly handoffOperationId?: string;
} = {}): Promise<LinuxFixture> {
  const root = await mkdtemp(join(tmpdir(), "inertia-update-startup-linux-"));
  roots.push(root);
  const dataDirectory = join(root, "data");
  const profileDirectory = join(root, "profile");
  await Promise.all([
    mkdir(dataDirectory, { mode: 0o700 }),
    mkdir(profileDirectory, { mode: 0o700 }),
  ]);
  const activePath = join(root, "Inertia-1.2.3.AppImage");
  const downloadedPath = join(root, "downloaded.AppImage");
  await Promise.all([
    writeFile(activePath, "old", { mode: 0o755 }),
    writeFile(downloadedPath, "new", { mode: 0o755 }),
  ]);
  const transaction = await prepareAppImageUpdate({
    channel: "stable",
    activePath,
    downloadedPath,
    operationId: options.transactionOperationId ?? operationId,
  });
  const now = Date.now();
  const journal = new AppUpdateHandoffJournal(dataDirectory);
  const prepared = journal.prepare({
    operationId: options.handoffOperationId ?? operationId,
    platform: "linux",
    channel: "stable",
    oldVersion: "1.2.3",
    newVersion: "1.3.0",
    oldRuntimeGenerationId:
      "22222222-2222-4222-8222-222222222222:7",
    systemBootId: "linux:33333333-3333-4333-8333-333333333333",
    candidateArtifactDigest: transaction.artifactDigest,
    candidateExecutableIdentityDigest: transaction.executableIdentityDigest,
    profileIdentityDigest: appUpdateDirectoryIdentityDigest(
      profileDirectory,
      "profile",
    ),
    dataIdentityDigest: appUpdateDirectoryIdentityDigest(
      dataDirectory,
      "data",
    ),
    handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
  })!;
  return {
    dataDirectory,
    profileDirectory,
    activePath,
    journal,
    prepared,
    transaction,
  };
}

function transferOwnership(fixture: WindowsFixture): AppUpdateHandoffSnapshot {
  const cleaned = fixture.journal.transition(
    appUpdateHandoffOwner(fixture.prepared),
    "old-generation-cleanup-confirmed",
  )!;
  return fixture.journal.transition(
    appUpdateHandoffOwner(cleaned),
    "ownership-transfer-committed",
  )!;
}

async function publishWindowsTerminalReceipt(
  fixture: WindowsFixture,
  snapshot: AppUpdateHandoffSnapshot,
  outcome: WindowsUpdateTerminalOutcome,
): Promise<void> {
  const executableDigest = createHash("sha256")
    .update(await readFile(fixture.executablePath))
    .digest("hex");
  const receipt = createWindowsUpdateTerminalReceipt({
    schemaVersion: 1,
    operationId: snapshot.operationId,
    handoffChecksum: snapshot.checksum,
    outcome,
    installerExitCode: outcome === "success" ? 0 : null,
    installerDigest: snapshot.candidateArtifactDigest,
    supervisorDigest: "c".repeat(64),
    executableDigest: outcome === "quarantined" ? null : executableDigest,
    parentCreationTimeBits: "123456789",
    completedAt: outcome === "quarantined"
      ? new Date(Date.parse(snapshot.deadlineAt) + 1).toISOString()
      : snapshot.transitionedAt,
  }, token);
  await writeFile(
    join(
      fixture.dataDirectory,
      windowsUpdateTerminalReceiptName(snapshot.operationId),
    ),
    serializeWindowsUpdateTerminalReceipt(receipt),
    { mode: 0o600 },
  );
}

async function completeLinuxUpdate(
  fixture: LinuxFixture,
): Promise<AppUpdateHandoffSnapshot> {
  const launched = fixture.journal.transition(
    appUpdateHandoffOwner(fixture.prepared),
    "candidate-launched",
  )!;
  const validated = fixture.journal.acknowledgeCandidateBootstrap(
    appUpdateHandoffOwner(launched),
    {
      operationId: fixture.prepared.operationId,
      platform: fixture.prepared.platform,
      channel: fixture.prepared.channel,
      oldVersion: fixture.prepared.oldVersion,
      newVersion: fixture.prepared.newVersion,
      oldRuntimeGenerationId: fixture.prepared.oldRuntimeGenerationId,
      candidateArtifactDigest: fixture.prepared.candidateArtifactDigest,
      candidateExecutableIdentityDigest:
        fixture.prepared.candidateExecutableIdentityDigest,
      profileIdentityDigest: fixture.prepared.profileIdentityDigest,
      dataIdentityDigest: fixture.prepared.dataIdentityDigest,
      handoffToken: token,
    },
  )!;
  const cleaned = fixture.journal.transition(
    appUpdateHandoffOwner(validated),
    "old-generation-cleanup-confirmed",
  )!;
  await fixture.transaction.commit();
  const transferred = fixture.journal.transition(
    appUpdateHandoffOwner(cleaned),
    "ownership-transfer-committed",
  )!;
  const admitted = fixture.journal.transition(
    appUpdateHandoffOwner(transferred),
    "candidate-admitted",
  )!;
  return fixture.journal.transition(
    appUpdateHandoffOwner(admitted),
    "completed",
  )!;
}

function applicationFixture(
  lock: boolean,
  order: string[],
): {
  readonly application: AppUpdateStartupOptions["application"];
  readonly quit: ReturnType<typeof vi.fn>;
  readonly exit: ReturnType<typeof vi.fn>;
  readonly listeners: Map<string, unknown[]>;
} {
  const listeners = new Map<string, unknown[]>();
  const quit = vi.fn(() => { order.push("quit"); });
  const exit = vi.fn((_code?: number) => { order.push("exit"); });
  const application = {
    exit,
    quit,
    requestSingleInstanceLock: () => {
      order.push("lock");
      return lock;
    },
    whenReady: async () => { order.push("ready"); },
    on: (event: string, listener: unknown) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return application;
    },
  };
  return {
    application: application as unknown as AppUpdateStartupOptions["application"],
    quit,
    exit,
    listeners,
  };
}

function startupOptions(
  fixture: WindowsFixture,
  application: AppUpdateStartupOptions["application"],
  overrides: Partial<AppUpdateStartupOptions> = {},
): AppUpdateStartupOptions {
  return {
    platform: "win32",
    environment: {},
    channel: "stable",
    version: "1.3.0",
    executablePath: fixture.executablePath,
    dataDirectory: fixture.dataDirectory,
    profileDirectory: fixture.profileDirectory,
    application,
    focusMainWindow: vi.fn(),
    updateInstallCoordinator: () => null,
    recordBeforeQuit: vi.fn(),
    cleanupBeforeQuit: async () => true,
    finishNormalShutdown: vi.fn(),
    onUnconfirmedShutdown: vi.fn(),
    reportCleanupFailure: vi.fn(),
    validateCandidateBootstrap: async () => undefined,
    bootstrap: async () => undefined,
    awaitCandidateReadiness: async () => undefined,
    cleanupFailedCandidate: async () => true,
    reportCandidateFailure: vi.fn(),
    ...overrides,
  };
}

function linuxStartupOptions(
  fixture: LinuxFixture,
  application: AppUpdateStartupOptions["application"],
  overrides: Partial<AppUpdateStartupOptions> = {},
): AppUpdateStartupOptions {
  return {
    platform: "linux",
    environment: { APPIMAGE: fixture.activePath },
    channel: "stable",
    version: "1.2.3",
    executablePath: fixture.activePath,
    dataDirectory: fixture.dataDirectory,
    profileDirectory: fixture.profileDirectory,
    application,
    focusMainWindow: vi.fn(),
    updateInstallCoordinator: () => null,
    recordBeforeQuit: vi.fn(),
    cleanupBeforeQuit: async () => true,
    finishNormalShutdown: vi.fn(),
    onUnconfirmedShutdown: vi.fn(),
    reportCleanupFailure: vi.fn(),
    validateCandidateBootstrap: async () => undefined,
    bootstrap: async () => undefined,
    awaitCandidateReadiness: async () => undefined,
    cleanupFailedCandidate: async () => true,
    reportCandidateFailure: vi.fn(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe("app update startup coordinator", () => {
  it("validates, grants normal admission, bootstraps, and consumes Windows authority in order", async () => {
    const fixture = await windowsFixture();
    transferOwnership(fixture);
    const order: string[] = [];
    const application = applicationFixture(true, order);

    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      {
        validateCandidateBootstrap: async (id) => {
          expect(id).toBe(operationId);
          expect(fixture.journal.current()?.phase).toBe("candidate-launched");
          order.push("validated");
        },
        bootstrap: async () => {
          expect(fixture.journal.current()?.phase).toBe("candidate-admitted");
          order.push("bootstrap");
        },
        awaitCandidateReadiness: async () => {
          expect(fixture.journal.current()?.phase).toBe("candidate-admitted");
          order.push("runtime-ready");
        },
      },
    ));

    expect(order).toEqual([
      "lock",
      "validated",
      "ready",
      "bootstrap",
      "runtime-ready",
    ]);
    expect(fixture.journal.current()).toBeNull();
    expect(fixture.vault.matches(fixture.prepared)).toBe(false);
    expect(application.listeners.has("before-quit")).toBe(true);
    expect(application.exit).not.toHaveBeenCalled();
  });

  it("lets only the exact installed Windows candidate commit ownership transfer", async () => {
    const fixture = await windowsFixture();
    const cleanupConfirmed = fixture.journal.transition(
      appUpdateHandoffOwner(fixture.prepared),
      "old-generation-cleanup-confirmed",
    )!;
    await publishWindowsTerminalReceipt(fixture, cleanupConfirmed, "success");
    const order: string[] = [];
    const application = applicationFixture(true, order);

    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      {
        validateCandidateBootstrap: async () => {
          expect(fixture.journal.current()?.phase).toBe("candidate-launched");
          order.push("validated");
        },
        bootstrap: async () => {
          expect(fixture.journal.current()?.phase).toBe("candidate-admitted");
          order.push("bootstrap");
        },
      },
    ));

    expect(cleanupConfirmed.phase).toBe("old-generation-cleanup-confirmed");
    expect(order).toEqual(["lock", "validated", "ready", "bootstrap"]);
    expect(fixture.journal.current()).toBeNull();
  });

  it("does not claim or validate a candidate that loses the singleton lock", async () => {
    const fixture = await windowsFixture();
    const transferred = transferOwnership(fixture);
    const order: string[] = [];
    const application = applicationFixture(false, order);
    const validateCandidateBootstrap = vi.fn(async () => undefined);

    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      { validateCandidateBootstrap },
    ));

    expect(order).toEqual(["lock", "quit"]);
    expect(validateCandidateBootstrap).not.toHaveBeenCalled();
    expect(fixture.journal.current()).toEqual(transferred);
    expect(fixture.vault.matches(transferred)).toBe(true);
  });

  it("does not mutate an active old generation's prepared receipt before winning the lock", async () => {
    const fixture = await windowsFixture();
    const order: string[] = [];
    const application = applicationFixture(false, order);

    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      { version: "1.2.3" },
    ));

    expect(order).toEqual(["lock", "quit"]);
    expect(fixture.journal.current()).toEqual(fixture.prepared);
    expect(fixture.vault.matches(fixture.prepared)).toBe(true);
  });

  it("does not recover an interrupted Windows publisher before winning the lock", async () => {
    const fixture = await windowsFixture();
    const interrupted = new AppUpdateHandoffJournal(fixture.dataDirectory, {
      testHooks: {
        beforeRename: (source, target) => {
          if (
            source.includes(".app-update-handoff-proposal-")
            && source.endsWith(".json")
            && target.endsWith(".app-update-handoff.json")
          ) throw new Error("simulated old-generation transition crash");
        },
      },
    });
    expect(() => interrupted.transition(
      appUpdateHandoffOwner(fixture.prepared),
      "old-generation-cleanup-confirmed",
    )).toThrow("could not be committed");
    const order: string[] = [];
    const application = applicationFixture(false, order);

    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      { version: "1.2.3" },
    ));

    expect(order).toEqual(["lock", "quit"]);
    const canonical = JSON.parse(await readFile(
      join(fixture.dataDirectory, ".app-update-handoff.json"),
      "utf8",
    )) as { phase: string };
    expect(canonical.phase).toBe("prepared");
    expect((await readdir(fixture.dataDirectory)).filter((name) =>
      name.includes(".app-update-handoff-proposal-"))).toHaveLength(1);
  });

  it("rejects failed viability before bootstrap and restores the one-time token", async () => {
    const fixture = await windowsFixture();
    transferOwnership(fixture);
    const order: string[] = [];
    const application = applicationFixture(true, order);
    const bootstrap = vi.fn(async () => undefined);
    const reportCandidateFailure = vi.fn();

    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      {
        validateCandidateBootstrap: async () => {
          throw new Error("migration incompatible");
        },
        bootstrap,
        reportCandidateFailure,
      },
    ));

    expect(order).toEqual(["lock", "exit"]);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(reportCandidateFailure).toHaveBeenCalledOnce();
    expect(fixture.journal.current()?.phase).toBe("candidate-launched");
    expect(fixture.vault.matches(fixture.journal.current()!)).toBe(true);
  });

  it("cleans up a typed runtime-readiness failure before restoring resumable authority", async () => {
    const fixture = await windowsFixture();
    transferOwnership(fixture);
    const firstOrder: string[] = [];
    const firstApplication = applicationFixture(true, firstOrder);

    await expect(startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      firstApplication.application,
      {
        bootstrap: async () => { firstOrder.push("bootstrap"); },
        awaitCandidateReadiness: async () => {
          throw new Error("runtime startup failed");
        },
        cleanupFailedCandidate: async () => {
          firstOrder.push("cleanup");
          return true;
        },
      },
    ))).rejects.toThrow("runtime startup failed");
    expect(firstOrder).toEqual([
      "lock",
      "ready",
      "bootstrap",
      "cleanup",
    ]);
    expect(fixture.journal.current()?.phase).toBe("candidate-admitted");
    expect(fixture.vault.matches(fixture.journal.current()!)).toBe(true);

    const resumedOrder: string[] = [];
    const resumedApplication = applicationFixture(true, resumedOrder);
    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      resumedApplication.application,
      { bootstrap: async () => { resumedOrder.push("bootstrap"); } },
    ));
    expect(resumedOrder).toEqual([
      "lock",
      "ready",
      "bootstrap",
    ]);
    expect(fixture.journal.current()).toBeNull();
  });

  it("does not restore or retire candidate authority when failed cleanup is unconfirmed", async () => {
    const fixture = await windowsFixture();
    transferOwnership(fixture);
    const order: string[] = [];
    const application = applicationFixture(true, order);

    await expect(startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      {
        awaitCandidateReadiness: async () => {
          throw new Error("runtime startup failed");
        },
        cleanupFailedCandidate: async () => false,
      },
    ))).rejects.toThrow("cleanup is unconfirmed");

    expect(fixture.journal.current()?.phase).toBe("candidate-admitted");
    expect(fixture.vault.matches(fixture.journal.current()!)).toBe(true);
  });

  it("rolls back a merely prepared native update before old-version startup", async () => {
    const fixture = await windowsFixture();
    const order: string[] = [];
    const application = applicationFixture(true, order);

    await startApplicationWithUpdateHandoff(startupOptions(
      fixture,
      application.application,
      {
        version: "1.2.3",
        bootstrap: async () => { order.push("bootstrap"); },
      },
    ));

    expect(order).toEqual(["lock", "ready", "bootstrap"]);
    expect(fixture.journal.current()).toBeNull();
    expect(fixture.vault.matches(fixture.prepared)).toBe(false);
  });

  it.each(["cleanup", "rollback"] as const)(
    "recovers the exact old executable from an authenticated clean failure at %s",
    async (phase) => {
      const fixture = await windowsFixture();
      const cleaned = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "old-generation-cleanup-confirmed",
      )!;
      await publishWindowsTerminalReceipt(
        fixture,
        cleaned,
        "clean-failure",
      );
      if (phase === "rollback") {
        fixture.journal.transition(
          appUpdateHandoffOwner(cleaned),
          "rollback-completed",
        );
      }
      const order: string[] = [];
      const application = applicationFixture(true, order);

      await startApplicationWithUpdateHandoff(startupOptions(
        fixture,
        application.application,
        {
          version: "1.2.3",
          bootstrap: async () => { order.push("bootstrap"); },
        },
      ));

      expect(order).toEqual(["lock", "ready", "bootstrap"]);
      expect(fixture.journal.current()).toBeNull();
      expect(fixture.vault.matches(fixture.prepared)).toBe(false);
      await expect(readFile(join(
        fixture.dataDirectory,
        windowsUpdateTerminalReceiptName(operationId),
      ))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("accepts an expired token only for an authenticated terminal clean failure", async () => {
    const fixture = await windowsFixture();
    const cleaned = fixture.journal.transition(
      appUpdateHandoffOwner(fixture.prepared),
      "old-generation-cleanup-confirmed",
    )!;
    await publishWindowsTerminalReceipt(
      fixture,
      cleaned,
      "clean-failure",
    );
    const order: string[] = [];
    const application = applicationFixture(true, order);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(cleaned.deadlineAt) + 1);
    try {
      await startApplicationWithUpdateHandoff(startupOptions(
        fixture,
        application.application,
        {
          version: "1.2.3",
          bootstrap: async () => { order.push("bootstrap"); },
        },
      ));
    } finally {
      vi.useRealTimers();
    }

    expect(order).toEqual(["lock", "ready", "bootstrap"]);
    expect(fixture.journal.current()).toBeNull();
    expect(fixture.vault.matches(fixture.prepared)).toBe(false);
  });

  it.each(["1.2.3", "1.3.0"] as const)(
    "blocks %s reboot startup on an authenticated installer-deadline quarantine",
    async (version) => {
      const fixture = await windowsFixture();
      const cleaned = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "old-generation-cleanup-confirmed",
      )!;
      await publishWindowsTerminalReceipt(fixture, cleaned, "quarantined");
      const helperPath = join(
        fixture.dataDirectory,
        windowsUpdateSupervisorExecutableName(operationId),
      );
      await writeFile(helperPath, "quarantined supervisor", { mode: 0o700 });
      const order: string[] = [];
      const application = applicationFixture(true, order);
      const reportCandidateFailure = vi.fn();

      vi.useFakeTimers();
      vi.setSystemTime(Date.parse(cleaned.deadlineAt) + 1);
      try {
        await startApplicationWithUpdateHandoff(startupOptions(
          fixture,
          application.application,
          {
            version,
            reportCandidateFailure,
            bootstrap: async () => { order.push("bootstrap"); },
          },
        ));
      } finally {
        vi.useRealTimers();
      }

      expect(order).toEqual(["lock", "exit"]);
      expect(reportCandidateFailure).toHaveBeenCalledWith(
        "The restricted Windows update candidate was rejected.",
        expect.objectContaining({
          message: expect.stringContaining("remains quarantined"),
        }),
      );
      expect(fixture.journal.current()).toEqual(cleaned);
      expect(fixture.vault.matches(cleaned)).toBe(true);
      await expect(readFile(join(
        fixture.dataDirectory,
        windowsUpdateTerminalReceiptName(operationId),
      ))).resolves.toBeTruthy();
      await expect(readFile(helperPath, "utf8")).resolves.toBe(
        "quarantined supervisor",
      );
    },
  );

  it.each(["before", "after"] as const)(
    "recovers a Windows rollback-completed publication interrupted %s rename",
    async (boundary) => {
      const fixture = await windowsFixture();
      let interrupt = true;
      const interrupted = new AppUpdateHandoffJournal(
        fixture.dataDirectory,
        {
          testHooks: boundary === "before"
              ? {
                  beforeRename: (source: string, target: string) => {
                    if (
                      interrupt
                      && source.includes(".app-update-handoff-proposal-")
                      && source.endsWith(".json")
                      && target.endsWith(".app-update-handoff.json")
                    ) {
                      interrupt = false;
                      throw new Error("simulated rollback completion crash");
                    }
                  },
                }
              : {
                  afterRename: (_source: string, target: string) => {
                    if (
                      interrupt
                      && target.endsWith(".app-update-handoff.json")
                    ) {
                      interrupt = false;
                      throw new Error("simulated rollback completion crash");
                    }
                  },
                },
        },
      );

      expect(() => completeWindowsUpdateRollback(
        interrupted,
        fixture.vault,
        fixture.prepared,
      )).toThrow();
      expect(fixture.vault.matches(fixture.prepared)).toBe(true);

      completeWindowsUpdateRollback(
        new AppUpdateHandoffJournal(fixture.dataDirectory),
        new AppUpdateHandoffTokenVault(fixture.dataDirectory),
        fixture.prepared,
      );
      expect(fixture.journal.current()).toBeNull();
      expect(fixture.vault.matches(fixture.prepared)).toBe(false);
    },
  );

  it("recovers when token removal is interrupted before unlink", async () => {
    const fixture = await windowsFixture();
    let interrupt = true;
    const interruptedVault = new AppUpdateHandoffTokenVault(
      fixture.dataDirectory,
      {
        testHooks: {
          beforeUnlink: (path: string) => {
            if (interrupt && path.endsWith(".app-update-secret.json")) {
              interrupt = false;
              throw new Error("simulated token removal crash");
            }
          },
        },
      },
    );

    expect(() => completeWindowsUpdateRollback(
      fixture.journal,
      interruptedVault,
      fixture.prepared,
    )).toThrow("could not be retired");
    expect(fixture.journal.current()?.phase).toBe("rollback-completed");
    expect(fixture.vault.matches(fixture.prepared)).toBe(true);

    completeWindowsUpdateRollback(
      fixture.journal,
      fixture.vault,
      fixture.prepared,
    );
    expect(fixture.journal.current()).toBeNull();
  });

  it("accepts an absent token only after durable rollback completion", async () => {
    const fixture = await windowsFixture();
    const discard = AppUpdateHandoffTokenVault.prototype.discard;
    let interrupt = true;
    const injected = vi.spyOn(
      AppUpdateHandoffTokenVault.prototype,
      "discard",
    ).mockImplementation(function (
      this: AppUpdateHandoffTokenVault,
      snapshot,
    ) {
      const discarded = discard.call(this, snapshot);
      if (interrupt && discarded) {
        interrupt = false;
        throw new Error("simulated crash after token unlink");
      }
      return discarded;
    });
    try {
      expect(() => completeWindowsUpdateRollback(
        fixture.journal,
        fixture.vault,
        fixture.prepared,
      )).toThrow("simulated crash after token unlink");
    } finally {
      injected.mockRestore();
    }

    const completed = fixture.journal.current()!;
    expect(completed.phase).toBe("rollback-completed");
    expect(fixture.vault.matches(completed)).toBe(false);
    completeWindowsUpdateRollback(
      fixture.journal,
      fixture.vault,
      completed,
    );
    expect(fixture.journal.current()).toBeNull();
  });

  it.each(["before-rename", "after-rename", "before-unlink"] as const)(
    "recovers Windows rollback retirement interrupted %s",
    async (boundary) => {
      const fixture = await windowsFixture();
      const completed = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "rollback-completed",
      )!;
      expect(fixture.vault.discard(completed)).toBe(true);
      let interrupt = true;
      const interrupted = new AppUpdateHandoffJournal(
        fixture.dataDirectory,
        {
          testHooks: {
            beforeRename: (_source: string, target: string) => {
              if (
                interrupt
                && boundary === "before-rename"
                && target.endsWith(".app-update-handoff.consume.tmp")
              ) {
                interrupt = false;
                throw new Error("simulated rollback retirement crash");
              }
            },
            afterRename: (_source: string, target: string) => {
              if (
                interrupt
                && boundary === "after-rename"
                && target.endsWith(".app-update-handoff.consume.tmp")
              ) {
                interrupt = false;
                throw new Error("simulated rollback retirement crash");
              }
            },
            beforeUnlink: (path: string) => {
              if (
                interrupt
                && boundary === "before-unlink"
                && path.endsWith(".app-update-handoff.consume.tmp")
              ) {
                interrupt = false;
                throw new Error("simulated rollback retirement crash");
              }
            },
          },
        },
      );

      expect(() => completeWindowsUpdateRollback(
        interrupted,
        fixture.vault,
        completed,
      )).toThrow("could not be retired");

      const recovered = new AppUpdateHandoffJournal(fixture.dataDirectory);
      const pending = recovered.current();
      if (pending) {
        completeWindowsUpdateRollback(
          recovered,
          new AppUpdateHandoffTokenVault(fixture.dataDirectory),
          pending,
        );
      }
      expect(recovered.current()).toBeNull();
    },
  );

  it.each([
    "old-generation-cleanup-confirmed",
    "rollback-required",
  ] as const)(
    "never retires an expired ambiguous native installer in phase %s",
    async (phase) => {
      const fixture = await windowsFixture();
      const cleanupRecorded = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "old-generation-cleanup-confirmed",
      )!;
      const ambiguous = phase === "rollback-required"
        ? fixture.journal.transition(
            appUpdateHandoffOwner(cleanupRecorded),
            "rollback-required",
          )!
        : cleanupRecorded;
      const now = vi.spyOn(Date, "now").mockReturnValue(
        Date.parse(ambiguous.deadlineAt) + 1,
      );
      const order: string[] = [];
      const application = applicationFixture(true, order);
      const reportCandidateFailure = vi.fn();
      try {
        await startApplicationWithUpdateHandoff(startupOptions(
          fixture,
          application.application,
          {
            version: "1.2.3",
            reportCandidateFailure,
            bootstrap: async () => { order.push("bootstrap"); },
          },
        ));
      } finally {
        now.mockRestore();
      }

      expect(order).toEqual(["lock", "exit"]);
      expect(reportCandidateFailure).toHaveBeenCalledWith(
        "The restricted Windows update candidate was rejected.",
        expect.objectContaining({
          message: phase === "old-generation-cleanup-confirmed"
            ? "The Windows installer failure receipt is invalid."
            : "The native Windows installer outcome is still unresolved.",
        }),
      );
      expect(fixture.journal.current()).toEqual(ambiguous);
      expect(fixture.vault.matches(ambiguous)).toBe(true);
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "Linux app update startup recovery",
  () => {
    it.each([
      "candidate-launched",
      "candidate-bootstrap-validated",
    ] as const)(
      "reconciles a terminal-proved candidate instance before %s restart rollback",
      async (phase) => {
        const fixture = await linuxFixture();
        const launched = fixture.journal.transition(
          appUpdateHandoffOwner(fixture.prepared),
          "candidate-launched",
        )!;
        const claimJournal = new LinuxAppUpdateCandidateClaimJournal(
          fixture.dataDirectory,
        );
        const claim = claimJournal.claim(
          launched,
          "55555555-5555-4555-8555-555555555555",
          {
            pid: 2_147_480_101,
            parentPid: process.pid,
            processGroupId: 2_147_480_101,
            startTimeTicks: "2101",
            guardianExecutableDevice: "31",
            guardianExecutableInode: "32",
          },
          {
            pid: 2_147_480_102,
            parentPid: 2_147_480_101,
            processGroupId: 2_147_480_101,
            startTimeTicks: "2102",
          },
        )!;
        expect(claimJournal.publishTerminalProof(claim)).toBe(true);
        const snapshot = phase === "candidate-launched"
          ? launched
          : fixture.journal.acknowledgeCandidateBootstrap(
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
                handoffToken: token,
              },
            )!;
        const order: string[] = [];
        const application = applicationFixture(true, order);

        await startApplicationWithUpdateHandoff(linuxStartupOptions(
          fixture,
          application.application,
          {
            runtimeProcessGuardianPath: fixture.activePath,
            bootstrap: async () => { order.push("bootstrap"); },
          },
        ));

        expect(order).toEqual(["lock", "ready", "bootstrap"]);
        expect(claimJournal.recovery(snapshot)).toBeNull();
        expect(fixture.journal.current()).toBeNull();
        await expect(readFile(fixture.activePath, "utf8")).resolves.toBe("old");
        await expect(readFile(fixture.transaction.stablePath, "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("never lets a stale same-operation snapshot acquire a newer rollback owner", async () => {
      const fixture = await linuxFixture();
      const launched = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "candidate-launched",
      )!;

      expect(() => beginAppUpdateRollback(
        fixture.journal,
        fixture.prepared,
      )).toThrow("rollback authority changed");
      expect(fixture.journal.current()).toEqual(launched);
      await fixture.transaction.rollback();
    });

    it("recovers a commit completed before ownership-transfer publication", async () => {
      const fixture = await linuxFixture();
      const launched = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "candidate-launched",
      )!;
      const validated = fixture.journal.acknowledgeCandidateBootstrap(
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
          handoffToken: token,
        },
      )!;
      const cleaned = fixture.journal.transition(
        appUpdateHandoffOwner(validated),
        "old-generation-cleanup-confirmed",
      )!;
      await fixture.transaction.commit();

      const order: string[] = [];
      const application = applicationFixture(true, order);
      await startApplicationWithUpdateHandoff(linuxStartupOptions(
        fixture,
        application.application,
        { bootstrap: async () => { order.push("bootstrap"); } },
      ));

      expect(order).toEqual(["lock", "ready", "bootstrap"]);
      expect(cleaned.phase).toBe("old-generation-cleanup-confirmed");
      expect(fixture.journal.current()).toBeNull();
      await expect(readFile(fixture.activePath, "utf8")).resolves.toBe("old");
      await expect(readFile(fixture.transaction.stablePath, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    });

    it("retains completed rollback authority when its companion is missing", async () => {
      const fixture = await linuxFixture();
      await fixture.transaction.rollback();
      const rollingBack = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "rollback-required",
      )!;
      const completed = fixture.journal.transition(
        appUpdateHandoffOwner(rollingBack),
        "rollback-completed",
      )!;
      const order: string[] = [];
      const application = applicationFixture(true, order);

      await expect(startApplicationWithUpdateHandoff(linuxStartupOptions(
        fixture,
        application.application,
      ))).rejects.toThrow("does not match its handoff authority");

      expect(order).toEqual(["lock"]);
      expect(fixture.journal.current()).toEqual(completed);
    });

    it.each(["before", "after"] as const)(
      "does not mutate the AppImage transaction when rollback publication fails %s rename",
      async (boundary) => {
        const fixture = await linuxFixture();
        let interrupt = true;
        const interrupted = new AppUpdateHandoffJournal(
          fixture.dataDirectory,
          {
            testHooks: boundary === "before"
                ? {
                    beforeRename: (source: string, target: string) => {
                      if (
                        interrupt
                        && source.includes(".app-update-handoff-proposal-")
                        && source.endsWith(".json")
                        && target.endsWith(".app-update-handoff.json")
                      ) {
                        interrupt = false;
                        throw new Error("simulated rollback publication failure");
                      }
                    },
                  }
                : {
                    afterRename: (_source: string, target: string) => {
                      if (
                        interrupt
                        && target.endsWith(".app-update-handoff.json")
                      ) {
                        interrupt = false;
                        throw new Error("simulated rollback publication failure");
                      }
                    },
                  },
          },
        );

        expect(() => beginAppUpdateRollback(
          interrupted,
          fixture.prepared,
        )).toThrow("could not be committed");
        await expect(readFile(fixture.activePath, "utf8")).resolves.toBe("old");
        await expect(readFile(
          join(fixture.activePath, "..", "Inertia.AppImage"),
          "utf8",
        )).rejects.toMatchObject({ code: "ENOENT" });

        const recovered = beginAppUpdateRollback(
          new AppUpdateHandoffJournal(fixture.dataDirectory),
          fixture.prepared,
        );
        expect(recovered.phase).toBe("rollback-required");
        await fixture.transaction.rollback();
      },
    );

    it.each(["before", "after"] as const)(
      "converges after rollback completion retirement is interrupted %s rename",
      async (boundary) => {
        const fixture = await linuxFixture();
        const rollingBack = fixture.journal.transition(
          appUpdateHandoffOwner(fixture.prepared),
          "rollback-required",
        )!;
        await recoverAppImageUpdateForHandoff({
          channel: "stable",
          activePath: fixture.activePath,
          expected: {
            operationId: rollingBack.operationId,
            artifactDigest: rollingBack.candidateArtifactDigest,
            executableIdentityDigest:
              rollingBack.candidateExecutableIdentityDigest,
            phases: ["staged", "ownership-committed"],
          },
        });
        const completed = fixture.journal.transition(
          appUpdateHandoffOwner(rollingBack),
          "rollback-completed",
        )!;
        let interrupt = true;
        const interrupted = new AppUpdateHandoffJournal(
          fixture.dataDirectory,
          {
            testHooks: boundary === "before"
                ? {
                    beforeRename: (_source: string, target: string) => {
                      if (
                        interrupt
                        && target.endsWith(".app-update-handoff.consume.tmp")
                      ) {
                        interrupt = false;
                        throw new Error("simulated rollback retirement failure");
                      }
                    },
                  }
                : {
                    afterRename: (_source: string, target: string) => {
                      if (
                        interrupt
                        && target.endsWith(".app-update-handoff.consume.tmp")
                      ) {
                        interrupt = false;
                        throw new Error("simulated rollback retirement failure");
                      }
                    },
                  },
          },
        );
        expect(retireAppUpdateRollback(interrupted, completed)).toBe(false);

        const order: string[] = [];
        const application = applicationFixture(true, order);
        await startApplicationWithUpdateHandoff(linuxStartupOptions(
          fixture,
          application.application,
          { bootstrap: async () => { order.push("bootstrap"); } },
        ));

        expect(order).toEqual(["lock", "ready", "bootstrap"]);
        expect(fixture.journal.current()).toBeNull();
        await expect(readFile(fixture.activePath, "utf8")).resolves.toBe("old");
        await expect(readdir(join(fixture.activePath, ".."))).resolves.not
          .toContain(".Inertia.AppImage.inertia-update.json");
      },
    );

    it.each(["before", "after"] as const)(
      "converges after completed candidate retirement is interrupted %s rename",
      async (boundary) => {
        const fixture = await linuxFixture();
        const completed = await completeLinuxUpdate(fixture);
        await finalizeAppImageUpdate({
          channel: "stable",
          operationId: completed.operationId,
          stablePath: fixture.transaction.stablePath,
          artifactDigest: completed.candidateArtifactDigest,
          executableIdentityDigest:
            completed.candidateExecutableIdentityDigest,
        });
        let interrupt = true;
        const interrupted = new AppUpdateHandoffJournal(
          fixture.dataDirectory,
          {
            testHooks: boundary === "before"
                ? {
                    beforeRename: (_source: string, target: string) => {
                      if (
                        interrupt
                        && target.endsWith(".app-update-handoff.consume.tmp")
                      ) {
                        interrupt = false;
                        throw new Error("simulated completion retirement failure");
                      }
                    },
                  }
                : {
                    afterRename: (_source: string, target: string) => {
                      if (
                        interrupt
                        && target.endsWith(".app-update-handoff.consume.tmp")
                      ) {
                        interrupt = false;
                        throw new Error("simulated completion retirement failure");
                      }
                    },
                  },
          },
        );
        expect(interrupted.retire(appUpdateHandoffOwner(completed))).toBe(false);

        const order: string[] = [];
        const application = applicationFixture(true, order);
        await startApplicationWithUpdateHandoff(linuxStartupOptions(
          fixture,
          application.application,
          {
            environment: { APPIMAGE: fixture.transaction.stablePath },
            executablePath: fixture.transaction.stablePath,
            version: "1.3.0",
            bootstrap: async () => { order.push("bootstrap"); },
          },
        ));

        expect(order).toEqual(["lock", "ready", "bootstrap"]);
        expect(fixture.journal.current()).toBeNull();
        await expect(readFile(fixture.transaction.stablePath, "utf8"))
          .resolves.toBe("new");
        await expect(readdir(join(fixture.activePath, ".."))).resolves.not
          .toContain(".Inertia.AppImage.inertia-update.json");
      },
    );

    it("never retires a replacement handoff while rolling back an older candidate", async () => {
      const fixture = await linuxFixture();
      const rollingBack = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "rollback-required",
      )!;
      const rolledBack = fixture.journal.transition(
        appUpdateHandoffOwner(rollingBack),
        "rollback-completed",
      )!;
      expect(fixture.journal.retire(appUpdateHandoffOwner(rolledBack)))
        .toBe(true);
      const replacement = fixture.journal.prepare({
        operationId: "44444444-4444-4444-8444-444444444444",
        platform: fixture.prepared.platform,
        channel: fixture.prepared.channel,
        oldVersion: fixture.prepared.oldVersion,
        newVersion: fixture.prepared.newVersion,
        oldRuntimeGenerationId: fixture.prepared.oldRuntimeGenerationId,
        systemBootId: fixture.prepared.systemBootId,
        candidateArtifactDigest: fixture.prepared.candidateArtifactDigest,
        candidateExecutableIdentityDigest:
          fixture.prepared.candidateExecutableIdentityDigest,
        profileIdentityDigest: fixture.prepared.profileIdentityDigest,
        dataIdentityDigest: fixture.prepared.dataIdentityDigest,
        handoffTokenDigest: fixture.prepared.handoffTokenDigest,
        createdAt: fixture.prepared.createdAt,
        deadlineAt: fixture.prepared.deadlineAt,
      })!;

      expect(retireAppUpdateRollback(
        fixture.journal,
        fixture.prepared,
      )).toBe(false);
      expect(fixture.journal.current()).toEqual(replacement);
      await fixture.transaction.rollback();
    });

    it("retires a handoff only after exact companion transaction recovery", async () => {
      const fixture = await linuxFixture();
      fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "candidate-launched",
      );
      const order: string[] = [];
      const application = applicationFixture(true, order);

      await startApplicationWithUpdateHandoff(linuxStartupOptions(
        fixture,
        application.application,
        { bootstrap: async () => { order.push("bootstrap"); } },
      ));

      expect(order).toEqual(["lock", "ready", "bootstrap"]);
      expect(fixture.journal.current()).toBeNull();
      await expect(readFile(fixture.activePath, "utf8")).resolves.toBe("old");
      await expect(readdir(join(fixture.activePath, ".."))).resolves.not
        .toContain(".Inertia.AppImage.inertia-update.json");
    });

    it("records rollback authority when its companion transaction is missing", async () => {
      const fixture = await linuxFixture();
      const launched = fixture.journal.transition(
        appUpdateHandoffOwner(fixture.prepared),
        "candidate-launched",
      )!;
      await fixture.transaction.rollback();
      const order: string[] = [];
      const application = applicationFixture(true, order);

      await expect(startApplicationWithUpdateHandoff(linuxStartupOptions(
        fixture,
        application.application,
      ))).rejects.toThrow("does not match its handoff authority");

      expect(order).toEqual(["lock"]);
      expect(fixture.journal.current()).toMatchObject({
        operationId: launched.operationId,
        phase: "rollback-required",
      });
    });

    it("retains both authorities when companion operation identity differs", async () => {
      const fixture = await linuxFixture({
        transactionOperationId: operationId,
        handoffOperationId: "44444444-4444-4444-8444-444444444444",
      });
      const order: string[] = [];
      const application = applicationFixture(true, order);

      await expect(startApplicationWithUpdateHandoff(linuxStartupOptions(
        fixture,
        application.application,
      ))).rejects.toThrow("does not match its handoff authority");

      expect(order).toEqual(["lock"]);
      expect(fixture.journal.current()).toMatchObject({
        operationId: fixture.prepared.operationId,
        phase: "rollback-required",
      });
      await fixture.transaction.rollback();
    });
  },
);
