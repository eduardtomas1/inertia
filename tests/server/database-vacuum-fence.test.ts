import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  DatabaseCompactionManager,
  measureDatabaseStorage,
  runFullVacuumOffThread,
  runtimeDatabaseCompactionBlocker,
} from "../../src/server/persistence/database-compaction";
import { DatabaseBackupManager } from "../../src/server/persistence/database-recovery";
import { openRuntimeConnection } from "../../src/server/persistence/runtime-connection-pragmas";
import { DatabaseWriteGate } from "../../src/server/runtime/database-write-gate";
import { privateConnectRefusal } from "../../src/server/runtime/private-connect-admission";
import { DATABASE_VACUUM_UNINTERRUPTIBLE_MESSAGE } from "../../src/shared/database-storage";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function legacyDatabase(): { database: Database.Database; databasePath: string; backups: DatabaseBackupManager } {
  const directory = mkdtempSync(join(tmpdir(), "inertia-vacuum-fence-"));
  directories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false }).close();
  const seed = new Database(databasePath);
  seed.pragma("auto_vacuum = NONE");
  seed.exec("VACUUM");
  seed.exec("CREATE TABLE fence_blob (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = seed.prepare("INSERT INTO fence_blob (body) VALUES (?)");
  seed.transaction(() => { for (let index = 0; index < 120; index += 1) insert.run("x".repeat(8_000)); })();
  seed.exec("DELETE FROM fence_blob");
  seed.pragma("wal_checkpoint(TRUNCATE)");
  seed.close();
  const database = new Database(databasePath);
  openRuntimeConnection(database, () => undefined);
  const backups = new DatabaseBackupManager(database, databasePath, { validateBackup: async () => "valid-current" });
  return { database, databasePath, backups };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function settledState(promise: Promise<unknown>): Promise<"pending" | "settled"> {
  return await Promise.race([
    promise.then(() => "settled" as const, () => "settled" as const),
    new Promise<"pending">((resolvePending) => setTimeout(() => resolvePending("pending"), 30)),
  ]);
}

describe("full VACUUM fence", () => {
  it("lets a started VACUUM finish instead of claiming it was cancelled", async () => {
    const { database, databasePath, backups } = legacyDatabase();
    try {
      database.pragma("wal_checkpoint(TRUNCATE)");
      const controller = new AbortController();
      const vacuum = runFullVacuumOffThread(databasePath, controller.signal);
      controller.abort();
      await expect(vacuum).resolves.toBeUndefined();
      expect(measureDatabaseStorage(database, databasePath).autoVacuum).toBe("incremental");
      await expect(runFullVacuumOffThread(databasePath, controller.signal)).rejects.toThrow("cancelled");
    } finally {
      await backups.cancelAndWait();
      database.close();
    }
  });

  it("signals writers when the VACUUM ends and waits for it on shutdown", async () => {
    const { database, databasePath, backups } = legacyDatabase();
    const vacuumRelease = deferred();
    const vacuumStarted = deferred();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      runFullVacuum: async () => { vacuumStarted.resolve(); await vacuumRelease.promise; },
    });
    try {
      await expect(manager.whenWritable()).resolves.toBeUndefined();
      const compaction = manager.compactNow();
      await vacuumStarted.promise;
      expect(manager.isHoldingExclusiveWork()).toBe(true);
      const writable = manager.whenWritable();
      const settled = manager.whenSettled();
      const shutdown = manager.cancelAndWait();
      expect(await settledState(writable)).toBe("pending");
      expect(await settledState(shutdown)).toBe("pending");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(DATABASE_VACUUM_UNINTERRUPTIBLE_MESSAGE));

      vacuumRelease.resolve();
      await writable;
      await shutdown;
      await settled;
      await expect(compaction).resolves.toMatchObject({ compaction: { mode: "full-vacuum" } });
      expect(manager.isCompacting()).toBe(false);
    } finally {
      vacuumRelease.resolve();
      await backups.cancelAndWait();
      database.close();
    }
  });

  it("defers gated writes until the VACUUM ends and refuses to start one while writes run", async () => {
    const { database, databasePath, backups } = legacyDatabase();
    const vacuumRelease = deferred();
    const vacuumStarted = deferred();
    let manager!: DatabaseCompactionManager;
    const gate = new DatabaseWriteGate({
      isDatabaseVacuuming: () => manager.isHoldingExclusiveWork(),
      whenDatabaseWritable: () => manager.whenWritable(),
    });
    const blockerState = {
      closed: false, updatePreparing: false, recoveryActive: false, activeTurns: false, activeRuns: false,
      providerMaintenanceActive: false, activeRuntimeCommands: 0, activeNonStorageCommands: 0, activeProviderRefreshes: 0,
    };
    manager = new DatabaseCompactionManager(database, databasePath, backups, {
      availableDiskBytes: () => 2 * 1024 ** 3,
      blockedReason: (mode) => runtimeDatabaseCompactionBlocker(mode, { ...blockerState, activeBackgroundWrites: gate.activeWrites() }),
      runFullVacuum: async () => { vacuumStarted.resolve(); await vacuumRelease.promise; },
    });
    try {
      const writeRelease = deferred();
      const running = gate.run(() => writeRelease.promise);
      expect(gate.activeWrites()).toBe(1);
      await expect(manager.compactNow()).rejects.toThrow("Wait for pending operations to finish before compacting the database.");
      writeRelease.resolve();
      await running;
      expect(gate.activeWrites()).toBe(0);

      const compaction = manager.compactNow();
      await vacuumStarted.promise;
      const writes: string[] = [];
      const deferredWrite = gate.run(async () => {
        writes.push(manager.isHoldingExclusiveWork() ? "during-vacuum" : "after-vacuum");
      });
      expect(await settledState(deferredWrite)).toBe("pending");
      expect(writes).toEqual([]);

      vacuumRelease.resolve();
      await deferredWrite;
      await compaction;
      expect(writes).toEqual(["after-vacuum"]);
    } finally {
      vacuumRelease.resolve();
      await manager.cancelAndWait();
      await backups.cancelAndWait();
      database.close();
    }
  });

  it("refuses idle and manual compaction while background writes are admitted", () => {
    const state = {
      closed: false, updatePreparing: false, recoveryActive: false, activeTurns: false, activeRuns: false,
      providerMaintenanceActive: false, activeRuntimeCommands: 0, activeNonStorageCommands: 0, activeProviderRefreshes: 0,
    };
    expect(runtimeDatabaseCompactionBlocker("idle", state)).toBeNull();
    expect(runtimeDatabaseCompactionBlocker("idle", { ...state, activeBackgroundWrites: 1 })).toBe("Runtime work is active.");
    expect(runtimeDatabaseCompactionBlocker("manual", { ...state, activeBackgroundWrites: 2 }))
      .toBe("Wait for pending operations to finish before compacting the database.");
  });

  it("refuses Private Connect requests while a VACUUM runs", () => {
    const admission = {
      updatePreparing: () => false,
      safetyLocked: () => false,
      safetyError: (message: string) => message,
      recoveryActive: () => false,
      databaseVacuuming: () => true,
    };
    expect(privateConnectRefusal(admission, "request-1")).toEqual({
      type: "response",
      requestId: "request-1",
      ok: false,
      code: "unavailable",
      message: "Database compaction is in progress. Try again after it finishes.",
    });
    expect(privateConnectRefusal({ ...admission, databaseVacuuming: () => false }, "request-2")).toBeNull();
    expect(privateConnectRefusal({ ...admission, recoveryActive: () => true }, "request-3"))
      .toMatchObject({ message: "Database recovery is in progress." });
  });
});
