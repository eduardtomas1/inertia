import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  backfillLegacyAgentTurns,
  DatabaseMigrationError,
  formatMigrationDiagnostic,
  runDatabaseMigrations,
} from "../../src/server/database-migrations";
import { RuntimeStore } from "../../src/server/database";
import {
  CURRENT_DATABASE_SCHEMA_VERSION,
  LEGACY_SCHEMA_MIGRATION_COUNT,
  createRuntimeMigrationCatalog,
  type DatabaseMigrationDefinition,
} from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const fixtureDirectory = join(repositoryRoot, "tests", "fixtures", "database");
const temporaryDirectories: string[] = [];

interface FixtureManifest {
  format: number;
  fixtures: Array<{
    tag: string;
    commit: string;
    schemaVersion: number;
    file: string;
    bytes: number;
    sha256: string;
  }>;
}

async function temporaryDirectory(prefix = "inertia-migration-test-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fixtureManifest(): Promise<FixtureManifest> {
  return JSON.parse(
    await readFile(join(fixtureDirectory, "manifest.json"), "utf8"),
  ) as FixtureManifest;
}

function migrateFixtureInPlace(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    migrateRuntimeDatabase(database);
  } finally {
    database.close();
  }
}

function dropUnreleasedAgentThreadManagement(
  database: Database.Database,
): void {
  database.exec(`
    DROP TRIGGER IF EXISTS conversation_context_packets_discard_source_drafts;
    DROP TABLE IF EXISTS agent_context_requests;
    DROP TABLE IF EXISTS conversation_context_packets;
    DROP TABLE IF EXISTS agent_thread_operations;
    DROP TABLE IF EXISTS agent_managed_conversations;
    DELETE FROM schema_migrations WHERE version >= 60;
  `);
}

function dropUnreleasedProviderOwnership(database: Database.Database): void {
  dropUnreleasedAgentThreadManagement(database);
  database.exec(`
    DROP TABLE IF EXISTS provider_run_ownership;
    DROP INDEX IF EXISTS agent_turns_provider_run_identity_idx;
    DELETE FROM schema_migrations WHERE version = 55;
  `);
}

async function createLegacyBackfillDatabase(): Promise<{
  databasePath: string;
  workspacePath: string;
  conversationId: string;
}> {
  const directory = await temporaryDirectory();
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspacePath);
  const project = store.createProject("Sanitized migration project", workspacePath);
  const conversation = store.createConversation(project.id, "Sanitized migration conversation", {
    providerId: "codex",
    model: "",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
  });
  store.close();

  const database = new Database(databasePath);
  const at = (seconds: number): string =>
    `2025-02-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
  const insertMessage = database.prepare(`
    INSERT INTO messages (
      id, conversation_id, turn_id, role, content, attachments_json, created_at
    ) VALUES (?, ?, NULL, ?, ?, '[]', ?)
  `);
  insertMessage.run("legacy-orphan-assistant", conversation.id, "assistant", "Retained orphan response.", "0000-malformed");
  insertMessage.run("legacy-user-1", conversation.id, "user", "First retained request.", at(10));
  insertMessage.run("legacy-assistant-1a", conversation.id, "assistant", "First retained response.", at(20));
  insertMessage.run("legacy-system-1", conversation.id, "system", "Retained system note.", at(21));
  insertMessage.run("legacy-assistant-1b", conversation.id, "assistant", "First terminal response.", at(22));
  insertMessage.run("legacy-user-2", conversation.id, "user", "Second retained request.", at(30));
  insertMessage.run("legacy-assistant-2", conversation.id, "assistant", "Second terminal response.", at(40));

  const insertActivity = database.prepare(`
    INSERT INTO activities (
      id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at
    ) VALUES (?, ?, ?, NULL, 'status', ?, NULL, ?, ?)
  `);
  insertActivity.run("legacy-activity-orphan", conversation.id, "legacy-run-orphan", "Retained malformed activity", "completed", "not-a-time");
  insertActivity.run("legacy-activity-1a", conversation.id, "legacy-run-1", "First run starts", "running", at(12));
  insertActivity.run("legacy-activity-1b", conversation.id, "legacy-run-1", "First run completes", "completed", at(19));
  insertActivity.run("legacy-activity-competing", conversation.id, "legacy-run-unmatched", "Unmatched run", "completed", at(18));
  insertActivity.run("legacy-activity-2", conversation.id, "legacy-run-2", "Second run completes", "completed", at(35));

  const insertReasoning = database.prepare(`
    INSERT INTO agent_reasonings (
      id, conversation_id, run_id, turn_id, content, status, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?)
  `);
  insertReasoning.run("legacy-reasoning-orphan", conversation.id, "legacy-reasoning-orphan-run", "Retained malformed reasoning.", "completed", "invalid");
  insertReasoning.run("legacy-reasoning-1", conversation.id, "legacy-run-1", "First retained reasoning.", "completed", at(17));
  insertReasoning.run("legacy-reasoning-2", conversation.id, "legacy-run-2", "Second retained reasoning.", "completed", at(36));

  database.prepare(`
    INSERT INTO agent_plans (
      conversation_id, run_id, turn_id, explanation, steps_json, updated_at
    ) VALUES (?, 'legacy-run-2', NULL, 'Retained plan.', '[]', ?)
  `).run(conversation.id, at(34));
  database.prepare(`
    INSERT INTO thread_usage (
      conversation_id, turn_id, used_tokens, total_processed_tokens,
      total_processed_scope, max_tokens, input_tokens, cached_input_tokens,
      cache_write_input_tokens, output_tokens, reasoning_output_tokens,
      compacts_automatically, updated_at
    ) VALUES (?, NULL, 10, 20, 'thread', 200000, 8, 2, 0, 2, 1, 1, ?)
  `).run(conversation.id, at(37));

  const insertCheckpoint = database.prepare(`
    INSERT INTO checkpoints (
      id, conversation_id, turn_id, ref, label, turn_index,
      files_changed, insertions, deletions, created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, 0, 0, 0, ?)
  `);
  insertCheckpoint.run("legacy-checkpoint-1", conversation.id, "fixture-ref-1", "Before turn 1", 1, at(11));
  insertCheckpoint.run("legacy-checkpoint-2", conversation.id, "fixture-ref-2", "Before turn 2", 2, at(31));
  insertCheckpoint.run("legacy-checkpoint-orphan", conversation.id, "fixture-ref-orphan", "Unmatched checkpoint", 999, "invalid");

  const projectId = (database.prepare(
    "SELECT project_id FROM conversations WHERE id = ?",
  ).get(conversation.id) as { project_id: string }).project_id;
  const insertWorkspaceRun = database.prepare(`
    INSERT INTO workspace_runs (
      id, kind, project_id, conversation_id, action_id, label, detail,
      status, port, started_at, finished_at
    ) VALUES (?, 'agent', ?, ?, NULL, ?, NULL, 'succeeded', NULL, ?, ?)
  `);
  insertWorkspaceRun.run("legacy-run-1", projectId, conversation.id, "First retained run", at(11), at(22));
  insertWorkspaceRun.run("legacy-run-2", projectId, conversation.id, "Second retained run", at(31), at(40));
  database.close();
  return { databasePath, workspacePath, conversationId: conversation.id };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("published database fixtures", { timeout: 30_000 }, () => {
  it("pins all six released schemas to sanitized, byte-reproducible databases", async () => {
    const manifest = await fixtureManifest();
    expect(manifest.format).toBe(1);
    expect(manifest.fixtures.map(({ tag, schemaVersion }) => [tag, schemaVersion])).toEqual([
      ["v0.0.1", 2],
      ["v0.0.2", 3],
      ["v0.0.3", 4],
      ["v0.0.4", 6],
      ["v0.0.5", 15],
      ["v0.0.6", 15],
    ]);
    for (const fixture of manifest.fixtures) {
      const path = join(fixtureDirectory, fixture.file);
      expect(await sha256(path)).toBe(fixture.sha256);
      const database = new Database(path, { readonly: true });
      const migration = database.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number };
      const project = database.prepare("SELECT name, path FROM projects").get() as {
        name: string;
        path: string;
      };
      database.close();
      expect(migration.version).toBe(fixture.schemaVersion);
      expect(project.name).toBe(`Sanitized ${fixture.tag} project`);
      expect(project.path).toBe(`fixture://published-schema/${fixture.tag}`);
    }

    execFileSync(process.execPath, ["scripts/generate-database-fixtures.mjs", "--verify"], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
  }, 30_000);

  it("upgrades every released fixture through the inferred-turn migration without data loss", async () => {
    const manifest = await fixtureManifest();
    for (const fixture of manifest.fixtures) {
      const directory = await temporaryDirectory(`inertia-${fixture.tag}-`);
      const databasePath = join(directory, "published.sqlite");
      const workspacePath = join(directory, "workspace");
      await mkdir(workspacePath);
      await copyFile(join(fixtureDirectory, fixture.file), databasePath);
      const before = new Database(databasePath, { readonly: true });
      const messagesBefore = before.prepare(
        "SELECT id, role, content, created_at FROM messages ORDER BY id",
      ).all();
      before.close();

      const diagnostics: string[] = [];
      const log = vi.spyOn(console, "info").mockImplementation((value) => {
        diagnostics.push(String(value));
      });
      const store = new RuntimeStore(databasePath, workspacePath);
      const snapshot = store.snapshot();
      store.close();
      log.mockRestore();

      expect(snapshot.agentTurns).toHaveLength(2);
      expect(snapshot.agentTurns.every(({ association }) => association === "inferred")).toBe(true);
      expect(snapshot.agentTurns.map(({ runId }) => runId)).toEqual([
        `run-reused-1-${fixture.tag.replaceAll(".", "").replace("v", "")}`,
        `run-reused-2-${fixture.tag.replaceAll(".", "").replace("v", "")}`,
      ]);
      if (fixture.schemaVersion === 15) {
        expect(snapshot.reviewSummaries).toEqual([{
          conversationId: `fixture-conversation-${fixture.tag.replaceAll(".", "").replace("v", "")}`,
          fingerprint: "a".repeat(64),
          providerId: "codex",
          harnessId: null,
          backendProfileId: null,
          model: null,
          overall: "Sanitized review.",
          classifications: [],
          files: [],
          generatedAt: "2025-01-01T00:00:42.000Z",
        }]);
      }
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain(
        `schema=${fixture.schemaVersion}->${CURRENT_DATABASE_SCHEMA_VERSION}`,
      );
      expect(diagnostics[0]).toContain("inferredTurns=2");
      expect(diagnostics[0]).not.toMatch(/fixture:\/\/|request|response|token|secret/iu);

      let inspection = new Database(databasePath);
      expect(inspection.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all()).toEqual(Array.from(
        { length: CURRENT_DATABASE_SCHEMA_VERSION },
        (_, index) => ({ version: index + 1 }),
      ));
      expect(inspection.prepare(
        "SELECT id, role, content, created_at FROM messages ORDER BY id",
      ).all()).toEqual(messagesBefore);
      expect((inspection.prepare(
        "SELECT COUNT(*) AS count FROM agent_turns",
      ).get() as { count: number }).count).toBe(2);
      expect((inspection.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE role = 'user' AND turn_id IS NULL",
      ).get() as { count: number }).count).toBe(0);
      expect((inspection.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant' AND turn_id IS NULL",
      ).get() as { count: number }).count).toBe(1);
      expect((inspection.prepare(
        "SELECT COUNT(*) AS count FROM activities WHERE turn_id IS NULL",
      ).get() as { count: number }).count).toBe(2);
      expect((inspection.prepare(
        "SELECT COUNT(*) AS count FROM checkpoints WHERE turn_id IS NULL",
      ).get() as { count: number }).count).toBe(1);
      expect((inspection.prepare(
        "SELECT auto_open_plan AS autoOpenPlan FROM app_state WHERE id = 1",
      ).get() as { autoOpenPlan: number }).autoOpenPlan).toBe(0);
      expect((inspection.prepare(
        "SELECT auto_scroll_to_final_answer AS enabled FROM app_state WHERE id = 1",
      ).get() as { enabled: number }).enabled).toBe(1);
      expect(inspection.pragma("foreign_key_check")).toEqual([]);
      inspection.close();

      const reopened = new RuntimeStore(databasePath, workspacePath);
      expect(reopened.snapshot().agentTurns).toHaveLength(2);
      reopened.close();
      inspection = new Database(databasePath, { readonly: true });
      expect((inspection.prepare(
        "SELECT COUNT(*) AS count FROM agent_turns",
      ).get() as { count: number }).count).toBe(2);
      inspection.close();
    }
  }, 30_000);

  it("backfills pre-receipt conversation worktrees as explicitly external", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "worktree-ownership.sqlite");
    const workspacePath = join(directory, "workspace");
    const linkedPath = join(directory, "legacy-linked-worktree");
    await mkdir(workspacePath);
    await mkdir(linkedPath);
    const store = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Legacy worktree", workspacePath);
    const conversation = store.createConversation(
      project.id,
      "Legacy linked checkout",
      { branch: "legacy/topic", worktreePath: linkedPath },
    );
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE conversation_worktree_ownership");
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= 52").run();
    dropUnreleasedProviderOwnership(legacy);
    legacy.close();

    migrateFixtureInPlace(databasePath);
    const migrated = new Database(databasePath);
    migrated.pragma("foreign_keys = ON");
    expect(migrated.prepare(`
      SELECT conversation_id, path, branch, owns_worktree, creation_state,
        ownership_token, worktree_id, repository_identity,
        filesystem_identity_json, branch_head
      FROM conversation_worktree_ownership
    `).get()).toEqual({
      conversation_id: conversation.id,
      path: linkedPath,
      branch: "legacy/topic",
      owns_worktree: 0,
      creation_state: "external",
      ownership_token: null,
      worktree_id: null,
      repository_identity: null,
      filesystem_identity_json: null,
      branch_head: null,
    });
    expect((migrated.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'conversation_worktree_ownership_project_delete'
    `).get()).toEqual({
      name: "conversation_worktree_ownership_project_delete",
    });
    migrated.prepare(`
      UPDATE conversation_worktree_ownership
      SET owns_worktree = 1, creation_state = 'creating',
        ownership_token = ?
      WHERE conversation_id = ?
    `).run(randomUUID(), conversation.id);
    expect(() => migrated.prepare("DELETE FROM projects WHERE id = ?").run(
      project.id,
    )).toThrow(/isolated chat worktrees.*Delete each affected chat/isu);
    migrated.close();

    const reopened = new Database(databasePath);
    reopened.pragma("foreign_keys = ON");
    expect(reopened.prepare(`
      SELECT owns_worktree, creation_state
      FROM conversation_worktree_ownership
      WHERE conversation_id = ?
    `).get(conversation.id)).toEqual({
      owns_worktree: 1,
      creation_state: "creating",
    });
    reopened.prepare(`
      UPDATE conversation_worktree_ownership
      SET owns_worktree = 0, creation_state = 'external',
        ownership_token = NULL
      WHERE conversation_id = ?
    `).run(conversation.id);
    expect(reopened.prepare("DELETE FROM projects WHERE id = ?").run(
      project.id,
    ).changes).toBe(1);
    expect(reopened.prepare(
      "SELECT id FROM conversations WHERE id = ?",
    ).get(conversation.id)).toBeUndefined();
    expect(reopened.pragma("foreign_key_check")).toEqual([]);
    reopened.close();
  });

  it("backfills typed non-repository artifact absence for legacy persisted rows", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "artifact-absence.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath);
    const project = store.createProject("Legacy artifact", workspacePath);
    const conversation = store.createConversation(project.id, "Legacy absence");
    const turn = store.beginAgentTurn({
      id: "legacy-no-git-turn",
      conversationId: conversation.id,
      runId: "legacy-no-git-run",
      content: "Run outside Git",
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
    store.createTurnGitArtifact({
      turnId: turn.id,
      status: "unavailable",
      completeness: "unavailable",
      failureReason: "This workspace is not a Git repository.",
      absenceReason: null,
    });
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec("ALTER TABLE turn_git_artifacts DROP COLUMN absence_reason");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 27").run();
    dropUnreleasedProviderOwnership(legacy);
    legacy.close();
    migrateFixtureInPlace(databasePath);

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.turnGitArtifact(turn.id)).toMatchObject({
      status: "unavailable",
      completeness: "unavailable",
      failureReason: "This workspace is not a Git repository.",
      absenceReason: "not-repository",
    });
    migrated.close();
  });

  it("migrates v19 run attention without inventing successful-result views", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "attention-v19.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath);
    const project = store.createProject("Attention migration", workspacePath);
    const seenConversation = store.createConversation(project.id, "Seen result");
    const unseenConversation = store.createConversation(project.id, "Unseen result");
    store.close();

    const now = Date.now();
    const recentStartedAt = new Date(now - 60 * 60 * 1_000).toISOString();
    const recentFinishedAt = new Date(now - 59 * 60 * 1_000).toISOString();
    const beforeRecent = new Date(now - 2 * 60 * 60 * 1_000).toISOString();
    const afterRecent = new Date(now - 30 * 60 * 1_000).toISOString();
    const oldStartedAt = new Date(now - 4 * 24 * 60 * 60 * 1_000).toISOString();
    const oldFinishedAt = new Date(now - 4 * 24 * 60 * 60 * 1_000 + 60_000).toISOString();
    const database = new Database(databasePath);
    database.exec("DROP INDEX workspace_runs_attention_idx");
    database.exec("ALTER TABLE workspace_runs DROP COLUMN attention_state");
    database.prepare("DELETE FROM schema_migrations WHERE version >= 20").run();
    dropUnreleasedProviderOwnership(database);
    database.prepare("UPDATE conversations SET last_viewed_at = ? WHERE id = ?")
      .run(afterRecent, seenConversation.id);
    database.prepare("UPDATE conversations SET last_viewed_at = ? WHERE id = ?")
      .run(beforeRecent, unseenConversation.id);
    const insertRun = database.prepare(`
      INSERT INTO workspace_runs (
        id, kind, project_id, conversation_id, action_id, label, detail,
        status, port, started_at, finished_at
      ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?)
    `);
    insertRun.run(
      "seen-completion",
      "agent",
      project.id,
      seenConversation.id,
      "Seen completion",
      "succeeded",
      recentStartedAt,
      recentFinishedAt,
    );
    insertRun.run(
      "unseen-completion",
      "agent",
      project.id,
      unseenConversation.id,
      "Unseen completion",
      "succeeded",
      recentStartedAt,
      recentFinishedAt,
    );
    insertRun.run(
      "seen-failure",
      "check",
      project.id,
      seenConversation.id,
      "Seen failure",
      "failed",
      recentStartedAt,
      recentFinishedAt,
    );
    insertRun.run(
      "unseen-failure",
      "source-control",
      project.id,
      unseenConversation.id,
      "Unseen failure",
      "failed",
      recentStartedAt,
      recentFinishedAt,
    );
    insertRun.run(
      "historical-failure",
      "service",
      project.id,
      null,
      "Historical failure",
      "failed",
      oldStartedAt,
      oldFinishedAt,
    );
    insertRun.run(
      "waiting-request",
      "agent",
      project.id,
      seenConversation.id,
      "Waiting request",
      "waiting",
      recentStartedAt,
      null,
    );
    database.close();

    const migrated = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    const attentionById = Object.fromEntries(
      migrated.snapshot().runs.map(({ id, attentionState }) => [id, attentionState]),
    );
    expect(attentionById).toMatchObject({
      "seen-completion": "seen",
      "unseen-completion": "unseen",
      "seen-failure": "seen",
      "unseen-failure": "unseen",
      "historical-failure": "acknowledged",
      "waiting-request": "unseen",
    });
    migrated.close();

    const inspection = new Database(databasePath, { readonly: true });
    expect((inspection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("migrates the v20 legacy plan row without inventing turn ownership", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "plans-v20.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath);
    const project = store.createProject("Plan migration", workspacePath);
    const conversation = store.createConversation(project.id, "Legacy plan");
    store.close();

    const updatedAt = "2025-03-01T12:34:56.789Z";
    const stepsJson = '[{"step":"Preserve this exact plan","status":"pending"}]';
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE agent_plans_v20 (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        explanation TEXT,
        steps_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        turn_id TEXT REFERENCES agent_turns(id) ON DELETE SET NULL
      );
      INSERT INTO agent_plans_v20 (
        conversation_id, run_id, explanation, steps_json, updated_at, turn_id
      )
      SELECT '${conversation.id}', 'legacy-plan-run', 'Preserved explanation.',
        '${stepsJson}', '${updatedAt}', NULL;
      DROP TABLE agent_plans;
      ALTER TABLE agent_plans_v20 RENAME TO agent_plans;
      CREATE INDEX agent_plans_conversation_turn_idx
        ON agent_plans(conversation_id, turn_id);
      DELETE FROM schema_migrations WHERE version = 21;
    `);
    dropUnreleasedProviderOwnership(database);
    database.close();
    migrateFixtureInPlace(databasePath);

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.snapshot().plans).toContainEqual({
      conversationId: conversation.id,
      runId: "legacy-plan-run",
      turnId: null,
      explanation: "Preserved explanation.",
      steps: [{ step: "Preserve this exact plan", status: "pending" }],
    });
    expect(migrated.snapshot().agentTurns).toEqual([]);
    const userMessage = migrated.createMessage(conversation.id, "Create an indexed plan.");
    const turn = migrated.createAgentTurn({
      id: "indexed-plan-turn",
      conversationId: conversation.id,
      runId: "indexed-plan-run",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "plan",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    migrated.upsertAgentPlan({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      explanation: "Indexed plan.",
      steps: [],
    });
    migrated.close();

    const inspection = new Database(databasePath);
    expect(inspection.prepare(`
      SELECT conversation_id, run_id, turn_id, explanation, steps_json, updated_at
      FROM agent_plans
      WHERE run_id = 'legacy-plan-run'
    `).get()).toEqual({
      conversation_id: conversation.id,
      run_id: "legacy-plan-run",
      turn_id: null,
      explanation: "Preserved explanation.",
      steps_json: stepsJson,
      updated_at: updatedAt,
    });
    expect((inspection.pragma("table_info(agent_plans)") as Array<{
      name: string;
      pk: number;
    }>).filter(({ pk }) => pk > 0).map(({ name, pk }) => [name, pk])).toEqual([
      ["conversation_id", 1],
      ["run_id", 2],
    ]);
    expect((inspection.pragma("index_list(agent_plans)") as Array<{
      name: string;
      unique: number;
      partial: number;
    }>)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "agent_plans_turn_id_unique_idx",
        unique: 1,
        partial: 1,
      }),
      expect.objectContaining({
        name: "agent_plans_conversation_turn_idx",
        unique: 0,
      }),
    ]));
    expect((inspection.pragma("foreign_key_list(agent_plans)") as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "conversation_id",
        table: "conversations",
        on_delete: "CASCADE",
      }),
      expect.objectContaining({
        from: "turn_id",
        table: "agent_turns",
        on_delete: "SET NULL",
      }),
    ]));
    expect(() => inspection.prepare(`
      INSERT INTO agent_plans (
        conversation_id, run_id, turn_id, explanation, steps_json, updated_at
      ) VALUES (?, ?, ?, NULL, '[]', ?)
    `).run(
      conversation.id,
      "duplicate-indexed-plan-run",
      turn.id,
      "2025-03-01T12:34:57.000Z",
    )).toThrow(/unique/iu);
    expect((inspection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("upgrades v34 execution context without losing references and accepts attachments", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "execution-context-v34.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const context = (
      kind: "attachment" | "review-note",
      label: string,
      content: string,
    ) => {
      const digest = createHash("sha256").update(content).digest("hex");
      const reference = `sha256:${digest}`;
      const byteSize = Buffer.byteLength(content, "utf8");
      return {
        manifest: {
          version: 1 as const,
          visibleMessageBytes: 1,
          imageCount: 0,
          imageBytes: 0,
          contextReferenceCount: 1,
          uniqueContextBlobCount: 1,
          contextBytes: byteSize,
          internalInstructionCount: 0,
          internalInstructionBytes: 0,
          executionSegmentCount: 2,
          assembledPayloadBytes: byteSize + 1,
          references: [{
            kind,
            label,
            reference,
            byteSize,
            truncated: false,
          }],
        },
        blobs: [{
          reference,
          digest,
          byteSize,
          content,
        }],
      };
    };
    const turnInput = {
      providerId: "codex" as const,
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "gpt-test",
      reasoningEffort: "high" as const,
      interactionMode: "build" as const,
      accessMode: "supervised" as const,
      configurationRevision: 0,
      association: "authoritative" as const,
    };

    const store = new RuntimeStore(databasePath, workspacePath);
    const project = store.createProject("Execution context migration", workspacePath);
    const conversation = store.createConversation(project.id, "Preserved context");
    const legacyTurn = store.beginAgentTurn({
      ...turnInput,
      id: "v34-context-turn",
      conversationId: conversation.id,
      runId: "v34-context-run",
      content: "Preserve the existing review note.",
      executionContext: context(
        "review-note",
        "Review note · migration",
        "Preserved review context.",
      ),
    }).turn;
    store.close();

    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TRIGGER turn_execution_context_refs_prune_blob;
      CREATE TABLE turn_execution_context_refs_v34 (
        turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
        digest TEXT NOT NULL
          REFERENCES turn_execution_context_blobs(digest) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (
          kind IN ('file', 'diff', 'terminal', 'preview', 'review-note')
        ),
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 4096),
        byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
        truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
        PRIMARY KEY (turn_id, ordinal)
      );
      INSERT INTO turn_execution_context_refs_v34 (
        turn_id, ordinal, digest, kind, label, byte_size, truncated
      )
      SELECT turn_id, ordinal, digest, kind, label, byte_size, truncated
      FROM turn_execution_context_refs;
      DROP TABLE turn_execution_context_refs;
      ALTER TABLE turn_execution_context_refs_v34
        RENAME TO turn_execution_context_refs;
      CREATE INDEX turn_execution_context_refs_digest_idx
        ON turn_execution_context_refs(digest);
      CREATE TRIGGER turn_execution_context_refs_prune_blob
      AFTER DELETE ON turn_execution_context_refs
      BEGIN
        DELETE FROM turn_execution_context_blobs
        WHERE digest = OLD.digest
          AND NOT EXISTS (
            SELECT 1 FROM turn_execution_context_refs
            WHERE turn_execution_context_refs.digest = OLD.digest
          );
      END;
      DELETE FROM schema_migrations WHERE version = 35;
    `);
    dropUnreleasedProviderOwnership(legacy);
    legacy.close();
    migrateFixtureInPlace(databasePath);

    const migrated = new RuntimeStore(databasePath, workspacePath);
    expect(migrated.turnExecutionManifest(legacyTurn.id)?.references).toEqual([
      expect.objectContaining({
        kind: "review-note",
        label: "Review note · migration",
      }),
    ]);
    const attachmentTurn = migrated.beginAgentTurn({
      ...turnInput,
      id: "v35-attachment-turn",
      conversationId: conversation.id,
      runId: "v35-attachment-run",
      content: "Inspect the attached document.",
      executionContext: context(
        "attachment",
        "PDF · specification.pdf",
        "Verified document context.",
      ),
    }).turn;
    migrated.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.turnExecutionManifest(attachmentTurn.id)?.references).toEqual([
      expect.objectContaining({
        kind: "attachment",
        label: "PDF · specification.pdf",
      }),
    ]);
    reopened.close();

    const inspection = new Database(databasePath);
    expect((inspection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });

  it("upgrades v35 delegated traces without losing identities or hierarchy", async () => {
    const directory = await temporaryDirectory();
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const databasePath = join(directory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, workspacePath);
    const project = store.createProject("Subagent migration", workspacePath);
    const conversation = store.createConversation(
      project.id,
      "Preserved delegated traces",
    );
    const turn = store.beginAgentTurn({
      id: "v35-subagent-turn",
      conversationId: conversation.id,
      runId: "v35-subagent-run",
      content: "Preserve delegated identities.",
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
    const parent = store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      providerId: "codex",
      providerTaskId: null,
      providerAgentId: "v35-parent-agent",
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: "v35-parent-tool",
      providerRole: "coordinator",
      providerName: "Migration coordinator",
      status: "running",
      isLive: true,
      description: "Coordinate the upgrade.",
      progress: "Waiting for the child.",
      result: null,
      sequence: 1,
    })!.trace;
    const child = store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      providerId: "codex",
      providerTaskId: null,
      providerAgentId: "v35-child-agent",
      parentProviderAgentId: parent.providerAgentId,
      parentProviderToolUseId: null,
      providerToolUseId: "v35-child-tool",
      providerRole: "reviewer",
      providerName: "Migration reviewer",
      status: "completed",
      isLive: false,
      description: "Verify the upgrade.",
      progress: null,
      result: "Verified.",
      sequence: 2,
    })!.trace;
    store.close();

    const v35 = new Database(databasePath);
    v35.pragma("foreign_keys = OFF");
    v35.exec(`
      CREATE TABLE subagent_traces_v35 (
        id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
        turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL
          CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
        provider_task_id TEXT,
        provider_agent_id TEXT,
        parent_trace_id TEXT
          REFERENCES subagent_traces_v35(id) ON DELETE SET NULL,
        parent_provider_agent_id TEXT,
        parent_provider_tool_use_id TEXT,
        provider_tool_use_id TEXT,
        provider_role TEXT,
        provider_name TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'spawned', 'running', 'waiting', 'completed', 'failed',
          'cancelled', 'lost'
        )),
        description TEXT,
        progress TEXT,
        result TEXT,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO subagent_traces_v35 (
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role, provider_name, status,
        description, progress, result, sequence, created_at, updated_at
      )
      SELECT
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role, provider_name, status,
        description, progress, result, sequence, created_at, updated_at
      FROM subagent_traces;
      DROP TABLE subagent_traces;
      ALTER TABLE subagent_traces_v35 RENAME TO subagent_traces;
      CREATE INDEX subagent_traces_turn_order_idx
        ON subagent_traces(turn_id, created_at ASC, sequence ASC, id ASC);
      CREATE UNIQUE INDEX subagent_traces_task_identity_idx
        ON subagent_traces(conversation_id, run_id, provider_id, provider_task_id)
        WHERE provider_task_id IS NOT NULL;
      CREATE UNIQUE INDEX subagent_traces_agent_identity_idx
        ON subagent_traces(conversation_id, run_id, provider_id, provider_agent_id)
        WHERE provider_agent_id IS NOT NULL;
      CREATE INDEX subagent_traces_parent_idx
        ON subagent_traces(parent_trace_id, created_at ASC);
      CREATE INDEX subagents_conversation_created_idx
        ON subagent_traces(
          conversation_id,
          created_at ASC,
          sequence ASC,
          id ASC
        );
      DELETE FROM schema_migrations WHERE version >= 36;
    `);
    dropUnreleasedProviderOwnership(v35);
    v35.pragma("foreign_keys = ON");
    v35.close();

    const migrated = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(migrated.subagentTrace(parent.id)).toMatchObject({
      providerAgentId: "v35-parent-agent",
      providerStatus: null,
      status: "running",
      isLive: true,
    });
    expect(migrated.subagentTrace(child.id)).toMatchObject({
      parentTraceId: parent.id,
      providerStatus: null,
      status: "completed",
      isLive: false,
      result: "Verified.",
    });
    const updated = migrated.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: turn.runId,
      turnId: turn.id,
      providerId: "codex",
      providerTaskId: null,
      providerAgentId: "v35-parent-agent",
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: "v35-parent-tool",
      providerRole: null,
      providerName: null,
      providerStatus: "interrupted",
      status: "interrupted",
      isLive: false,
      description: null,
      progress: null,
      result: "Interrupted after migration.",
      sequence: 3,
    })!.trace;
    expect(updated).toMatchObject({
      providerStatus: "interrupted",
      status: "interrupted",
    });
    migrated.close();

    const inspection = new Database(databasePath);
    expect((inspection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(
      CURRENT_DATABASE_SCHEMA_VERSION,
    );
    expect(inspection.pragma("foreign_key_check")).toEqual([]);
    inspection.close();
  });
});

describe("atomic Duo schema migration", () => {
  it.each([
    "current",
    "v37-upgrade",
    "v38-upgrade",
    "v39-upgrade",
    "v40-upgrade",
    "v41-upgrade",
    "v45-upgrade",
  ] as const)(
    "installs active-launch deletion protection for a %s database",
    async (source) => {
      const directory = await temporaryDirectory("inertia-duo-migration-");
      const workspacePath = join(directory, "workspace");
      await mkdir(workspacePath);
      const databasePath = join(directory, "inertia.sqlite");
      const current = new RuntimeStore(databasePath, workspacePath, {
        recoverInterruptedRuns: false,
      });
      const retainedLaunchId = source === "v38-upgrade"
        || source === "v39-upgrade"
        || source === "v40-upgrade"
        || source === "v41-upgrade"
        || source === "v45-upgrade"
        ? randomUUID()
        : null;
      if (retainedLaunchId) {
        const project = current.createProject("Retained Duo", workspacePath);
        current.createPairedLaunch(retainedLaunchId, [0, 1].map((ordinal) => ({
          ordinal: ordinal as 0 | 1,
          projectId: project.id,
          plannedConversationId: randomUUID(),
          plannedWorktreePath: join(directory, `worktree-${ordinal}`),
          plannedBranch: `inertia/retained-${ordinal}`,
          ownsWorktree: true,
        })) as Parameters<RuntimeStore["createPairedLaunch"]>[1]);
      }
      current.close();

      if (source === "v37-upgrade") {
        const previous = new Database(databasePath);
        previous.exec(`
          DROP TRIGGER paired_launches_conversation_delete;
          DROP TRIGGER paired_launches_project_delete;
          DROP TABLE paired_launch_sides;
          DROP TABLE paired_launches;
        `);
        previous.prepare(
          "DELETE FROM schema_migrations WHERE version >= ?",
        ).run(38);
        dropUnreleasedProviderOwnership(previous);
        expect((previous.prepare(
          "SELECT MAX(version) AS version FROM schema_migrations",
        ).get() as { version: number }).version).toBe(
          37,
        );
        previous.close();
      } else if (source === "v38-upgrade") {
        const previous = new Database(databasePath);
        previous.exec(`
          DROP TRIGGER paired_launches_project_delete;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_observed_head;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_observed_branch;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_observed_path;
          ALTER TABLE paired_launch_sides DROP COLUMN worktree_cleanup_topology;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_repository_identity;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_worktree_id;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_worktree_token;
          ALTER TABLE paired_launch_sides DROP COLUMN branch_cleanup_outcome;
          ALTER TABLE paired_launch_sides DROP COLUMN worktree_cleanup_outcome;
          ALTER TABLE paired_launch_sides DROP COLUMN worktree_removal_confirmed;
          ALTER TABLE paired_launch_sides DROP COLUMN worktree_removal_started;
          ALTER TABLE paired_launch_sides DROP COLUMN worktree_creation_state;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_branch_head;
        `);
        previous.prepare(
          "DELETE FROM schema_migrations WHERE version >= ?",
        ).run(39);
        dropUnreleasedProviderOwnership(previous);
        previous.close();
      } else if (source === "v39-upgrade") {
        const previous = new Database(databasePath);
        previous.exec(`
          UPDATE paired_launch_sides
          SET worktree_creation_state = 'created',
            cleanup_branch_head = '${"a".repeat(40)}'
          WHERE owns_worktree = 1;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_observed_head;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_observed_branch;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_observed_path;
          ALTER TABLE paired_launch_sides DROP COLUMN worktree_cleanup_topology;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_repository_identity;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_worktree_id;
          ALTER TABLE paired_launch_sides DROP COLUMN cleanup_worktree_token;
        `);
        previous.prepare(
          "DELETE FROM schema_migrations WHERE version >= ?",
        ).run(40);
        dropUnreleasedProviderOwnership(previous);
        previous.close();
      } else if (source === "v40-upgrade") {
        const previous = new Database(databasePath);
        previous.exec(`
          ALTER TABLE paired_launch_sides
            DROP COLUMN cleanup_filesystem_identity_json;
        `);
        previous.prepare(
          "DELETE FROM schema_migrations WHERE version >= ?",
        ).run(41);
        dropUnreleasedProviderOwnership(previous);
        previous.close();
      } else if (source === "v41-upgrade") {
        const previous = new Database(databasePath);
        previous.exec(`
          DROP TABLE recovery_import_journals;
          DROP TABLE recovery_import_receipts;
          DROP TABLE message_content_chunks;
          DROP TABLE reasoning_content_chunks;
          DELETE FROM schema_migrations WHERE version >= 42;
        `);
        dropUnreleasedProviderOwnership(previous);
        previous.close();
      } else if (source === "v45-upgrade") {
        const previous = new Database(databasePath);
        previous.exec(`
          DROP TRIGGER paired_launches_conversation_delete;
          DROP TRIGGER paired_launches_project_delete;
          ALTER TABLE paired_launches DROP COLUMN comparison_failure_message;
          ALTER TABLE paired_launches DROP COLUMN comparison_attempt;
          ALTER TABLE paired_launches DROP COLUMN comparison_turn_id;
          ALTER TABLE paired_launches DROP COLUMN comparison_conversation_id;
          ALTER TABLE paired_launches DROP COLUMN comparison_planned_conversation_id;
          ALTER TABLE paired_launches DROP COLUMN comparison_state;
          DELETE FROM schema_migrations WHERE version >= 46;
        `);
        dropUnreleasedProviderOwnership(previous);
        previous.close();
      }

      const migrated = new RuntimeStore(databasePath, workspacePath, {
        recoverInterruptedRuns: false,
      });
      if (retainedLaunchId) {
        const expectedCreationState = source === "v39-upgrade"
          ? "created"
          : "pending";
        const expectedHead = source === "v39-upgrade" ? "a".repeat(40) : null;
        expect(migrated.pairedLaunch(retainedLaunchId).plans).toEqual([
          expect.objectContaining({
            cleanupBranchHead: expectedHead,
            worktreeCreationState: expectedCreationState,
            worktreeRemovalStarted: false,
            worktreeRemovalConfirmed: false,
            worktreeCleanupOutcome: null,
            branchCleanupOutcome: null,
            cleanupWorktreeToken: null,
            cleanupWorktreeId: null,
            cleanupFilesystemReceipt: null,
            cleanupRepositoryIdentity: null,
            worktreeCleanupTopology: null,
            cleanupObservedPath: null,
            cleanupObservedBranch: null,
            cleanupObservedHead: null,
          }),
          expect.objectContaining({
            cleanupBranchHead: expectedHead,
            worktreeCreationState: expectedCreationState,
            worktreeRemovalStarted: false,
            worktreeRemovalConfirmed: false,
            worktreeCleanupOutcome: null,
            branchCleanupOutcome: null,
            cleanupWorktreeToken: null,
            cleanupWorktreeId: null,
            cleanupRepositoryIdentity: null,
            worktreeCleanupTopology: null,
            cleanupObservedPath: null,
            cleanupObservedBranch: null,
            cleanupObservedHead: null,
          }),
        ]);
        if (source === "v39-upgrade") {
          expect(() => migrated.removeProject(
            migrated.pairedLaunch(retainedLaunchId).plans[0].projectId,
          )).toThrow(/Cancel the active Duo launch/u);
        }
      }
      migrated.close();
      const inspection = new Database(databasePath, { readonly: true });
      expect((inspection.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN ('paired_launches', 'paired_launch_sides')
      `).get() as { count: number }).count).toBe(2);
      const triggers = inspection.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'paired_launches_conversation_delete',
          'paired_launches_project_delete'
        )
        ORDER BY name
      `).all() as Array<{ name: string; sql: string }>;
      expect(triggers.map(({ name }) => name)).toEqual([
        "paired_launches_conversation_delete",
        "paired_launches_project_delete",
      ]);
      for (const trigger of triggers) {
        expect(trigger.sql).toMatch(/Cancel the active Duo launch/u);
        expect(trigger.sql).toMatch(/locked comparison/u);
        expect(trigger.sql).toMatch(/comparison_state/u);
        expect(trigger.sql).toMatch(
          /status\s*=\s*'running'\s+AND\s+launch\.cancel_requested\s*=\s*1/u,
        );
        expect(trigger.sql).toMatch(/recovery-required/u);
        expect(trigger.sql).toMatch(/interrupted/u);
        expect(trigger.sql).toMatch(/live_turn\.status NOT IN/u);
        expect(trigger.sql).toMatch(/DELETE FROM paired_launches/u);
      }
      expect((inspection.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number }).version).toBe(
        CURRENT_DATABASE_SCHEMA_VERSION,
      );
      expect((inspection.prepare(
        "PRAGMA table_info(paired_launch_sides)",
      ).all() as Array<{ dflt_value: string | null; name: string }>).filter(
        ({ name }) => name === "cleanup_branch_head"
          || name === "worktree_creation_state"
          || name === "worktree_removal_started"
          || name === "worktree_removal_confirmed"
          || name === "worktree_cleanup_outcome"
          || name === "branch_cleanup_outcome"
          || name === "cleanup_worktree_token"
          || name === "cleanup_worktree_id"
          || name === "cleanup_repository_identity"
          || name === "cleanup_filesystem_identity_json"
          || name === "worktree_cleanup_topology"
          || name === "cleanup_observed_path"
          || name === "cleanup_observed_branch"
          || name === "cleanup_observed_head",
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "cleanup_branch_head",
          dflt_value: null,
        }),
        expect.objectContaining({
          name: "worktree_creation_state",
          dflt_value: "'pending'",
        }),
        expect.objectContaining({
          name: "worktree_removal_confirmed",
          dflt_value: "0",
        }),
        expect.objectContaining({
          name: "worktree_removal_started",
          dflt_value: "0",
        }),
        expect.objectContaining({
          name: "worktree_cleanup_outcome",
          dflt_value: null,
        }),
        expect.objectContaining({
          name: "branch_cleanup_outcome",
          dflt_value: null,
        }),
        expect.objectContaining({ name: "cleanup_worktree_token", dflt_value: null }),
        expect.objectContaining({ name: "cleanup_worktree_id", dflt_value: null }),
        expect.objectContaining({ name: "cleanup_repository_identity", dflt_value: null }),
        expect.objectContaining({ name: "cleanup_filesystem_identity_json", dflt_value: null }),
        expect.objectContaining({ name: "worktree_cleanup_topology", dflt_value: null }),
        expect.objectContaining({ name: "cleanup_observed_path", dflt_value: null }),
        expect.objectContaining({ name: "cleanup_observed_branch", dflt_value: null }),
        expect.objectContaining({ name: "cleanup_observed_head", dflt_value: null }),
      ]));
      expect((inspection.prepare(
        "PRAGMA table_info(paired_launches)",
      ).all() as Array<{ dflt_value: string | null; name: string }>).filter(
        ({ name }) => name.startsWith("comparison_"),
      )).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "comparison_state", dflt_value: null }),
        expect.objectContaining({
          name: "comparison_planned_conversation_id",
          dflt_value: null,
        }),
        expect.objectContaining({
          name: "comparison_conversation_id",
          dflt_value: null,
        }),
        expect.objectContaining({ name: "comparison_turn_id", dflt_value: null }),
        expect.objectContaining({ name: "comparison_attempt", dflt_value: "0" }),
        expect.objectContaining({
          name: "comparison_failure_message",
          dflt_value: null,
        }),
      ]));
      expect(inspection.pragma("foreign_key_check")).toEqual([]);
      inspection.close();
    },
  );
});

describe("transactional database migrations", () => {
  it("rolls back the tracking table and every earlier step when a later step fails", () => {
    const database = new Database(":memory:");
    let emitted = "";
    expect(() => runDatabaseMigrations(database, [
      {
        version: 1,
        name: "CreateFixture",
        up: "CREATE TABLE fixture_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);"
          + " INSERT INTO fixture_records (id, value) VALUES (1, 'retained');",
      },
      {
        version: 2,
        name: "FailFixture",
        up: "INSERT INTO missing_fixture_table (id) VALUES (1);",
      },
    ], {
      onDiagnostic(diagnostic) {
        emitted = formatMigrationDiagnostic(diagnostic);
      },
    })).toThrow(DatabaseMigrationError);
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all()).toEqual([]);
    expect(emitted).toMatch(
      /^Database migration failed and rolled back source=unpublished-or-new schema=0 target=2 step=2 category=SQLITE_ERROR$/u,
    );
    expect(emitted).not.toMatch(/missing_fixture_table|retained/iu);
    database.close();
  });

  it("preserves a published fixture byte-for-byte on failure and succeeds on retry", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "published.sqlite");
    await copyFile(join(fixtureDirectory, "v0.0.1.sqlite"), databasePath);
    const originalHash = await sha256(databasePath);

    let database = new Database(databasePath);
    expect(() => runDatabaseMigrations(database, [
      {
        version: 3,
        name: "FixtureAdditiveStep",
        up: "CREATE TABLE fixture_addition (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);"
          + " INSERT INTO fixture_addition VALUES (1, 'synthetic');",
      },
      {
        version: 4,
        name: "FixtureFailure",
        up: "INSERT INTO absent_table VALUES (1);",
      },
    ])).toThrow(DatabaseMigrationError);
    database.close();
    expect(await sha256(databasePath)).toBe(originalHash);

    database = new Database(databasePath);
    const first = runDatabaseMigrations(database, [
      {
        version: 3,
        name: "FixtureAdditiveStep",
        up: "CREATE TABLE fixture_addition (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);"
          + " INSERT INTO fixture_addition VALUES (1, 'synthetic');",
      },
      {
        version: 4,
        name: "FixtureRecovery",
        up: "CREATE INDEX fixture_addition_marker_idx ON fixture_addition(marker);",
      },
    ], { now: () => "2025-01-01T00:00:00.000Z" });
    expect(first.appliedVersions).toEqual([3, 4]);
    const retry = runDatabaseMigrations(database, [
      {
        version: 3,
        name: "FixtureAdditiveStep",
        up: "CREATE TABLE fixture_addition (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);"
          + " INSERT INTO fixture_addition VALUES (1, 'synthetic');",
      },
      {
        version: 4,
        name: "FixtureRecovery",
        up: "CREATE INDEX fixture_addition_marker_idx ON fixture_addition(marker);",
      },
    ]);
    expect(retry.appliedVersions).toEqual([]);
    expect((database.prepare("SELECT COUNT(*) AS count FROM fixture_addition").get() as {
      count: number;
    }).count).toBe(1);
    database.close();
  });
});

describe("runtime migration catalog", () => {
  it("pins released numbering in one immutable, contiguous catalog", () => {
    const definition = (name: string): DatabaseMigrationDefinition => ({
      name,
      up: "SELECT 1;",
    });
    const legacy = Array.from(
      { length: LEGACY_SCHEMA_MIGRATION_COUNT },
      (_, index) => definition(`legacy-${index + 1}`),
    );
    const extensions = Array.from(
      {
        length: CURRENT_DATABASE_SCHEMA_VERSION
          - LEGACY_SCHEMA_MIGRATION_COUNT,
      },
      (_, index) => definition(`extension-${index + 1}`),
    );

    const catalog = createRuntimeMigrationCatalog(legacy, extensions);

    expect(catalog.map(({ version }) => version)).toEqual(
      Array.from(
        { length: CURRENT_DATABASE_SCHEMA_VERSION },
        (_, index) => index + 1,
      ),
    );
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.every(Object.isFrozen)).toBe(true);
    expect(() => createRuntimeMigrationCatalog(legacy.slice(1), extensions))
      .toThrow(/legacy schema catalog/iu);
    expect(() => createRuntimeMigrationCatalog(legacy, extensions.slice(1)))
      .toThrow(/runtime schema catalog/iu);
  });

  it("upgrades schema 63 turn rows into coherent authoritative run states", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "schema-63-run-state.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Run-state migration", workspacePath);
    const createTurn = (title: string, id: string) => {
      const conversation = store.createConversation(project.id, title, {
        providerId: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
      });
      return store.beginAgentTurn({
        id,
        conversationId: conversation.id,
        runId: `run-${id}`,
        content: title,
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
    };
    const running = createTurn("Running before migration", "legacy-running-turn");
    store.updateAgentTurnLifecycle(running.id, { status: "starting" });
    store.updateAgentTurnLifecycle(running.id, { status: "running" });
    const completed = createTurn("Completed before migration", "legacy-completed-turn");
    store.updateAgentTurnLifecycle(completed.id, { status: "completed" });
    store.close();

    const schema63 = new Database(databasePath);
    schema63.exec(`
      DROP INDEX agent_turns_run_state_requested_idx;
      ALTER TABLE agent_turns DROP COLUMN run_state;
      ALTER TABLE agent_turns DROP COLUMN provider_state;
      ALTER TABLE agent_turns DROP COLUMN run_state_revision;
      DELETE FROM schema_migrations WHERE version >= 64;
    `);
    expect((schema63.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(63);
    migrateRuntimeDatabase(schema63);
    expect(schema63.prepare(`
      SELECT status, run_state, provider_state, run_state_revision
      FROM agent_turns WHERE id = ?
    `).get(running.id)).toEqual({
      status: "running",
      run_state: "running",
      provider_state: null,
      run_state_revision: 0,
    });
    expect(schema63.prepare(`
      SELECT status, run_state FROM agent_turns WHERE id = ?
    `).get(completed.id)).toEqual({ status: "completed", run_state: "completed" });
    expect(schema63.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
    schema63.close();

    const migrated = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(migrated.agentTurn(running.id).runState).toEqual({
      state: "running",
      providerState: null,
      revision: 0,
    });
    expect(migrated.agentTurn(completed.id).runState?.state).toBe("completed");
    migrated.close();
  });

  it("invalidates only pre-tool Codex sessions while preserving conversations", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "schema-59-codex-tools.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Tool registration", workspacePath);
    const codex = store.createConversation(project.id, "Legacy Codex chat", {
      providerId: "codex",
    });
    const claude = store.createConversation(project.id, "Existing Claude chat", {
      providerId: "claude",
    });
    store.createMessage(codex.id, "Keep this exact visible request.");
    store.createMessage(codex.id, "Keep this exact visible answer.", "assistant");
    store.updateConversation(codex.id, {
      providerSessionId: "legacy-codex-thread",
    });
    store.updateConversation(claude.id, {
      providerSessionId: "existing-claude-session",
    });
    store.upsertAgentGoal({
      conversationId: codex.id,
      source: "codex-native",
      providerSessionId: "legacy-codex-thread",
      objective: "Legacy provider-owned goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 5,
      createdAt: "2026-08-19T10:00:00.000Z",
      updatedAt: "2026-08-19T10:01:00.000Z",
      synchronizedAt: "2026-08-19T10:01:00.000Z",
    });
    store.close();

    const schema59 = new Database(databasePath);
    dropUnreleasedAgentThreadManagement(schema59);
    expect((schema59.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(59);
    expect(schema59.prepare(`
      SELECT provider_session_id FROM conversations WHERE id = ?
    `).get(codex.id)).toEqual({ provider_session_id: "legacy-codex-thread" });
    schema59.close();

    migrateFixtureInPlace(databasePath);
    migrateFixtureInPlace(databasePath);

    const migrated = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(migrated.conversation(codex.id)).toMatchObject({
      id: codex.id,
      title: "Legacy Codex chat",
      providerSessionId: null,
      continuationIdentity: null,
    });
    const retainedMessages = migrated.conversationDetail(codex.id)!.messages
      .map(({ role, content }) => ({
        role,
        content,
      }));
    expect(retainedMessages).toHaveLength(2);
    expect(retainedMessages).toEqual(expect.arrayContaining([
      { role: "user", content: "Keep this exact visible request." },
      { role: "assistant", content: "Keep this exact visible answer." },
    ]));
    expect(migrated.agentGoals(codex.id)).toEqual([]);
    expect(migrated.conversation(claude.id)).toMatchObject({
      providerSessionId: "existing-claude-session",
      continuationIdentity: expect.any(Object),
    });
    migrated.close();
  });

  it("refreshes the Codex Browser capability epoch without resetting other providers", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "schema-64-browser-tools.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Browser capability", workspacePath);
    const codex = store.createConversation(project.id, "Existing Codex chat", {
      providerId: "codex",
    });
    const resumableProviders = ["claude", "opencode", "cursor", "kimi"] as const;
    const resumableConversations = resumableProviders.map((providerId) =>
      store.createConversation(project.id, `Existing ${providerId} chat`, {
        providerId,
      }));
    store.createMessage(codex.id, "Keep the Browser request transcript.");
    store.updateConversation(codex.id, {
      providerSessionId: "codex-before-browser-capability",
    });
    for (const conversation of resumableConversations) {
      store.updateConversation(conversation.id, {
        providerSessionId: `${conversation.providerId}-browser-session`,
      });
    }
    store.upsertAgentGoal({
      conversationId: codex.id,
      source: "codex-native",
      providerSessionId: "codex-before-browser-capability",
      objective: "Provider-owned goal from incompatible session",
      status: "active",
      tokenBudget: null,
      tokensUsed: 4,
      timeUsedSeconds: 2,
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-22T10:01:00.000Z",
      synchronizedAt: "2026-08-22T10:01:00.000Z",
    });
    store.close();

    const schema64 = new Database(databasePath);
    schema64.prepare("DELETE FROM schema_migrations WHERE version >= 65").run();
    expect((schema64.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(64);
    schema64.close();

    migrateFixtureInPlace(databasePath);
    migrateFixtureInPlace(databasePath);

    const migrated = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    expect(migrated.conversation(codex.id)).toMatchObject({
      providerSessionId: null,
      continuationIdentity: null,
    });
    expect(migrated.conversationDetail(codex.id)!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Keep the Browser request transcript.",
        }),
      ]),
    );
    expect(migrated.agentGoals(codex.id)).toEqual([]);
    for (const conversation of resumableConversations) {
      expect(migrated.conversation(conversation.id)).toMatchObject({
        providerSessionId: `${conversation.providerId}-browser-session`,
        continuationIdentity: expect.any(Object),
      });
    }
    migrated.close();
  });

  it.each(["complete", "partial"] as const)(
    "fails closed when schema 61 finds an unreceipted %s context table",
    async (shape) => {
      const directory = await temporaryDirectory();
      const databasePath = join(directory, `schema-61-${shape}.sqlite`);
      const workspacePath = join(directory, "workspace");
      await mkdir(workspacePath);
      const store = new RuntimeStore(databasePath, workspacePath, {
        recoverInterruptedRuns: false,
      });
      store.close();

      const unreceipted = new Database(databasePath);
      if (shape === "partial") {
        unreceipted.exec(`
          DROP TRIGGER conversation_context_packets_discard_source_drafts;
          DROP TABLE agent_context_requests;
          DROP TABLE conversation_context_packets;
          CREATE TABLE conversation_context_packets (id TEXT PRIMARY KEY);
        `);
      }
      unreceipted.prepare(
        "DELETE FROM schema_migrations WHERE version >= 61",
      ).run();
      unreceipted.close();

      expect(() => migrateFixtureInPlace(databasePath)).toThrow(
        /Database migration 61 \(PersistConversationContextPackets\) failed/iu,
      );
      const inspected = new Database(databasePath, { readonly: true });
      expect((inspected.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number }).version).toBe(60);
      const columns = inspected.prepare(
        "PRAGMA table_info(conversation_context_packets)",
      ).all() as Array<{ name: string }>;
      if (shape === "partial") {
        expect(columns.map(({ name }) => name)).toEqual(["id"]);
      } else {
        expect(columns.map(({ name }) => name)).toContain("excerpts_json");
      }
      inspected.close();
    },
  );

  it("upgrades exact schema 56 with an indexed completed-turn range path without changing durable data", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "schema-56-usage-index.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Usage index", workspacePath);
    store.close();

    const schema56 = new Database(databasePath);
    schema56.exec(`
      DROP INDEX agent_turns_usage_dashboard_completed_idx;
      CREATE INDEX agent_turns_usage_dashboard_completed_idx
      ON agent_turns(association, completed_at COLLATE NOCASE, id);
      DELETE FROM schema_migrations WHERE version >= 57;
    `);
    dropUnreleasedAgentThreadManagement(schema56);
    expect((schema56.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(56);
    expect(schema56.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_run_ownership'",
    ).get()).toEqual({ name: "provider_run_ownership" });
    schema56.close();

    migrateFixtureInPlace(databasePath);

    const migrated = new Database(databasePath, { readonly: true });
    const index = migrated.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index'
        AND name = 'agent_turns_usage_dashboard_completed_idx'
    `).get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/association, completed_at ASC, id ASC/iu);
    expect(index?.sql).not.toMatch(/NOCASE/iu);
    const plan = migrated.prepare(`
      EXPLAIN QUERY PLAN
      SELECT provider_id, model_selection_json, continuation_identity_json,
        harness_id, backend_profile_id, model, model_alias, reasoning_effort,
        provider_session_before, provider_session_after, started_at,
        completed_at, status,
        usage_start_json, usage_completion_json, configuration_revision,
        association
      FROM agent_turns
      WHERE completed_at >= ?
        AND completed_at < ?
        AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND association = 'authoritative'
      ORDER BY completed_at ASC, id ASC
    `).all("2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z") as Array<{
      detail: string;
    }>;
    expect(plan.some(({ detail }) =>
      detail.includes("agent_turns_usage_dashboard_completed_idx"))).toBe(true);
    expect((migrated.prepare(
      "SELECT name FROM projects WHERE id = ?",
    ).get(project.id) as { name: string }).name).toBe("Usage index");
    expect(migrated.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
    migrated.close();
  });

  it("upgrades exact schema 56 by invalidating legacy turn-start usage without changing completions", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "schema-56-usage-boundary.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const store = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Usage boundary", workspacePath);
    const conversation = store.createConversation(project.id, "Legacy boundary");
    const usageAtStart = {
      usedTokens: 60,
      totalProcessedTokens: 1_000,
      totalProcessedScope: "thread" as const,
      maxTokens: 200_000,
      inputTokens: 800,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 20,
      compactsAutomatically: true,
      capturedAt: "2026-08-11T10:00:00.000Z",
    };
    const usageAtCompletion = {
      ...usageAtStart,
      usedTokens: 90,
      totalProcessedTokens: 1_300,
      inputTokens: 1_020,
      outputTokens: 160,
      capturedAt: "2026-08-11T10:01:00.000Z",
    };
    const turn = store.beginAgentTurn({
      id: "legacy-unowned-usage-start",
      conversationId: conversation.id,
      runId: "legacy-unowned-usage-run",
      content: "Preserve completion but reject this unowned start.",
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: "legacy-session",
      requestedAt: "2026-08-11T10:00:00.000Z",
      usageAtStart,
      configurationRevision: 0,
      association: "authoritative",
    }).turn;
    store.updateAgentTurnLifecycle(turn.id, {
      status: "starting",
      updatedAt: "2026-08-11T10:00:01.000Z",
    });
    store.updateAgentTurnLifecycle(turn.id, {
      status: "running",
      updatedAt: "2026-08-11T10:00:02.000Z",
    });
    store.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      providerSessionAfter: "legacy-session",
      usageAtCompletion,
      completedAt: "2026-08-11T10:01:00.000Z",
      updatedAt: "2026-08-11T10:01:00.000Z",
    });
    store.close();

    const schema56 = new Database(databasePath);
    schema56.exec(`
      DROP INDEX agent_turns_usage_dashboard_completed_idx;
      DELETE FROM schema_migrations WHERE version >= 57;
    `);
    dropUnreleasedAgentThreadManagement(schema56);
    expect((schema56.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version).toBe(56);
    const before = schema56.prepare(`
      SELECT usage_start_json, usage_completion_json
      FROM agent_turns WHERE id = ?
    `).get(turn.id) as {
      usage_start_json: string | null;
      usage_completion_json: string | null;
    };
    expect(JSON.parse(before.usage_start_json!)).toMatchObject({
      totalProcessedTokens: 1_000,
    });
    expect(JSON.parse(before.usage_completion_json!)).toMatchObject({
      totalProcessedTokens: 1_300,
    });
    schema56.close();

    migrateFixtureInPlace(databasePath);
    migrateFixtureInPlace(databasePath);

    const migrated = new Database(databasePath, { readonly: true });
    const after = migrated.prepare(`
      SELECT usage_start_json, usage_completion_json
      FROM agent_turns WHERE id = ?
    `).get(turn.id) as {
      usage_start_json: string | null;
      usage_completion_json: string | null;
    };
    expect(after.usage_start_json).toBeNull();
    expect(JSON.parse(after.usage_completion_json!)).toEqual(
      JSON.parse(before.usage_completion_json!),
    );
    expect((migrated.prepare(
      "SELECT name FROM projects WHERE id = ?",
    ).get(project.id) as { name: string }).name).toBe("Usage boundary");
    expect(migrated.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
    migrated.close();

    const reopened = new RuntimeStore(databasePath, workspacePath, {
      recoverInterruptedRuns: false,
    });
    const dashboard = reopened.usageDashboard({
      days: 7,
      fromInclusive: "2026-08-05T00:00:00.000Z",
      toExclusive: "2026-08-12T00:00:00.000Z",
      endDate: "2026-08-11",
      timeZone: "UTC",
    });
    reopened.close();
    expect(dashboard.totals.processedTokens).toEqual({
      value: null,
      measuredRequests: 0,
      totalRequests: 1,
      coverage: "unavailable",
    });
  });

  it("appends final-answer auto-scroll after the released schema-50 migration", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "schema-50-upgrade.sqlite");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);

    const store = new RuntimeStore(databasePath, workspacePath);
    store.close();

    const schema50 = new Database(databasePath);
    schema50.exec(`
      DROP TABLE conversation_path_authorities;
      DROP TABLE project_path_authorities;
      DROP TABLE workspace_path_authority_enrollment;
      DROP TRIGGER conversation_worktree_ownership_project_delete;
      DROP TABLE conversation_worktree_ownership;
      DROP TABLE prompt_presets;
      ALTER TABLE app_state DROP COLUMN auto_scroll_to_final_answer;
      DELETE FROM schema_migrations WHERE version >= 51;
    `);
    dropUnreleasedProviderOwnership(schema50);
    schema50.close();

    migrateFixtureInPlace(databasePath);

    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.prepare(
      "SELECT version FROM schema_migrations WHERE version >= 50 ORDER BY version",
    ).all()).toEqual([
      { version: 50 },
      { version: 51 },
      { version: 52 },
      { version: 53 },
      { version: 54 },
      { version: 55 },
      { version: 56 },
      { version: 57 },
      { version: 58 },
      { version: 59 },
      { version: 60 },
      { version: 61 },
      { version: 62 },
      { version: 63 },
      { version: 64 },
      { version: 65 },
      { version: 66 },
    ]);
    expect((migrated.prepare(
      "SELECT auto_scroll_to_final_answer AS enabled FROM app_state WHERE id = 1",
    ).get() as { enabled: number }).enabled).toBe(1);
    expect((migrated.prepare(
      "SELECT color_theme AS colorTheme FROM app_state WHERE id = 1",
    ).get() as { colorTheme: string }).colorTheme).toBe("inertia");
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompt_presets'",
    ).get()).toEqual({ name: "prompt_presets" });
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_suspend_intervals'",
    ).get()).toEqual({ name: "system_suspend_intervals" });
    expect((migrated.prepare("PRAGMA table_info(agent_turns)").all() as Array<{
      name: string;
    }>).some(({ name }) => name === "suspended_duration_ms")).toBe(true);
    const appStateColumns = new Set((migrated.prepare(
      "PRAGMA table_info(app_state)",
    ).all() as Array<{ name: string }>).map(({ name }) => name));
    expect(appStateColumns.has("discord_release_repository_url")).toBe(true);
    expect(appStateColumns.has("discord_webhook_url")).toBe(false);
    expect(appStateColumns.has("discord_release_provider")).toBe(false);
    expect(appStateColumns.has("discord_release_model")).toBe(false);
    expect(appStateColumns.has("discord_release_reasoning_effort")).toBe(false);
    migrated.close();
  });
});

describe("legacy inferred turn backfill", () => {
  it("is deterministic and idempotent while retaining malformed and unmatched records", async () => {
    // This proves deterministic migration capacity under suite load, not latency.
    const first = await createLegacyBackfillDatabase();
    const database = new Database(first.databasePath);
    const contentBefore = database.prepare(
      "SELECT id, content FROM messages ORDER BY id",
    ).all();
    const diagnostics = backfillLegacyAgentTurns(database, { sourceSchemaVersion: 15 });
    const turns = database.prepare(`
      SELECT id, run_id, user_message_id, terminal_assistant_message_id,
        status, association, checkpoint_id
      FROM agent_turns
      ORDER BY requested_at, id
    `).all() as Array<{
      id: string;
      run_id: string;
      user_message_id: string;
      terminal_assistant_message_id: string | null;
      status: string;
      association: string;
      checkpoint_id: string | null;
    }>;
    expect(turns).toEqual([
      expect.objectContaining({
        run_id: "legacy-run-1",
        user_message_id: "legacy-user-1",
        terminal_assistant_message_id: "legacy-assistant-1b",
        status: "completed",
        association: "inferred",
        checkpoint_id: "legacy-checkpoint-1",
      }),
      expect.objectContaining({
        run_id: "legacy-run-2",
        user_message_id: "legacy-user-2",
        terminal_assistant_message_id: "legacy-assistant-2",
        status: "completed",
        association: "inferred",
        checkpoint_id: "legacy-checkpoint-2",
      }),
    ]);
    expect(new Set(turns.map(({ id }) => id)).size).toBe(2);
    expect(diagnostics).toMatchObject({
      sourceSchemaVersion: 15,
      sourceReleases: ["v0.0.5", "v0.0.6"],
      responseGroups: 2,
      turnsCreated: 2,
      runIdsReused: 2,
      deterministicRunIdsCreated: 0,
      associated: {
        messages: 6,
        activities: 3,
        reasonings: 2,
        plans: 1,
        usageSnapshots: 1,
        checkpoints: 2,
      },
      orphans: {
        assistantMessages: 1,
        systemMessages: 0,
        activities: 2,
        reasonings: 1,
        plans: 0,
        usageSnapshots: 0,
        checkpoints: 1,
      },
    });
    expect(database.prepare(
      "SELECT id, content FROM messages ORDER BY id",
    ).all()).toEqual(contentBefore);
    for (const [table, idColumn, id] of [
      ["messages", "id", "legacy-orphan-assistant"],
      ["activities", "id", "legacy-activity-orphan"],
      ["activities", "id", "legacy-activity-competing"],
      ["agent_reasonings", "id", "legacy-reasoning-orphan"],
      ["checkpoints", "id", "legacy-checkpoint-orphan"],
    ] as const) {
      expect((database.prepare(
        `SELECT turn_id FROM ${table} WHERE ${idColumn} = ?`,
      ).get(id) as { turn_id: string | null }).turn_id).toBeNull();
    }

    const retry = backfillLegacyAgentTurns(database, { sourceSchemaVersion: 15 });
    expect(retry.turnsCreated).toBe(0);
    expect(retry.inferredTurnsReused).toBe(2);
    expect((database.prepare("SELECT COUNT(*) AS count FROM agent_turns").get() as {
      count: number;
    }).count).toBe(2);
    database.close();

    const second = await createLegacyBackfillDatabase();
    const secondDatabase = new Database(second.databasePath);
    backfillLegacyAgentTurns(secondDatabase, { sourceSchemaVersion: 15 });
    const secondTurnIds = (secondDatabase.prepare(
      "SELECT id FROM agent_turns ORDER BY requested_at, id",
    ).all() as Array<{ id: string }>).map(({ id }) => id);
    secondDatabase.close();
    expect(secondTurnIds).toEqual(turns.map(({ id }) => id));
  }, 30_000);
});
