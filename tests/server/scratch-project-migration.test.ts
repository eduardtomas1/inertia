import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type ProjectSnapshotRow = { id: string; name: string; path: string; normalized_path: string; updated_at: string };

const projectRows = (database: Database.Database): ProjectSnapshotRow[] => database.prepare(
  "SELECT id, name, path, normalized_path, updated_at FROM projects ORDER BY id",
).all() as ProjectSnapshotRow[];

async function schema85Database(prepare?: (database: Database.Database) => void) {
  const directory = await mkdtemp(join(tmpdir(), "inertia-scratch-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  await copyFile(fixture, databasePath);
  const database = new Database(databasePath);
  try {
    migrateRuntimeDatabase(database, 85);
    prepare?.(database);
    return { databasePath, workspacePath, projects: projectRows(database) };
  } finally {
    database.close();
  }
}

describe("no-project folder migration", () => {
  it("upgrades a published database at schema 85 without changing existing projects", async () => {
    const { databasePath, workspacePath, projects } = await schema85Database();
    expect(projects.length).toBeGreaterThan(0);
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(store.shellSnapshot().projects.filter(({ workspaceKind }) => workspaceKind !== undefined)).toEqual([]);
    } finally {
      store.close();
    }
    const migrated = new Database(databasePath);
    try {
      expect((migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(projectRows(migrated)).toEqual(projects);
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM projects WHERE workspace_kind IS NOT NULL").get()).toEqual({ count: 0 });
      const insert = migrated.prepare(`
        INSERT INTO projects (id, name, path, normalized_path, color, status, created_at, updated_at, workspace_kind)
        VALUES (?, 'No project', ?, ?, '#6f76d9', 'ready', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', ?)
      `);
      insert.run("scratch-1", "/data/scratch", "/data/scratch", "scratch");
      expect(() => insert.run("scratch-2", "/other/scratch", "/other/scratch", "scratch")).toThrow(/UNIQUE/u);
      expect(() => insert.run("other-kind", "/other", "/other", "workspace")).toThrow(/CHECK/u);
    } finally {
      migrated.close();
    }
  });

  it("tolerates a schema 85 database that already has the column", async () => {
    const { databasePath, workspacePath, projects } = await schema85Database((database) => {
      database.exec("ALTER TABLE projects ADD COLUMN workspace_kind TEXT");
    });
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    store.close();
    const migrated = new Database(databasePath, { readonly: true });
    try {
      expect(projectRows(migrated)).toEqual(projects);
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_scratch_workspace'").get())
        .toEqual({ name: "projects_scratch_workspace" });
    } finally {
      migrated.close();
    }
  });
});
