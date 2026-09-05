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

const REBUILT_TABLES = [
  "provider_metadata_cache",
  "diff_review_summaries",
  "provider_metadata_scoped_cache",
  "agent_turns",
  "subagent_traces",
] as const;

const AGENT_THREAD_TABLES = [
  "agent_managed_conversations",
  "agent_thread_operations",
] as const;

const PRESERVED_TABLES = [...REBUILT_TABLES, ...AGENT_THREAD_TABLES] as const;

const EXPECTED_INDEXES = [
  "provider_metadata_scoped_identity_idx",
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-kimi-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tableColumns(database: Database.Database, table: string): string[] {
  return (database.pragma(`table_info(${table})`) as Array<{ name: string }>)
    .map(({ name }) => name);
}

function rowsByTable(
  database: Database.Database,
  agentTurnColumns?: string[],
): Record<string, unknown[]> {
  return Object.fromEntries(PRESERVED_TABLES.map((table) => [
    table,
    database.prepare(`SELECT ${table === "agent_turns" && agentTurnColumns
      ? agentTurnColumns.join(", ")
      : "*"} FROM ${table} ORDER BY 1`).all(),
  ]));
}

function pairedDeletionTriggers(
  database: Database.Database,
): Array<{ name: string; sql: string }> {
  return database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN (
        'paired_launches_conversation_delete',
        'paired_launches_project_delete'
      )
    ORDER BY name
  `).all() as Array<{ name: string; sql: string }>;
}

function copyPopulatedRowsToV61(
  database: Database.Database,
  populatedDatabasePath: string,
): void {
  database.prepare("ATTACH DATABASE ? AS populated").run(populatedDatabasePath);
  database.transaction(() => {
    for (const table of [
      "projects",
      "conversations",
      ...REBUILT_TABLES,
      ...AGENT_THREAD_TABLES,
    ]) {
      const columns = tableColumns(database, table).join(", ");
      database.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM populated.${table}`);
    }
  })();
  database.exec("DETACH DATABASE populated");
  expect(database.pragma("foreign_key_check")).toEqual([]);
}

async function populatedV61Fixture(): Promise<{
  databasePath: string;
  conversationId: string;
  turnId: string;
}> {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  const populatedDatabasePath = join(directory, "populated-v62.sqlite");
  const store = new RuntimeStore(populatedDatabasePath, workspacePath, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Kimi migration", workspacePath);
  const conversation = store.createConversation(project.id, "Retained provider rows", {
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
  });
  const childConversation = store.createConversation(project.id, "Retained managed child", {
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
    generatedAt: "2026-08-20T08:00:00.000Z",
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
    modelsUpdatedAt: "2026-08-20T08:00:00.000Z",
    modelsLastAttemptedAt: "2026-08-20T08:00:00.000Z",
    modelsProvenance: "provider",
    modelsStale: false,
    rateLimits: [],
    rateLimitsUpdatedAt: null,
    rateLimitsLastAttemptedAt: null,
    rateLimitsProvenance: null,
    rateLimitsStale: false,
  });
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
    "2026-08-20T08:01:00.000Z",
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
    "2026-08-20T08:01:00.000Z",
    "2026-08-20T08:01:01.000Z",
  );
  populatedDatabase.prepare(`
    INSERT INTO provider_metadata_cache (
      provider_id, executable, version, auth_state
    ) VALUES ('codex', '/usr/local/bin/codex', '1.0.0', 'authenticated')
  `).run();
  populatedDatabase.close();

  const database = new Database(databasePath);
  migrateRuntimeDatabase(database, 61);
  copyPopulatedRowsToV61(database, populatedDatabasePath);
  expect((database.prepare(
    "SELECT MAX(version) AS version FROM schema_migrations",
  ).get() as { version: number }).version).toBe(61);
  for (const table of REBUILT_TABLES) {
    const sql = (database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string }).sql;
    expect(sql).not.toContain("'kimi'");
    expect(sql).not.toContain("'kimi-acp'");
  }
  database.close();
  return { databasePath, conversationId: conversation.id, turnId: turn.id };
}

describe.sequential("native Kimi provider migration", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it("preserves all rebuilt rows, indexes, foreign keys, and latest deletion guards", async () => {
    const fixture = await populatedV61Fixture();
    const rollbackPath = join(
      await temporaryDirectory(),
      "rollback.sqlite",
    );
    await copyFile(fixture.databasePath, rollbackPath);

    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = ON");
    const agentTurnColumns = tableColumns(database, "agent_turns");
    const before = rowsByTable(database, agentTurnColumns);
    const beforeTriggers = pairedDeletionTriggers(database);
    migrateRuntimeDatabase(database);
    expect(rowsByTable(database, agentTurnColumns)).toEqual(before);
    expect(database.prepare(`
      SELECT run_state, provider_state, run_state_revision FROM agent_turns
    `).get()).toEqual({ run_state: "queued", provider_state: null, run_state_revision: 0 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect((database.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(CURRENT_DATABASE_SCHEMA_VERSION);

    const indexes = (database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        ${EXPECTED_INDEXES.map(() => "?").join(", ")}
      )
      ORDER BY name
    `).all(...EXPECTED_INDEXES) as Array<{ name: string }>).map(({ name }) => name);
    expect(indexes).toEqual([...EXPECTED_INDEXES].sort());
    const triggers = pairedDeletionTriggers(database);
    expect(triggers).toEqual(beforeTriggers);
    expect(triggers.map(({ name }) => name)).toEqual([
      "paired_launches_conversation_delete",
      "paired_launches_project_delete",
    ]);
    for (const { sql } of triggers) {
      expect(sql).toMatch(/locked comparison/u);
      expect(sql).toMatch(/cancel_requested/u);
      expect(sql).toMatch(/live_turn\.status NOT IN/u);
    }

    database.exec(`
      UPDATE provider_metadata_cache SET provider_id = 'kimi';
      UPDATE diff_review_summaries SET provider_id = 'kimi';
      UPDATE provider_metadata_scoped_cache
        SET provider_id = 'kimi', harness_id = 'kimi-acp';
      UPDATE agent_turns
        SET provider_id = 'kimi', harness_id = 'kimi-acp',
            backend_profile_id = 'builtin:kimi';
      UPDATE subagent_traces SET provider_id = 'kimi';
    `);
    for (const table of REBUILT_TABLES) {
      expect((database.prepare(
        `SELECT provider_id FROM ${table} LIMIT 1`,
      ).get() as { provider_id: string }).provider_id).toBe("kimi");
    }
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
    expect(() => migrateRuntimeDatabase(rollback)).toThrow(DatabaseMigrationError);
    expect((rollback.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(61);
    expect(rollback.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(rollback.pragma("foreign_key_check")).toHaveLength(1);
    expect(rowsByTable(rollback)).toEqual(rollbackRows);
    expect((rollback.prepare(
      "SELECT id FROM agent_turns WHERE id = ?",
    ).get(fixture.turnId) as { id: string }).id).toBe(fixture.turnId);
    rollback.close();
  });
});
