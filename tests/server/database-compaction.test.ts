import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { RuntimeStore } from "../../src/server/database";
import {
  DatabaseCompactionCancelledError,
  DatabaseCompactionError,
  DatabaseCompactionManager,
  measureDatabaseStorage,
  runtimeDatabaseCompactionBlocker,
  shouldAutoConvertToIncremental,
} from "../../src/server/persistence/database-compaction";
import { closeDatabaseAfterBackupCancellation } from "../../src/server/persistence/database-backup-close";
import {
  DatabaseBackupManager,
  recoverDatabaseOnStartup,
} from "../../src/server/persistence/database-recovery";
import { runRuntimeShutdownPhases } from "../../src/server/runtime-shutdown";
import { RuntimeUpdatePreparationGate } from "../../src/server/runtime-update-preparation";
import {
  openRuntimeConnection,
  RUNTIME_MMAP_SIZE_BYTES,
} from "../../src/server/persistence/runtime-connection-pragmas";
import {
  AUTO_COMPACT_MIN_RECLAIMABLE_BYTES,
  isDatabaseCompactionSummary,
  isDatabaseStorageResult,
  isDatabaseStorageStatus,
} from "../../src/shared/database-storage";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { ServerEvent } from "../../src/shared/contracts";
import { startTestRuntime } from "../support/test-runtime";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-db-compaction-"));
  directories.push(directory);
  return directory;
}

function seedLegacyDatabase(databasePath: string): void {
  new RuntimeStore(databasePath, join(databasePath, ".."), { recoverInterruptedRuns: false }).close();
  const database = new Database(databasePath);
  database.pragma("auto_vacuum = NONE");
  database.exec("VACUUM");
  database.pragma("wal_checkpoint(TRUNCATE)");
  database.close();
}

function populateAndDeleteMessages(
  store: RuntimeStore,
  projectId: string,
  count: number,
  bodyLength: number,
): string {
  const kept = store.createConversation(projectId, "Kept chat");
  store.createMessage(kept.id, "important-retained-message", "user");
  const removable = store.createConversation(projectId, "Bulk chat");
  const payload = "a".repeat(bodyLength);
  for (let index = 0; index < count; index += 1) {
    store.createMessage(removable.id, `${index}-${payload}`, "user");
  }
  store.deleteConversation(removable.id);
  return kept.id;
}

function createDirectCompactionDatabase(databasePath: string): {
  database: Database.Database;
  backups: DatabaseBackupManager;
} {
  seedLegacyDatabase(databasePath);
  const store = new RuntimeStore(databasePath, join(databasePath, ".."), {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Compact", join(databasePath, ".."));
  const kept = store.createConversation(project.id, "Kept");
  store.createMessage(kept.id, "keep-me", "user");
  store.close();
  const database = new Database(databasePath);
  openRuntimeConnection(database, () => undefined);
  const backups = new DatabaseBackupManager(database, databasePath, {
    validateBackup: async () => "valid-current",
  });
  return { database, backups };
}

function bulkInsertAndDelete(database: Database.Database, rows: number, bytesPerRow: number): void {
  database.exec("CREATE TABLE IF NOT EXISTS compaction_test_blob (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO compaction_test_blob (body) VALUES (?)");
  const payload = "x".repeat(bytesPerRow);
  database.transaction(() => {
    for (let index = 0; index < rows; index += 1) {
      insert.run(`${index}:${payload}`);
    }
  })();
  database.prepare("SELECT COUNT(*), SUM(length(body)) FROM compaction_test_blob").get();
  database.exec("DELETE FROM compaction_test_blob");
  database.prepare("SELECT COUNT(*) FROM compaction_test_blob").get();
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database storage measurement and compaction", () => {
  it("measures page_size, page_count, freelist_count, WAL size, and backup totals accurately", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    seedLegacyDatabase(databasePath);
    const store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    try {
      const project = store.createProject("Measure", directory);
      populateAndDeleteMessages(store, project.id, 120, 12_000);
      const firstBackup = await store.createBackup();
      const status = store.databaseStorageStatus();

      expect(isDatabaseStorageStatus(status)).toBe(true);
      expect(status.pageSize).toBeGreaterThan(0);
      expect(status.pageCount).toBeGreaterThan(0);
      expect(status.freelistCount).toBeGreaterThan(0);
      expect(status.freelistCount).toBeLessThan(status.pageCount);
      expect(status.databaseBytes).toBe(status.pageCount * status.pageSize);
      expect(status.reclaimableBytes).toBe(status.freelistCount * status.pageSize);
      expect(status.walBytes).toBeGreaterThan(0);
      expect(status.backupCount).toBe(1);
      expect(status.backupBytes).toBe(firstBackup.size);
      expect(status.autoVacuum).toBe("none");
      expect(status.compactionState).toBe("idle");
      expect(status.busy).toBe(false);
      expect(status.blockedReason).toBeNull();
    } finally {
      await store.backupAndClose();
    }
  });

  it("converts to incremental auto_vacuum on manual compaction, shrinks the file and subsequent backups, and checkpoints WAL", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    seedLegacyDatabase(databasePath);
    const store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
      databaseCompaction: {
        availableDiskBytes: () => 2 * 1024 ** 3,
        diskMarginBytes: 64 * 1024 * 1024,
      },
    });
    const project = store.createProject("Compact", directory);
    const keptId = populateAndDeleteMessages(store, project.id, 220, 16_000);
    const preBackup = await store.createBackup();
    const beforeStatus = store.databaseStorageStatus();
    const diskSizeBefore = statSync(databasePath).size;

    expect(beforeStatus.autoVacuum).toBe("none");
    expect(beforeStatus.reclaimableBytes).toBeGreaterThan(1_000_000);

    const { storage, compaction } = await store.compactDatabase();
    const diskSizeAfter = statSync(databasePath).size;

    expect(compaction.mode).toBe("full-vacuum");
    expect(compaction.autoVacuumBefore).toBe("none");
    expect(compaction.autoVacuumAfter).toBe("incremental");
    expect(compaction.bytesAfter).toBeLessThan(compaction.bytesBefore);
    expect(compaction.reclaimedBytes).toBeGreaterThan(1_000_000);
    expect(compaction.walBytesAfter).toBe(0);
    expect(storage.autoVacuum).toBe("incremental");
    expect(storage.freelistCount).toBe(0);
    expect(storage.walBytes).toBe(0);
    expect(storage.busy).toBe(false);
    expect(diskSizeAfter).toBeLessThan(diskSizeBefore);
    expect(diskSizeAfter).toBe(storage.databaseBytes);

    const postBackup = await store.createBackup();
    expect(postBackup.size).toBeLessThan(preBackup.size);

    const detail = store.conversationDetail(keptId);
    expect(detail?.messages.map(({ content }) => content)).toEqual(["important-retained-message"]);
    store.createMessage(keptId, "written-after-vacuum", "assistant");
    expect(store.conversationDetail(keptId)?.messages).toHaveLength(2);

    await store.backupAndClose();
    const recovery = recoverDatabaseOnStartup(databasePath);
    expect(recovery.outcome).toBe("healthy");
  });

  it("takes a fresh backup before full VACUUM when none exists and reuses a confirmed fresh backup", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { database, backups } = createDirectCompactionDatabase(databasePath);
    const createBackupSpy = vi.spyOn(backups, "createBackup");
    const states: string[] = [];
    const manager = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      onStateChange: (status) => { states.push(status.compactionState); },
    });
    try {
      bulkInsertAndDelete(database, 180, 12_000);
      await manager.compactNow();
      expect(createBackupSpy).toHaveBeenCalledTimes(1);
      expect(states).toContain("backing-up");
      expect(states).toContain("checkpointing");
      expect(states).toContain("vacuuming");
      expect(states.at(-1)).toBe("idle");
      expect(database.pragma("mmap_size", { simple: true })).toBe(RUNTIME_MMAP_SIZE_BYTES);
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      await manager.cancelAndWait();
      await backups.cancelAndWait();
      database.close();
    }

    const secondDir = temporaryDirectory();
    const secondPath = join(secondDir, "inertia.sqlite");
    const second = createDirectCompactionDatabase(secondPath);
    const secondSpy = vi.spyOn(second.backups, "createBackup");
    const secondManager = new DatabaseCompactionManager(second.database, secondPath, second.backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
    });
    try {
      bulkInsertAndDelete(second.database, 120, 10_000);
      await second.backups.createBackup();
      expect(secondSpy).toHaveBeenCalledTimes(1);
      expect(second.backups.hasFreshBackup()).toBe(true);
      await secondManager.compactNow();
      expect(secondSpy).toHaveBeenCalledTimes(1);
    } finally {
      await secondManager.cancelAndWait();
      await second.backups.cancelAndWait();
      second.database.close();
    }
  });

  it("enforces both the 20% and 64 MiB thresholds for automatic idle conversion", async () => {
    expect(shouldAutoConvertToIncremental({
      autoVacuum: "none",
      databaseBytes: 100 * 1024 * 1024,
      reclaimableBytes: AUTO_COMPACT_MIN_RECLAIMABLE_BYTES,
    })).toBe(false);
    expect(shouldAutoConvertToIncremental({
      autoVacuum: "none",
      databaseBytes: 500 * 1024 * 1024,
      reclaimableBytes: 80 * 1024 * 1024,
    })).toBe(false);
    expect(shouldAutoConvertToIncremental({
      autoVacuum: "none",
      databaseBytes: 120 * 1024 * 1024,
      reclaimableBytes: 60 * 1024 * 1024,
    })).toBe(false);
    expect(shouldAutoConvertToIncremental({
      autoVacuum: "none",
      databaseBytes: 200 * 1024 * 1024,
      reclaimableBytes: 65 * 1024 * 1024,
    })).toBe(true);
    expect(shouldAutoConvertToIncremental({
      autoVacuum: "incremental",
      databaseBytes: 200 * 1024 * 1024,
      reclaimableBytes: 150 * 1024 * 1024,
    })).toBe(false);

    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { database, backups } = createDirectCompactionDatabase(databasePath);
    const managerBelow = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      autoConvertMinBytes: 64 * 1024 * 1024,
      autoConvertMinRatio: 0.2,
    });
    try {
      bulkInsertAndDelete(database, 120, 12_000);
      expect(await managerBelow.runIdlePass()).toBeNull();
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("none");

      const managerEligible = new DatabaseCompactionManager(database, databasePath, backups, {
        availableDiskBytes: () => 2 * 1024 ** 3,
        autoConvertMinBytes: 512 * 1024,
        autoConvertMinRatio: 0.2,
      });
      const result = await managerEligible.runIdlePass();
      expect(result?.mode).toBe("full-vacuum");
      expect(result?.autoVacuumAfter).toBe("incremental");
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("incremental");
      await managerEligible.cancelAndWait();
    } finally {
      await managerBelow.cancelAndWait();
      await backups.cancelAndWait();
      database.close();
    }
  });

  it("reclaims pages incrementally in bounded yielding steps and stops cleanly if busy mid-pass", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { database, backups } = createDirectCompactionDatabase(databasePath);
    let busy = false;
    let checks = 0;
    const manager = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      incrementalPagesPerStep: 32,
      incrementalStepYieldMs: 1,
      maxIdleIncrementalSteps: 20,
      blockedReason: (mode) => {
        if (mode === "idle") {
          checks += 1;
          if (checks >= 5) busy = true;
        }
        return busy ? "Wait for active turns to finish before compacting the database." : null;
      },
    });
    try {
      bulkInsertAndDelete(database, 80, 12_000);
      await manager.compactNow();
      expect(manager.status().autoVacuum).toBe("incremental");

      bulkInsertAndDelete(database, 320, 12_000);
      const beforeIdle = manager.status();
      expect(beforeIdle.freelistCount).toBeGreaterThan(200);

      const partial = await manager.runIdlePass();
      expect(partial?.mode).toBe("incremental");
      const afterPartial = manager.status();
      expect(afterPartial.freelistCount).toBeLessThan(beforeIdle.freelistCount);
      expect(afterPartial.freelistCount).toBeGreaterThan(0);
      expect(database.pragma("mmap_size", { simple: true })).toBe(RUNTIME_MMAP_SIZE_BYTES);

      busy = false;
      checks = -1_000;
      const diskBeforeFinal = statSync(databasePath).size;
      const { storage, compaction } = await manager.compactNow();
      expect(compaction.mode).toBe("incremental");
      expect(compaction.reclaimedBytes).toBeGreaterThan(0);
      expect(storage.freelistCount).toBe(0);
      expect(storage.walBytes).toBe(0);
      expect(statSync(databasePath).size).toBeLessThan(diskBeforeFinal);
      expect(statSync(databasePath).size).toBe(storage.databaseBytes);
    } finally {
      await manager.cancelAndWait();
      await backups.cancelAndWait();
      database.close();
    }
  });

  it("refuses full VACUUM when free disk space is insufficient or cannot be verified", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { database, backups } = createDirectCompactionDatabase(databasePath);
    const createBackupSpy = vi.spyOn(backups, "createBackup");
    try {
      bulkInsertAndDelete(database, 120, 10_000);
      const before = measureDatabaseStorage(database, databasePath);

      const lowSpace = new DatabaseCompactionManager(database, databasePath, backups, {
        availableDiskBytes: () => before.databaseBytes,
        diskMarginBytes: 64 * 1024 * 1024,
      });
      await expect(lowSpace.compactNow()).rejects.toThrow(DatabaseCompactionError);
      await expect(lowSpace.compactNow()).rejects.toThrow(/Not enough free disk space/u);
      expect(createBackupSpy).not.toHaveBeenCalled();
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("none");

      const probeFailure = new DatabaseCompactionManager(database, databasePath, backups, {
        availableDiskBytes: () => { throw new Error("statfs failed"); },
      });
      await expect(probeFailure.compactNow()).rejects.toThrow(/could not be verified/u);
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("none");
    } finally {
      await backups.cancelAndWait();
      database.close();
    }
  });

  it("refuses compaction while busy with active turns or pending work", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { database, backups } = createDirectCompactionDatabase(databasePath);
    const manager = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      blockedReason: () => "Wait for active turns to finish before compacting the database.",
    });
    try {
      bulkInsertAndDelete(database, 100, 10_000);
      expect(manager.status().blockedReason).toBe(
        "Wait for active turns to finish before compacting the database.",
      );
      await expect(manager.compactNow()).rejects.toThrow(
        "Wait for active turns to finish before compacting the database.",
      );
      expect(await manager.runIdlePass()).toBeNull();
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("none");
    } finally {
      await backups.cancelAndWait();
      database.close();
    }

    expect(runtimeDatabaseCompactionBlocker("manual", {
      closed: false,
      updatePreparing: false,
      recoveryActive: false,
      activeTurns: true,
      activeRuns: false,
      providerMaintenanceActive: false,
      activeRuntimeCommands: 1,
      activeNonStorageCommands: 0,
      activeProviderRefreshes: 0,
    })).toBe("Wait for active turns to finish before compacting the database.");
    expect(runtimeDatabaseCompactionBlocker("manual", {
      closed: false,
      updatePreparing: false,
      recoveryActive: false,
      activeTurns: false,
      activeRuns: false,
      providerMaintenanceActive: false,
      activeRuntimeCommands: 1,
      activeNonStorageCommands: 0,
      activeProviderRefreshes: 0,
    })).toBeNull();
    expect(runtimeDatabaseCompactionBlocker("idle", {
      closed: false,
      updatePreparing: false,
      recoveryActive: false,
      activeTurns: false,
      activeRuns: false,
      providerMaintenanceActive: false,
      activeRuntimeCommands: 1,
      activeNonStorageCommands: 0,
      activeProviderRefreshes: 0,
    })).toBe("Runtime work is active.");
  });

  it("creates new databases with incremental auto_vacuum so they never need a full VACUUM", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false }).close();
    const database = new Database(databasePath, { readonly: true });
    try {
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("incremental");
    } finally {
      database.close();
    }
  });

  it("leaves large databases for a manual compaction instead of converting them while idle", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { database, backups } = createDirectCompactionDatabase(databasePath);
    const manager = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      autoConvertMinBytes: 512 * 1024,
      autoConvertMinRatio: 0.2,
      autoConvertMaxBytes: 1,
    });
    try {
      bulkInsertAndDelete(database, 120, 12_000);
      expect(await manager.runIdlePass()).toBeNull();
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("none");
    } finally {
      await manager.cancelAndWait();
      await backups.cancelAndWait();
      database.close();
    }
  });

  it("validates database storage payloads strictly at the boundary", () => {
    const validStatus = {
      pageSize: 4096,
      pageCount: 100,
      freelistCount: 25,
      databaseBytes: 409_600,
      reclaimableBytes: 102_400,
      walBytes: 8_192,
      backupCount: 2,
      backupBytes: 819_200,
      autoVacuum: "incremental" as const,
      compactionState: "idle" as const,
      busy: false,
      blockedReason: null,
    };
    const validSummary = {
      mode: "full-vacuum" as const,
      bytesBefore: 409_600,
      bytesAfter: 307_200,
      reclaimedBytes: 102_400,
      walBytesBefore: 8_192,
      walBytesAfter: 0,
      autoVacuumBefore: "none" as const,
      autoVacuumAfter: "incremental" as const,
    };
    expect(isDatabaseStorageStatus(validStatus)).toBe(true);
    expect(isDatabaseCompactionSummary(validSummary)).toBe(true);
    expect(isDatabaseStorageResult({ kind: "database.storage", storage: validStatus, compaction: validSummary })).toBe(true);
    expect(isDatabaseStorageStatus({ ...validStatus, freelistCount: 101 })).toBe(false);
    expect(isDatabaseStorageStatus({ ...validStatus, databaseBytes: 999 })).toBe(false);
    expect(isDatabaseStorageStatus({ ...validStatus, busy: true })).toBe(false);
    expect(isDatabaseStorageStatus({ ...validStatus, blockedReason: "" })).toBe(false);
    expect(isDatabaseStorageResult({ kind: "database.storage", storage: validStatus, compaction: { ...validSummary, mode: "bad" } })).toBe(false);
  });

  it("exposes database.storage.get and database.storage.compact over the runtime WebSocket command boundary", async () => {
    const directory = temporaryDirectory();
    seedLegacyDatabase(join(directory, "inertia.sqlite"));
    const runtime = await startTestRuntime({
      dataDirectory: directory,
      defaultWorkspacePath: directory,
      enableProviders: false,
      runtimeGenerationId: `${randomUUID()}:1`,
      systemBootId: `test:${randomUUID()}`,
    });
    const socket = new WebSocket(runtime.websocketUrl, { origin: "http://localhost:5173" });
    try {
      await new Promise<void>((resolveOpen, rejectOpen) => {
        socket.once("open", () => resolveOpen());
        socket.once("error", rejectOpen);
      });
      const request = (type: "database.storage.get" | "database.storage.compact", requestId: string): Promise<ServerEvent> =>
        new Promise<ServerEvent>((resolveEvent, rejectEvent) => {
          const onMessage = (raw: WebSocket.RawData): void => {
            const event = parseServerEvent(JSON.parse(raw.toString("utf8")));
            if (!event) {
              socket.off("message", onMessage);
              rejectEvent(new Error("Invalid server event payload."));
              return;
            }
            if ((event.type === "request.result" || event.type === "request.error") && event.requestId === requestId) {
              socket.off("message", onMessage);
              resolveEvent(event);
            }
          };
          socket.on("message", onMessage);
          socket.send(JSON.stringify({ requestId, type }));
        });

      const initial = await request("database.storage.get", randomUUID());
      expect(initial.type).toBe("request.result");
      if (initial.type !== "request.result" || initial.result.kind !== "database.storage") {
        throw new Error("Expected database.storage result.");
      }
      expect(initial.result.storage.autoVacuum).toBe("none");
      expect(initial.result.storage.pageSize).toBeGreaterThan(0);

      const compacted = await request("database.storage.compact", randomUUID());
      expect(compacted.type).toBe("request.result");
      if (compacted.type !== "request.result" || compacted.result.kind !== "database.storage") {
        throw new Error("Expected compacted database.storage result.");
      }
      expect(compacted.result.storage.autoVacuum).toBe("incremental");
      expect(compacted.result.compaction?.mode).toBe("full-vacuum");
    } finally {
      socket.close();
      await runtime.close();
    }
  });

  it("aborts tracked compaction backup during shutdown quiescence so closeStore completes before deadline", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    seedLegacyDatabase(databasePath);
    const database = new Database(databasePath);
    openRuntimeConnection(database, () => undefined);
    let validationStarted!: () => void;
    const validationEntered = new Promise<void>((resolve) => { validationStarted = resolve; });
    let validationAborted = false;
    const backups = new DatabaseBackupManager(database, databasePath, {
      validateBackup: (_path, signal) => new Promise((_resolve, reject) => {
        validationStarted();
        signal.addEventListener("abort", () => {
          validationAborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
    });
    const updatePreparation = new RuntimeUpdatePreparationGate({
      isClosed: () => false,
      activeRuntimeCommands: () => 0,
      databaseRecoveryActive: () => false,
      agentWorkActive: () => false,
      terminalActivity: () => false,
      providerMaintenanceActive: () => false,
      providerRefreshActive: () => false,
      artifactReconciliationActive: () => false,
      holdTerminalAdmission: () => undefined,
      releaseTerminalAdmission: () => undefined,
      drainAdditionalOperations: async () => undefined,
    });
    const compaction = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      trackOperation: (operation) => updatePreparation.track(operation),
    });
    const phases: string[] = [];
    try {
      const compacting = updatePreparation.track(() => compaction.compactNow());
      void compacting.catch(() => undefined);
      await validationEntered;
      expect(compaction.status().compactionState).toBe("backing-up");

      // Mirrors src/server/index.ts runtime.close(): abort store managers
      // synchronously before quiescence drains tracked runtime operations.
      compaction.beginShutdown();
      backups.beginShutdown();

      await runRuntimeShutdownPhases({
        quiesceRuntimeWork: async () => {
          phases.push("quiesce:start");
          await updatePreparation.drainTracked();
          phases.push("quiesce:done");
        },
        independentDrains: [],
        stopIsolatedRuns: () => undefined,
        disposeTurnsAndProviders: () => undefined,
        settleArtifacts: () => undefined,
        terminateClients: () => undefined,
        closeServer: () => undefined,
        closeStore: async () => {
          phases.push("closeStore");
          await closeDatabaseAfterBackupCancellation(database, backups, compaction);
        },
      }, 1_500);

      await expect(compacting).rejects.toBeInstanceOf(DatabaseCompactionCancelledError);
      expect(validationAborted).toBe(true);
      expect(phases).toEqual(["quiesce:start", "quiesce:done", "closeStore"]);
      expect(database.open).toBe(false);
    } finally {
      if (database.open) {
        await compaction.cancelAndWait();
        await backups.cancelAndWait();
        database.close();
      }
    }
  });
});
