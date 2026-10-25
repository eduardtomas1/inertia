import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { defaultSettings } from "../../src/shared/contracts/app";
import { restoredDefaultSettings } from "../../src/shared/restore-defaults";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTemporaryDirectory(directory);
});

function workspaceRoot(): { path: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "inertia-compact-on-return-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { path: join(root, "inertia.sqlite"), workspace };
}

const columns = (database: Database.Database, table: string) =>
  (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);

const usage = {
  usedTokens: 210_000,
  totalProcessedTokens: 400_000,
  totalProcessedScope: "session" as const,
  maxTokens: 1_000_000,
  inputTokens: 380_000,
  cachedInputTokens: 300_000,
  cacheWriteInputTokens: 20_000,
  outputTokens: 20_000,
  reasoningOutputTokens: 1_000,
  compactsAutomatically: true,
};

describe("PersistCompactOnReturn migration", () => {
  it("is the current schema version", () => {
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBe(104);
  });

  it("upgrades a schema-103 database with the offer default and empty cache facts", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 103);
      database.prepare("INSERT OR IGNORE INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, default_provider, default_model, default_access_mode, new_thread_mode, wrap_diffs, ignore_whitespace, usage_display_mode, active_project_id, active_conversation_id) VALUES (1, 'system', 0, 1, 13, 'codex', '', 'supervised', 'local', 1, 0, 'compact', NULL, NULL)").run();
      expect(columns(database, "app_state").map(({ name }) => name)).not.toContain("compact_on_return");
      expect(columns(database, "thread_usage").map(({ name }) => name)).not.toContain("last_request_started_at");
      migrateRuntimeDatabase(database);
      const setting = columns(database, "app_state").find(({ name }) => name === "compact_on_return");
      expect(setting).toMatchObject({ notnull: 1, dflt_value: "'offer'" });
      expect(database.prepare("SELECT compact_on_return AS value FROM app_state WHERE id = 1").get()).toEqual({ value: "offer" });
      const usageColumns = columns(database, "thread_usage");
      for (const name of ["last_request_started_at", "prompt_cache_lifetime_ms", "prompt_cache_source"]) {
        expect(usageColumns.filter((column) => column.name === name)).toEqual([expect.objectContaining({ notnull: 0, dflt_value: null })]);
      }
      expect((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(104);
    } finally {
      database.close();
    }
  });

  it("rejects values outside the allowed setting and cache fact shapes", () => {
    const { path, workspace } = workspaceRoot();
    const store = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
    const project = store.createProject("Cache", workspace);
    const chat = store.createConversation(project.id, "Cache facts");
    store.upsertUsage({ conversationId: chat.id, ...usage });
    store.close();
    const database = new Database(path);
    try {
      expect(() => database.prepare("UPDATE app_state SET compact_on_return = 'always' WHERE id = 1").run()).toThrow(/constraint/u);
      expect(() => database.prepare("UPDATE app_state SET compact_on_return = NULL WHERE id = 1").run()).toThrow(/constraint/u);
      expect(() => database.prepare("UPDATE thread_usage SET prompt_cache_lifetime_ms = 0").run()).toThrow(/constraint/u);
      expect(() => database.prepare("UPDATE thread_usage SET prompt_cache_source = 'guessed'").run()).toThrow(/constraint/u);
      expect(() => database.prepare("UPDATE thread_usage SET last_request_started_at = ?").run("x".repeat(65))).toThrow(/constraint/u);
    } finally {
      database.close();
    }
  });
});

describe("compact on return setting", () => {
  it("defaults to offer, persists never across restart and restores the default", () => {
    const { path, workspace } = workspaceRoot();
    const store = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
    expect(store.snapshot().settings.compactOnReturn).toBe("offer");
    expect(defaultSettings.compactOnReturn).toBe("offer");
    store.updateSettings({ compactOnReturn: "never" });
    store.updateSettings({ notifyOnlyInBackground: true });
    store.close();
    const reopened = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
    try {
      expect(reopened.snapshot().settings.compactOnReturn).toBe("never");
      reopened.updateSettingsClearingGlobalDefault(restoredDefaultSettings(reopened.snapshot().settings));
      expect(reopened.snapshot().settings.compactOnReturn).toBe("offer");
    } finally {
      reopened.close();
    }
  });
});

describe("prompt cache facts", () => {
  it("round-trips facts, keeps them when a later usage omits them and exposes them on detail usage", () => {
    const { path, workspace } = workspaceRoot();
    const store = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
    const project = store.createProject("Cache", workspace);
    const chat = store.createConversation(project.id, "Cache facts");
    const facts = { lastRequestStartedAt: "2026-10-25T09:00:00.000Z", lifetimeMs: 3_600_000, source: "reported" as const };
    expect(store.upsertUsage({ conversationId: chat.id, ...usage, promptCache: facts }).promptCache).toEqual(facts);
    const kept = store.upsertUsage({ conversationId: chat.id, ...usage, usedTokens: 12_000 });
    expect(kept).toMatchObject({ usedTokens: 12_000, promptCache: facts });
    store.close();
    const reopened = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
    try {
      expect(reopened.usageForConversation(chat.id)?.promptCache).toEqual(facts);
      expect(reopened.conversationDetail(chat.id)?.usage.at(-1)?.promptCache).toEqual(facts);
      const assumed = { lastRequestStartedAt: "2026-10-25T10:00:00.000Z", lifetimeMs: 300_000, source: "assumed" as const };
      expect(reopened.upsertUsage({ conversationId: chat.id, ...usage, promptCache: assumed }).promptCache).toEqual(assumed);
      expect(reopened.usageForConversation(chat.id)?.promptCache).toEqual(assumed);
    } finally {
      reopened.close();
    }
  });

  it("omits facts from usage that never recorded any and drops malformed facts", () => {
    const { path, workspace } = workspaceRoot();
    const store = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
    try {
      const project = store.createProject("Cache", workspace);
      const chat = store.createConversation(project.id, "No facts");
      expect(store.upsertUsage({ conversationId: chat.id, ...usage })).not.toHaveProperty("promptCache");
      const malformed = { lastRequestStartedAt: "yesterday", lifetimeMs: -1, source: "guessed" } as never;
      expect(store.upsertUsage({ conversationId: chat.id, ...usage, promptCache: malformed })).not.toHaveProperty("promptCache");
      expect(store.usageForConversation(chat.id)).not.toHaveProperty("promptCache");
    } finally {
      store.close();
    }
  });
});
