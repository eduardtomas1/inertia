// @inertia-test-suite portable

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { DatabaseMigrationError } from "../../src/server/database-migrations";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import type { PersistedModelBackendProfile } from "../../src/shared/backend-profile-settings";
import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

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

const PROFILE_TIMESTAMP = "2026-09-01T08:00:00.000Z";

const GEMINI_SELECTION = JSON.stringify({
  harnessId: "gemini-acp",
  backendProfileId: "builtin:gemini",
  backendProfileDisplayName: "Google Gemini",
  modelId: "gemini-2.5-pro",
  alias: "Gemini 2.5 Pro",
  reasoningEffort: "high",
  contextWindowOverride: null,
  providerOptions: {},
  capabilities: [],
  backendConfigurationRevision: 0,
});

const GEMINI_CONTINUATION = JSON.stringify({
  harnessId: "gemini-acp",
  backendProfileId: "builtin:gemini",
  backendConfigurationRevision: 0,
  modelIdentity: "gemini-2.5-pro",
  endpointIdentity: null,
});

const RETIRED_PROFILE_SELECTION = JSON.stringify({
  harnessId: "claude-agent-sdk",
  backendProfileId: "custom:gemini-team",
  backendProfileDisplayName: "Team Gemini gateway",
  modelId: "team-model",
  alias: null,
  reasoningEffort: "high",
  contextWindowOverride: null,
  providerOptions: {},
  capabilities: [],
  backendConfigurationRevision: 3,
});

const temporaryDirectories: string[] = [];

function customProfile(): PersistedModelBackendProfile {
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

function nativeAntigravityProfile(): PersistedModelBackendProfile {
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
    database.pragma("defer_foreign_keys = ON");
    database.exec("DELETE FROM main.app_state");
    for (const table of [
      "app_state",
      "projects",
      "conversations",
      "messages",
      ...REBUILT_TABLES,
      "agent_managed_conversations",
      "agent_thread_operations",
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

function textReferences(database: Database.Database, value: string): string[] {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).pluck().all() as string[];
  return tables.flatMap((table) => tableColumns(database, table)
    .filter((column) => (database.prepare(
      `SELECT COUNT(*) FROM "${table}" WHERE instr(CAST("${column}" AS TEXT), ?) > 0`,
    ).pluck().get(value) as number) > 0)
    .map((column) => `${table}.${column}`));
}

function cloneRow(
  database: Database.Database,
  table: string,
  where: string,
  overrides: Record<string, unknown>,
): void {
  const columns = tableColumns(database, table);
  const selected = columns.map((column) => (Object.hasOwn(overrides, column) ? `@${column}` : column));
  database.prepare(`
    INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${selected.join(", ")} FROM ${table} WHERE ${where} LIMIT 1
  `).run(overrides);
}

interface Fixture {
  databasePath: string;
  workspacePath: string;
  geminiConversationId: string;
  codexConversationId: string;
  geminiTurnId: string;
  retiredProfileConversationId: string;
  retiredProfileTurnId: string;
  switchedConversationId: string;
}

async function geminiFixture(): Promise<Fixture> {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, `schema-${PREVIOUS_SCHEMA_VERSION}.sqlite`);
  const populatedDatabasePath = join(directory, "populated-current.sqlite");
  const store = new RuntimeStore(populatedDatabasePath, workspacePath, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Gemini chats", workspacePath);
  const configuration = {
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
  } as const;
  const geminiConversation = store.createConversation(project.id, "Gemini chat", configuration);
  const codexConversation = store.createConversation(project.id, "Codex chat", configuration);
  const childConversation = store.createConversation(project.id, "Managed child", configuration);
  const retiredProfileConversation = store.createConversation(project.id, "Retired profile chat", {
    ...configuration,
    providerId: "claude",
    model: "team-model",
  });
  const switchedConversation = store.createConversation(project.id, "Switched from Gemini", configuration);
  const turn = store.beginAgentTurn({
    id: randomUUID(),
    conversationId: geminiConversation.id,
    runId: randomUUID(),
    content: "Keep this Gemini transcript.",
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
  const retiredProfileTurn = store.beginAgentTurn({
    id: randomUUID(),
    conversationId: retiredProfileConversation.id,
    runId: randomUUID(),
    content: "Keep this retired profile transcript.",
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    backendProfileId: "custom:gemini-team",
    model: "team-model",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 0,
    association: "authoritative",
  }).turn;
  store.upsertSubagentTrace({
    conversationId: geminiConversation.id,
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
    conversationId: geminiConversation.id,
    fingerprint: "a".repeat(64),
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    model: "gpt-test",
    overall: "Retained summary",
    classifications: [],
    files: [{ path: "src/index.ts", summary: "Retained file summary", classifications: [], hunks: [] }],
    generatedAt: PROFILE_TIMESTAMP,
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
  store.saveModelBackendProfile(customProfile());
  store.close();

  const populated = new Database(populatedDatabasePath);
  populated.prepare(`
    INSERT INTO agent_managed_conversations (
      child_conversation_id, source_conversation_id, source_turn_id,
      source_run_id, root_conversation_id, source_harness_id, depth, created_at
    ) VALUES (?, ?, ?, ?, ?, 'codex-app-server', 1, ?)
  `).run(childConversation.id, geminiConversation.id, turn.id, turn.runId, geminiConversation.id, PROFILE_TIMESTAMP);
  populated.prepare(`
    INSERT INTO provider_metadata_cache (provider_id, executable, version, auth_state)
    VALUES ('codex', '/usr/local/bin/codex', '1.0.0', 'authenticated')
  `).run();
  populated.close();

  const database = new Database(databasePath);
  migrateRuntimeDatabase(database, PREVIOUS_SCHEMA_VERSION);
  copyPopulatedRowsToPreviousSchema(database, populatedDatabasePath);
  database.prepare(`
    UPDATE conversations
    SET provider_id = 'gemini', provider_session_id = 'gemini-session-after',
        model = 'gemini-2.5-pro', reasoning_effort = 'high',
        model_selection_json = @selection, continuation_identity_json = @continuation
    WHERE id = @id
  `).run({ id: geminiConversation.id, selection: GEMINI_SELECTION, continuation: GEMINI_CONTINUATION });
  database.prepare(`
    UPDATE agent_turns
    SET provider_id = 'gemini', harness_id = 'gemini-acp', backend_profile_id = 'builtin:gemini',
        model = 'gemini-2.5-pro', model_alias = 'Gemini 2.5 Pro', reasoning_effort = 'high',
        provider_session_before = 'gemini-session-before',
        model_selection_json = @selection, continuation_identity_json = @continuation
    WHERE id = @id
  `).run({ id: turn.id, selection: GEMINI_SELECTION, continuation: GEMINI_CONTINUATION });
  database.prepare("UPDATE subagent_traces SET provider_id = 'gemini' WHERE turn_id = ?").run(turn.id);
  database.prepare("UPDATE diff_review_summaries SET provider_id = 'gemini' WHERE conversation_id = ?")
    .run(geminiConversation.id);
  database.prepare(`
    INSERT INTO provider_metadata_cache (provider_id, executable, version, auth_state)
    VALUES ('gemini', '/usr/local/bin/gemini', '0.58.0', 'authenticated')
  `).run();
  cloneRow(database, "provider_metadata_scoped_cache", "provider_id = 'codex'", {
    scope_key: "gemini-scope",
    provider_id: "gemini",
    harness_id: "gemini-acp",
    backend_profile_id: "builtin:gemini",
  });
  cloneRow(database, "model_backend_profiles", "profile_id = 'custom:retained-anthropic'", {
    profile_id: "builtin:gemini",
    harness_id: "gemini-acp",
    preset: "native",
    protocol: "gemini-managed",
    source: "built-in",
    endpoint_identity: null,
    credential_generation: null,
  });
  database.prepare(`
    INSERT INTO model_backend_defaults (scope, project_id, selection_json, updated_at)
    VALUES ('global', NULL, ?, ?)
  `).run(GEMINI_SELECTION, PROFILE_TIMESTAMP);
  database.prepare(`
    UPDATE app_state
    SET default_provider = 'gemini', default_model = 'gemini-2.5-pro', default_reasoning_effort = 'high',
        provider_identity_labels_json = '{"codex":"Work Codex","gemini":"Work Gemini"}'
  `).run();
  database.prepare("UPDATE agent_managed_conversations SET source_harness_id = 'gemini-acp'").run();
  cloneRow(database, "model_backend_profiles", "profile_id = 'custom:retained-anthropic'", {
    profile_id: "custom:gemini-team",
    protocol: "gemini-managed",
  });
  database.prepare(`
    UPDATE conversations SET provider_session_id = 'team-session', model_selection_json = @selection
    WHERE id = @id
  `).run({ id: retiredProfileConversation.id, selection: RETIRED_PROFILE_SELECTION });
  database.prepare("UPDATE agent_turns SET model_selection_json = @selection WHERE id = @id")
    .run({ id: retiredProfileTurn.id, selection: RETIRED_PROFILE_SELECTION });
  database.prepare(`
    INSERT INTO model_backend_defaults (scope, project_id, selection_json, updated_at)
    VALUES ('project', ?, ?, ?)
  `).run(project.id, RETIRED_PROFILE_SELECTION, PROFILE_TIMESTAMP);
  cloneRow(database, "provider_metadata_scoped_cache", "provider_id = 'codex'", {
    scope_key: "retired-profile-scope",
    provider_id: "claude",
    harness_id: "claude-agent-sdk",
    backend_profile_id: "custom:gemini-team",
  });
  database.prepare(`
    UPDATE conversations
    SET provider_session_id = 'gemini-session-left', continuation_identity_json = @continuation
    WHERE id = @id
  `).run({ id: switchedConversation.id, continuation: GEMINI_CONTINUATION });
  expect(database.pragma("foreign_key_check")).toEqual([]);
  expect(schemaVersion(database)).toBe(PREVIOUS_SCHEMA_VERSION);
  database.close();
  return {
    databasePath,
    workspacePath,
    geminiConversationId: geminiConversation.id,
    codexConversationId: codexConversation.id,
    geminiTurnId: turn.id,
    retiredProfileConversationId: retiredProfileConversation.id,
    retiredProfileTurnId: retiredProfileTurn.id,
    switchedConversationId: switchedConversation.id,
  };
}

describe("Antigravity replaces the Gemini CLI provider", { concurrent: false }, () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it("moves Gemini chats to Antigravity and removes every Gemini identity", async () => {
    const fixture = await geminiFixture();
    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = ON");
    const messages = database.prepare("SELECT * FROM messages ORDER BY id").all();
    const codexConversation = database.prepare("SELECT * FROM conversations WHERE id = ?")
      .get(fixture.codexConversationId);
    const beforeIndexes = schemaObjects(database, "index");
    const beforeTriggers = schemaObjects(database, "trigger");
    const beforeForeignKeys = foreignKeys(database);
    const beforeCounts = Object.fromEntries(["agent_turns", "subagent_traces", "diff_review_summaries", "messages"]
      .map((table) => [table, database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()]));
    expect(messages.length).toBeGreaterThan(0);

    migrateRuntimeDatabase(database, ANTIGRAVITY_SCHEMA_VERSION);

    expect(schemaVersion(database)).toBe(ANTIGRAVITY_SCHEMA_VERSION);
    const antigravitySelection = providerNativeModelSelection({ providerId: "antigravity" });
    const conversation = database.prepare(`
      SELECT provider_id, provider_session_id, model, reasoning_effort,
             model_selection_json, continuation_identity_json
      FROM conversations WHERE id = ?
    `).get(fixture.geminiConversationId) as Record<string, string | null>;
    expect(conversation).toMatchObject({
      provider_id: "antigravity",
      provider_session_id: null,
      model: "",
      reasoning_effort: "",
      continuation_identity_json: null,
    });
    expect(JSON.parse(conversation.model_selection_json!)).toEqual(antigravitySelection);
    const turn = database.prepare(`
      SELECT provider_id, harness_id, backend_profile_id, model, model_alias, reasoning_effort,
             provider_session_before, provider_session_after, model_selection_json,
             continuation_identity_json
      FROM agent_turns WHERE id = ?
    `).get(fixture.geminiTurnId) as Record<string, string | null>;
    expect(turn).toMatchObject({
      provider_id: "antigravity",
      harness_id: "antigravity-cli",
      backend_profile_id: "builtin:antigravity",
      model: "provider-default",
      model_alias: null,
      reasoning_effort: "",
      provider_session_before: null,
      provider_session_after: null,
      continuation_identity_json: null,
    });
    expect(JSON.parse(turn.model_selection_json!)).toEqual(antigravitySelection);
    expect(database.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(messages);
    expect(database.prepare("SELECT * FROM conversations WHERE id = ?").get(fixture.codexConversationId))
      .toEqual(codexConversation);
    expect(Object.fromEntries(Object.keys(beforeCounts)
      .map((table) => [table, database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()])))
      .toEqual(beforeCounts);
    expect(database.prepare("SELECT DISTINCT provider_id FROM subagent_traces").pluck().all())
      .toEqual(["antigravity"]);
    expect(database.prepare("SELECT DISTINCT provider_id FROM diff_review_summaries").pluck().all())
      .toEqual(["antigravity"]);
    expect(database.prepare("SELECT provider_id FROM provider_metadata_cache ORDER BY 1").pluck().all())
      .toEqual(["codex"]);
    expect(database.prepare("SELECT provider_id FROM provider_metadata_scoped_cache ORDER BY 1").pluck().all())
      .toEqual(["codex"]);
    expect(database.prepare("SELECT profile_id FROM model_backend_profiles ORDER BY 1").pluck().all())
      .toEqual(["custom:retained-anthropic"]);
    expect(JSON.parse(database.prepare("SELECT selection_json FROM model_backend_defaults").pluck().get() as string))
      .toEqual(antigravitySelection);
    expect(database.prepare(`
      SELECT default_provider, default_model, default_reasoning_effort, provider_identity_labels_json FROM app_state
    `).get()).toEqual({
      default_provider: "antigravity",
      default_model: "",
      default_reasoning_effort: "",
      provider_identity_labels_json: '{"codex":"Work Codex"}',
    });
    expect(database.prepare("SELECT DISTINCT source_harness_id FROM agent_managed_conversations").pluck().all())
      .toEqual(["antigravity-cli"]);
    for (const table of REBUILT_TABLES) {
      expect(tableSql(database, table)).not.toMatch(/gemini/iu);
    }
    expect(tableSql(database, "agent_turns")).toContain("'antigravity'");
    expect(tableSql(database, "model_backend_profiles")).toContain("'antigravity-managed'");
    expect(() => database.prepare("UPDATE subagent_traces SET provider_id = 'gemini'").run()).toThrow();
    expect(schemaObjects(database, "index")).toEqual(beforeIndexes);
    expect(schemaObjects(database, "trigger")).toEqual(beforeTriggers);
    expect(foreignKeys(database)).toEqual(beforeForeignKeys);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    database.close();

    const reopened = new RuntimeStore(fixture.databasePath, fixture.workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.databaseRecoveryReport().outcome).toBe("healthy");
    expect(reopened.agentTurn(fixture.geminiTurnId)).toMatchObject({
      providerId: "antigravity",
      harnessId: "antigravity-cli",
      providerSessionBefore: null,
      providerSessionAfter: null,
    });
    const migrated = reopened.snapshot().conversations.find(({ id }) => id === fixture.geminiConversationId);
    expect(migrated).toMatchObject({ providerId: "antigravity", providerSessionId: null });
    expect(migrated?.modelSelection).toEqual(antigravitySelection);
    expect(reopened.saveModelBackendProfile(nativeAntigravityProfile()).profile)
      .toEqual(nativeAntigravityProfile());
    reopened.close();
  });

  it("repoints every reference to a retired Gemini profile and still commits", async () => {
    const fixture = await geminiFixture();
    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = ON");
    expect(textReferences(database, "custom:gemini-team").sort()).toEqual([
      "agent_turns.backend_profile_id",
      "agent_turns.continuation_identity_json",
      "agent_turns.model_selection_json",
      "conversations.model_selection_json",
      "model_backend_defaults.selection_json",
      "model_backend_profiles.profile_id",
      "provider_metadata_scoped_cache.backend_profile_id",
    ]);
    const switchedBefore = database.prepare(`
      SELECT provider_id, model, model_selection_json FROM conversations WHERE id = ?
    `).get(fixture.switchedConversationId) as Record<string, string | null>;
    expect(switchedBefore.provider_id).toBe("codex");

    migrateRuntimeDatabase(database, ANTIGRAVITY_SCHEMA_VERSION);

    expect(schemaVersion(database)).toBe(ANTIGRAVITY_SCHEMA_VERSION);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(textReferences(database, "custom:gemini-team")).toEqual([]);
    const antigravitySelection = providerNativeModelSelection({ providerId: "antigravity" });
    const conversation = database.prepare(`
      SELECT provider_id, provider_session_id, continuation_identity_json, model_selection_json
      FROM conversations WHERE id = ?
    `).get(fixture.retiredProfileConversationId) as Record<string, string | null>;
    expect(conversation).toMatchObject({
      provider_id: "antigravity",
      provider_session_id: null,
      continuation_identity_json: null,
    });
    expect(JSON.parse(conversation.model_selection_json!)).toEqual(antigravitySelection);
    const turn = database.prepare(`
      SELECT provider_id, harness_id, backend_profile_id, provider_session_before,
             continuation_identity_json, model_selection_json
      FROM agent_turns WHERE id = ?
    `).get(fixture.retiredProfileTurnId) as Record<string, string | null>;
    expect(turn).toMatchObject({
      provider_id: "antigravity",
      harness_id: "antigravity-cli",
      backend_profile_id: "builtin:antigravity",
      provider_session_before: null,
      continuation_identity_json: null,
    });
    expect(JSON.parse(turn.model_selection_json!)).toEqual(antigravitySelection);
    expect((database.prepare("SELECT selection_json FROM model_backend_defaults ORDER BY scope")
      .pluck().all() as string[]).map((value) => JSON.parse(value)))
      .toEqual([antigravitySelection, antigravitySelection]);
    expect(database.prepare(`
      SELECT provider_id, model, model_selection_json, provider_session_id, continuation_identity_json
      FROM conversations WHERE id = ?
    `).get(fixture.switchedConversationId)).toEqual({
      ...switchedBefore,
      provider_session_id: null,
      continuation_identity_json: null,
    });
    expect(textReferences(database, "gemini-session")).toEqual([]);
    database.close();

    const reopened = new RuntimeStore(fixture.databasePath, fixture.workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.databaseRecoveryReport().outcome).toBe("healthy");
    expect(reopened.snapshot().conversations.find(({ id }) => id === fixture.retiredProfileConversationId))
      .toMatchObject({ providerId: "antigravity", providerSessionId: null });
    reopened.close();
  });

  it("rolls back completely when the upgraded database would violate a foreign key", async () => {
    const fixture = await geminiFixture();
    const database = new Database(fixture.databasePath);
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      UPDATE diff_review_summaries SET conversation_id = 'missing-conversation'
      WHERE conversation_id = ?
    `).run(fixture.geminiConversationId);
    database.pragma("foreign_keys = ON");
    const before = Object.fromEntries(REBUILT_TABLES.map((table) => [
      table,
      { sql: tableSql(database, table), rows: database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() },
    ]));
    const beforeConversations = database.prepare("SELECT * FROM conversations ORDER BY id").all();
    const beforeState = database.prepare("SELECT * FROM app_state").all();
    const beforeTriggers = schemaObjects(database, "trigger");

    expect(() => migrateRuntimeDatabase(database)).toThrow(DatabaseMigrationError);

    expect(schemaVersion(database)).toBe(PREVIOUS_SCHEMA_VERSION);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(Object.fromEntries(REBUILT_TABLES.map((table) => [
      table,
      { sql: tableSql(database, table), rows: database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() },
    ]))).toEqual(before);
    expect(database.prepare("SELECT * FROM conversations ORDER BY id").all()).toEqual(beforeConversations);
    expect(database.prepare("SELECT * FROM app_state").all()).toEqual(beforeState);
    expect(schemaObjects(database, "trigger")).toEqual(beforeTriggers);
    database.close();
  });

  it("upgrades a schema-75 database without Gemini records unchanged apart from its constraints", async () => {
    const directory = await temporaryDirectory();
    const database = new Database(join(directory, "plain.sqlite"));
    migrateRuntimeDatabase(database, PREVIOUS_SCHEMA_VERSION);
    const beforeIndexes = schemaObjects(database, "index");
    const beforeTriggers = schemaObjects(database, "trigger");
    migrateRuntimeDatabase(database, ANTIGRAVITY_SCHEMA_VERSION);
    expect(schemaVersion(database)).toBe(ANTIGRAVITY_SCHEMA_VERSION);
    expect(schemaObjects(database, "index")).toEqual(beforeIndexes);
    expect(schemaObjects(database, "trigger")).toEqual(beforeTriggers);
    for (const table of REBUILT_TABLES) {
      expect(tableSql(database, table)).not.toMatch(/gemini/iu);
      expect(tableSql(database, table)).toMatch(/antigravity/u);
    }
    database.close();
  });
});
