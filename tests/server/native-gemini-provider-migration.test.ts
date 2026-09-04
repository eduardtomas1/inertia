// @inertia-test-suite portable

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { DatabaseMigrationError } from "../../src/server/database-migrations";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import type { PersistedModelBackendProfile } from "../../src/shared/backend-profile-settings";

const PREVIOUS_SCHEMA_VERSION = 66;

const PROVIDER_ID_TABLES = [
  "provider_metadata_cache",
  "diff_review_summaries",
  "provider_metadata_scoped_cache",
  "agent_turns",
  "subagent_traces",
] as const;

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

const EXPECTED_INDEXES = [
  "provider_metadata_scoped_identity_idx",
  "model_backend_profiles_harness_idx",
  "agent_turns_conversation_requested_idx",
  "agent_turns_status_requested_idx",
  "agent_turns_run_state_requested_idx",
  "agent_turns_provider_run_identity_idx",
  "agent_turns_usage_dashboard_completed_idx",
  "subagent_traces_turn_order_idx",
  "subagent_traces_task_identity_idx",
  "subagent_traces_agent_identity_idx",
  "subagent_traces_parent_idx",
  "subagents_conversation_created_idx",
] as const;

const temporaryDirectories: string[] = [];

const PROFILE_TIMESTAMP = "2026-09-01T08:00:00.000Z";

function retainedLegacyBackendProfile(): PersistedModelBackendProfile {
  return {
    id: "custom:retained-anthropic",
    displayName: "Retained Anthropic gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "none",
    source: "custom",
    enabled: false,
    configurationRevision: 3,
    endpointIdentity: backendEndpointIdentity("https://retained.example.test/v1"),
    preset: "custom",
    baseUrl: "https://retained.example.test/v1",
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: "retained-model",
      displayName: "Retained model",
      contextWindowTokens: 200_000,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "retained-model" },
    capabilityHints: [],
    createdAt: PROFILE_TIMESTAMP,
    updatedAt: PROFILE_TIMESTAMP,
  };
}

function nativeGeminiBackendProfile(): PersistedModelBackendProfile {
  return {
    id: "builtin:gemini",
    displayName: "Google Gemini",
    harnessId: "gemini-acp",
    protocol: "gemini-managed",
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
  const directory = await mkdtemp(join(tmpdir(), "inertia-gemini-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tableColumns(database: Database.Database, table: string): string[] {
  return (database.pragma(`table_info(${table})`) as Array<{ name: string }>)
    .map(({ name }) => name);
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

function namedIndexes(
  database: Database.Database,
): Array<{ name: string; sql: string }> {
  return database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND sql IS NOT NULL
    ORDER BY name
  `).all() as Array<{ name: string; sql: string }>;
}

function triggers(
  database: Database.Database,
): Array<{ name: string; sql: string }> {
  return database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger'
    ORDER BY name
  `).all() as Array<{ name: string; sql: string }>;
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

async function populatedFixture(schemaVersion = PREVIOUS_SCHEMA_VERSION): Promise<{
  databasePath: string;
  workspacePath: string;
  conversationId: string;
  turnId: string;
  backendProfileId: string;
}> {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, `schema-${schemaVersion}.sqlite`);
  const populatedDatabasePath = join(directory, "populated-current.sqlite");
  const store = new RuntimeStore(populatedDatabasePath, workspacePath, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Gemini migration", workspacePath);
  const conversation = store.createConversation(
    project.id,
    "Retained provider rows",
    {
      providerId: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
    },
  );
  const childConversation = store.createConversation(
    project.id,
    "Retained managed child",
    {
      providerId: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
    },
  );
  const turn = store.beginAgentTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    runId: randomUUID(),
    content: "Preserve this populated turn.",
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 0,
    association: "authoritative",
  }).turn;
  store.upsertSubagentTrace({
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    providerId: "codex",
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
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    model: "gpt-test",
    overall: "Retained summary",
    classifications: [],
    files: [{
      path: "src/index.ts",
      summary: "Retained file summary",
      classifications: [],
      hunks: [],
    }],
    generatedAt: "2026-09-01T08:00:00.000Z",
  });
  store.saveProviderMetadata({
    scope: {
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      modelId: "provider-catalog",
      executable: "/usr/local/bin/codex",
      version: "1.0.0",
      backendConfigurationRevision: 0,
      authState: "authenticated",
    },
    models: [],
    modelsUpdatedAt: "2026-09-01T08:00:00.000Z",
    modelsLastAttemptedAt: "2026-09-01T08:00:00.000Z",
    modelsProvenance: "provider",
    modelsStale: false,
    rateLimits: [],
    rateLimitsUpdatedAt: null,
    rateLimitsLastAttemptedAt: null,
    rateLimitsProvenance: null,
    rateLimitsStale: false,
  });
  const backendProfile = store.saveModelBackendProfile(
    retainedLegacyBackendProfile(),
  ).profile;
  store.close();

  const populatedDatabase = new Database(populatedDatabasePath);
  populatedDatabase.prepare(`
    INSERT INTO agent_managed_conversations (
      child_conversation_id, source_conversation_id, source_turn_id,
      source_run_id, root_conversation_id, source_harness_id, depth, created_at
    ) VALUES (?, ?, ?, ?, ?, 'codex-app-server', 1, ?)
  `).run(
    childConversation.id,
    conversation.id,
    turn.id,
    turn.runId,
    conversation.id,
    "2026-09-01T08:01:00.000Z",
  );
  populatedDatabase.prepare(`
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
  populatedDatabase.prepare(`
    INSERT INTO provider_metadata_cache (
      provider_id, executable, version, auth_state
    ) VALUES ('codex', '/usr/local/bin/codex', '1.0.0', 'authenticated')
  `).run();
  populatedDatabase.prepare(`
    UPDATE agent_turns
    SET status = 'running', run_state = 'retrying',
        provider_state = 'provider-retrying',
        run_state_revision = 7, suspended_duration_ms = 123456
    WHERE id = ?
  `).run(turn.id);
  populatedDatabase.close();

  const database = new Database(databasePath);
  migrateRuntimeDatabase(database, schemaVersion);
  copyPopulatedRowsToPreviousSchema(database, populatedDatabasePath);
  expect(database.prepare(`
    SELECT profile_id FROM model_backend_profiles ORDER BY profile_id
  `).all()).toEqual([{ profile_id: backendProfile.id }]);
  expect((database.prepare(
    "SELECT MAX(version) AS version FROM schema_migrations",
  ).get() as { version: number }).version).toBe(schemaVersion);
  expect(tableColumns(database, "agent_turns").slice(-4)).toEqual([
    "run_state",
    "provider_state",
    "run_state_revision",
    "suspended_duration_ms",
  ]);
  for (const table of REBUILT_TABLES) {
    const sql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { sql: string }).sql;
    if (schemaVersion === PREVIOUS_SCHEMA_VERSION) {
      expect(sql).not.toContain("'gemini'");
      expect(sql).not.toContain("'gemini-acp'");
    }
  }
  database.close();
  return {
    databasePath,
    workspacePath,
    conversationId: conversation.id,
    turnId: turn.id,
    backendProfileId: backendProfile.id,
  };
}

describe.sequential("native Gemini provider migration", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it("preserves the complete schema-66 data and relational topology in released migration 67", async () => {
    const fixture = await populatedFixture();
    const rollbackPath = join(await temporaryDirectory(), "rollback.sqlite");
    await copyFile(fixture.databasePath, rollbackPath);

    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = ON");
    const beforeRows = rowsByTable(database);
    const beforeColumns = columnsByTable(database);
    const beforeIndexes = namedIndexes(database);
    const beforeTriggers = triggers(database);
    const beforeForeignKeys = foreignKeys(database);

    migrateRuntimeDatabase(database, 67);

    expect(rowsByTable(database)).toEqual(beforeRows);
    expect(columnsByTable(database)).toEqual(beforeColumns);
    expect(namedIndexes(database)).toEqual(beforeIndexes);
    expect(triggers(database)).toEqual(beforeTriggers);
    expect(foreignKeys(database)).toEqual(beforeForeignKeys);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect((database.prepare(`
      SELECT run_state, provider_state, run_state_revision,
             suspended_duration_ms
      FROM agent_turns WHERE id = ?
    `).get(fixture.turnId))).toEqual({
      run_state: "retrying",
      provider_state: "provider-retrying",
      run_state_revision: 7,
      suspended_duration_ms: 123456,
    });
    expect((database.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(67);

    const indexes = new Set(beforeIndexes.map(({ name }) => name));
    for (const index of EXPECTED_INDEXES) expect(indexes.has(index)).toBe(true);
    const backendProfileSql = (database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'model_backend_profiles'
    `).get() as { sql: string }).sql;
    expect(backendProfileSql).toContain("'gemini-acp'");
    expect(backendProfileSql).toContain("'kimi-acp'");
    expect(backendProfileSql).toContain("'gemini-managed'");
    expect(backendProfileSql).toContain("'kimi-managed'");
    expect(() => database.prepare(`
      UPDATE agent_turns SET run_state = 'invalid-state' WHERE id = ?
    `).run(fixture.turnId)).toThrow();
    expect(() => database.prepare(`
      UPDATE agent_turns SET suspended_duration_ms = -1 WHERE id = ?
    `).run(fixture.turnId)).toThrow();
    database.exec(`
      UPDATE provider_metadata_cache SET provider_id = 'gemini';
      UPDATE diff_review_summaries SET provider_id = 'gemini';
      UPDATE provider_metadata_scoped_cache
        SET provider_id = 'gemini', harness_id = 'gemini-acp';
      UPDATE agent_turns
        SET provider_id = 'gemini', harness_id = 'gemini-acp',
            backend_profile_id = 'builtin:gemini';
      UPDATE subagent_traces SET provider_id = 'gemini';
    `);
    for (const table of PROVIDER_ID_TABLES) {
      expect((database.prepare(
        `SELECT provider_id FROM ${table} LIMIT 1`,
      ).get() as { provider_id: string }).provider_id).toBe("gemini");
    }
    expect((database.prepare(`
      SELECT harness_id FROM provider_metadata_scoped_cache LIMIT 1
    `).get() as { harness_id: string }).harness_id).toBe("gemini-acp");
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();

    const rollback = new Database(rollbackPath);
    rollback.pragma("foreign_keys = OFF");
    rollback.prepare(`
      UPDATE diff_review_summaries
      SET conversation_id = 'missing-conversation'
      WHERE conversation_id = ?
    `).run(fixture.conversationId);
    rollback.pragma("foreign_keys = ON");
    const rollbackRows = rowsByTable(rollback);
    const rollbackIndexes = namedIndexes(rollback);
    const rollbackTriggers = triggers(rollback);
    const rollbackForeignKeys = foreignKeys(rollback);
    expect(() => migrateRuntimeDatabase(rollback)).toThrow(DatabaseMigrationError);
    expect((rollback.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(PREVIOUS_SCHEMA_VERSION);
    expect(rollback.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(rollback.pragma("foreign_key_check")).toHaveLength(1);
    expect(rowsByTable(rollback)).toEqual(rollbackRows);
    expect(namedIndexes(rollback)).toEqual(rollbackIndexes);
    expect(triggers(rollback)).toEqual(rollbackTriggers);
    expect(foreignKeys(rollback)).toEqual(rollbackForeignKeys);
    rollback.close();
  });

  it("appends continuation evidence to a populated released schema-67 database", async () => {
    const fixture = await populatedFixture(67);
    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = ON");
    database.prepare(`
      UPDATE agent_turns SET provider_id = 'gemini', harness_id = 'gemini-acp',
        backend_profile_id = 'builtin:gemini' WHERE id = ?
    `).run(fixture.turnId);
    const beforeRows = rowsByTable(database);
    const beforeColumns = columnsByTable(database);
    const beforeIndexes = namedIndexes(database);
    const beforeTriggers = triggers(database);
    const beforeForeignKeys = foreignKeys(database);

    migrateRuntimeDatabase(database);
    migrateRuntimeDatabase(database);

    expect(rowsByTable(database)).toEqual({
      ...beforeRows,
      agent_turns: beforeRows.agent_turns!.map((row) => ({
        ...row as Record<string, unknown>, continuation_reason_code: null,
      })),
    });
    expect(columnsByTable(database)).toEqual({
      ...beforeColumns,
      agent_turns: [...beforeColumns.agent_turns!, "continuation_reason_code"],
    });
    expect(namedIndexes(database)).toEqual(beforeIndexes);
    expect(triggers(database)).toEqual(beforeTriggers);
    expect(foreignKeys(database)).toEqual(beforeForeignKeys);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect((database.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    expect(() => database.prepare(`
      UPDATE agent_turns SET continuation_reason_code = 'invalid-reason'
      WHERE id = ?
    `).run(fixture.turnId)).toThrow();
    database.prepare(`
      UPDATE agent_turns SET continuation_reason_code = 'harness-changed'
      WHERE id = ?
    `).run(fixture.turnId);
    database.close();

    const reopened = new RuntimeStore(fixture.databasePath, fixture.workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.agentTurn(fixture.turnId).continuationReasonCode).toBe("harness-changed");
    expect(reopened.agentTurn(fixture.turnId).providerId).toBe("gemini");
    reopened.close();
  });

  it("round-trips native Gemini profiles through the post-migration repository", async () => {
    const fixture = await populatedFixture();
    const database = new Database(fixture.databasePath);
    migrateRuntimeDatabase(database);
    database.close();

    const migrated = new RuntimeStore(
      fixture.databasePath,
      fixture.workspacePath,
      { recoverInterruptedRuns: false },
    );
    expect(migrated.databaseRecoveryReport().outcome).toBe("healthy");
    expect(migrated.modelBackendProfile(fixture.backendProfileId).profile)
      .toEqual(retainedLegacyBackendProfile());
    expect(migrated.saveModelBackendProfile(nativeGeminiBackendProfile()).profile)
      .toEqual(nativeGeminiBackendProfile());
    migrated.close();

    const reopened = new RuntimeStore(
      fixture.databasePath,
      fixture.workspacePath,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.modelBackendProfile("builtin:gemini").profile)
      .toEqual(nativeGeminiBackendProfile());
    expect(reopened.listModelBackendProfiles().map(({ profile }) => profile.id))
      .toEqual([
        "builtin:gemini",
        fixture.backendProfileId,
      ]);
    reopened.close();
  });
});
