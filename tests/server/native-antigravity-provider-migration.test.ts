// @inertia-test-suite portable

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { DatabaseMigrationError } from "../../src/server/database-migrations";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import type { PersistedModelBackendProfile } from "../../src/shared/backend-profile-settings";

const PREVIOUS_SCHEMA_VERSION = 75;
const ANTIGRAVITY_SCHEMA_VERSION = 76;

const REBUILT_TABLES = [
  "provider_metadata_cache",
  "diff_review_summaries",
  "provider_metadata_scoped_cache",
  "model_backend_profiles",
  "agent_turns",
  "subagent_traces",
] as const;

const RELATED_TABLES = [
  "agent_managed_conversations",
  "agent_thread_operations",
] as const;

const PRESERVED_TABLES = [...REBUILT_TABLES, ...RELATED_TABLES] as const;

const PROFILE_TIMESTAMP = "2026-09-01T08:00:00.000Z";

const temporaryDirectories: string[] = [];

function nativeAntigravityBackendProfile(): PersistedModelBackendProfile {
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
    credentialGeneration: null,
    models: [{
      id: "provider-default",
      displayName: "Provider default",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "provider-default" },
    capabilityHints: [],
    createdAt: PROFILE_TIMESTAMP,
    updatedAt: PROFILE_TIMESTAMP,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-antigravity-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tableColumns(database: Database.Database, table: string): string[] {
  return (database.pragma(`table_info(${table})`) as Array<{ name: string }>)
    .map(({ name }) => name);
}

function tableSql(database: Database.Database, table: string): string {
  return (database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as { sql: string }).sql;
}

function rowsByTable(database: Database.Database): Record<string, unknown[]> {
  return Object.fromEntries(PRESERVED_TABLES.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
  ]));
}

function columnsByTable(database: Database.Database): Record<string, string[]> {
  return Object.fromEntries(PRESERVED_TABLES.map((table) => [
    table,
    tableColumns(database, table),
  ]));
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

function foreignKeys(database: Database.Database): Record<string, unknown[]> {
  const tables = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  return Object.fromEntries(tables.map((table) => [
    table,
    database.pragma(`foreign_key_list(${table})`) as unknown[],
  ]));
}

function schemaVersion(database: Database.Database): number {
  return (database.prepare(
    "SELECT MAX(version) AS version FROM schema_migrations",
  ).get() as { version: number }).version;
}

function copyPopulatedRowsToPreviousSchema(
  database: Database.Database,
  populatedDatabasePath: string,
): void {
  database.prepare("ATTACH DATABASE ? AS populated").run(populatedDatabasePath);
  database.transaction(() => {
    for (const table of [
      "projects",
      "conversations",
      ...REBUILT_TABLES,
      ...RELATED_TABLES,
    ]) {
      const columns = tableColumns(database, table).join(", ");
      database.exec(
        `INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM populated.${table}`,
      );
    }
  })();
  database.exec("DETACH DATABASE populated");
  expect(database.pragma("foreign_key_check")).toEqual([]);
}

async function populatedFixture(): Promise<{
  databasePath: string;
  workspacePath: string;
  conversationId: string;
  turnId: string;
}> {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, `schema-${PREVIOUS_SCHEMA_VERSION}.sqlite`);
  const populatedDatabasePath = join(directory, "populated-current.sqlite");
  const store = new RuntimeStore(populatedDatabasePath, workspacePath, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Antigravity migration", workspacePath);
  const conversation = store.createConversation(project.id, "Retained Gemini chat", {
    providerId: "gemini",
    model: "gemini-2.5-pro",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
  });
  const childConversation = store.createConversation(project.id, "Retained child", {
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
  });
  const turn = store.beginAgentTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    runId: randomUUID(),
    content: "Preserve this Gemini turn.",
    providerId: "gemini",
    harnessId: "gemini-acp",
    backendProfileId: "builtin:gemini",
    model: "gemini-2.5-pro",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 0,
    association: "authoritative",
  }).turn;
  store.upsertSubagentTrace({
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    providerId: "gemini",
    providerTaskId: "retained-task",
    providerAgentId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "retained-tool",
    providerRole: "reviewer",
    providerName: "Retained reviewer",
    providerStatus: "running",
    status: "running",
    isLive: true,
    description: "Retain this delegated trace.",
    progress: "Working",
    result: null,
    sequence: 1,
  });
  store.upsertReviewSummary({
    conversationId: conversation.id,
    fingerprint: "a".repeat(64),
    providerId: "gemini",
    harnessId: "gemini-acp",
    backendProfileId: "builtin:gemini",
    model: "gemini-2.5-pro",
    overall: "Retained summary",
    classifications: [],
    files: [{
      path: "src/index.ts",
      summary: "Retained file summary",
      classifications: [],
      hunks: [],
    }],
    generatedAt: PROFILE_TIMESTAMP,
  });
  store.saveProviderMetadata({
    scope: {
      providerId: "gemini",
      harnessId: "gemini-acp",
      backendProfileId: "builtin:gemini",
      modelId: "provider-catalog",
      executable: "/usr/local/bin/gemini",
      version: "0.58.0",
      backendConfigurationRevision: 0,
      authState: "authenticated",
    },
    models: [],
    modelsUpdatedAt: PROFILE_TIMESTAMP,
    modelsLastAttemptedAt: PROFILE_TIMESTAMP,
    modelsProvenance: "provider",
    modelsStale: false,
    rateLimits: [],
    rateLimitsUpdatedAt: null,
    rateLimitsLastAttemptedAt: null,
    rateLimitsProvenance: null,
    rateLimitsStale: false,
  });
  store.close();

  const populated = new Database(populatedDatabasePath);
  populated.prepare(`
    INSERT INTO agent_managed_conversations (
      child_conversation_id, source_conversation_id, source_turn_id,
      source_run_id, root_conversation_id, source_harness_id, depth, created_at
    ) VALUES (?, ?, ?, ?, ?, 'gemini-acp', 1, ?)
  `).run(
    childConversation.id,
    conversation.id,
    turn.id,
    turn.runId,
    conversation.id,
    "2026-09-01T08:01:00.000Z",
  );
  populated.prepare(`
    INSERT INTO agent_thread_operations (
      id, source_conversation_id, source_turn_id, source_run_id,
      tool_call_id_hash, tool_name, request_fingerprint, status,
      child_conversation_id, input_chars, result_json, failure_message,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'inertia_create_conversation', ?, 'completed',
      ?, 12, '{}', NULL, ?, ?)
  `).run(
    "b".repeat(64),
    conversation.id,
    turn.id,
    turn.runId,
    "c".repeat(64),
    "d".repeat(64),
    childConversation.id,
    "2026-09-01T08:01:00.000Z",
    "2026-09-01T08:01:01.000Z",
  );
  populated.prepare(`
    INSERT INTO provider_metadata_cache (
      provider_id, executable, version, auth_state
    ) VALUES ('gemini', '/usr/local/bin/gemini', '0.58.0', 'authenticated')
  `).run();
  populated.close();

  const database = new Database(databasePath);
  migrateRuntimeDatabase(database, PREVIOUS_SCHEMA_VERSION);
  copyPopulatedRowsToPreviousSchema(database, populatedDatabasePath);
  expect(schemaVersion(database)).toBe(PREVIOUS_SCHEMA_VERSION);
  for (const table of REBUILT_TABLES) {
    expect(tableSql(database, table)).not.toContain("'antigravity");
  }
  database.close();
  return {
    databasePath,
    workspacePath,
    conversationId: conversation.id,
    turnId: turn.id,
  };
}

describe("native Antigravity provider migration", { concurrent: false }, () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it("widens provider constraints while preserving every schema-75 row and relation", async () => {
    const fixture = await populatedFixture();
    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = ON");
    const beforeRows = rowsByTable(database);
    const beforeColumns = columnsByTable(database);
    const beforeIndexes = schemaObjects(database, "index");
    const beforeTriggers = schemaObjects(database, "trigger");
    const beforeForeignKeys = foreignKeys(database);
    expect(beforeTriggers.length).toBeGreaterThan(0);

    migrateRuntimeDatabase(database, ANTIGRAVITY_SCHEMA_VERSION);

    expect(schemaVersion(database)).toBe(ANTIGRAVITY_SCHEMA_VERSION);
    expect(rowsByTable(database)).toEqual(beforeRows);
    expect(columnsByTable(database)).toEqual(beforeColumns);
    expect(schemaObjects(database, "index")).toEqual(beforeIndexes);
    expect(schemaObjects(database, "trigger")).toEqual(beforeTriggers);
    expect(foreignKeys(database)).toEqual(beforeForeignKeys);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(tableSql(database, "model_backend_profiles")).toContain("'antigravity-cli'");
    expect(tableSql(database, "model_backend_profiles")).toContain("'antigravity-managed'");
    expect(tableSql(database, "agent_turns")).toContain("'antigravity'");
    expect(tableSql(database, "agent_turns")).toContain("'gemini'");
    expect(database.prepare(`
      SELECT provider_id, harness_id, backend_profile_id FROM agent_turns WHERE id = ?
    `).get(fixture.turnId)).toEqual({
      provider_id: "gemini",
      harness_id: "gemini-acp",
      backend_profile_id: "builtin:gemini",
    });

    database.exec(`
      UPDATE provider_metadata_cache SET provider_id = 'antigravity';
      UPDATE diff_review_summaries SET provider_id = 'antigravity';
      UPDATE provider_metadata_scoped_cache
        SET provider_id = 'antigravity', harness_id = 'antigravity-cli';
      UPDATE subagent_traces SET provider_id = 'antigravity';
    `);
    expect(() => database.prepare(`
      UPDATE agent_turns SET provider_id = 'unknown-provider' WHERE id = ?
    `).run(fixture.turnId)).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("rolls back completely when the upgraded database would violate a foreign key", async () => {
    const fixture = await populatedFixture();
    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      UPDATE diff_review_summaries
      SET conversation_id = 'missing-conversation'
      WHERE conversation_id = ?
    `).run(fixture.conversationId);
    database.pragma("foreign_keys = ON");
    const beforeRows = rowsByTable(database);
    const beforeIndexes = schemaObjects(database, "index");
    const beforeTriggers = schemaObjects(database, "trigger");
    const beforeSql = REBUILT_TABLES.map((table) => tableSql(database, table));

    expect(() => migrateRuntimeDatabase(database)).toThrow(DatabaseMigrationError);

    expect(schemaVersion(database)).toBe(PREVIOUS_SCHEMA_VERSION);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(rowsByTable(database)).toEqual(beforeRows);
    expect(schemaObjects(database, "index")).toEqual(beforeIndexes);
    expect(schemaObjects(database, "trigger")).toEqual(beforeTriggers);
    expect(REBUILT_TABLES.map((table) => tableSql(database, table))).toEqual(beforeSql);
    database.close();
  });

  it("stores native Antigravity routes next to untouched Gemini history", async () => {
    const fixture = await populatedFixture();
    const copyPath = join(await temporaryDirectory(), "copy.sqlite");
    await copyFile(fixture.databasePath, copyPath);

    const migrated = new RuntimeStore(fixture.databasePath, fixture.workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(migrated.databaseRecoveryReport().outcome).toBe("healthy");
    expect(migrated.agentTurn(fixture.turnId).providerId).toBe("gemini");
    expect(migrated.saveModelBackendProfile(nativeAntigravityBackendProfile()).profile)
      .toEqual(nativeAntigravityBackendProfile());
    migrated.close();

    const reopened = new RuntimeStore(fixture.databasePath, fixture.workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.modelBackendProfile("builtin:antigravity").profile)
      .toEqual(nativeAntigravityBackendProfile());
    expect(reopened.agentTurn(fixture.turnId)).toMatchObject({
      providerId: "gemini",
      harnessId: "gemini-acp",
    });
    reopened.close();
  });
});
