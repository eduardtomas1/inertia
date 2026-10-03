import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { databaseRecoveryPaths } from "../../src/server/persistence/database-recovery";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { defaultSettings } from "../../src/shared/contracts/app";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import {
  activeQuotaWarningThresholds,
  DEFAULT_QUOTA_WARNINGS,
  isQuotaWarningSettings,
} from "../../src/shared/quota-warnings";

const temporaryDirectories: string[] = [];
const NOTIFICATION_COLUMNS = ["quota_warnings_enabled", "quota_warning_threshold", "notify_only_in_background"];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore(): Promise<{ databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-notification-preferences-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  return { databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

const columns = (database: Database.Database) =>
  (database.prepare("PRAGMA table_info(app_state)").all() as Array<{ name: string }>).map(({ name }) => name);
const schemaVersion = (database: Database.Database) =>
  (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;

describe("notification preference defaults", () => {
  it("warns from 25 percent and notifies in the foreground by default", () => {
    expect(DEFAULT_QUOTA_WARNINGS).toEqual({ enabled: true, firstThreshold: 25 });
    expect(defaultSettings.quotaWarnings).toEqual(DEFAULT_QUOTA_WARNINGS);
    expect(defaultSettings.quotaWarnings).not.toBe(DEFAULT_QUOTA_WARNINGS);
    expect(defaultSettings.notifyOnlyInBackground).toBe(false);
  });

  it("starts at the first threshold and keeps the lower fixed levels", () => {
    expect(activeQuotaWarningThresholds({ enabled: true, firstThreshold: 25 })).toEqual([25, 15, 5]);
    expect(activeQuotaWarningThresholds({ enabled: true, firstThreshold: 15 })).toEqual([15, 5]);
    expect(activeQuotaWarningThresholds({ enabled: true, firstThreshold: 5 })).toEqual([5]);
    expect(activeQuotaWarningThresholds({ enabled: false, firstThreshold: 25 })).toEqual([]);
  });

  it("accepts only the complete canonical shape", () => {
    expect(isQuotaWarningSettings({ enabled: false, firstThreshold: 15 })).toBe(true);
    for (const invalid of [
      null, [], "25", { enabled: true }, { firstThreshold: 25 },
      { enabled: "yes", firstThreshold: 25 }, { enabled: true, firstThreshold: 10 },
      { enabled: true, firstThreshold: "25" }, { enabled: true, firstThreshold: 25, extra: 1 },
    ]) expect(isQuotaWarningSettings(invalid)).toBe(false);
  });
});

describe("notification preference persistence", () => {
  it("persists across restart, merges partial updates and restores defaults", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    expect(store.snapshot().settings.quotaWarnings).toEqual(DEFAULT_QUOTA_WARNINGS);
    expect(store.snapshot().settings.notifyOnlyInBackground).toBe(false);
    store.updateSettings({ quotaWarnings: { firstThreshold: 5 } });
    store.updateSettings({ quotaWarnings: { enabled: false } });
    store.updateSettings({ notifyOnlyInBackground: true });
    store.updateSettings({ desktopNotifications: false });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings).toMatchObject({
      quotaWarnings: { enabled: false, firstThreshold: 5 },
      notifyOnlyInBackground: true,
      desktopNotifications: false,
    });
    reopened.updateSettings(defaultSettings);
    expect(reopened.snapshot().settings.quotaWarnings).toEqual(DEFAULT_QUOTA_WARNINGS);
    expect(reopened.snapshot().settings.notifyOnlyInBackground).toBe(false);
    reopened.close();
  });

  it("rejects out-of-range stored values at the column", async () => {
    const { databasePath, store } = await openStore();
    store.close();
    const database = new Database(databasePath);
    try {
      for (const [column, value] of [
        ["quota_warnings_enabled", 2],
        ["quota_warning_threshold", 10],
        ["quota_warning_threshold", null],
        ["notify_only_in_background", -1],
      ] as const) {
        expect(() => database.prepare(`UPDATE app_state SET ${column} = ? WHERE id = 1`).run(value)).toThrow(/constraint/u);
      }
    } finally {
      database.close();
    }
  });
});

describe("notification preference migration", () => {
  it("upgrades a schema-87 database with the defaults", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 87);
      database.prepare("INSERT OR IGNORE INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, default_provider, default_model, default_access_mode, new_thread_mode, wrap_diffs, ignore_whitespace, usage_display_mode, active_project_id, active_conversation_id) VALUES (1, 'system', 0, 1, 13, 'codex', '', 'supervised', 'local', 1, 0, 'compact', NULL, NULL)").run();
      for (const column of NOTIFICATION_COLUMNS) expect(columns(database)).not.toContain(column);
      migrateRuntimeDatabase(database);
      for (const column of NOTIFICATION_COLUMNS) expect(columns(database).filter((name) => name === column)).toHaveLength(1);
      expect(database.prepare("SELECT quota_warnings_enabled, quota_warning_threshold, notify_only_in_background FROM app_state WHERE id = 1").get())
        .toEqual({ quota_warnings_enabled: 1, quota_warning_threshold: 25, notify_only_in_background: 0 });
      expect(schemaVersion(database)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it.each([
    ["every column", NOTIFICATION_COLUMNS],
    ["only the quota switch", ["quota_warnings_enabled"]],
    ["only the background switch", ["notify_only_in_background"]],
  ])("tolerates %s already existing", (_label, existing) => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 87);
      for (const column of existing) database.exec(`ALTER TABLE app_state ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${column === "quota_warning_threshold" ? 25 : column === "quota_warnings_enabled" ? 1 : 0}`);
      expect(() => migrateRuntimeDatabase(database)).not.toThrow();
      for (const column of NOTIFICATION_COLUMNS) expect(columns(database).filter((name) => name === column)).toHaveLength(1);
      expect(schemaVersion(database)).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });
});

describe("notification preference recovery", () => {
  it("restores a schema-87 backup and upgrades it with the defaults", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    store.updateSettings({ desktopNotifications: false });
    const backup = await store.createBackup();
    store.close();
    const legacy = new Database(join(databaseRecoveryPaths(databasePath).backupsDirectory, backup.filename));
    legacy.exec(`
      ALTER TABLE app_state DROP COLUMN quota_warnings_enabled;
      ALTER TABLE app_state DROP COLUMN quota_warning_threshold;
      ALTER TABLE app_state DROP COLUMN notify_only_in_background;
      DELETE FROM schema_migrations WHERE version >= 88;
    `);
    legacy.close();
    writeFileSync(databasePath, "invalid primary");

    const recovered = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(recovered.databaseRecoveryReport()).toMatchObject({ outcome: "restored", restoredBackup: backup.filename });
      expect(recovered.snapshot().settings).toMatchObject({
        desktopNotifications: false,
        notifyOnlyInBackground: false,
        quotaWarnings: DEFAULT_QUOTA_WARNINGS,
      });
      recovered.updateSettings({ quotaWarnings: { firstThreshold: 15 }, notifyOnlyInBackground: true });
      expect(recovered.snapshot().settings).toMatchObject({ notifyOnlyInBackground: true, quotaWarnings: { enabled: true, firstThreshold: 15 } });
    } finally {
      recovered.close();
    }
  });
});

describe("notification preference contracts", () => {
  const command = (payload: unknown) => ({
    type: "settings.update",
    requestId: crypto.randomUUID(),
    payload,
  });
  const snapshotEvent = (settings: unknown): unknown => ({
    type: "snapshot.updated",
    snapshot: {
      projects: [],
      conversations: [],
      runs: [],
      providers: [],
      settings,
      activeProjectId: null,
      activeConversationId: null,
    },
  });

  it("accepts partial updates with supported values only", () => {
    for (const valid of [
      { quotaWarnings: { enabled: false } },
      { quotaWarnings: { firstThreshold: 15 } },
      { quotaWarnings: { enabled: true, firstThreshold: 5 } },
      { notifyOnlyInBackground: true },
    ]) expect(clientCommandSchema.safeParse(command(valid)).success).toBe(true);
    for (const invalid of [
      { quotaWarnings: { firstThreshold: 10 } },
      { quotaWarnings: { firstThreshold: "25" } },
      { quotaWarnings: { enabled: "yes" } },
      { quotaWarnings: { enabled: true, extra: true } },
      { quotaWarnings: null },
      { notifyOnlyInBackground: "true" },
      { notifyOnlyInBackground: null },
    ]) expect(clientCommandSchema.safeParse(command(invalid)).success).toBe(false);
  });

  it("validates the snapshot projection and completes legacy snapshots with the defaults", () => {
    expect(parseServerEvent(snapshotEvent(defaultSettings))).toBeTruthy();
    for (const invalid of [
      { ...defaultSettings, quotaWarnings: { enabled: true, firstThreshold: 10 } },
      { ...defaultSettings, quotaWarnings: { enabled: true } },
      { ...defaultSettings, notifyOnlyInBackground: "no" },
    ]) expect(() => parseServerEvent(snapshotEvent(invalid))).toThrow("Malformed server event");
    const { quotaWarnings: _quotaWarnings, notifyOnlyInBackground: _notifyOnlyInBackground, ...legacy } = defaultSettings;
    const decoded = parseServerEvent(snapshotEvent(legacy));
    if (decoded.type !== "snapshot.updated") throw new Error(decoded.type);
    expect(decoded.snapshot.settings.quotaWarnings).toEqual(DEFAULT_QUOTA_WARNINGS);
    expect(decoded.snapshot.settings.notifyOnlyInBackground).toBe(false);
    const current = { ...defaultSettings, quotaWarnings: { enabled: false, firstThreshold: 15 }, notifyOnlyInBackground: true };
    const kept = parseServerEvent(snapshotEvent(current));
    expect(kept.type === "snapshot.updated" && kept.snapshot.settings).toMatchObject({
      quotaWarnings: { enabled: false, firstThreshold: 15 },
      notifyOnlyInBackground: true,
    });
  });
});
