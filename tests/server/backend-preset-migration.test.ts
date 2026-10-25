import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { extendBackendPresetsMigration } from "../../src/server/persistence/migrations/extend-backend-presets";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import type { PersistedModelBackendProfile } from "../../src/shared/backend-profile-settings";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const PREVIOUS_SCHEMA_VERSION = 101;
const PRESET_SCHEMA_VERSION = 102;
const TIMESTAMP = "2026-10-01T08:00:00.000Z";
const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type ProfileRowInput = Pick<
  PersistedModelBackendProfile,
  | "id"
  | "harnessId"
  | "preset"
  | "protocol"
  | "source"
  | "enabled"
  | "configurationRevision"
  | "endpointIdentity"
  | "credentialGeneration"
  | "createdAt"
  | "updatedAt"
>;

function retainedProfile(): Omit<PersistedModelBackendProfile, "allowPrivateNetwork"> {
  return {
    id: "custom:retained-gateway",
    displayName: "Retained gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 4,
    endpointIdentity: backendEndpointIdentity("https://retained.example.test/v1"),
    preset: "custom",
    baseUrl: "https://retained.example.test/v1",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:retained",
    models: [{
      id: "retained-model",
      displayName: "Retained model",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "retained-model" },
    capabilityHints: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function presetProfile(): PersistedModelBackendProfile {
  return {
    id: "custom:anthropic-key",
    displayName: "Anthropic API key",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: false,
    configurationRevision: 1,
    endpointIdentity: backendEndpointIdentity("https://api.anthropic.com"),
    preset: "anthropic-api-key",
    baseUrl: "https://api.anthropic.com",
    allowInsecureLocalhost: false,
    allowPrivateNetwork: false,
    credentialGeneration: null,
    models: [{
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "claude-opus-5-5" },
    capabilityHints: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function insertProfile(database: Database.Database, profile: ProfileRowInput): void {
  database.prepare(`
    INSERT INTO model_backend_profiles (
      profile_id, harness_id, preset, protocol, source, enabled,
      configuration_revision, endpoint_identity, credential_generation,
      configuration_json, latest_probe_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    profile.id,
    profile.harnessId,
    profile.preset,
    profile.protocol,
    profile.source,
    Number(profile.enabled),
    profile.configurationRevision,
    profile.endpointIdentity,
    profile.credentialGeneration,
    JSON.stringify(profile),
    profile.createdAt,
    profile.updatedAt,
  );
}

function schemaVersion(database: Database.Database): number {
  return (database.prepare(
    "SELECT MAX(version) AS version FROM schema_migrations",
  ).get() as { version: number }).version;
}

function profileRows(database: Database.Database): unknown[] {
  return database.prepare("SELECT * FROM model_backend_profiles ORDER BY profile_id").all();
}

function profileTableSql(database: Database.Database): unknown {
  return database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_backend_profiles'",
  ).get();
}

function profileIndexes(database: Database.Database): unknown[] {
  return database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'model_backend_profiles' AND sql IS NOT NULL
    ORDER BY name
  `).all();
}

async function schema101Database(): Promise<{
  database: Database.Database;
  databasePath: string;
  workspacePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-backend-preset-migration-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  await copyFile(fixture, databasePath);
  const database = new Database(databasePath);
  databases.push(database);
  migrateRuntimeDatabase(database, PREVIOUS_SCHEMA_VERSION);
  return { database, databasePath, workspacePath };
}

describe("ExtendBackendPresets migration", () => {
  it("is registered in the catalog", () => {
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(PRESET_SCHEMA_VERSION);
    expect(extendBackendPresetsMigration.name).toBe("ExtendBackendPresets");
  });

  it("upgrades a schema-101 database without losing profiles or indexes", async () => {
    const { database, databasePath, workspacePath } = await schema101Database();
    insertProfile(database, retainedProfile());
    expect(schemaVersion(database)).toBe(PREVIOUS_SCHEMA_VERSION);
    expect(() => insertProfile(database, presetProfile())).toThrow(/CHECK constraint/u);
    const rowsBefore = profileRows(database);
    const indexesBefore = profileIndexes(database);
    expect(indexesBefore).not.toEqual([]);

    migrateRuntimeDatabase(database, PRESET_SCHEMA_VERSION);

    expect(schemaVersion(database)).toBe(PRESET_SCHEMA_VERSION);
    expect(profileRows(database)).toEqual(rowsBefore);
    expect(profileIndexes(database)).toEqual(indexesBefore);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(() => insertProfile(database, presetProfile())).not.toThrow();
    expect(() => insertProfile(database, {
      ...presetProfile(),
      id: "custom:openai-key",
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      preset: "openai-api-key",
    })).not.toThrow();
    expect(() => insertProfile(database, {
      ...presetProfile(),
      id: "custom:unknown-preset",
      preset: "unknown-preset" as PersistedModelBackendProfile["preset"],
    })).toThrow(/CHECK constraint/u);
    database.prepare("DELETE FROM model_backend_profiles WHERE profile_id = ?")
      .run("custom:openai-key");
    database.close();

    const store = new RuntimeStore(databasePath, workspacePath);
    try {
      expect(store.modelBackendProfile("custom:retained-gateway").profile).toMatchObject({
        configurationRevision: 4,
        allowPrivateNetwork: false,
        enabled: true,
      });
      expect(store.modelBackendProfile("custom:anthropic-key").profile).toMatchObject({
        preset: "anthropic-api-key",
        baseUrl: "https://api.anthropic.com",
      });
    } finally {
      store.close();
    }
  });

  it("leaves an already extended table unchanged when it runs again", async () => {
    const { database } = await schema101Database();
    migrateRuntimeDatabase(database, PRESET_SCHEMA_VERSION);
    insertProfile(database, presetProfile());
    const schemaBefore = profileTableSql(database);
    const rowsBefore = profileRows(database);
    const up = extendBackendPresetsMigration.up;
    if (typeof up !== "function") throw new Error("The preset migration must run as a function.");

    database.transaction(() => up(database, {
      sourceSchemaVersion: PRESET_SCHEMA_VERSION,
      sourceReleases: [],
      setLegacyBackfillDiagnostics: () => undefined,
    }))();

    expect(profileTableSql(database)).toEqual(schemaBefore);
    expect(profileRows(database)).toEqual(rowsBefore);
    database.close();
  });
});
