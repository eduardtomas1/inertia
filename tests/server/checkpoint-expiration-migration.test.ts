import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  CHECKPOINT_EXPIRATION_SCHEMA_VERSION,
  checkpointExpirationMigration,
} from "../../src/server/persistence/migrations/checkpoint-expiration";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";

const NOW = "2030-01-01T00:00:00.000Z";

describe("checkpoint expiration migration", () => {
  it("appends checkpoint expiration tracking as schema 120", () => {
    expect(CHECKPOINT_EXPIRATION_SCHEMA_VERSION).toBe(120);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(CHECKPOINT_EXPIRATION_SCHEMA_VERSION);
    expect(runtimeMigrationCatalog().find(({ version }) => version === 120)).toMatchObject({
      name: checkpointExpirationMigration.name,
    });
  });

  it("preserves existing checkpoints with null expired_at and indexes active checkpoints", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, CHECKPOINT_EXPIRATION_SCHEMA_VERSION - 1);
      database.prepare(`
        INSERT INTO projects (
          id, name, path, normalized_path, repository_relative_path,
          git_repository_limit, color, status, created_at, updated_at
        ) VALUES ('project-1', 'Project', '/workspace', '/workspace', '.', 16, '#6f76d9', 'ready', ?, ?)
      `).run(NOW, NOW);
      database.prepare(`
        INSERT INTO conversations (
          id, project_id, title, provider_id, model, status, created_at, updated_at
        ) VALUES ('conv-1', 'project-1', 'Chat', 'codex', 'gpt-test', 'idle', ?, ?)
      `).run(NOW, NOW);
      database.prepare(`
        INSERT INTO checkpoints (
          id, conversation_id, turn_id, ref, label, turn_index,
          files_changed, insertions, deletions, created_at
        ) VALUES (
          'cp-1', 'conv-1', NULL,
          'refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
          'Before turn 1', 1, 2, 10, 3, ?
        )
      `).run(NOW);

      migrateRuntimeDatabase(database);

      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      const row = database.prepare("SELECT * FROM checkpoints WHERE id = 'cp-1'").get() as Record<string, unknown>;
      expect(row).toMatchObject({
        id: "cp-1",
        conversation_id: "conv-1",
        label: "Before turn 1",
        turn_index: 1,
        files_changed: 2,
        insertions: 10,
        deletions: 3,
        expired_at: null,
      });
      const indexes = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE tbl_name = 'checkpoints' AND type = 'index'
      `).all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toContain("checkpoints_active_conversation_idx");

      database.prepare("UPDATE checkpoints SET expired_at = ? WHERE id = 'cp-1'").run("2030-01-02T00:00:00.000Z");
      expect(
        (database.prepare("SELECT expired_at FROM checkpoints WHERE id = 'cp-1'").get() as { expired_at: string }).expired_at,
      ).toBe("2030-01-02T00:00:00.000Z");

      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(() => migrateRuntimeDatabase(database)).not.toThrow();
    } finally {
      database.close();
    }
  });
});
