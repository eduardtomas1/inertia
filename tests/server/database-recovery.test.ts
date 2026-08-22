import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  DatabaseBackupCancelledError,
  DatabaseBackupManager,
  DATABASE_BACKUP_INTERVAL_MS,
  databaseRecoveryPaths,
  recoverDatabaseOnStartup,
} from "../../src/server/persistence/database-recovery";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-database-recovery-"));
  directories.push(directory);
  return directory;
}

function seed(databasePath: string, label = "original"): {
  conversationId: string;
  store: RuntimeStore;
} {
  const directory = dirname(databasePath);
  const store = new RuntimeStore(databasePath, directory, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Recovery", directory);
  const conversation = store.createConversation(project.id, "Recovery test");
  store.createMessage(conversation.id, label, "user");
  return { conversationId: conversation.id, store };
}

function backupNames(databasePath: string): string[] {
  return readdirSync(databaseRecoveryPaths(databasePath).backupsDirectory)
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
}

function replaceProviderRunOwnershipTable(
  database: Database.Database,
  options: { checks: boolean; foreignKey: boolean },
): void {
  database.exec(`
    DROP INDEX provider_run_ownership_conversation_idx;
    ALTER TABLE provider_run_ownership
      RENAME TO malformed_provider_run_ownership;
    CREATE TABLE provider_run_ownership (
      turn_id TEXT NOT NULL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      runtime_generation_id TEXT NOT NULL,
      system_boot_id TEXT NOT NULL,
      created_at TEXT NOT NULL
      ${options.foreignKey ? `,
        FOREIGN KEY (turn_id, conversation_id, run_id)
          REFERENCES agent_turns(id, conversation_id, run_id)
          ON DELETE RESTRICT` : ""}
      ${options.checks ? `,
        CHECK (length(turn_id) BETWEEN 1 AND 200),
        CHECK (length(conversation_id) BETWEEN 1 AND 200),
        CHECK (length(run_id) BETWEEN 1 AND 200),
        CHECK (length(runtime_generation_id) BETWEEN 38 AND 80),
        CHECK (length(system_boot_id) BETWEEN 8 AND 80),
        CHECK (length(created_at) BETWEEN 20 AND 40)` : ""}
    );
    INSERT INTO provider_run_ownership
    SELECT * FROM malformed_provider_run_ownership;
    DROP TABLE malformed_provider_run_ownership;
    CREATE INDEX provider_run_ownership_conversation_idx
      ON provider_run_ownership(conversation_id, created_at, turn_id);
  `);
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database backup and startup recovery", () => {
  it("does not present an unverified retained file as a validated backup", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    await store.createBackup();
    store.close();

    const database = new Database(databasePath);
    const manager = new DatabaseBackupManager(database, databasePath, {
      validateBackup: async () => "valid-current",
    });
    expect(backupNames(databasePath)).toHaveLength(1);
    expect(manager.status().lastValidatedAt).toBeNull();
    await expect(manager.createBackup()).resolves.toMatchObject({
      createdAt: expect.any(String),
    });
    expect(manager.status().lastValidatedAt).toEqual(expect.any(String));
    database.close();
  });

  it("creates the first validated backup after a short delay and deduplicates a turn trigger", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let backupCalls = 0;
    const writer = {
      open: true,
      backup: async (destination: string) => {
        backupCalls += 1;
        copyFileSync(databasePath, destination);
      },
    } as unknown as Database.Database;
    const manager = new DatabaseBackupManager(writer, databasePath, {
      initialDelayMs: 1_000,
      intervalMs: DATABASE_BACKUP_INTERVAL_MS,
      validateBackup: async () => "valid-current",
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(backupCalls).toBe(0);
    const first = manager.createInitialBackup();
    const duplicate = manager.createInitialBackup();
    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      createdAt: expect.any(String),
    });
    expect(backupCalls).toBe(1);
    await expect(manager.createInitialBackup()).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(backupCalls).toBe(1);
    expect(manager.status().lastValidatedAt).toEqual(expect.any(String));
    await manager.cancelAndWait();
  });

  it("automatically creates the first validated backup after the quiet period", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 1_000,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).toHaveBeenCalledOnce();
    expect(manager.status().lastValidatedAt).toEqual(expect.any(String));
    await manager.cancelAndWait();
  });

  it("keeps the initial backup pending while an active turn blocks the quiet gate", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let activeTurn = true;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 1_000,
        quietGraceMs: 1_000,
        canStartBackup: () => !activeTurn,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).not.toHaveBeenCalled();
    activeTurn = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(backup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backup).toHaveBeenCalledOnce();
    expect(manager.status().lastValidatedAt).toEqual(expect.any(String));
    await manager.cancelAndWait();
  });

  it("queues an hourly backup behind the quiet gate until an active turn settles", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let activeTurn = true;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 60_000,
        intervalMs: 1_000,
        quietGraceMs: 1_000,
        canStartBackup: () => !activeTurn,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).not.toHaveBeenCalled();
    activeTurn = false;
    void manager.requestInitialBackup(1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(backup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backup).toHaveBeenCalledOnce();
    await manager.cancelAndWait();
  });

  it("keeps an hourly backup pending throughout recovery import", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let recoveryImportActive = true;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 60_000,
        intervalMs: 1_000,
        quietGraceMs: 1_000,
        canStartBackup: () => !recoveryImportActive,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(backup).not.toHaveBeenCalled();
    recoveryImportActive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).toHaveBeenCalledOnce();
    await manager.cancelAndWait();
  });

  it("deduplicates simultaneous initial and hourly automatic triggers", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 1_000,
        intervalMs: 1_000,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).toHaveBeenCalledOnce();
    expect(backupNames(databasePath)).toHaveLength(1);
    await manager.cancelAndWait();
  });

  it("lets an explicit manual backup satisfy a racing hourly request", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let releaseBackup!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
      await blocked;
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 60_000,
        intervalMs: 1_000,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(900);
    const manual = manager.createBackup();
    await vi.advanceTimersByTimeAsync(100);
    expect(backup).toHaveBeenCalledOnce();
    releaseBackup();
    await expect(manual).resolves.toMatchObject({ filename: expect.any(String) });
    expect(backupNames(databasePath)).toHaveLength(1);
    await manager.cancelAndWait();
  });

  it("coalesces repeated hourly ticks into one blocked automatic request", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let eligible = false;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 60_000,
        intervalMs: 1_000,
        quietGraceMs: 1_000,
        canStartBackup: () => eligible,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const timerCount = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(vi.getTimerCount()).toBe(timerCount);
    expect(backup).not.toHaveBeenCalled();
    eligible = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).toHaveBeenCalledOnce();
    await manager.cancelAndWait();
  });

  it("cancels a pending hourly request without starting it during shutdown", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let eligible = false;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 60_000,
        intervalMs: 1_000,
        canStartBackup: () => eligible,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.cancelAndWait();
    eligible = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backup).not.toHaveBeenCalled();
  });

  it("continues hourly rotation after the first validated backup", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 1_000,
        intervalMs: 1_000,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).toHaveBeenCalledTimes(2);
    expect(backupNames(databasePath)).toHaveLength(2);
    await manager.cancelAndWait();
  });

  it("restarts the full quiet grace after consecutive turn settlements", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        quietGraceMs: 1_000,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    const first = manager.requestInitialBackup(1_000);
    await vi.advanceTimersByTimeAsync(900);
    expect(manager.requestInitialBackup(1_000)).toBe(first);
    await vi.advanceTimersByTimeAsync(999);
    expect(backup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toMatchObject({ filename: expect.any(String) });
    expect(backup).toHaveBeenCalledOnce();
    await manager.cancelAndWait();
  });

  it("restarts one scheduler deadline across three rapid settlements", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      { validateBackup: async () => "valid-current" },
    );

    manager.start();
    const pending = manager.requestInitialBackup(1_000);
    await vi.advanceTimersByTimeAsync(300);
    void manager.requestInitialBackup(1_000);
    await vi.advanceTimersByTimeAsync(300);
    void manager.requestInitialBackup(1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(backup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(backup).toHaveBeenCalledOnce();
    await manager.cancelAndWait();
  });

  it("keeps a settled-turn grace while another turn remains active", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let anotherTurnActive = true;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 60_000,
        intervalMs: 1_000,
        quietGraceMs: 1_000,
        canStartBackup: () => !anotherTurnActive,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const pending = manager.requestInitialBackup(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    anotherTurnActive = false;
    await vi.advanceTimersByTimeAsync(499);
    expect(backup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ filename: expect.any(String) });
    expect(backup).toHaveBeenCalledOnce();
    await manager.cancelAndWait();
  });

  it("does not let quiet activity shorten validation retry backoff", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let valid = false;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        retryDelayMs: 2_000,
        validateBackup: async () => valid ? "valid-current" : "corrupt",
      },
    );

    manager.start();
    await expect(manager.requestInitialBackup()).rejects.toThrow(/failed validation/u);
    valid = true;
    await vi.advanceTimersByTimeAsync(500);
    const retry = manager.requestInitialBackup(1_000);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(backup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(retry).resolves.toMatchObject({ filename: expect.any(String) });
    expect(backup).toHaveBeenCalledTimes(2);
    await manager.cancelAndWait();
  });

  it("deduplicates a first-turn quiet-grace request with an active timer", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 1_000,
        quietGraceMs: 1_000,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await vi.advanceTimersByTimeAsync(900);
    const fromTurn = manager.requestInitialBackup(1_000);
    const fromTimer = manager.requestInitialBackup();
    expect(fromTimer).toBe(fromTurn);
    await vi.advanceTimersByTimeAsync(999);
    expect(backup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(fromTurn).resolves.toMatchObject({ filename: expect.any(String) });
    expect(backup).toHaveBeenCalledOnce();
    await manager.cancelAndWait();
  });

  it("retries an initial validation failure with bounded backoff and truthful status", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let valid = false;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        retryDelayMs: 1_000,
        validateBackup: async () => valid ? "valid-current" : "corrupt",
      },
    );

    manager.start();
    const first = manager.requestInitialBackup();
    await expect(first).rejects.toThrow(/failed validation/u);
    expect(manager.status().lastValidatedAt).toBeNull();
    valid = true;
    await vi.advanceTimersByTimeAsync(999);
    expect(backup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(backup).toHaveBeenCalledTimes(2);
    expect(manager.status().lastValidatedAt).toEqual(expect.any(String));
    await manager.cancelAndWait();
  });

  it("observes an overlapping backup when initial eligibility arrives", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let releaseValidation!: () => void;
    const validationBlocked = new Promise<void>((resolveValidation) => {
      releaseValidation = resolveValidation;
    });
    let validationStarted!: () => void;
    const validationReady = new Promise<void>((resolveStarted) => {
      validationStarted = resolveStarted;
    });
    const manager = new DatabaseBackupManager(
      {
        open: true,
        backup: async (destination: string) => {
          copyFileSync(databasePath, destination);
        },
      } as unknown as Database.Database,
      databasePath,
      {
        canStartBackup: () => false,
        validateBackup: async () => {
          validationStarted();
          await validationBlocked;
          return "corrupt";
        },
      },
    );

    manager.start();
    const overlapping = manager.createBackup();
    await validationReady;
    const initial = manager.requestInitialBackup();
    releaseValidation();
    await expect(overlapping).rejects.toThrow(/failed validation/u);
    await expect(initial).rejects.toThrow(/failed validation/u);
    await manager.cancelAndWait();
  });

  it("reschedules the automatic first backup after an early manual failure", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    let valid = false;
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 1_000,
        validateBackup: async () => valid ? "valid-current" : "corrupt",
      },
    );

    manager.start();
    await expect(manager.createBackup()).rejects.toThrow(/failed validation/u);
    valid = true;
    await vi.advanceTimersByTimeAsync(999);
    expect(backup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(backup).toHaveBeenCalledTimes(2);
    expect(manager.status().lastValidatedAt).toEqual(expect.any(String));
    await manager.cancelAndWait();
  });

  it("stops retrying after the bounded initial retry budget", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async (destination: string) => {
      copyFileSync(databasePath, destination);
    });
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        retryDelayMs: 1_000,
        maxInitialRetries: 2,
        validateBackup: async () => "corrupt",
      },
    );

    manager.start();
    await expect(manager.requestInitialBackup()).rejects.toThrow(/failed validation/u);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backup).toHaveBeenCalledTimes(3);
    expect(manager.status().lastValidatedAt).toBeNull();
    await manager.cancelAndWait();
  });

  it("cancels the quiet-period backup without starting work during shutdown", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const backup = vi.fn(async () => undefined);
    const manager = new DatabaseBackupManager(
      { open: true, backup } as unknown as Database.Database,
      databasePath,
      {
        initialDelayMs: 1_000,
        validateBackup: async () => "valid-current",
      },
    );

    manager.start();
    await manager.cancelAndWait();
    await vi.advanceTimersByTimeAsync(DATABASE_BACKUP_INTERVAL_MS);
    expect(backup).not.toHaveBeenCalled();
  });

  it("distinguishes a clean first launch from a recovery incident", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");

    const store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });

    expect(store.databaseRecoveryReport()).toMatchObject({
      outcome: "first-launch",
      trigger: "none",
      preservedCorruptPrimary: false,
      invalidBackupsSkipped: 0,
      unsupportedBackupsSkipped: 0,
    });
    expect(existsSync(join(
      databaseRecoveryPaths(databasePath).recoveryDirectory,
      "last-database-recovery.json",
    ))).toBe(false);
    store.close();
  });

  it("creates an online validated backup that includes committed WAL data", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath);
    for (let index = 0; index < 200; index += 1) {
      store.createMessage(conversationId, `wal-message-${index}`, "assistant");
    }
    expect(existsSync(`${databasePath}-wal`)).toBe(true);

    const [backup, overlapping] = await Promise.all([
      store.createBackup(),
      store.createBackup(),
    ]);
    expect(overlapping).toEqual(backup);
    expect(backupNames(databasePath)).toHaveLength(1);
    const backupPath = join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      backup.filename,
    );
    const copy = new Database(backupPath, { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((copy.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
      count: number;
    }).count).toBe(201);
    copy.close();
    store.close();
  });

  it("isolates concurrent validation workers and releases them before publication and teardown", async () => {
    const directory = temporaryDirectory();
    const operations = Array.from({ length: 4 }, async (_value, index) => {
      const databasePath = join(directory, `inertia-${index}.sqlite`);
      const { store } = seed(databasePath, `worker-${index}`);
      const backup = await store.createBackup();
      store.close();
      const backupPath = join(
        databaseRecoveryPaths(databasePath).backupsDirectory,
        backup.filename,
      );
      const movedBackup = `${backupPath}.moved`;
      const movedPrimary = `${databasePath}.moved`;
      // Windows rename succeeds only after the worker/native SQLite handles
      // have actually exited; a posted validation receipt is insufficient.
      renameSync(backupPath, movedBackup);
      renameSync(movedBackup, backupPath);
      renameSync(databasePath, movedPrimary);
      renameSync(movedPrimary, databasePath);
    });

    await Promise.all(operations);
  });

  it("preserves a corrupt primary and restores the newest valid backup", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "first-version");
    await store.createBackup();
    store.createMessage(conversationId, "newest-version", "assistant");
    await store.createBackup();
    store.close();
    writeFileSync(databasePath, Buffer.from("not a sqlite database"));

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    const report = recovered.databaseRecoveryReport();
    expect(report).toMatchObject({
      outcome: "restored",
      trigger: "primary-corrupt",
      preservedCorruptPrimary: true,
      invalidBackupsSkipped: 0,
    });
    expect(recovered.conversationDetail(conversationId)?.messages
      .map(({ content }) => content)).toEqual([
        "first-version",
        "newest-version",
      ]);
    const corruptDirectory = databaseRecoveryPaths(databasePath).corruptDirectory;
    const corruptPrimary = readdirSync(corruptDirectory)
      .find((name) => name.endsWith(".sqlite"));
    expect(corruptPrimary).toBeDefined();
    expect(readFileSync(join(corruptDirectory, corruptPrimary!), "utf8"))
      .toBe("not a sqlite database");
    recovered.close();
  });

  it("skips a corrupt newest backup and restores the older valid copy", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "older-valid");
    const older = await store.createBackup();
    store.createMessage(conversationId, "newer-invalid", "assistant");
    const newer = await store.createBackup();
    store.close();
    const backupsDirectory = databaseRecoveryPaths(databasePath).backupsDirectory;
    writeFileSync(join(backupsDirectory, newer.filename), "invalid backup");
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: older.filename,
      invalidBackupsSkipped: 1,
    });
    expect(recovered.conversationDetail(conversationId)?.messages
      .map(({ content }) => content)).toEqual(["older-valid"]);
    expect(existsSync(join(backupsDirectory, newer.filename))).toBe(false);
    recovered.close();
  });

  it.skipIf(process.platform === "win32")(
    "never follows a pre-planted restore-partial symlink",
    async () => {
      const directory = temporaryDirectory();
      const databasePath = join(directory, "inertia.sqlite");
      const { store } = seed(databasePath, "safe backup");
      await store.createBackup();
      store.close();
      writeFileSync(databasePath, "invalid primary");
      const outside = join(directory, "outside-sentinel.txt");
      writeFileSync(outside, "outside must remain unchanged");
      symlinkSync(
        outside,
        databaseRecoveryPaths(databasePath).restorePartialPath,
      );

      expect(() => new RuntimeStore(databasePath, directory, {
        recoverInterruptedRuns: false,
      })).toThrow();
      expect(readFileSync(outside, "utf8")).toBe(
        "outside must remain unchanged",
      );
    },
  );

  it("skips a newest backup with orphaned foreign keys and restores the older valid copy", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "older-relationally-valid");
    const older = await store.createBackup();
    store.createMessage(conversationId, "newer-orphaned", "assistant");
    const newer = await store.createBackup();
    store.close();
    const backupsDirectory = databaseRecoveryPaths(databasePath).backupsDirectory;
    const tampered = new Database(join(backupsDirectory, newer.filename));
    tampered.pragma("foreign_keys = OFF");
    tampered.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    expect(tampered.pragma("quick_check", { simple: true })).toBe("ok");
    expect(tampered.prepare("PRAGMA foreign_key_check").get()).toBeDefined();
    tampered.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: older.filename,
      invalidBackupsSkipped: 1,
    });
    expect(recovered.conversationDetail(conversationId)?.messages
      .map(({ content }) => content)).toEqual(["older-relationally-valid"]);
    recovered.close();
  });

  it("preserves a corrupt primary and initializes cleanly when no backup is valid", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    writeFileSync(databasePath, "only corrupt copy");
    writeFileSync(`${databasePath}-wal`, "corrupt wal");
    writeFileSync(`${databasePath}-shm`, "corrupt shm");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "created-empty",
      trigger: "primary-corrupt",
      restoredBackup: null,
      preservedCorruptPrimary: true,
    });
    expect(recovered.shellSnapshot().projects).toEqual([]);
    recovered.close();
    const corruptDirectory = databaseRecoveryPaths(databasePath).corruptDirectory;
    const preserved = readdirSync(corruptDirectory)
      .find((name) => name.endsWith(".sqlite"));
    expect(preserved).toBeDefined();
    expect(readFileSync(join(corruptDirectory, preserved!), "utf8"))
      .toBe("only corrupt copy");
    const artifacts = readdirSync(corruptDirectory);
    const preservedWal = artifacts.find((name) => name.endsWith(".sqlite-wal"));
    const preservedShm = artifacts.find((name) => name.endsWith(".sqlite-shm"));
    expect(readFileSync(join(corruptDirectory, preservedWal!), "utf8"))
      .toBe("corrupt wal");
    // SQLite may normalize the shared-memory sidecar while attempting the
    // read-only integrity check. Recovery must still quarantine that exact
    // sidecar instead of discarding it.
    expect(statSync(join(corruptDirectory, preservedShm!)).size).toBeGreaterThan(0);
  });

  it("keeps a collided corrupt primary, WAL, and SHM in one database family", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const now = new Date("2026-08-21T10:00:00.000Z");
    const paths = databaseRecoveryPaths(databasePath);
    mkdirSync(paths.corruptDirectory, { recursive: true });
    writeFileSync(
      join(paths.corruptDirectory, "inertia-20260821T100000000Z.sqlite"),
      "older corrupt primary",
    );
    writeFileSync(databasePath, "new corrupt primary");
    writeFileSync(`${databasePath}-wal`, "new corrupt wal");
    writeFileSync(`${databasePath}-shm`, "new corrupt shm");

    expect(recoverDatabaseOnStartup(databasePath, { now: () => now }))
      .toMatchObject({
        outcome: "created-empty",
        trigger: "primary-corrupt",
        preservedCorruptPrimary: true,
      });
    expect(readdirSync(paths.corruptDirectory).sort()).toEqual([
      "inertia-20260821T100000000Z-1.sqlite",
      "inertia-20260821T100000000Z-1.sqlite-shm",
      "inertia-20260821T100000000Z-1.sqlite-wal",
      "inertia-20260821T100000000Z.sqlite",
    ]);
    expect(readFileSync(
      join(paths.corruptDirectory, "inertia-20260821T100000000Z.sqlite"),
      "utf8",
    )).toBe("older corrupt primary");
  });

  it("closes cleanly without beginning a full backup inside the shutdown deadline", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath, "clean shutdown");

    await store.backupAndClose();

    expect(backupNames(databasePath)).toEqual([]);
    const closed = new Database(databasePath, { readonly: true });
    expect(closed.pragma("quick_check", { simple: true })).toBe("ok");
    expect((closed.prepare("SELECT content FROM messages").get() as {
      content: string;
    }).content).toBe("clean shutdown");
    closed.close();
  });

  it("cancels off-thread validation and removes the partial before shutdown continues", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const database = new Database(databasePath);
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    const manager = new DatabaseBackupManager(database, databasePath, {
      validateBackup: (_path, signal) => new Promise((_resolve, reject) => {
        validationStarted();
        signal.addEventListener("abort", () => {
          reject(new DatabaseBackupCancelledError());
        }, { once: true });
      }),
    });
    const backup = manager.createBackup();
    const rejected = expect(backup).rejects.toBeInstanceOf(
      DatabaseBackupCancelledError,
    );
    await started;

    const before = Date.now();
    await manager.cancelAndWait();
    expect(Date.now() - before).toBeLessThan(500);
    await rejected;
    expect(readdirSync(databaseRecoveryPaths(databasePath).backupsDirectory))
      .toEqual([]);
    database.close();
  });

  it("does not let non-interruptible validation block database shutdown", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const database = new Database(databasePath);
    let validationStarted!: () => void;
    let finishValidation!: (result: "valid-current") => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    const manager = new DatabaseBackupManager(database, databasePath, {
      validateBackup: () => new Promise((resolve) => {
        finishValidation = resolve;
        validationStarted();
      }),
    });
    const backup = manager.createBackup();
    const rejected = expect(backup).rejects.toBeInstanceOf(
      DatabaseBackupCancelledError,
    );
    await started;

    const before = Date.now();
    await manager.cancelAndWait();
    expect(Date.now() - before).toBeLessThan(500);
    await rejected;
    expect(readdirSync(databaseRecoveryPaths(databasePath).backupsDirectory))
      .toEqual([]);

    finishValidation("valid-current");
    await Promise.resolve();
    expect(backupNames(databasePath)).toEqual([]);
    database.close();
  });

  it("restores a valid backup when a quick-checkable primary has no released schema", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "recover me");
    const backup = await store.createBackup();
    store.close();
    writeFileSync(databasePath, Buffer.alloc(0));
    const schemaLess = new Database(databasePath);
    schemaLess.exec("CREATE TABLE unrelated (value TEXT)");
    expect(schemaLess.pragma("quick_check", { simple: true })).toBe("ok");
    schemaLess.close();

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: backup.filename,
      trigger: "primary-corrupt",
    });
    expect(recovered.conversationDetail(conversationId)?.messages[0]?.content)
      .toBe("recover me");
    recovered.close();
  });

  it.each([
    "agent_turns",
    "workspace_runs",
    "prompt_presets",
    "agent_managed_conversations",
    "agent_thread_operations",
  ] as const)(
    "restores a valid backup when a current-schema primary lost %s",
    async (missingTable) => {
      const directory = temporaryDirectory();
      const databasePath = join(directory, "inertia.sqlite");
      const { conversationId, store } = seed(databasePath, "required table backup");
      const backup = await store.createBackup();
      store.close();
      const incomplete = new Database(databasePath);
      incomplete.pragma("foreign_keys = OFF");
      incomplete.exec(`DROP TABLE ${missingTable}`);
      expect(incomplete.pragma("quick_check", { simple: true })).toBe("ok");
      incomplete.close();

      const recovered = new RuntimeStore(databasePath, directory, {
        recoverInterruptedRuns: false,
      });
      expect(recovered.databaseRecoveryReport()).toMatchObject({
        outcome: "restored",
        restoredBackup: backup.filename,
        trigger: "primary-corrupt",
      });
      expect(recovered.conversationDetail(conversationId)?.messages[0]?.content)
        .toBe("required table backup");
      recovered.close();
    },
  );

  it("restores and upgrades a valid backup from released schema 41", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "released schema backup");
    const backup = await store.createBackup();
    store.close();
    const backupPath = join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      backup.filename,
    );
    const released = new Database(backupPath);
    released.exec(`
      DROP TRIGGER conversation_context_packets_discard_source_drafts;
      DROP TABLE agent_context_requests;
      DROP TABLE conversation_context_packets;
      DROP TABLE agent_thread_operations;
      DROP TABLE agent_managed_conversations;
      DROP TABLE recovery_import_journals;
      DROP TABLE recovery_import_receipts;
      DROP TABLE message_content_chunks;
      DROP TABLE reasoning_content_chunks;
      DROP TABLE provider_run_ownership;
      DROP INDEX agent_turns_provider_run_identity_idx;
      DELETE FROM schema_migrations WHERE version >= 42;
    `);
    released.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: backup.filename,
      trigger: "primary-corrupt",
    });
    expect(recovered.conversationDetail(conversationId)?.messages[0]?.content)
      .toBe("released schema backup");
    recovered.close();
    const upgraded = new Database(databasePath, { readonly: true });
    expect((upgraded.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    upgraded.close();
  });

  it("restores the released V0.0.6 fixture through the current schema without losing data", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const paths = databaseRecoveryPaths(databasePath);
    mkdirSync(paths.backupsDirectory, { recursive: true });
    const backupFilename = "inertia-20260812T000000000Z.sqlite";
    const backupPath = join(paths.backupsDirectory, backupFilename);
    copyFileSync(join(
      import.meta.dirname,
      "..",
      "fixtures",
      "database",
      "v0.0.6.sqlite",
    ), backupPath);
    const released = new Database(backupPath, { readonly: true });
    const messagesBefore = released.prepare(
      "SELECT id, role, content, created_at FROM messages ORDER BY id",
    ).all();
    released.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: backupFilename,
      trigger: "primary-corrupt",
    });
    expect(recovered.snapshot().agentTurns).toHaveLength(2);
    expect(recovered.snapshot().agentTurns.every(
      ({ association }) => association === "inferred",
    )).toBe(true);
    recovered.close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect(upgraded.prepare(
      "SELECT id, role, content, created_at FROM messages ORDER BY id",
    ).all()).toEqual(messagesBefore);
    expect((upgraded.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    expect((upgraded.prepare(
      "SELECT color_theme AS colorTheme FROM app_state WHERE id = 1",
    ).get() as { colorTheme: string }).colorTheme).toBe("inertia");
    expect(upgraded.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name = 'agent_turns_usage_dashboard_completed_idx'
    `).get()).toEqual({ name: "agent_turns_usage_dashboard_completed_idx" });
    upgraded.close();
  });

  it("restores schema 55 provider ownership before applying attachment sanitization", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "schema 55 backup");
    const attachmentId = "33333333-3333-4333-8333-333333333333";
    const message = store.createMessage(
      conversationId,
      "Keep the attachment capability opaque.",
      "user",
      [{
        id: attachmentId,
        name: "legacy-reference.png",
        path: attachmentId,
        mimeType: "image/png",
        size: 8,
      }],
    );
    const backup = await store.createBackup();
    store.close();
    const backupPath = join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      backup.filename,
    );
    const schema55 = new Database(backupPath);
    schema55.prepare(`
      UPDATE messages
      SET attachments_json = ?
      WHERE id = ?
    `).run(JSON.stringify([{
      id: attachmentId,
      name: "legacy-reference.png",
      path: "/Users/person/secret/legacy-reference.png",
      mimeType: "image/png",
      size: 8,
    }]), message.id);
    schema55.exec(`
      DROP TRIGGER conversation_context_packets_discard_source_drafts;
      DROP TABLE agent_context_requests;
      DROP TABLE conversation_context_packets;
      DROP TABLE agent_thread_operations;
      DROP TABLE agent_managed_conversations;
      DROP INDEX agent_turns_usage_dashboard_completed_idx;
      DELETE FROM schema_migrations WHERE version >= 56;
    `);
    schema55.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: backup.filename,
      trigger: "primary-corrupt",
    });
    expect(recovered.providerRunOwnership.all()).toEqual([]);
    expect(recovered.message(message.id).attachments).toEqual([{
      id: attachmentId,
      name: "legacy-reference.png",
      path: attachmentId,
      mimeType: "image/png",
      size: 8,
    }]);
    recovered.close();

    const upgraded = new Database(databasePath, { readonly: true });
    expect((upgraded.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    expect((upgraded.prepare(
      "SELECT attachments_json FROM messages WHERE id = ?",
    ).get(message.id) as { attachments_json: string }).attachments_json)
      .not.toContain("/Users/person/secret");
    upgraded.close();
  });

  it("rejects a schema 56 backup that reintroduces an attachment path capability", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "safe current schema");
    const attachmentId = "44444444-4444-4444-8444-444444444444";
    const message = store.createMessage(
      conversationId,
      "Opaque attachment",
      "user",
      [{
        id: attachmentId,
        name: "opaque.png",
        path: attachmentId,
        mimeType: "image/png",
        size: 8,
      }],
    );
    const older = await store.createBackup();
    store.createMessage(conversationId, "newer unsafe state", "assistant");
    const newer = await store.createBackup();
    store.close();
    const paths = databaseRecoveryPaths(databasePath);
    for (const backup of [older, newer]) {
      const schema56 = new Database(join(paths.backupsDirectory, backup.filename));
      schema56.exec(`
        DROP TRIGGER conversation_context_packets_discard_source_drafts;
        DROP TABLE agent_context_requests;
        DROP TABLE conversation_context_packets;
        DROP TABLE agent_thread_operations;
        DROP TABLE agent_managed_conversations;
        DROP INDEX agent_turns_usage_dashboard_completed_idx;
        DELETE FROM schema_migrations WHERE version >= 57;
      `);
      schema56.close();
    }
    const tampered = new Database(join(paths.backupsDirectory, newer.filename));
    tampered.prepare(`
      UPDATE messages SET attachments_json = ? WHERE id = ?
    `).run(JSON.stringify([{
      id: "/Users/person/private/opaque.png",
      name: "opaque.png",
      path: "/Users/person/private/opaque.png",
      mimeType: "image/png",
      size: 8,
    }]), message.id);
    tampered.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: older.filename,
      invalidBackupsSkipped: 1,
    });
    expect(recovered.message(message.id).attachments[0]?.path).toBe(attachmentId);
    expect(recovered.conversationDetail(conversationId)?.messages
      .some(({ content }) => content === "newer unsafe state")).toBe(false);
    recovered.close();
  });

  it("rejects a path-shaped attachment identity during off-thread backup validation", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath, "unsafe capability source");
    store.close();
    const primary = new Database(databasePath);
    primary.prepare(`
      UPDATE messages SET attachments_json = ?
    `).run(JSON.stringify([{
      id: "/Users/person/private/source.png",
      name: "source.png",
      path: "/Users/person/private/source.png",
      mimeType: "image/png",
      size: 8,
    }]));
    const manager = new DatabaseBackupManager(primary, databasePath);

    await expect(manager.createBackup()).rejects.toThrow(/failed validation/u);
    expect(readdirSync(databaseRecoveryPaths(databasePath).backupsDirectory))
      .toEqual([]);
    primary.close();
  });

  it("validates the exact schema 58 Usage index off thread", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath, "usage index validation");
    store.close();
    const primary = new Database(databasePath);
    primary.exec(`
      DROP INDEX agent_turns_usage_dashboard_completed_idx;
      CREATE INDEX agent_turns_usage_dashboard_completed_idx
      ON agent_turns(association, completed_at COLLATE NOCASE, id);
    `);
    const manager = new DatabaseBackupManager(primary, databasePath);

    await expect(manager.createBackup()).rejects.toThrow(/failed validation/u);
    expect(backupNames(databasePath)).toEqual([]);
    primary.exec(`
      DROP INDEX agent_turns_usage_dashboard_completed_idx;
      CREATE INDEX agent_turns_usage_dashboard_completed_idx
      ON agent_turns(association, completed_at ASC, id ASC);
    `);
    await expect(manager.createBackup()).resolves.toMatchObject({
      filename: expect.stringMatching(/\.sqlite$/u),
    });
    primary.close();
  });

  it("skips incomplete migration history and restores the next coherent backup", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "coherent");
    const older = await store.createBackup();
    store.createMessage(conversationId, "tampered", "assistant");
    const newer = await store.createBackup();
    store.close();
    const newestDatabase = new Database(join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      newer.filename,
    ));
    newestDatabase.prepare(
      "DELETE FROM schema_migrations WHERE version = ?",
    ).run(CURRENT_DATABASE_SCHEMA_VERSION - 1);
    newestDatabase.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: older.filename,
      invalidBackupsSkipped: 1,
    });
    expect(recovered.conversationDetail(conversationId)?.messages
      .map(({ content }) => content)).toEqual(["coherent"]);
    recovered.close();
  });

  it("preserves an unsupported future backup instead of restoring or deleting it", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath, "future");
    const future = await store.createBackup();
    store.close();
    const futurePath = join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      future.filename,
    );
    const futureDatabase = new Database(futurePath);
    futureDatabase.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(CURRENT_DATABASE_SCHEMA_VERSION + 1, new Date().toISOString());
    futureDatabase.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "created-empty",
      trigger: "primary-corrupt",
      invalidBackupsSkipped: 0,
      unsupportedBackupsSkipped: 1,
    });
    expect(existsSync(futurePath)).toBe(true);
    expect(recovered.shellSnapshot().projects).toEqual([]);
    recovered.close();
  });

  it("does not count or delete a future backup while pruning current backups", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath, "future retention");
    const future = await store.createBackup();
    store.close();
    const futurePath = join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      future.filename,
    );
    const futureDatabase = new Database(futurePath);
    futureDatabase.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(CURRENT_DATABASE_SCHEMA_VERSION + 1, new Date().toISOString());
    futureDatabase.close();

    const primary = new Database(databasePath);
    const manager = new DatabaseBackupManager(primary, databasePath, {
      maxBackups: 1,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    await manager.createBackup();
    expect(existsSync(futurePath)).toBe(true);
    expect(backupNames(databasePath)).toHaveLength(2);
    primary.close();
  });

  it("rejects a backup whose current migration receipt lacks required tables", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "required structure");
    const older = await store.createBackup();
    store.createMessage(conversationId, "broken structure", "assistant");
    const newer = await store.createBackup();
    store.close();
    const newerPath = join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      newer.filename,
    );
    const broken = new Database(newerPath);
    broken.exec("DROP TABLE recovery_import_receipts");
    broken.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: older.filename,
      invalidBackupsSkipped: 1,
    });
    recovered.close();
  });

  it.each([
    {
      label: "a required current-schema column",
      mutate: (database: Database.Database) => {
        database.exec("ALTER TABLE app_state DROP COLUMN keybindings_json");
      },
    },
    {
      label: "a required current-schema index",
      mutate: (database: Database.Database) => {
        database.exec("DROP INDEX conversations_snoozed_until_idx");
      },
    },
    {
      label: "a required worktree ownership receipt column",
      mutate: (database: Database.Database) => {
        database.exec(`
          ALTER TABLE conversation_worktree_ownership
            RENAME TO malformed_conversation_worktree_ownership;
          CREATE TABLE conversation_worktree_ownership AS
          SELECT conversation_id, path, branch, owns_worktree, creation_state,
            ownership_token, worktree_id, repository_identity,
            filesystem_identity_json
          FROM malformed_conversation_worktree_ownership;
          DROP TABLE malformed_conversation_worktree_ownership;
        `);
      },
    },
    {
      label: "the owned-worktree project deletion trigger",
      mutate: (database: Database.Database) => {
        database.exec(
          "DROP TRIGGER conversation_worktree_ownership_project_delete",
        );
      },
    },
    {
      label: "a required prompt preset column",
      mutate: (database: Database.Database) => {
        database.exec("ALTER TABLE prompt_presets DROP COLUMN route_json");
      },
    },
    {
      label: "the prompt preset ordering index",
      mutate: (database: Database.Database) => {
        database.exec("DROP INDEX prompt_presets_position_idx");
      },
    },
    {
      label: "the prompt preset count trigger",
      mutate: (database: Database.Database) => {
        database.exec("DROP TRIGGER prompt_presets_count_limit");
      },
    },
    {
      label: "the provider ownership composite foreign key",
      mutate: (database: Database.Database) => {
        replaceProviderRunOwnershipTable(database, {
          checks: true,
          foreignKey: false,
        });
      },
    },
    {
      label: "the provider ownership safety checks",
      mutate: (database: Database.Database) => {
        replaceProviderRunOwnershipTable(database, {
          checks: false,
          foreignKey: true,
        });
      },
    },
    {
      label: "the unique provider ownership parent identity index",
      mutate: (database: Database.Database) => {
        database.exec(`
          DROP INDEX agent_turns_provider_run_identity_idx;
          CREATE INDEX agent_turns_provider_run_identity_idx
            ON agent_turns(id, conversation_id, run_id);
        `);
      },
    },
    {
      label: "the Usage dashboard completed-turn range index",
      mutate: (database: Database.Database) => {
        database.exec("DROP INDEX agent_turns_usage_dashboard_completed_idx");
      },
    },
    {
      label: "the exact Usage dashboard completed-turn range index",
      mutate: (database: Database.Database) => {
        database.exec(`
          DROP INDEX agent_turns_usage_dashboard_completed_idx;
          CREATE INDEX agent_turns_usage_dashboard_completed_idx
          ON agent_turns(association, completed_at COLLATE NOCASE, id);
        `);
      },
    },
  ])("skips a current-schema backup missing $label", async ({ mutate }) => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "coherent schema");
    const older = await store.createBackup();
    store.createMessage(conversationId, "malformed schema", "assistant");
    const newer = await store.createBackup();
    store.close();
    const malformed = new Database(join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      newer.filename,
    ));
    mutate(malformed);
    expect(malformed.pragma("quick_check", { simple: true })).toBe("ok");
    malformed.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: older.filename,
      invalidBackupsSkipped: 1,
    });
    expect(recovered.conversationDetail(conversationId)?.messages
      .map(({ content }) => content)).toEqual(["coherent schema"]);
    recovered.close();
  });

  it("skips a current-schema backup with an unreceiptable provider ownership row", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { conversationId, store } = seed(databasePath, "coherent ownership");
    const userMessage = store.createMessage(conversationId, "Provider run");
    const turn = store.createAgentTurn({
      id: "provider-ownership-turn",
      conversationId,
      runId: "provider-ownership-run",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    store.providerRunOwnership.record(
      turn.id,
      conversationId,
      turn.runId,
      "00000000-0000-4000-8000-000000000001:1",
      "test:00000000-0000-4000-8000-000000000001",
      new Date().toISOString(),
    );
    const older = await store.createBackup();
    store.createMessage(conversationId, "malformed ownership", "assistant");
    const newer = await store.createBackup();
    store.close();

    const malformed = new Database(join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      newer.filename,
    ));
    malformed.prepare(`
      UPDATE provider_run_ownership SET runtime_generation_id = ?
    `).run("x".repeat(40));
    expect(malformed.pragma("quick_check", { simple: true })).toBe("ok");
    malformed.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    expect(recovered.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      restoredBackup: older.filename,
      invalidBackupsSkipped: 1,
    });
    expect(recovered.conversationDetail(conversationId)?.messages
      .map(({ content }) => content)).not.toContain("malformed ownership");
    recovered.close();
  });

  it("cleans interrupted partials and bounds count and bytes without deleting the last valid backup", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const database = new Database(databasePath);
    const paths = databaseRecoveryPaths(databasePath);
    const partial = join(paths.backupsDirectory, "inertia-20260101T000000000Z.sqlite.partial");
    writeFileSync(partial, "interrupted");
    const countBounded = new DatabaseBackupManager(database, databasePath, {
      maxBackups: 2,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
    await countBounded.createBackup();
    await countBounded.createBackup();
    await countBounded.createBackup();
    expect(existsSync(partial)).toBe(false);
    expect(backupNames(databasePath)).toHaveLength(2);

    const byteBounded = new DatabaseBackupManager(database, databasePath, {
      maxBackups: 5,
      maxTotalBytes: 1,
    });
    await byteBounded.createBackup();
    expect(backupNames(databasePath)).toHaveLength(1);
    const retained = join(paths.backupsDirectory, backupNames(databasePath)[0]!);
    expect(statSync(retained).size).toBeGreaterThan(1);
    database.close();
  });

  it("does not publish or retain a backup that fails validation", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const invalidWriter = {
      open: true,
      backup: async (destination: string) => {
        writeFileSync(destination, "fault-injected invalid backup");
      },
    } as unknown as Database.Database;
    const manager = new DatabaseBackupManager(invalidWriter, databasePath);

    await expect(manager.createBackup()).rejects.toThrow(/failed validation/u);
    expect(readdirSync(databaseRecoveryPaths(databasePath).backupsDirectory))
      .toEqual([]);
  });

  it("leaves a quick-checkable WAL database after abrupt process termination", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "abrupt.sqlite");
    const script = `
      const Database = require('better-sqlite3');
      const database = new Database(process.argv[1]);
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = NORMAL');
      database.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      const insert = database.prepare('INSERT INTO entries (value) VALUES (?)');
      database.transaction(() => {
        for (let index = 0; index < 10000; index += 1) insert.run('value-' + index);
      })();
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawn(process.execPath, ["-e", script, databasePath], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });

    const database = new Database(databasePath, { readonly: true });
    expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    expect((database.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
      count: number;
    }).count).toBe(10_000);
    database.close();
  });

  it("rolls back an uncommitted recovery mutation when the supervised worker is terminated", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "recovery-cancel.sqlite");
    const { store } = seed(databasePath);
    store.close();
    const script = `
      const Database = require('better-sqlite3');
      const database = new Database(process.argv[1]);
      database.exec('BEGIN IMMEDIATE');
      database.prepare(\`
        INSERT INTO recovery_import_receipts (
          digest, projects, conversations, messages, imported_at
        ) VALUES (?, 1, 1, 1, ?)
      \`).run('a'.repeat(64), new Date().toISOString());
      process.stdout.write('mutation-open\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script, databasePath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.once("data", () => resolve());
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const database = new Database(databasePath, { readonly: true });
    expect(database.pragma("quick_check", { simple: true })).toBe("ok");
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM recovery_import_receipts",
    ).get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("keeps recovery artifacts private on POSIX filesystems", async () => {
    if (process.platform === "win32") return;
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath);
    const backup = await store.createBackup();
    store.close();
    chmodSync(databasePath, 0o600);
    writeFileSync(databasePath, "corrupt");
    const recovered = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    recovered.close();
    const paths = databaseRecoveryPaths(databasePath);
    expect(statSync(join(paths.backupsDirectory, backup.filename)).mode & 0o777)
      .toBe(0o600);
    expect(statSync(paths.backupsDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.corruptDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.recoveryDirectory).mode & 0o777).toBe(0o700);
  });
});
