import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { databaseRecoveryPaths } from "../../src/server/persistence/database-recovery";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-empty-primary-"));
  directories.push(directory);
  return directory;
}

function openStore(databasePath: string): RuntimeStore {
  return new RuntimeStore(databasePath, dirname(databasePath), {
    recoverInterruptedRuns: false,
  });
}

function schemaVersion(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (database.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations",
    ).get() as { count: number }).count;
  } finally {
    database.close();
  }
}

async function interruptFirstLaunchMigration(databasePath: string): Promise<void> {
  const script = `
    const Database = require('better-sqlite3');
    const database = new Database(process.argv[1]);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('cache_size = 8');
    database.exec('BEGIN IMMEDIATE');
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    database.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)');
    const insert = database.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)');
    for (let index = 0; index < 2000; index += 1) {
      insert.run('project-' + index, 'Project ' + index, '/synthetic/' + index);
    }
    process.stdout.write('migration-open\\n');
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
}

function expectCleanFirstLaunch(databasePath: string, store: RuntimeStore): void {
  expect(store.databaseRecoveryReport()).toMatchObject({
    outcome: "first-launch",
    trigger: "none",
    restoredBackup: null,
    preservedCorruptPrimary: false,
    preservedDatabaseFamilyMembers: 0,
  });
  const project = store.createProject("Fresh", dirname(databasePath));
  expect(store.createConversation(project.id, "Fresh").projectId).toBe(project.id);
  store.close();
  expect(schemaVersion(databasePath)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  const paths = databaseRecoveryPaths(databasePath);
  expect(existsSync(paths.corruptDirectory)).toBe(false);
  expect(existsSync(join(paths.recoveryDirectory, "last-database-recovery.json")))
    .toBe(false);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("schema-less empty primary database", () => {
  it("initializes a zero-byte primary left before the first migration", () => {
    const databasePath = join(temporaryDirectory(), "inertia.sqlite");
    writeFileSync(databasePath, Buffer.alloc(0));

    expectCleanFirstLaunch(databasePath, openStore(databasePath));
  });

  it("initializes a primary whose first-launch migration was killed before commit", async () => {
    const databasePath = join(temporaryDirectory(), "inertia.sqlite");
    await interruptFirstLaunchMigration(databasePath);
    expect(existsSync(databasePath)).toBe(true);

    expectCleanFirstLaunch(databasePath, openStore(databasePath));
  });

  it("restores the newest valid backup instead of starting fresh over an empty primary", async () => {
    const databasePath = join(temporaryDirectory(), "inertia.sqlite");
    const seeded = openStore(databasePath);
    const project = seeded.createProject("Kept", dirname(databasePath));
    await seeded.createBackup();
    seeded.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
    writeFileSync(databasePath, Buffer.alloc(0));

    const store = openStore(databasePath);
    expect(store.databaseRecoveryReport()).toMatchObject({
      outcome: "restored",
      trigger: "primary-corrupt",
      preservedCorruptPrimary: true,
    });
    expect(store.snapshot().projects.map(({ id }) => id)).toContain(project.id);
    store.close();
    expect(readdirSync(databaseRecoveryPaths(databasePath).corruptDirectory))
      .toHaveLength(1);
  });

  it.each([
    ["a user version", "PRAGMA user_version = 7"],
    ["an application id", "PRAGMA application_id = 7"],
    ["an unrelated view", "CREATE VIEW unrelated AS SELECT 1 AS value"],
    ["freed data pages", "CREATE TABLE removed (value TEXT); INSERT INTO removed VALUES (randomblob(40000)); DROP TABLE removed"],
  ])("keeps failing closed for a schema-less primary with %s", (_label, sql) => {
    const databasePath = join(temporaryDirectory(), "inertia.sqlite");
    const database = new Database(databasePath);
    database.exec(sql);
    database.close();
    const original = readFileSync(databasePath);

    expect(() => openStore(databasePath))
      .toThrow("schema or stored relationships are inconsistent");
    expect(readFileSync(databasePath).equals(original)).toBe(true);
    expect(existsSync(databaseRecoveryPaths(databasePath).corruptDirectory))
      .toBe(false);
  });
});
