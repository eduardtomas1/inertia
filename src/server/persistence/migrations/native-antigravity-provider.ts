import type Database from "better-sqlite3";

import type { DatabaseMigrationDefinition } from "./catalog";

const REBUILT_TABLES = [
  "provider_metadata_cache",
  "diff_review_summaries",
  "provider_metadata_scoped_cache",
  "model_backend_profiles",
  "agent_turns",
  "subagent_traces",
] as const;

type RebuiltTable = (typeof REBUILT_TABLES)[number];

const CONSTRAINT_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/'gemini', 'kimi', 'opencode'\)/gu, "'kimi', 'opencode', 'antigravity')"],
  [/'gemini-acp', 'kimi-acp',/gu, "'kimi-acp', 'antigravity-cli',"],
  [/'gemini-managed', 'kimi-managed',/gu, "'kimi-managed', 'antigravity-managed',"],
];

const ANTIGRAVITY_SELECTION_JSON = JSON.stringify({
  harnessId: "antigravity-cli",
  backendProfileId: "builtin:antigravity",
  backendProfileDisplayName: "Google Antigravity",
  modelId: "provider-default",
  alias: null,
  reasoningEffort: null,
  contextWindowOverride: null,
  providerOptions: {},
  capabilities: [],
  backendConfigurationRevision: 0,
});

const GEMINI_HARNESS = "IFNULL(harness_id, '') LIKE 'gemini-%'";
const RETIRED_PROFILES = "(SELECT value FROM json_each(@profiles))";

function selectionField(column: string, field: string): string {
  return `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${field}') END`;
}

function geminiSelection(column: string): string {
  return `(IFNULL(${selectionField(column, "harnessId")}, '') LIKE 'gemini-%'`
    + ` OR IFNULL(${selectionField(column, "backendProfileId")}, '') IN ${RETIRED_PROFILES})`;
}

const RETIRED_PROFILE = `IFNULL(backend_profile_id, '') IN ${RETIRED_PROFILES}`;

const GEMINI_TURN = `(provider_id = 'gemini' OR ${GEMINI_HARNESS} OR ${RETIRED_PROFILE}`
  + ` OR ${geminiSelection("model_selection_json")} OR ${geminiSelection("continuation_identity_json")})`;

const GEMINI_CONVERSATION = `(provider_id = 'gemini' OR ${geminiSelection("model_selection_json")})`;

const GEMINI_SCOPE = `(provider_id = 'gemini' OR ${GEMINI_HARNESS} OR ${RETIRED_PROFILE})`;

const RETAINED_ROWS: Readonly<Record<RebuiltTable, string>> = {
  provider_metadata_cache: "provider_id <> 'gemini'",
  diff_review_summaries: "1",
  provider_metadata_scoped_cache: `NOT ${GEMINI_SCOPE}`,
  model_backend_profiles: `profile_id NOT IN ${RETIRED_PROFILES}`,
  agent_turns: "1",
  subagent_traces: "1",
};

const COLUMN_REWRITES: Readonly<Partial<Record<RebuiltTable, Readonly<Record<string, string>>>>> = {
  diff_review_summaries: {
    provider_id: "CASE WHEN provider_id = 'gemini' THEN 'antigravity' ELSE provider_id END",
  },
  subagent_traces: {
    provider_id: "CASE WHEN provider_id = 'gemini' THEN 'antigravity' ELSE provider_id END",
  },
  agent_turns: {
    provider_id: `CASE WHEN ${GEMINI_TURN} THEN 'antigravity' ELSE provider_id END`,
    harness_id: `CASE WHEN ${GEMINI_TURN} THEN 'antigravity-cli' ELSE harness_id END`,
    backend_profile_id: `CASE WHEN ${GEMINI_TURN} THEN 'builtin:antigravity' ELSE backend_profile_id END`,
    model: `CASE WHEN ${GEMINI_TURN} THEN 'provider-default' ELSE model END`,
    model_alias: `CASE WHEN ${GEMINI_TURN} THEN NULL ELSE model_alias END`,
    reasoning_effort: `CASE WHEN ${GEMINI_TURN} THEN '' ELSE reasoning_effort END`,
    provider_session_before: `CASE WHEN ${GEMINI_TURN} THEN NULL ELSE provider_session_before END`,
    provider_session_after: `CASE WHEN ${GEMINI_TURN} THEN NULL ELSE provider_session_after END`,
    model_selection_json: `CASE WHEN ${GEMINI_TURN} THEN @selection ELSE model_selection_json END`,
    continuation_identity_json: `CASE WHEN ${GEMINI_TURN} THEN NULL ELSE continuation_identity_json END`,
  },
};

const RECORD_UPDATES = [
  `UPDATE conversations
   SET provider_id = 'antigravity', provider_session_id = NULL,
       continuation_identity_json = NULL, model_selection_json = @selection,
       model = '', reasoning_effort = ''
   WHERE ${GEMINI_CONVERSATION}`,
  `UPDATE conversations SET provider_session_id = NULL, continuation_identity_json = NULL
   WHERE ${geminiSelection("continuation_identity_json")}`,
  `UPDATE model_backend_defaults SET selection_json = @selection
   WHERE ${geminiSelection("selection_json")}`,
  `UPDATE app_state
   SET default_provider = 'antigravity', default_model = '', default_reasoning_effort = ''
   WHERE default_provider = 'gemini'`,
  `UPDATE app_state
   SET provider_identity_labels_json = json_remove(provider_identity_labels_json, '$.gemini')
   WHERE json_valid(provider_identity_labels_json)
     AND json_type(provider_identity_labels_json, '$.gemini') IS NOT NULL`,
  `UPDATE agent_managed_conversations SET source_harness_id = 'antigravity-cli'
   WHERE source_harness_id LIKE 'gemini-%'`,
  `UPDATE agent_context_requests SET source_harness_id = 'antigravity-cli'
   WHERE source_harness_id LIKE 'gemini-%'`,
];

const REMAINING_GEMINI_RECORDS = `
  SELECT
    (SELECT COUNT(*) FROM conversations
      WHERE ${GEMINI_CONVERSATION} OR ${geminiSelection("continuation_identity_json")})
    + (SELECT COUNT(*) FROM agent_turns WHERE ${GEMINI_TURN})
    + (SELECT COUNT(*) FROM model_backend_profiles
      WHERE ${GEMINI_HARNESS} OR protocol = 'gemini-managed' OR profile_id IN ${RETIRED_PROFILES})
    + (SELECT COUNT(*) FROM provider_metadata_cache WHERE provider_id = 'gemini')
    + (SELECT COUNT(*) FROM provider_metadata_scoped_cache WHERE ${GEMINI_SCOPE})
    + (SELECT COUNT(*) FROM model_backend_defaults WHERE ${geminiSelection("selection_json")})
    + (SELECT COUNT(*) FROM app_state WHERE default_provider = 'gemini'
      OR (json_valid(provider_identity_labels_json)
        AND json_type(provider_identity_labels_json, '$.gemini') IS NOT NULL))
    + (SELECT COUNT(*) FROM agent_managed_conversations WHERE source_harness_id LIKE 'gemini-%')
    + (SELECT COUNT(*) FROM agent_context_requests WHERE source_harness_id LIKE 'gemini-%')
`;

interface SchemaRow {
  name: string;
  sql: string;
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function parameters(sql: string, profiles: string): Record<string, string> {
  return {
    ...(sql.includes("@selection") ? { selection: ANTIGRAVITY_SELECTION_JSON } : {}),
    ...(sql.includes("@profiles") ? { profiles } : {}),
  };
}

function retiredProfiles(database: Database.Database): string {
  const stored = database.prepare(`
    SELECT profile_id FROM model_backend_profiles
    WHERE ${GEMINI_HARNESS} OR protocol = 'gemini-managed'
  `).pluck().all() as string[];
  return JSON.stringify([...new Set(["builtin:gemini", ...stored])]);
}

function rebuiltTableSql(table: string, sql: string): string {
  const header = new RegExp(`^CREATE TABLE "?${table}"?\\s*\\(`, "u");
  if (!header.test(sql) || sql.includes("'antigravity") || !sql.includes("'gemini")) {
    throw new Error(`The ${table} schema has an unexpected shape.`);
  }
  let next = sql.replace(header, `CREATE TABLE ${quoted(`${table}_v76`)} (`);
  for (const [pattern, replacement] of CONSTRAINT_REWRITES) {
    next = next.replace(pattern, replacement);
  }
  if (next.includes("'gemini") || !next.includes("'antigravity")) {
    throw new Error(`The ${table} provider constraints were not found.`);
  }
  return next;
}

function tableSql(database: Database.Database, table: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`The ${table} table is missing.`);
  return row.sql;
}

function rebuildTable(database: Database.Database, table: RebuiltTable, profiles: string): void {
  const createSql = rebuiltTableSql(table, tableSql(database, table));
  const indexes = (database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
    .all(table) as { sql: string }[])
    .map(({ sql }) => sql);
  const columns = (database
    .prepare(`PRAGMA table_info(${quoted(table)})`)
    .all() as { name: string }[])
    .map(({ name }) => name);
  const rewrites = COLUMN_REWRITES[table] ?? {};
  const selected = columns.map((column) => rewrites[column] ?? quoted(column));
  database.exec(createSql);
  const copy = `
    INSERT INTO ${quoted(`${table}_v76`)} (${columns.map(quoted).join(", ")})
    SELECT ${selected.join(", ")} FROM ${quoted(table)} WHERE ${RETAINED_ROWS[table]}
  `;
  database.prepare(copy).run(parameters(copy, profiles));
  database.exec(`DROP TABLE ${quoted(table)}`);
  database.exec(`ALTER TABLE ${quoted(`${table}_v76`)} RENAME TO ${quoted(table)}`);
  for (const sql of indexes) database.exec(sql);
}

export const nativeAntigravityProviderMigration: DatabaseMigrationDefinition = {
  name: "SupportNativeAntigravityProvider",
  foreignKeys: "off",
  up: (database) => {
    const profiles = retiredProfiles(database);
    const dependentTriggers = (database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name")
      .all() as SchemaRow[])
      .filter(({ sql }) => REBUILT_TABLES.some((table) =>
        new RegExp(`\\b${table}\\b`, "u").test(sql)));
    for (const { name } of dependentTriggers) {
      database.exec(`DROP TRIGGER ${quoted(name)}`);
    }
    for (const table of REBUILT_TABLES) rebuildTable(database, table, profiles);
    for (const sql of RECORD_UPDATES) database.prepare(sql).run(parameters(sql, profiles));
    for (const { sql } of dependentTriggers) database.exec(sql);
    const remaining = database.prepare(REMAINING_GEMINI_RECORDS)
      .pluck().get(parameters(REMAINING_GEMINI_RECORDS, profiles)) as number;
    if (remaining !== 0) throw new Error("Gemini provider records remained after migration.");
  },
};
