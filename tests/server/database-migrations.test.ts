import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

describe("published database fixtures", () => {
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
    legacy.close();

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
    database.close();

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
    legacy.close();

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
});

describe("legacy inferred turn backfill", () => {
  it("is deterministic and idempotent while retaining malformed and unmatched records", async () => {
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
  });
});
