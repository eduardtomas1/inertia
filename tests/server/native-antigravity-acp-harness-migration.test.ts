// @inertia-test-suite portable

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION,
  nativeAntigravityAcpHarnessMigration,
} from "../../src/server/persistence/migrations/native-antigravity-acp-harness";
import {
  migrateRuntimeDatabase,
  runtimeMigrationCatalog,
} from "../../src/server/persistence/migrations/runtime-catalog";
import type { PersistedModelBackendProfile } from "../../src/shared/backend-profile-settings";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const PREVIOUS_SCHEMA_VERSION = 122;
const REQUIRED_TABLES = [
  "provider_metadata_scoped_cache",
  "model_backend_profiles",
] as const;
const TIMESTAMP = "2026-11-26T10:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function tableSql(database: Database.Database, table: string): string {
  return (database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string }).sql;
}

function schemaObjects(
  database: Database.Database,
  type: "index" | "trigger",
): Array<{ name: string; sql: string }> {
  return database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = ? AND sql IS NOT NULL
    ORDER BY name
  `).all(type) as Array<{ name: string; sql: string }>;
}

function runMigrationAgain(database: Database.Database): void {
  if (typeof nativeAntigravityAcpHarnessMigration.up !== "function") {
    throw new Error("Expected a code migration.");
  }
  nativeAntigravityAcpHarnessMigration.up(database, {
    sourceSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
    sourceReleases: [],
    setLegacyBackfillDiagnostics: () => undefined,
  });
}

function legacyAntigravityProfile(): PersistedModelBackendProfile {
  return {
    id: "builtin:antigravity",
    displayName: "Google Antigravity",
    harnessId: "antigravity-cli",
    protocol: "antigravity-managed",
    authenticationMode: "harness-managed",
    source: "built-in",
    enabled: true,
    configurationRevision: 0,
    endpointIdentity: null,
    preset: "native",
    baseUrl: null,
    allowInsecureLocalhost: false,
    allowPrivateNetwork: false,
    credentialGeneration: null,
    models: [{
      id: "gemini-3-pro",
      displayName: "Gemini 3 Pro",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "gemini-3-pro" },
    capabilityHints: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

describe("native Antigravity ACP harness migration", () => {
  it("is registered as schema 123 after the message search index migration", () => {
    expect(NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION).toBe(123);
    expect(CURRENT_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(123);
    expect(runtimeMigrationCatalog().find(({ version }) => version === NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION)).toMatchObject({
      version: NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION,
      name: nativeAntigravityAcpHarnessMigration.name,
      foreignKeys: "off",
    });
  });

  it("widens harness checks, migrates active Antigravity rows, preserves historical turns and continuations, and stays idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-antigravity-acp-migration-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const databasePath = join(directory, "v122.sqlite");

    const legacySelection = {
      ...providerNativeModelSelection({
        providerId: "antigravity",
        modelId: "gemini-3-pro",
        alias: "Gemini 3 Pro",
        reasoningEffort: "high",
      }),
      harnessId: "antigravity-cli",
    };
    const legacySelectionJson = JSON.stringify(legacySelection);
    const legacyContinuation = {
      harnessId: "antigravity-cli",
      backendProfileId: "builtin:antigravity",
      backendConfigurationRevision: 0,
      modelIdentity: "gemini-3-pro",
      endpointIdentity: null,
    };
    const legacyContinuationJson = JSON.stringify(legacyContinuation);
    const codexSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-5.4",
      alias: "GPT 5.4",
      reasoningEffort: "medium",
    });
    const codexSelectionJson = JSON.stringify(codexSelection);
    const builtinProfile = legacyAntigravityProfile();
    const projectId = randomUUID();
    const antigravityConversationId = randomUUID();
    const codexConversationId = randomUUID();
    const turnId = randomUUID();
    const runId = randomUUID();
    const userMessageId = randomUUID();

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(database, PREVIOUS_SCHEMA_VERSION);
      const history = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();

      database.prepare(`
        INSERT INTO projects (id, name, path, color, status, created_at, updated_at)
        VALUES (?, 'Antigravity project', ?, '#2563eb', 'ready', ?, ?)
      `).run(projectId, workspacePath, TIMESTAMP, TIMESTAMP);

      database.prepare(`
        INSERT INTO conversations (
          id, project_id, title, provider_id, model, reasoning_effort,
          interaction_mode, access_mode, status, branch, worktree_path,
          provider_session_id, model_selection_json, continuation_identity_json,
          created_at, updated_at
        ) VALUES (?, ?, 'Antigravity chat', 'antigravity', 'gemini-3-pro', 'high',
          'build', 'supervised', 'idle', NULL, NULL, 'legacy-agy-session', ?, ?, ?, ?)
      `).run(
        antigravityConversationId,
        projectId,
        legacySelectionJson,
        legacyContinuationJson,
        TIMESTAMP,
        TIMESTAMP,
      );

      database.prepare(`
        INSERT INTO conversations (
          id, project_id, title, provider_id, model, reasoning_effort,
          interaction_mode, access_mode, status, branch, worktree_path,
          provider_session_id, model_selection_json, continuation_identity_json,
          created_at, updated_at
        ) VALUES (?, ?, 'Codex chat', 'codex', 'gpt-5.4', 'medium',
          'build', 'supervised', 'idle', NULL, NULL, 'codex-session', ?, NULL, ?, ?)
      `).run(codexConversationId, projectId, codexSelectionJson, TIMESTAMP, TIMESTAMP);

      database.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, created_at)
        VALUES (?, ?, 'user', 'Check headless history', ?)
      `).run(userMessageId, antigravityConversationId, TIMESTAMP);

      database.prepare(`
        INSERT INTO agent_turns (
          id, conversation_id, run_id, user_message_id, provider_id, harness_id,
          backend_profile_id, model, model_alias, reasoning_effort, interaction_mode,
          access_mode, provider_session_before, provider_session_after, requested_at,
          started_at, completed_at, status, run_state, configuration_revision, association,
          created_at, updated_at, model_selection_json, continuation_identity_json
        ) VALUES (
          ?, ?, ?, ?, 'antigravity', 'antigravity-cli',
          'builtin:antigravity', 'gemini-3-pro', 'Gemini 3 Pro', 'high', 'build',
          'supervised', NULL, 'legacy-agy-session', ?,
          ?, ?, 'completed', 'completed', 0, 'authoritative',
          ?, ?, ?, ?
        )
      `).run(
        turnId,
        antigravityConversationId,
        runId,
        userMessageId,
        TIMESTAMP,
        TIMESTAMP,
        TIMESTAMP,
        TIMESTAMP,
        TIMESTAMP,
        legacySelectionJson,
        legacyContinuationJson,
      );

      database.prepare(`
        INSERT INTO model_backend_profiles (
          profile_id, harness_id, preset, protocol, source, enabled,
          configuration_revision, endpoint_identity, credential_generation,
          configuration_json, latest_probe_json, created_at, updated_at
        ) VALUES (
          'builtin:antigravity', 'antigravity-cli', 'native', 'antigravity-managed',
          'built-in', 1, 0, NULL, NULL, ?, NULL, ?, ?
        )
      `).run(JSON.stringify(builtinProfile), TIMESTAMP, TIMESTAMP);

      database.prepare(`
        INSERT INTO model_backend_defaults (scope, project_id, selection_json, updated_at)
        VALUES ('global', NULL, ?, ?)
      `).run(legacySelectionJson, TIMESTAMP);
      database.prepare(`
        INSERT INTO model_backend_defaults (scope, project_id, selection_json, updated_at)
        VALUES ('project', ?, ?, ?)
      `).run(projectId, legacySelectionJson, TIMESTAMP);

      database.prepare(`
        INSERT INTO provider_metadata_scoped_cache (
          scope_key, provider_id, harness_id, backend_profile_id, model_id,
          executable, version, backend_configuration_revision, auth_state
        ) VALUES (
          'legacy-antigravity-scope', 'antigravity', 'antigravity-cli',
          'builtin:antigravity', 'provider-catalog', '/opt/bin/agy', '1.5.10', 0, 'authenticated'
        )
      `).run();

      const beforeIndexes = schemaObjects(database, "index");
      const beforeTriggers = schemaObjects(database, "trigger");
      const beforeCounts = Object.fromEntries(
        ["model_backend_profiles", "provider_metadata_scoped_cache", "conversations", "agent_turns", "model_backend_defaults"]
          .map((table) => [table, database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()]),
      );

      for (const table of REQUIRED_TABLES) {
        const sql = tableSql(database, table);
        expect(sql).toContain("'antigravity-cli'");
        expect(sql).not.toContain("'antigravity-acp'");
      }
      expect(() => database.prepare(`
        INSERT INTO provider_metadata_scoped_cache (
          scope_key, provider_id, harness_id, backend_profile_id, model_id,
          executable, version, backend_configuration_revision, auth_state
        ) VALUES (
          'acp-antigravity-scope', 'antigravity', 'antigravity-acp',
          'builtin:antigravity', 'provider-catalog', '/opt/bin/agy', '1.5.17', 0, 'authenticated'
        )
      `).run()).toThrow(/CHECK constraint failed/u);

      migrateRuntimeDatabase(database, NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION);

      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version").all(PREVIOUS_SCHEMA_VERSION))
        .toEqual(history);
      expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get())
        .toBe(NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION);
      expect(schemaObjects(database, "index")).toEqual(beforeIndexes);
      expect(schemaObjects(database, "trigger")).toEqual(beforeTriggers);
      expect(Object.fromEntries(
        Object.keys(beforeCounts).map((table) => [table, database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()]),
      )).toEqual(beforeCounts);

      for (const table of REQUIRED_TABLES) {
        const sql = tableSql(database, table);
        expect(sql).toContain("'antigravity-cli'");
        expect(sql).toContain("'antigravity-acp'");
      }

      const migratedProfile = database.prepare(`
        SELECT harness_id, configuration_json FROM model_backend_profiles WHERE profile_id = 'builtin:antigravity'
      `).get() as { harness_id: string; configuration_json: string };
      expect(migratedProfile.harness_id).toBe("antigravity-acp");
      expect(JSON.parse(migratedProfile.configuration_json)).toEqual({
        ...builtinProfile,
        harnessId: "antigravity-acp",
      });

      const migratedConversation = database.prepare(`
        SELECT provider_session_id, model_selection_json, continuation_identity_json
        FROM conversations WHERE id = ?
      `).get(antigravityConversationId) as {
        provider_session_id: string | null;
        model_selection_json: string;
        continuation_identity_json: string;
      };
      expect(migratedConversation.provider_session_id).toBe("legacy-agy-session");
      expect(JSON.parse(migratedConversation.model_selection_json)).toEqual({
        ...legacySelection,
        harnessId: "antigravity-acp",
      });
      expect(JSON.parse(migratedConversation.continuation_identity_json)).toEqual(legacyContinuation);

      const untouchedCodex = database.prepare(`
        SELECT model_selection_json FROM conversations WHERE id = ?
      `).get(codexConversationId) as { model_selection_json: string };
      expect(JSON.parse(untouchedCodex.model_selection_json)).toEqual(codexSelection);

      const historicalTurn = database.prepare(`
        SELECT harness_id, model_selection_json, continuation_identity_json
        FROM agent_turns WHERE id = ?
      `).get(turnId) as {
        harness_id: string;
        model_selection_json: string;
        continuation_identity_json: string;
      };
      expect(historicalTurn.harness_id).toBe("antigravity-cli");
      expect(JSON.parse(historicalTurn.model_selection_json)).toEqual(legacySelection);
      expect(JSON.parse(historicalTurn.continuation_identity_json)).toEqual(legacyContinuation);

      const defaults = (database.prepare(`
        SELECT selection_json FROM model_backend_defaults ORDER BY scope
      `).pluck().all() as string[]).map((value) => JSON.parse(value));
      expect(defaults).toEqual([
        { ...legacySelection, harnessId: "antigravity-acp" },
        { ...legacySelection, harnessId: "antigravity-acp" },
      ]);

      expect(() => database.prepare(`
        INSERT INTO provider_metadata_scoped_cache (
          scope_key, provider_id, harness_id, backend_profile_id, model_id,
          executable, version, backend_configuration_revision, auth_state
        ) VALUES (
          'acp-antigravity-scope', 'antigravity', 'antigravity-acp',
          'builtin:antigravity', 'provider-catalog', '/opt/bin/agy', '1.5.17', 0, 'authenticated'
        )
      `).run()).not.toThrow();
      expect(() => database.prepare(`
        INSERT INTO provider_metadata_scoped_cache (
          scope_key, provider_id, harness_id, backend_profile_id, model_id,
          executable, version, backend_configuration_revision, auth_state
        ) VALUES (
          'legacy-antigravity-scope-2', 'antigravity', 'antigravity-cli',
          'builtin:antigravity', 'provider-catalog', '/opt/bin/agy', '1.5.10', 0, 'authenticated'
        )
      `).run()).not.toThrow();

      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("quick_check", { simple: true })).toBe("ok");

      const schemaVersion = database.pragma("schema_version", { simple: true });
      migrateRuntimeDatabase(database, NATIVE_ANTIGRAVITY_ACP_HARNESS_SCHEMA_VERSION);
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
      runMigrationAgain(database);
      expect(database.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    } finally {
      database.close();
    }

    const reopened = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(reopened.databaseRecoveryReport().outcome).toBe("healthy");
      expect(reopened.modelBackendProfile("builtin:antigravity").profile.harnessId).toBe("antigravity-acp");
      expect(reopened.agentTurn(turnId).harnessId).toBe("antigravity-cli");
    } finally {
      reopened.close();
    }

    const released = await Promise.all([
      readFile(resolve("src/server/persistence/migrations/native-antigravity-provider.ts"), "utf8"),
      readFile(resolve("src/server/persistence/migrations/native-grok-provider.ts"), "utf8"),
    ]);
    for (const source of released) expect(source).not.toContain("antigravity-acp");
  });
});
