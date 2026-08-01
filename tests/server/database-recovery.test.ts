import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  DatabaseBackupManager,
  databaseRecoveryPaths,
} from "../../src/server/persistence/database-recovery";

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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database backup and startup recovery", () => {
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

  it("creates a validated final backup during clean store shutdown", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const { store } = seed(databasePath, "clean shutdown");

    await store.backupAndClose();

    const names = backupNames(databasePath);
    expect(names).toHaveLength(1);
    const backup = new Database(join(
      databaseRecoveryPaths(databasePath).backupsDirectory,
      names[0]!,
    ), { readonly: true });
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((backup.prepare("SELECT content FROM messages").get() as {
      content: string;
    }).content).toBe("clean shutdown");
    backup.close();
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
