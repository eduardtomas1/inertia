import { createHash } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

type SqliteDatabase = BetterSqlite3.Database;

const PUBLISHED_RELEASES_BY_SCHEMA: Readonly<Record<number, readonly string[]>> = {
  2: ["v0.0.1"],
  3: ["v0.0.2"],
  4: ["v0.0.3"],
  6: ["v0.0.4"],
  15: ["v0.0.5", "v0.0.6"],
};

const PROVIDERS = new Set(["codex", "claude", "cursor", "opencode"]);
const INTERACTION_MODES = new Set(["build", "plan"]);
const ACCESS_MODES = new Set(["supervised", "auto-edit", "full"]);
const TERMINAL_WORKSPACE_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export interface LegacyBackfillDiagnostics {
  readonly sourceSchemaVersion: number;
  readonly sourceReleases: readonly string[];
  readonly responseGroups: number;
  readonly turnsCreated: number;
  readonly inferredTurnsReused: number;
  readonly runIdsReused: number;
  readonly deterministicRunIdsCreated: number;
  readonly associated: {
    readonly messages: number;
    readonly activities: number;
    readonly reasonings: number;
    readonly plans: number;
    readonly usageSnapshots: number;
    readonly checkpoints: number;
  };
  readonly orphans: {
    readonly assistantMessages: number;
    readonly systemMessages: number;
    readonly activities: number;
    readonly reasonings: number;
    readonly plans: number;
    readonly usageSnapshots: number;
    readonly checkpoints: number;
  };
}

export interface DatabaseMigrationContext {
  readonly sourceSchemaVersion: number;
  readonly sourceReleases: readonly string[];
  setLegacyBackfillDiagnostics(diagnostics: LegacyBackfillDiagnostics): void;
}

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly up: string | ((database: SqliteDatabase, context: DatabaseMigrationContext) => void);
}

export interface DatabaseMigrationDiagnostic {
  readonly outcome: "succeeded" | "failed";
  readonly sourceSchemaVersion: number;
  readonly sourceReleases: readonly string[];
  readonly targetSchemaVersion: number;
  readonly appliedVersions: readonly number[];
  readonly failedVersion: number | null;
  readonly failedMigration: string | null;
  readonly errorCategory: string | null;
  readonly legacyBackfill: LegacyBackfillDiagnostics | null;
}

export class DatabaseMigrationError extends Error {
  readonly diagnostic: DatabaseMigrationDiagnostic;

  constructor(diagnostic: DatabaseMigrationDiagnostic, cause: unknown) {
    const step = diagnostic.failedVersion === null
      ? "migration validation"
      : `migration ${diagnostic.failedVersion} (${diagnostic.failedMigration ?? "unnamed"})`;
    super(
      `Database ${step} failed; all pending schema and data changes were rolled back`
      + (diagnostic.errorCategory ? ` (${diagnostic.errorCategory})` : "."),
      { cause },
    );
    this.name = "DatabaseMigrationError";
    this.diagnostic = diagnostic;
  }
}

export interface RunDatabaseMigrationsOptions {
  readonly now?: () => string;
  readonly onDiagnostic?: (diagnostic: DatabaseMigrationDiagnostic) => void;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | string;
  created_at: string;
  turn_id: string | null;
}

interface ActivityRow {
  id: string;
  conversation_id: string;
  run_id: string;
  status: string;
  created_at: string;
  turn_id: string | null;
}

interface ReasoningRow {
  id: string;
  conversation_id: string;
  run_id: string;
  status: string;
  created_at: string;
  turn_id: string | null;
}

interface CheckpointRow {
  id: string;
  conversation_id: string;
  turn_index: number;
  created_at: string;
  turn_id: string | null;
}

interface ConversationRow {
  id: string;
  provider_id: string;
  model: string;
  reasoning_effort: string;
  interaction_mode: string;
  access_mode: string;
  provider_session_id: string | null;
}

interface ExistingTurnRow {
  id: string;
  conversation_id: string;
  run_id: string;
  user_message_id: string;
  association: "authoritative" | "inferred" | string;
}

interface WorkspaceRunRow {
  id: string;
  conversation_id: string;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}

interface PlanRow {
  conversation_id: string;
  run_id: string;
  updated_at: string;
  turn_id: string | null;
}

interface UsageRow {
  conversation_id: string;
  updated_at: string;
  turn_id: string | null;
}

interface ResponseGroup {
  readonly conversationId: string;
  readonly ordinal: number;
  readonly user: MessageRow;
  readonly messages: readonly MessageRow[];
  readonly hasNextUser: boolean;
  readonly nextRequestedAt: number | null;
}

interface RunEvidence {
  readonly runId: string;
  readonly at: number;
  readonly strength: number;
}

function hasTable(database: SqliteDatabase, table: string): boolean {
  return database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function tableColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name),
  );
}

function schemaVersion(database: SqliteDatabase): number {
  if (!hasTable(database, "schema_migrations")) return 0;
  const row = database.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
  ).get() as { version: number };
  return row.version;
}

export function publishedReleasesForSchema(version: number): readonly string[] {
  return PUBLISHED_RELEASES_BY_SCHEMA[version] ?? [];
}

function safeErrorCategory(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (/^SQLITE_[A-Z0-9_]+$/u.test(code)) return code;
  }
  return "migration-step-failed";
}

function emitDiagnostic(
  callback: RunDatabaseMigrationsOptions["onDiagnostic"],
  diagnostic: DatabaseMigrationDiagnostic,
): void {
  try {
    callback?.(diagnostic);
  } catch {
    // Diagnostics are advisory and must never turn a committed migration into
    // a reported startup failure or hide the original migration exception.
  }
}

function validateMigrations(migrations: readonly DatabaseMigration[]): void {
  let previous = 0;
  const names = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    if (
      !Number.isSafeInteger(migration.version)
      || migration.version <= 0
      || (index > 0 && migration.version !== previous + 1)
    ) {
      throw new Error("Migration versions must be positive, unique, and contiguous.");
    }
    if (!migration.name || names.has(migration.name)) {
      throw new Error("Migration names must be non-empty and unique.");
    }
    previous = migration.version;
    names.add(migration.name);
  }
}

/**
 * Runs every pending migration, including the tracking-table creation, in one
 * SQLite transaction. A failure therefore restores the exact pre-run schema
 * and data state and can be retried safely.
 */
export function runDatabaseMigrations(
  database: SqliteDatabase,
  migrations: readonly DatabaseMigration[],
  options: RunDatabaseMigrationsOptions = {},
): DatabaseMigrationDiagnostic {
  const sourceSchemaVersion = schemaVersion(database);
  const sourceReleases = publishedReleasesForSchema(sourceSchemaVersion);
  const targetSchemaVersion = migrations.at(-1)?.version ?? sourceSchemaVersion;
  const appliedVersions: number[] = [];
  let failedVersion: number | null = null;
  let failedMigration: string | null = null;
  let legacyBackfill: LegacyBackfillDiagnostics | null = null;

  try {
    validateMigrations(migrations);
    const firstManagedVersion = migrations[0]?.version;
    if (
      firstManagedVersion !== undefined
      && sourceSchemaVersion < firstManagedVersion - 1
    ) {
      throw new Error("The database is older than the supplied migration baseline.");
    }
    database.transaction(() => {
      database.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations"
        + " (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const applied = new Set(
        (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
          .map(({ version }) => version),
      );
      const known = new Set(migrations.map(({ version }) => version));
      const firstManagedVersion = migrations[0]?.version ?? Number.POSITIVE_INFINITY;
      const unknownApplied = [...applied].filter(
        (version) => version >= firstManagedVersion && !known.has(version),
      );
      if (unknownApplied.length > 0) {
        throw new Error("The database contains an unknown migration version.");
      }

      const context: DatabaseMigrationContext = {
        sourceSchemaVersion,
        sourceReleases,
        setLegacyBackfillDiagnostics(diagnostics) {
          legacyBackfill = diagnostics;
        },
      };
      const insertApplied = database.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        failedVersion = migration.version;
        failedMigration = migration.name;
        if (typeof migration.up === "string") database.exec(migration.up);
        else migration.up(database, context);
        insertApplied.run(migration.version, options.now?.() ?? new Date().toISOString());
        appliedVersions.push(migration.version);
      }
    })();
  } catch (error) {
    const diagnostic: DatabaseMigrationDiagnostic = {
      outcome: "failed",
      sourceSchemaVersion,
      sourceReleases,
      targetSchemaVersion,
      appliedVersions: [],
      failedVersion,
      failedMigration,
      errorCategory: safeErrorCategory(error),
      legacyBackfill: null,
    };
    emitDiagnostic(options.onDiagnostic, diagnostic);
    throw new DatabaseMigrationError(diagnostic, error);
  }

  const diagnostic: DatabaseMigrationDiagnostic = {
    outcome: "succeeded",
    sourceSchemaVersion,
    sourceReleases,
    targetSchemaVersion,
    appliedVersions,
    failedVersion: null,
    failedMigration: null,
    errorCategory: null,
    legacyBackfill,
  };
  emitDiagnostic(options.onDiagnostic, diagnostic);
  return diagnostic;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function stableIdentifier(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  return `${prefix}-${hash}`;
}

function groupByConversation<T extends { conversation_id: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.conversation_id);
    if (existing) existing.push(row);
    else grouped.set(row.conversation_id, [row]);
  }
  return grouped;
}

function validRunId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null;
}

function buildResponseGroups(messages: readonly MessageRow[]): ResponseGroup[] {
  const groups: ResponseGroup[] = [];
  const byConversation = groupByConversation(messages);
  for (const [conversationId, conversationMessages] of byConversation) {
    let current: { user: MessageRow; messages: MessageRow[]; ordinal: number } | null = null;
    let ordinal = 0;
    for (const message of conversationMessages) {
      if (message.role === "user") {
        if (current) {
          groups.push({
            conversationId,
            ordinal: current.ordinal,
            user: current.user,
            messages: current.messages,
            hasNextUser: true,
            nextRequestedAt: parseTimestamp(message.created_at),
          });
        }
        ordinal += 1;
        current = { user: message, messages: [message], ordinal };
      } else if (current) {
        current.messages.push(message);
      }
    }
    if (current) {
      groups.push({
        conversationId,
        ordinal: current.ordinal,
        user: current.user,
        messages: current.messages,
        hasNextUser: false,
        nextRequestedAt: null,
      });
    }
  }
  return groups;
}

function isWithinGroup(
  at: number | null,
  requestedAt: number | null,
  nextRequestedAt: number | null,
  hasNextUser: boolean,
): boolean {
  if (at === null || requestedAt === null || at < requestedAt) return false;
  if (nextRequestedAt === null) return !hasNextUser;
  return at < nextRequestedAt;
}

function chooseRunId(
  group: ResponseGroup,
  requestedAt: number | null,
  activities: readonly ActivityRow[],
  reasonings: readonly ReasoningRow[],
  workspaceRuns: readonly WorkspaceRunRow[],
  plans: readonly PlanRow[],
  usedRunIds: ReadonlySet<string>,
): { runId: string; reused: boolean } {
  const evidence: RunEvidence[] = [];
  for (const activity of activities) {
    const at = parseTimestamp(activity.created_at);
    const runId = validRunId(activity.run_id);
    if (runId && isWithinGroup(at, requestedAt, group.nextRequestedAt, group.hasNextUser)) {
      evidence.push({ runId, at: at!, strength: 4 });
    }
  }
  for (const reasoning of reasonings) {
    const at = parseTimestamp(reasoning.created_at);
    const runId = validRunId(reasoning.run_id);
    if (runId && isWithinGroup(at, requestedAt, group.nextRequestedAt, group.hasNextUser)) {
      evidence.push({ runId, at: at!, strength: 4 });
    }
  }
  for (const workspaceRun of workspaceRuns) {
    const at = parseTimestamp(workspaceRun.started_at);
    const runId = validRunId(workspaceRun.id);
    if (
      workspaceRun.kind === "agent"
      && runId
      && isWithinGroup(at, requestedAt, group.nextRequestedAt, group.hasNextUser)
    ) {
      evidence.push({ runId, at: at!, strength: 3 });
    }
  }
  for (const plan of plans) {
    const at = parseTimestamp(plan.updated_at);
    const runId = validRunId(plan.run_id);
    if (runId && isWithinGroup(at, requestedAt, group.nextRequestedAt, group.hasNextUser)) {
      evidence.push({ runId, at: at!, strength: 2 });
    }
  }

  const scores = new Map<string, { score: number; count: number; firstAt: number }>();
  for (const item of evidence) {
    const current = scores.get(item.runId);
    scores.set(item.runId, {
      score: (current?.score ?? 0) + item.strength,
      count: (current?.count ?? 0) + 1,
      firstAt: Math.min(current?.firstAt ?? item.at, item.at),
    });
  }
  const candidate = [...scores]
    .filter(([runId]) => !usedRunIds.has(runId))
    .sort((left, right) =>
      right[1].score - left[1].score
      || right[1].count - left[1].count
      || left[1].firstAt - right[1].firstAt
      || left[0].localeCompare(right[0]))[0]?.[0];
  if (candidate) return { runId: candidate, reused: true };

  const base = stableIdentifier("legacy-run", group.user.id);
  if (!usedRunIds.has(base)) return { runId: base, reused: false };
  for (let suffix = 2; ; suffix += 1) {
    const runId = `${base}-${suffix}`;
    if (!usedRunIds.has(runId)) return { runId, reused: false };
  }
}

function normalizedConversation(conversation: ConversationRow): {
  providerId: string;
  model: string;
  reasoningEffort: string;
  interactionMode: string;
  accessMode: string;
} {
  const providerId = PROVIDERS.has(conversation.provider_id) ? conversation.provider_id : "codex";
  const model = conversation.model.trim().slice(0, 300) || "legacy-unknown";
  const reasoningEffort = conversation.reasoning_effort.trim().slice(0, 80);
  const interactionMode = INTERACTION_MODES.has(conversation.interaction_mode)
    ? conversation.interaction_mode
    : "build";
  const accessMode = ACCESS_MODES.has(conversation.access_mode)
    ? conversation.access_mode
    : "supervised";
  return {
    providerId,
    model,
    reasoningEffort,
    interactionMode,
    accessMode,
  };
}

function requireLegacyOwnershipSchema(database: SqliteDatabase): void {
  for (const table of [
    "messages",
    "activities",
    "agent_reasonings",
    "agent_plans",
    "thread_usage",
    "checkpoints",
  ]) {
    if (!hasTable(database, table) || !tableColumns(database, table).has("turn_id")) {
      throw new Error("Legacy turn ownership columns are unavailable.");
    }
  }
  if (!hasTable(database, "agent_turns")) {
    throw new Error("The agent turn ledger is unavailable.");
  }
}

/**
 * One-time recovery for databases created before explicit turn ownership.
 *
 * Timestamp windows are confined to this migration primitive. Exact run IDs
 * and checkpoint ordinals take precedence; records that cannot be associated
 * safely keep a null turn_id and remain visible to orphan recovery views.
 */
export function backfillLegacyAgentTurns(
  database: SqliteDatabase,
  options: { readonly sourceSchemaVersion: number },
): LegacyBackfillDiagnostics {
  if (!database.inTransaction) {
    return database.transaction(() => backfillLegacyAgentTurns(database, options))();
  }
  requireLegacyOwnershipSchema(database);

  const messages = database.prepare(
    "SELECT id, conversation_id, role, created_at, turn_id"
    + " FROM messages ORDER BY conversation_id, created_at, id",
  ).all() as MessageRow[];
  const activities = database.prepare(
    "SELECT id, conversation_id, run_id, status, created_at, turn_id"
    + " FROM activities ORDER BY conversation_id, created_at, id",
  ).all() as ActivityRow[];
  const reasonings = database.prepare(
    "SELECT id, conversation_id, run_id, status, created_at, turn_id"
    + " FROM agent_reasonings ORDER BY conversation_id, created_at, id",
  ).all() as ReasoningRow[];
  const checkpoints = database.prepare(
    "SELECT id, conversation_id, turn_index, created_at, turn_id"
    + " FROM checkpoints ORDER BY conversation_id, turn_index, created_at, id",
  ).all() as CheckpointRow[];
  const conversations = database.prepare(
    "SELECT id, provider_id, model, reasoning_effort, interaction_mode,"
    + " access_mode, provider_session_id FROM conversations ORDER BY id",
  ).all() as ConversationRow[];
  const existingTurns = database.prepare(
    "SELECT id, conversation_id, run_id, user_message_id, association"
    + " FROM agent_turns ORDER BY requested_at, id",
  ).all() as ExistingTurnRow[];
  const workspaceRuns = hasTable(database, "workspace_runs")
    ? database.prepare(
      "SELECT id, conversation_id, kind, status, started_at, finished_at"
      + " FROM workspace_runs WHERE conversation_id IS NOT NULL"
      + " ORDER BY conversation_id, started_at, id",
    ).all() as WorkspaceRunRow[]
    : [];
  const plans = hasTable(database, "agent_plans")
    ? database.prepare(
      "SELECT conversation_id, run_id, updated_at, turn_id FROM agent_plans"
      + " ORDER BY conversation_id, updated_at, run_id",
    ).all() as PlanRow[]
    : [];
  const usageRows = hasTable(database, "thread_usage")
    ? database.prepare(
      "SELECT conversation_id, updated_at, turn_id FROM thread_usage"
      + " ORDER BY conversation_id, updated_at",
    ).all() as UsageRow[]
    : [];

  const groups = buildResponseGroups(messages);
  const conversationById = new Map(conversations.map((row) => [row.id, row]));
  const turnByUserMessage = new Map(existingTurns.map((row) => [row.user_message_id, row]));
  const usedRunIds = new Set(existingTurns.map((row) => row.run_id));
  const activityByConversation = groupByConversation(activities);
  const reasoningByConversation = groupByConversation(reasonings);
  const checkpointByConversation = groupByConversation(checkpoints);
  const workspaceByConversation = groupByConversation(workspaceRuns);
  const planByConversation = groupByConversation(plans);
  const usageByConversation = groupByConversation(usageRows);
  const insertTurn = database.prepare(`
    INSERT INTO agent_turns (
      id, conversation_id, run_id, user_message_id, terminal_assistant_message_id,
      provider_id, harness_id, backend_profile_id, model, model_alias, reasoning_effort,
      interaction_mode, access_mode, provider_session_before, provider_session_after,
      requested_at, started_at, completed_at, status, terminal_reason, checkpoint_id,
      usage_start_json, usage_completion_json, configuration_revision, association,
      created_at, updated_at
    ) VALUES (
      @id, @conversationId, @runId, @userMessageId, @terminalAssistantMessageId,
      @providerId, @harnessId, @backendProfileId, @model, NULL, @reasoningEffort,
      @interactionMode, @accessMode, @providerSessionBefore, @providerSessionAfter,
      @requestedAt, @startedAt, @completedAt, @status, @terminalReason, @checkpointId,
      NULL, NULL, 0, 'inferred', @createdAt, @updatedAt
    )
  `);
  const assignMessage = database.prepare(
    "UPDATE messages SET turn_id = ? WHERE id = ? AND turn_id IS NULL",
  );
  const assignActivity = database.prepare(
    "UPDATE activities SET turn_id = ? WHERE id = ? AND turn_id IS NULL",
  );
  const assignReasoning = database.prepare(
    "UPDATE agent_reasonings SET turn_id = ? WHERE id = ? AND turn_id IS NULL",
  );
  const assignPlan = database.prepare(
    "UPDATE agent_plans SET turn_id = ?"
    + " WHERE conversation_id = ? AND run_id = ? AND turn_id IS NULL",
  );
  const assignUsage = database.prepare(
    "UPDATE thread_usage SET turn_id = ? WHERE conversation_id = ? AND turn_id IS NULL",
  );
  const assignCheckpoint = database.prepare(
    "UPDATE checkpoints SET turn_id = ? WHERE id = ? AND turn_id IS NULL",
  );

  let turnsCreated = 0;
  let inferredTurnsReused = 0;
  let runIdsReused = 0;
  let deterministicRunIdsCreated = 0;
  let associatedMessages = 0;
  let associatedActivities = 0;
  let associatedReasonings = 0;
  let associatedPlans = 0;
  let associatedUsageSnapshots = 0;
  let associatedCheckpoints = 0;
  let fallbackTimestampIndex = 0;

  for (const group of groups) {
    const existing = turnByUserMessage.get(group.user.id);
    if (existing) {
      if (existing.association === "inferred") inferredTurnsReused += 1;
      continue;
    }
    if (group.user.turn_id !== null) continue;
    const conversation = conversationById.get(group.conversationId);
    if (!conversation) continue;

    const requestedMillis = parseTimestamp(group.user.created_at);
    const requestFallback = Date.UTC(2000, 0, 1) + fallbackTimestampIndex;
    fallbackTimestampIndex += 1;
    const requestedAtMillis = requestedMillis ?? requestFallback;
    const conversationActivities = activityByConversation.get(group.conversationId) ?? [];
    const conversationReasonings = reasoningByConversation.get(group.conversationId) ?? [];
    const conversationCheckpoints = checkpointByConversation.get(group.conversationId) ?? [];
    const conversationWorkspaceRuns = workspaceByConversation.get(group.conversationId) ?? [];
    const conversationPlans = planByConversation.get(group.conversationId) ?? [];
    const conversationUsage = usageByConversation.get(group.conversationId) ?? [];
    const chosenRun = chooseRunId(
      group,
      requestedMillis,
      conversationActivities,
      conversationReasonings,
      conversationWorkspaceRuns,
      conversationPlans,
      usedRunIds,
    );
    usedRunIds.add(chosenRun.runId);
    if (chosenRun.reused) runIdsReused += 1;
    else deterministicRunIdsCreated += 1;

    const matchedActivities = conversationActivities.filter(
      (row) => row.turn_id === null && validRunId(row.run_id) === chosenRun.runId,
    );
    const matchedReasonings = conversationReasonings.filter(
      (row) => row.turn_id === null && validRunId(row.run_id) === chosenRun.runId,
    );
    const matchedPlans = conversationPlans.filter(
      (row) => row.turn_id === null && validRunId(row.run_id) === chosenRun.runId,
    );
    const matchedUsage = conversationUsage.filter(
      (row) =>
        row.turn_id === null
        && isWithinGroup(
          parseTimestamp(row.updated_at),
          requestedMillis,
          group.nextRequestedAt,
          group.hasNextUser,
        ),
    );
    const matchedCheckpoints = conversationCheckpoints.filter(
      (row) => row.turn_id === null && row.turn_index === group.ordinal,
    );
    const matchedWorkspaceRun = conversationWorkspaceRuns.find(
      (row) => row.kind === "agent" && validRunId(row.id) === chosenRun.runId,
    ) ?? null;
    const assistants = group.messages.filter(({ role }) => role === "assistant");
    const terminalAssistant = assistants.at(-1) ?? null;
    const eventTimes = [
      ...group.messages.map(({ created_at }) => parseTimestamp(created_at)),
      ...matchedActivities.map(({ created_at }) => parseTimestamp(created_at)),
      ...matchedReasonings.map(({ created_at }) => parseTimestamp(created_at)),
      ...matchedPlans.map(({ updated_at }) => parseTimestamp(updated_at)),
      ...matchedUsage.map(({ updated_at }) => parseTimestamp(updated_at)),
      ...matchedCheckpoints.map(({ created_at }) => parseTimestamp(created_at)),
      parseTimestamp(matchedWorkspaceRun?.started_at ?? null),
      parseTimestamp(matchedWorkspaceRun?.finished_at ?? null),
    ].filter((value): value is number => value !== null && value >= requestedAtMillis);
    const startedAtMillis = eventTimes.length > 0
      ? Math.max(requestedAtMillis, Math.min(...eventTimes))
      : requestedAtMillis;
    const completedAtMillis = Math.max(startedAtMillis, ...eventTimes);
    const hasFailure = matchedWorkspaceRun?.status === "failed"
      || matchedActivities.some(({ status }) => status === "failed")
      || matchedReasonings.some(({ status }) => status === "failed");
    const status = matchedWorkspaceRun?.status === "cancelled"
      ? "cancelled"
      : hasFailure
        ? "failed"
        : terminalAssistant
          || matchedCheckpoints.length > 0
          || matchedActivities.some(({ status }) => status === "completed")
          || matchedReasonings.some(({ status }) => status === "completed")
          || (matchedWorkspaceRun && TERMINAL_WORKSPACE_STATUSES.has(matchedWorkspaceRun.status))
          ? "completed"
          : "interrupted";
    const normalized = normalizedConversation(conversation);
    const turnId = stableIdentifier("legacy-turn", group.user.id);
    const requestedAt = isoTimestamp(requestedAtMillis);
    const startedAt = isoTimestamp(startedAtMillis);
    const completedAt = isoTimestamp(completedAtMillis);
    insertTurn.run({
      id: turnId,
      conversationId: group.conversationId,
      runId: chosenRun.runId,
      userMessageId: group.user.id,
      terminalAssistantMessageId: terminalAssistant?.id ?? null,
      providerId: normalized.providerId,
      harnessId: `legacy-${normalized.providerId}`,
      backendProfileId: `legacy-${normalized.providerId}`,
      model: normalized.model,
      reasoningEffort: normalized.reasoningEffort,
      interactionMode: normalized.interactionMode,
      accessMode: normalized.accessMode,
      // A conversation only retains its latest provider session. It is not
      // strong enough evidence to claim a historical per-turn boundary.
      providerSessionBefore: null,
      providerSessionAfter: null,
      requestedAt,
      startedAt,
      completedAt,
      status,
      terminalReason: `legacy-backfill-${status}`,
      checkpointId: matchedCheckpoints[0]?.id ?? null,
      createdAt: requestedAt,
      updatedAt: completedAt,
    });
    turnsCreated += 1;

    for (const message of group.messages) {
      associatedMessages += assignMessage.run(turnId, message.id).changes;
    }
    for (const activity of matchedActivities) {
      associatedActivities += assignActivity.run(turnId, activity.id).changes;
    }
    for (const reasoning of matchedReasonings) {
      associatedReasonings += assignReasoning.run(turnId, reasoning.id).changes;
    }
    for (const plan of matchedPlans) {
      associatedPlans += assignPlan.run(turnId, plan.conversation_id, plan.run_id).changes;
    }
    for (const usage of matchedUsage) {
      associatedUsageSnapshots += assignUsage.run(turnId, usage.conversation_id).changes;
    }
    for (const checkpoint of matchedCheckpoints) {
      associatedCheckpoints += assignCheckpoint.run(turnId, checkpoint.id).changes;
    }
  }

  const orphanRole = database.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE role = ? AND turn_id IS NULL",
  );
  const orphanCount = (table: string): number =>
    (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE turn_id IS NULL`).get() as {
      count: number;
    }).count;
  const diagnostics: LegacyBackfillDiagnostics = {
    sourceSchemaVersion: options.sourceSchemaVersion,
    sourceReleases: publishedReleasesForSchema(options.sourceSchemaVersion),
    responseGroups: groups.length,
    turnsCreated,
    inferredTurnsReused,
    runIdsReused,
    deterministicRunIdsCreated,
    associated: {
      messages: associatedMessages,
      activities: associatedActivities,
      reasonings: associatedReasonings,
      plans: associatedPlans,
      usageSnapshots: associatedUsageSnapshots,
      checkpoints: associatedCheckpoints,
    },
    orphans: {
      assistantMessages: (orphanRole.get("assistant") as { count: number }).count,
      systemMessages: (orphanRole.get("system") as { count: number }).count,
      activities: orphanCount("activities"),
      reasonings: orphanCount("agent_reasonings"),
      plans: orphanCount("agent_plans"),
      usageSnapshots: orphanCount("thread_usage"),
      checkpoints: orphanCount("checkpoints"),
    },
  };
  return diagnostics;
}

export function formatMigrationDiagnostic(diagnostic: DatabaseMigrationDiagnostic): string {
  const releases = diagnostic.sourceReleases.length > 0
    ? diagnostic.sourceReleases.join("/")
    : "unpublished-or-new";
  if (diagnostic.outcome === "failed") {
    return [
      "Database migration failed and rolled back",
      `source=${releases}`,
      `schema=${diagnostic.sourceSchemaVersion}`,
      `target=${diagnostic.targetSchemaVersion}`,
      `step=${diagnostic.failedVersion ?? "validation"}`,
      `category=${diagnostic.errorCategory ?? "unknown"}`,
    ].join(" ");
  }
  const backfill = diagnostic.legacyBackfill;
  return [
    "Database migration succeeded",
    `source=${releases}`,
    `schema=${diagnostic.sourceSchemaVersion}->${diagnostic.targetSchemaVersion}`,
    `applied=${diagnostic.appliedVersions.join(",") || "none"}`,
    ...(backfill
      ? [
        `inferredTurns=${backfill.turnsCreated}`,
        `orphanAssistant=${backfill.orphans.assistantMessages}`,
        `orphanSystem=${backfill.orphans.systemMessages}`,
        `orphanActivities=${backfill.orphans.activities}`,
        `orphanReasonings=${backfill.orphans.reasonings}`,
        `orphanPlans=${backfill.orphans.plans}`,
        `orphanUsage=${backfill.orphans.usageSnapshots}`,
        `orphanCheckpoints=${backfill.orphans.checkpoints}`,
      ]
      : []),
  ].join(" ");
}
