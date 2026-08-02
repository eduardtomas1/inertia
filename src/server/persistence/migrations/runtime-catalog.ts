import type Database from "better-sqlite3";

import type { ProviderId } from "../../../shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../../shared/model-routing";
import {
  backfillLegacyAgentTurns,
  formatMigrationDiagnostic,
  runDatabaseMigrations,
} from "../../database-migrations";
import {
  nativeProviderMetadataScope,
  providerMetadataScopeKey,
  type PersistedProviderMetadata,
} from "../../provider/metadata";
import { legacyModelSelection } from "../codecs";
import type { AgentTurnRow, ConversationRow } from "../rows";
import {
  createRuntimeMigrationCatalog,
  type DatabaseMigrationDefinition,
} from "./catalog";
import { rebuildPairedLaunchProjectDeletionTrigger } from "./duo-deletion-trigger";
import { LEGACY_SCHEMA_SQL } from "./legacy-schema";
import { quotedSqlIdentifier } from "./sql-identifiers";

const MODEL_SELECTION_TABLES = ["conversations", "agent_turns"] as const;
const MODEL_SELECTION_COLUMNS = [
  "model_selection_json",
  "continuation_identity_json",
] as const;
const TURN_ASSOCIATION_TABLES = [
  "messages",
  "activities",
  "agent_reasonings",
  "agent_plans",
  "thread_usage",
  "checkpoints",
] as const;
const TURN_ASSOCIATION_COLUMNS = ["turn_id"] as const;

export function migrateRuntimeDatabase(database: Database.Database): void {
    const legacyMigrations: DatabaseMigrationDefinition[] = LEGACY_SCHEMA_SQL.map(
      (sql, index) => {
      const version = index + 1;
      return {
        name: version === 17 ? "ExplicitTurnOwnership" : `SchemaVersion${version}`,
        up: version === 17
          ? (database) => {
            ensureTurnAssociationColumns(database);
            database.exec(sql);
          }
          : sql,
      };
    });
    const migrationExtensions: DatabaseMigrationDefinition[] = [];
    migrationExtensions.push({
      name: "BackfillLegacyAgentTurns",
      up: (database, context) => {
        context.setLegacyBackfillDiagnostics(backfillLegacyAgentTurns(database, {
          sourceSchemaVersion: context.sourceSchemaVersion,
        }));
      },
    });
    migrationExtensions.push({
      name: "PersistCompleteDiffReviewSummary",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(diff_review_summaries)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "summary_json")) {
          database.exec(`
            ALTER TABLE diff_review_summaries ADD COLUMN summary_json TEXT
              CHECK (summary_json IS NULL OR length(summary_json) <= 524288);
          `);
        }
      },
    });
    migrationExtensions.push({
      name: "PersistWorkspaceRunAttention",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(workspace_runs)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "attention_state")) {
          database.exec(`
            ALTER TABLE workspace_runs ADD COLUMN attention_state TEXT NOT NULL DEFAULT 'acknowledged'
              CHECK (attention_state IN ('unseen', 'seen', 'acknowledged', 'dismissed'));
          `);
        }
        database.prepare(`
          UPDATE workspace_runs
          SET attention_state = CASE
            WHEN status = 'waiting' THEN 'unseen'
            WHEN status = 'failed'
              AND julianday(COALESCE(finished_at, started_at)) < julianday(?) - 1
              THEN 'acknowledged'
            WHEN status = 'failed'
              AND conversation_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM conversations
                WHERE conversations.id = workspace_runs.conversation_id
                  AND conversations.last_viewed_at IS NOT NULL
                  AND julianday(conversations.last_viewed_at)
                    >= julianday(COALESCE(workspace_runs.finished_at, workspace_runs.started_at))
              )
              THEN 'seen'
            WHEN status = 'failed' THEN 'unseen'
            WHEN kind = 'agent' AND status = 'succeeded'
              AND conversation_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM conversations
                WHERE conversations.id = workspace_runs.conversation_id
                  AND conversations.last_viewed_at IS NOT NULL
                  AND julianday(conversations.last_viewed_at)
                    >= julianday(COALESCE(workspace_runs.finished_at, workspace_runs.started_at))
              )
              THEN 'seen'
            WHEN kind = 'agent' AND status = 'succeeded' THEN 'unseen'
            ELSE 'acknowledged'
          END
        `).run(new Date().toISOString());
        database.exec(`
          CREATE INDEX IF NOT EXISTS workspace_runs_attention_idx
            ON workspace_runs(attention_state, status, started_at DESC);
        `);
      },
    });
    migrationExtensions.push({
      name: "PersistAgentPlansPerTurn",
      up: `
        CREATE TABLE agent_plans_v21 (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          turn_id TEXT REFERENCES agent_turns(id) ON DELETE SET NULL,
          explanation TEXT,
          steps_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, run_id)
        );
        INSERT INTO agent_plans_v21 (
          conversation_id, run_id, turn_id, explanation, steps_json, updated_at
        )
        SELECT conversation_id, run_id, turn_id, explanation, steps_json, updated_at
        FROM agent_plans;
        DROP TABLE agent_plans;
        ALTER TABLE agent_plans_v21 RENAME TO agent_plans;
        CREATE UNIQUE INDEX agent_plans_turn_id_unique_idx
          ON agent_plans(turn_id) WHERE turn_id IS NOT NULL;
        CREATE INDEX agent_plans_conversation_turn_idx
          ON agent_plans(conversation_id, turn_id);
        CREATE INDEX agent_plans_conversation_updated_idx
          ON agent_plans(conversation_id, updated_at ASC, run_id ASC);
      `,
    });
    migrationExtensions.push({
      name: "PersistBoundedTurnExecutionContext",
      up: `
        CREATE TABLE IF NOT EXISTS turn_execution_context_blobs (
          digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
          byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
          content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) = byte_size),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turn_execution_manifests (
          turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
          manifest_json TEXT NOT NULL CHECK (length(manifest_json) BETWEEN 2 AND 65536),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turn_execution_context_refs (
          turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
          digest TEXT NOT NULL REFERENCES turn_execution_context_blobs(digest) ON DELETE RESTRICT,
          kind TEXT NOT NULL CHECK (kind IN ('file', 'diff', 'terminal', 'preview', 'review-note')),
          label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 4096),
          byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          PRIMARY KEY (turn_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS turn_execution_context_refs_digest_idx
          ON turn_execution_context_refs(digest);
        CREATE TRIGGER IF NOT EXISTS turn_execution_context_refs_prune_blob
        AFTER DELETE ON turn_execution_context_refs
        BEGIN
          DELETE FROM turn_execution_context_blobs
          WHERE digest = OLD.digest
            AND NOT EXISTS (
              SELECT 1 FROM turn_execution_context_refs
              WHERE turn_execution_context_refs.digest = OLD.digest
            );
        END;
      `,
    });
    migrationExtensions.push({
      name: "PersistTurnGitArtifacts",
      up: `
        CREATE TABLE IF NOT EXISTS turn_git_artifacts (
          id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
          turn_id TEXT NOT NULL UNIQUE REFERENCES agent_turns(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
          repository_identity TEXT
            CHECK (repository_identity IS NULL OR length(repository_identity) = 64),
          worktree_identity TEXT
            CHECK (worktree_identity IS NULL OR length(worktree_identity) = 64),
          branch TEXT CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 300),
          before_checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
          before_ref TEXT CHECK (before_ref IS NULL OR length(before_ref) <= 500),
          after_ref TEXT CHECK (after_ref IS NULL OR length(after_ref) <= 500),
          before_fingerprint TEXT
            CHECK (before_fingerprint IS NULL OR length(before_fingerprint) = 64),
          after_fingerprint TEXT
            CHECK (after_fingerprint IS NULL OR length(after_fingerprint) = 64),
          files_json TEXT NOT NULL DEFAULT '[]' CHECK (length(files_json) <= 262144),
          insertions INTEGER NOT NULL DEFAULT 0 CHECK (insertions >= 0),
          deletions INTEGER NOT NULL DEFAULT 0 CHECK (deletions >= 0),
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'ready', 'partial', 'unavailable', 'failed')
          ),
          completeness TEXT NOT NULL CHECK (
            completeness IN ('complete', 'truncated', 'partial', 'unavailable')
          ),
          patch_state TEXT NOT NULL CHECK (
            patch_state IN ('none', 'available', 'truncated', 'expired', 'failed')
          ),
          patch_digest TEXT CHECK (patch_digest IS NULL OR length(patch_digest) = 64),
          captured_at TEXT,
          terminal_assistant_message_id TEXT,
          failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 1000),
          absence_reason TEXT CHECK (
            absence_reason IS NULL OR absence_reason = 'not-repository'
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (created_at <= updated_at),
          CHECK (
            patch_state NOT IN ('available', 'truncated') OR patch_digest IS NOT NULL
          )
        );
        CREATE INDEX IF NOT EXISTS turn_git_artifacts_conversation_created_idx
          ON turn_git_artifacts(conversation_id, created_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS turn_git_artifacts_repository_worktree_idx
          ON turn_git_artifacts(repository_identity, worktree_identity, created_at ASC);
        CREATE INDEX IF NOT EXISTS turn_git_artifacts_patch_digest_idx
          ON turn_git_artifacts(patch_digest) WHERE patch_digest IS NOT NULL;
      `,
    });
    migrationExtensions.push({
      name: "PersistTurnModelSelection",
      up: (database) => {
        const addColumn = (
          table: (typeof MODEL_SELECTION_TABLES)[number],
          column: (typeof MODEL_SELECTION_COLUMNS)[number],
          maximum: number,
        ): void => {
          const tableSql = quotedSqlIdentifier(table, MODEL_SELECTION_TABLES);
          const columnSql = quotedSqlIdentifier(
            column,
            MODEL_SELECTION_COLUMNS,
          );
          if (!Number.isSafeInteger(maximum) || maximum < 1) {
            throw new Error("The migration column limit is invalid.");
          }
          const columns = database.prepare(`PRAGMA table_info(${tableSql})`)
            .all() as Array<{ name: string }>;
          if (columns.some(({ name }) => name === column)) return;
          database.exec(`
            ALTER TABLE ${tableSql} ADD COLUMN ${columnSql} TEXT
              CHECK (${columnSql} IS NULL OR length(${columnSql}) <= ${maximum});
          `);
        };
        addColumn("conversations", "model_selection_json", 65_536);
        addColumn("conversations", "continuation_identity_json", 4_096);
        addColumn("agent_turns", "model_selection_json", 65_536);
        addColumn("agent_turns", "continuation_identity_json", 4_096);
        const updateConversation = database.prepare(`
          UPDATE conversations
          SET model_selection_json = ?,
              continuation_identity_json = ?
          WHERE id = ?
        `);
        const conversations = database.prepare(`
          SELECT id, provider_id, model, reasoning_effort, provider_session_id
          FROM conversations
          ORDER BY id
        `).all() as Array<Pick<
          ConversationRow,
          "id" | "provider_id" | "model" | "reasoning_effort" | "provider_session_id"
        >>;
        for (const conversation of conversations) {
          const selection = nativeModelSelection({
            providerId: conversation.provider_id,
            modelId: conversation.model || "provider-default",
            alias: conversation.model || null,
            reasoningEffort: conversation.reasoning_effort || null,
          });
          const continuation = conversation.provider_session_id
            ? continuationIdentityForSelection(selection, null, false)
            : null;
          updateConversation.run(
            JSON.stringify(selection),
            continuation ? JSON.stringify(continuation) : null,
            conversation.id,
          );
        }

        const updateTurn = database.prepare(`
          UPDATE agent_turns
          SET model_selection_json = ?,
              continuation_identity_json = ?
          WHERE id = ?
        `);
        const turns = database.prepare(`
          SELECT id, provider_id, harness_id, backend_profile_id, model, model_alias,
                 reasoning_effort, configuration_revision
          FROM agent_turns
          ORDER BY requested_at, id
        `).all() as Array<Pick<
          AgentTurnRow,
          | "id"
          | "provider_id"
          | "harness_id"
          | "backend_profile_id"
          | "model"
          | "model_alias"
          | "reasoning_effort"
          | "configuration_revision"
        >>;
        for (const turn of turns) {
          const selection = legacyModelSelection({
            providerId: turn.provider_id,
            harnessId: turn.harness_id,
            backendProfileId: turn.backend_profile_id,
            model: turn.model,
            modelAlias: turn.model_alias,
            reasoningEffort: turn.reasoning_effort,
            configurationRevision: turn.configuration_revision,
          });
          updateTurn.run(
            JSON.stringify(selection),
            JSON.stringify(continuationIdentityForSelection(selection)),
            turn.id,
          );
        }
      },
    });
    migrationExtensions.push({
      name: "PersistModelBackendProfiles",
      up: `
        CREATE TABLE IF NOT EXISTS model_backend_profiles (
          profile_id TEXT PRIMARY KEY CHECK (length(profile_id) BETWEEN 1 AND 200),
          harness_id TEXT NOT NULL CHECK (
            harness_id IN (
              'codex-app-server', 'codex-cli', 'claude-agent-sdk', 'claude-cli',
              'cursor-acp', 'cursor-cli', 'opencode-sdk', 'opencode-cli'
            )
          ),
          preset TEXT NOT NULL CHECK (preset IN ('native', 'kimi-code', 'custom')),
          protocol TEXT NOT NULL CHECK (
            protocol IN (
              'openai-responses', 'anthropic-messages',
              'cursor-managed', 'opencode-native'
            )
          ),
          source TEXT NOT NULL CHECK (source IN ('built-in', 'custom')),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          configuration_revision INTEGER NOT NULL
            CHECK (configuration_revision >= 0),
          endpoint_identity TEXT
            CHECK (
              endpoint_identity IS NULL
              OR length(endpoint_identity) BETWEEN 1 AND 256
            ),
          credential_generation TEXT
            CHECK (
              credential_generation IS NULL
              OR length(credential_generation) BETWEEN 1 AND 200
            ),
          configuration_json TEXT NOT NULL
            CHECK (length(configuration_json) BETWEEN 2 AND 262144),
          latest_probe_json TEXT
            CHECK (latest_probe_json IS NULL OR length(latest_probe_json) <= 262144),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (created_at <= updated_at)
        );
        CREATE INDEX IF NOT EXISTS model_backend_profiles_harness_idx
          ON model_backend_profiles(harness_id, enabled, updated_at DESC);

        CREATE TABLE IF NOT EXISTS model_backend_defaults (
          scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          selection_json TEXT NOT NULL CHECK (length(selection_json) BETWEEN 2 AND 65536),
          updated_at TEXT NOT NULL,
          CHECK (
            (scope = 'global' AND project_id IS NULL)
            OR (scope = 'project' AND project_id IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS model_backend_defaults_global_unique_idx
          ON model_backend_defaults(scope) WHERE scope = 'global';
        CREATE UNIQUE INDEX IF NOT EXISTS model_backend_defaults_project_unique_idx
          ON model_backend_defaults(project_id) WHERE scope = 'project';
      `,
    });
    migrationExtensions.push({
      name: "ScopeProviderMetadataByExecutionIdentity",
      up: (database) => {
        database.exec(`
          CREATE TABLE IF NOT EXISTS provider_metadata_scoped_cache (
            scope_key TEXT PRIMARY KEY CHECK (length(scope_key) BETWEEN 2 AND 8192),
            provider_id TEXT NOT NULL CHECK (
              provider_id IN ('codex', 'claude', 'cursor', 'opencode')
            ),
            harness_id TEXT NOT NULL CHECK (
              harness_id IN (
                'codex-app-server', 'codex-cli', 'claude-agent-sdk', 'claude-cli',
                'cursor-acp', 'cursor-cli', 'opencode-sdk', 'opencode-cli'
              )
            ),
            backend_profile_id TEXT NOT NULL
              CHECK (length(backend_profile_id) BETWEEN 1 AND 200),
            model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 300),
            executable TEXT CHECK (executable IS NULL OR length(executable) <= 4096),
            version TEXT CHECK (version IS NULL OR length(version) <= 200),
            backend_configuration_revision INTEGER NOT NULL
              CHECK (backend_configuration_revision >= 0),
            auth_state TEXT NOT NULL CHECK (
              auth_state IN (
                'checking', 'authenticated', 'unauthenticated',
                'configured', 'unknown', 'error'
              )
            ),
            models_json TEXT NOT NULL DEFAULT '[]'
              CHECK (length(models_json) <= 262144),
            models_updated_at TEXT,
            models_last_attempted_at TEXT,
            models_provenance TEXT CHECK (
              models_provenance IS NULL
              OR models_provenance IN ('provider', 'session', 'persistent-cache')
            ),
            models_stale INTEGER NOT NULL DEFAULT 0
              CHECK (models_stale IN (0, 1)),
            rate_limits_json TEXT NOT NULL DEFAULT '[]'
              CHECK (length(rate_limits_json) <= 65536),
            rate_limits_updated_at TEXT,
            rate_limits_last_attempted_at TEXT,
            rate_limits_provenance TEXT CHECK (
              rate_limits_provenance IS NULL
              OR rate_limits_provenance IN ('provider', 'session', 'persistent-cache')
            ),
            rate_limits_stale INTEGER NOT NULL DEFAULT 0
              CHECK (rate_limits_stale IN (0, 1))
          );
          CREATE INDEX IF NOT EXISTS provider_metadata_scoped_identity_idx
            ON provider_metadata_scoped_cache(
              provider_id, harness_id, backend_profile_id, model_id,
              backend_configuration_revision
            );
        `);
        const legacyRows = database.prepare(`
          SELECT *
          FROM provider_metadata_cache
          ORDER BY provider_id
        `).all() as Array<{
          provider_id: ProviderId;
          executable: string | null;
          version: string | null;
          auth_state: PersistedProviderMetadata["scope"]["authState"] | null;
          models_json: string;
          models_updated_at: string | null;
          models_last_attempted_at: string | null;
          models_provenance: PersistedProviderMetadata["modelsProvenance"];
          models_stale: 0 | 1;
          rate_limits_json: string;
          rate_limits_updated_at: string | null;
          rate_limits_last_attempted_at: string | null;
          rate_limits_provenance: PersistedProviderMetadata["rateLimitsProvenance"];
          rate_limits_stale: 0 | 1;
        }>;
        const insert = database.prepare(`
          INSERT OR IGNORE INTO provider_metadata_scoped_cache (
            scope_key, provider_id, harness_id, backend_profile_id, model_id,
            executable, version, backend_configuration_revision, auth_state,
            models_json, models_updated_at, models_last_attempted_at,
            models_provenance, models_stale, rate_limits_json,
            rate_limits_updated_at, rate_limits_last_attempted_at,
            rate_limits_provenance, rate_limits_stale
          ) VALUES (
            @scopeKey, @providerId, @harnessId, @backendProfileId, @modelId,
            @executable, @version, @backendConfigurationRevision, @authState,
            @modelsJson, @modelsUpdatedAt, @modelsLastAttemptedAt,
            @modelsProvenance, @modelsStale, @rateLimitsJson,
            @rateLimitsUpdatedAt, @rateLimitsLastAttemptedAt,
            @rateLimitsProvenance, @rateLimitsStale
          )
        `);
        for (const row of legacyRows) {
          const scope = nativeProviderMetadataScope(row.provider_id, {
            executable: row.executable,
            version: row.version,
            authState: row.auth_state ?? "unknown",
          });
          insert.run({
            scopeKey: providerMetadataScopeKey(scope),
            ...scope,
            modelsJson: row.models_json,
            modelsUpdatedAt: row.models_updated_at,
            modelsLastAttemptedAt: row.models_last_attempted_at,
            modelsProvenance: row.models_provenance,
            modelsStale: row.models_stale,
            rateLimitsJson: row.rate_limits_json,
            rateLimitsUpdatedAt: row.rate_limits_updated_at,
            rateLimitsLastAttemptedAt: row.rate_limits_last_attempted_at,
            rateLimitsProvenance: row.rate_limits_provenance,
            rateLimitsStale: row.rate_limits_stale,
          });
        }
      },
    });
    migrationExtensions.push({
      name: "ClassifyTurnGitArtifactAbsence",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(turn_git_artifacts)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "absence_reason")) {
          database.exec(`
            ALTER TABLE turn_git_artifacts ADD COLUMN absence_reason TEXT
              CHECK (absence_reason IS NULL OR absence_reason = 'not-repository');
          `);
        }
        database.prepare(`
          UPDATE turn_git_artifacts
          SET absence_reason = 'not-repository'
          WHERE status = 'unavailable'
            AND completeness = 'unavailable'
            AND absence_reason IS NULL
            AND failure_reason IN (
              'This workspace is not a Git repository.',
              'The selected folder is not a Git repository.'
            )
        `).run();
      },
    });
    migrationExtensions.push({
      name: "PersistBoundedSubagentTraces",
      up: `
        CREATE TABLE IF NOT EXISTS subagent_traces (
          id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
          turn_id TEXT NOT NULL
            REFERENCES agent_turns(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL
            CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
          provider_task_id TEXT
            CHECK (provider_task_id IS NULL OR length(provider_task_id) BETWEEN 1 AND 1000),
          provider_agent_id TEXT
            CHECK (provider_agent_id IS NULL OR length(provider_agent_id) BETWEEN 1 AND 1000),
          parent_trace_id TEXT
            REFERENCES subagent_traces(id) ON DELETE SET NULL,
          parent_provider_agent_id TEXT
            CHECK (parent_provider_agent_id IS NULL OR length(parent_provider_agent_id) BETWEEN 1 AND 1000),
          parent_provider_tool_use_id TEXT
            CHECK (parent_provider_tool_use_id IS NULL OR length(parent_provider_tool_use_id) BETWEEN 1 AND 1000),
          provider_tool_use_id TEXT
            CHECK (provider_tool_use_id IS NULL OR length(provider_tool_use_id) BETWEEN 1 AND 1000),
          provider_role TEXT
            CHECK (provider_role IS NULL OR length(provider_role) BETWEEN 1 AND 200),
          provider_name TEXT
            CHECK (provider_name IS NULL OR length(provider_name) BETWEEN 1 AND 200),
          status TEXT NOT NULL CHECK (status IN (
            'spawned', 'running', 'waiting', 'completed', 'failed',
            'cancelled', 'lost'
          )),
          description TEXT
            CHECK (description IS NULL OR length(description) BETWEEN 1 AND 4000),
          progress TEXT
            CHECK (progress IS NULL OR length(progress) BETWEEN 1 AND 4000),
          result TEXT
            CHECK (result IS NULL OR length(result) BETWEEN 1 AND 16000),
          sequence INTEGER NOT NULL
            CHECK (sequence BETWEEN 0 AND 2147483647),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (provider_task_id IS NOT NULL OR provider_agent_id IS NOT NULL),
          CHECK (created_at <= updated_at)
        );
        CREATE INDEX IF NOT EXISTS subagent_traces_turn_order_idx
          ON subagent_traces(turn_id, created_at ASC, sequence ASC, id ASC);
        CREATE UNIQUE INDEX IF NOT EXISTS subagent_traces_task_identity_idx
          ON subagent_traces(conversation_id, run_id, provider_id, provider_task_id)
          WHERE provider_task_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS subagent_traces_agent_identity_idx
          ON subagent_traces(conversation_id, run_id, provider_id, provider_agent_id)
          WHERE provider_agent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS subagent_traces_parent_idx
          ON subagent_traces(parent_trace_id, created_at ASC);
      `,
    });
    migrationExtensions.push({
      name: "PersistProjectGitRepositoryLimit",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(projects)")
          .all() as Array<{ name: string }>;
        if (columns.some(({ name }) => name === "git_repository_limit")) return;
        database.exec(`
          ALTER TABLE projects
            ADD COLUMN git_repository_limit INTEGER NOT NULL DEFAULT 128
            CHECK (git_repository_limit BETWEEN 16 AND 1024);
        `);
      },
    });
    migrationExtensions.push({
      name: "ScopeDiffReviewTargetsByRepository",
      up: (database) => {
        const stateColumns = database.prepare(
          "PRAGMA table_info(diff_review_states)",
        ).all() as Array<{ name: string; pk: number }>;
        const hasStateRepository = stateColumns.some(
          ({ name }) => name === "repository_path",
        );
        const repositoryInStateKey = stateColumns.some(
          ({ name, pk }) => name === "repository_path" && pk > 0,
        );
        if (!repositoryInStateKey) {
          database.exec(`
            CREATE TABLE diff_review_states_v30 (
              conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              repository_path TEXT NOT NULL DEFAULT '.'
                CHECK (length(repository_path) BETWEEN 1 AND 4096),
              scope TEXT NOT NULL CHECK (scope IN ('file', 'hunk')),
              path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
              hunk_id TEXT NOT NULL DEFAULT '' CHECK (length(hunk_id) <= 128),
              target_fingerprint TEXT NOT NULL CHECK (length(target_fingerprint) = 64),
              reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
              stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
              updated_at TEXT NOT NULL,
              PRIMARY KEY (conversation_id, repository_path, scope, path, hunk_id)
            );
          `);
          database.exec(hasStateRepository
            ? `
              INSERT INTO diff_review_states_v30 (
                conversation_id, repository_path, scope, path, hunk_id,
                target_fingerprint, reviewed, stale, updated_at
              )
              SELECT
                conversation_id, repository_path, scope, path, hunk_id,
                target_fingerprint, reviewed, stale, updated_at
              FROM diff_review_states;
            `
            : `
              INSERT INTO diff_review_states_v30 (
                conversation_id, repository_path, scope, path, hunk_id,
                target_fingerprint, reviewed, stale, updated_at
              )
              SELECT
                conversation_id, '.', scope, path, hunk_id,
                target_fingerprint, reviewed, stale, updated_at
              FROM diff_review_states;
            `);
          database.exec(`
            DROP TABLE diff_review_states;
            ALTER TABLE diff_review_states_v30 RENAME TO diff_review_states;
          `);
        }
        database.exec(`
          DROP INDEX IF EXISTS diff_review_states_conversation_idx;
          CREATE INDEX diff_review_states_conversation_idx
            ON diff_review_states(conversation_id, repository_path, stale, reviewed);
        `);

        const noteColumns = database.prepare(
          "PRAGMA table_info(diff_review_notes)",
        ).all() as Array<{ name: string }>;
        if (!noteColumns.some(({ name }) => name === "repository_path")) {
          database.exec(`
            ALTER TABLE diff_review_notes
              ADD COLUMN repository_path TEXT NOT NULL DEFAULT '.'
              CHECK (length(repository_path) BETWEEN 1 AND 4096);
          `);
        }
        database.exec(`
          DROP INDEX IF EXISTS diff_review_notes_conversation_idx;
          CREATE INDEX diff_review_notes_conversation_idx
            ON diff_review_notes(conversation_id, repository_path, path, hunk_id);
        `);
      },
    });
    migrationExtensions.push({
      name: "PersistWorkspaceStartupSurface",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(app_state)")
          .all() as Array<{ name: string }>;
        if (columns.some(({ name }) =>
          name === "workspace_startup_surface")) return;
        database.exec(`
          ALTER TABLE app_state
            ADD COLUMN workspace_startup_surface TEXT NOT NULL DEFAULT 'summary'
            CHECK (workspace_startup_surface IN ('summary', 'tools'));
        `);
      },
    });
    migrationExtensions.push({
      name: "PersistAgentGoals",
      up: `
        CREATE TABLE IF NOT EXISTS agent_goals (
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,
          source TEXT NOT NULL
            CHECK (source IN ('codex-native', 'inertia-local')),
          provider_session_id TEXT,
          objective TEXT NOT NULL
            CHECK (length(objective) BETWEEN 1 AND 4000),
          status TEXT NOT NULL
            CHECK (status IN (
              'active', 'paused', 'blocked', 'usageLimited',
              'budgetLimited', 'complete'
            )),
          token_budget INTEGER
            CHECK (token_budget IS NULL OR token_budget BETWEEN 1 AND 1000000000),
          tokens_used INTEGER
            CHECK (tokens_used IS NULL OR tokens_used BETWEEN 0 AND 1000000000000),
          time_used_seconds INTEGER
            CHECK (time_used_seconds IS NULL OR time_used_seconds BETWEEN 0 AND 315360000),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synchronized_at TEXT,
          PRIMARY KEY (conversation_id, source),
          CHECK (
            (source = 'codex-native' AND provider_session_id IS NOT NULL)
            OR (source = 'inertia-local' AND provider_session_id IS NULL)
          ),
          CHECK (created_at <= updated_at)
        );
        CREATE INDEX IF NOT EXISTS agent_goals_status_updated_idx
          ON agent_goals(status, updated_at DESC);
      `,
    });
    migrationExtensions.push({
      name: "DisableAutomaticPlanPanelReveal",
      up: `
        UPDATE app_state SET auto_open_plan = 0;
      `,
    });
    migrationExtensions.push({
      name: "OptimizeConversationDetailIndexes",
      up: `
        CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
          ON messages(conversation_id, created_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS activities_conversation_created_idx
          ON activities(conversation_id, created_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS reasonings_conversation_created_idx
          ON agent_reasonings(conversation_id, created_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS checkpoints_conversation_created_idx
          ON checkpoints(conversation_id, created_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS subagents_conversation_created_idx
          ON subagent_traces(
            conversation_id,
            created_at ASC,
            sequence ASC,
            id ASC
          );
      `,
    });
    migrationExtensions.push({
      name: "PersistAttachmentExecutionContext",
      up: `
        DROP TRIGGER IF EXISTS turn_execution_context_refs_prune_blob;
        CREATE TABLE turn_execution_context_refs_v35 (
          turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
          digest TEXT NOT NULL
            REFERENCES turn_execution_context_blobs(digest) ON DELETE RESTRICT,
          kind TEXT NOT NULL CHECK (
            kind IN (
              'attachment', 'file', 'diff', 'terminal', 'preview', 'review-note'
            )
          ),
          label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 4096),
          byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          PRIMARY KEY (turn_id, ordinal)
        );
        INSERT INTO turn_execution_context_refs_v35 (
          turn_id, ordinal, digest, kind, label, byte_size, truncated
        )
        SELECT turn_id, ordinal, digest, kind, label, byte_size, truncated
        FROM turn_execution_context_refs;
        DROP TABLE turn_execution_context_refs;
        ALTER TABLE turn_execution_context_refs_v35
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
      `,
    });
    migrationExtensions.push({
      name: "PreserveProviderSubagentStatus",
      up: `
        CREATE TABLE subagent_traces_v36 (
          id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
          turn_id TEXT NOT NULL
            REFERENCES agent_turns(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL
            CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
          provider_task_id TEXT
            CHECK (provider_task_id IS NULL OR length(provider_task_id) BETWEEN 1 AND 1000),
          provider_agent_id TEXT
            CHECK (provider_agent_id IS NULL OR length(provider_agent_id) BETWEEN 1 AND 1000),
          parent_trace_id TEXT
            REFERENCES subagent_traces_v36(id) ON DELETE SET NULL,
          parent_provider_agent_id TEXT
            CHECK (parent_provider_agent_id IS NULL OR length(parent_provider_agent_id) BETWEEN 1 AND 1000),
          parent_provider_tool_use_id TEXT
            CHECK (parent_provider_tool_use_id IS NULL OR length(parent_provider_tool_use_id) BETWEEN 1 AND 1000),
          provider_tool_use_id TEXT
            CHECK (provider_tool_use_id IS NULL OR length(provider_tool_use_id) BETWEEN 1 AND 1000),
          provider_role TEXT
            CHECK (provider_role IS NULL OR length(provider_role) BETWEEN 1 AND 200),
          provider_name TEXT
            CHECK (provider_name IS NULL OR length(provider_name) BETWEEN 1 AND 200),
          provider_status TEXT
            CHECK (provider_status IS NULL OR length(provider_status) BETWEEN 1 AND 200),
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'spawned', 'running', 'waiting', 'completed', 'failed',
            'cancelled', 'interrupted', 'unknown', 'lost'
          )),
          description TEXT
            CHECK (description IS NULL OR length(description) BETWEEN 1 AND 4000),
          progress TEXT
            CHECK (progress IS NULL OR length(progress) BETWEEN 1 AND 4000),
          result TEXT
            CHECK (result IS NULL OR length(result) BETWEEN 1 AND 16000),
          sequence INTEGER NOT NULL
            CHECK (sequence BETWEEN 0 AND 2147483647),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (provider_task_id IS NOT NULL OR provider_agent_id IS NOT NULL),
          CHECK (created_at <= updated_at)
        );
        INSERT INTO subagent_traces_v36 (
          id, conversation_id, run_id, turn_id, provider_id,
          provider_task_id, provider_agent_id, parent_trace_id,
          parent_provider_agent_id, parent_provider_tool_use_id,
          provider_tool_use_id, provider_role, provider_name, provider_status,
          status, description, progress, result, sequence, created_at, updated_at
        )
        SELECT
          id, conversation_id, run_id, turn_id, provider_id,
          provider_task_id, provider_agent_id, parent_trace_id,
          parent_provider_agent_id, parent_provider_tool_use_id,
          provider_tool_use_id, provider_role, provider_name, NULL,
          status, description, progress, result, sequence, created_at, updated_at
        FROM subagent_traces;
        DROP TABLE subagent_traces;
        ALTER TABLE subagent_traces_v36 RENAME TO subagent_traces;
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
      `,
    });
    migrationExtensions.push({
      name: "PreserveProviderSubagentLiveness",
      up: `
        ALTER TABLE subagent_traces
          ADD COLUMN is_live INTEGER NOT NULL DEFAULT 0
          CHECK (is_live IN (0, 1));
        UPDATE subagent_traces
        SET is_live = 1
        WHERE status IN ('queued', 'spawned', 'running', 'waiting');
      `,
    });
    migrationExtensions.push({
      name: "PersistAtomicDuoLaunches",
      up: `
        CREATE TABLE IF NOT EXISTS paired_launches (
          id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
          status TEXT NOT NULL CHECK (status IN (
            'preparing', 'prepared', 'dispatching', 'running', 'cancelled',
            'failed', 'interrupted', 'recovery-required'
          )),
          cancel_requested INTEGER NOT NULL DEFAULT 0
            CHECK (cancel_requested IN (0, 1)),
          failure_message TEXT
            CHECK (failure_message IS NULL OR length(failure_message) <= 2000),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (created_at <= updated_at)
        );
        CREATE TABLE IF NOT EXISTS paired_launch_sides (
          launch_id TEXT NOT NULL
            REFERENCES paired_launches(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          planned_conversation_id TEXT NOT NULL UNIQUE
            CHECK (length(planned_conversation_id) BETWEEN 1 AND 200),
          conversation_id TEXT UNIQUE
            REFERENCES conversations(id) ON DELETE SET NULL,
          turn_id TEXT UNIQUE REFERENCES agent_turns(id) ON DELETE SET NULL,
          planned_worktree_path TEXT
            CHECK (planned_worktree_path IS NULL OR length(planned_worktree_path) <= 4096),
          planned_branch TEXT
            CHECK (planned_branch IS NULL OR length(planned_branch) <= 255),
          owns_worktree INTEGER NOT NULL DEFAULT 0
            CHECK (owns_worktree IN (0, 1)),
          dispatch_state TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN (
            'pending', 'claimed', 'started', 'failed', 'cancelled', 'uncertain'
          )),
          PRIMARY KEY (launch_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS paired_launches_status_updated_idx
          ON paired_launches(status, updated_at ASC, id ASC);
        CREATE TRIGGER IF NOT EXISTS paired_launches_conversation_delete
        BEFORE DELETE ON conversations
        BEGIN
          SELECT RAISE(
            ABORT,
            'Cancel the active Duo launch before deleting this thread.'
          )
          WHERE EXISTS (
            SELECT 1
            FROM paired_launches AS launch
            JOIN paired_launch_sides AS conversation_side
              ON conversation_side.launch_id = launch.id
            WHERE conversation_side.conversation_id = OLD.id
              AND (
                launch.status IN (
                  'preparing', 'prepared', 'dispatching', 'recovery-required'
                )
                OR EXISTS (
                  SELECT 1
                  FROM paired_launch_sides AS live_side
                  JOIN agent_turns AS live_turn ON live_turn.id = live_side.turn_id
                  WHERE live_side.launch_id = launch.id
                    AND live_turn.status NOT IN (
                      'completed', 'failed', 'cancelled', 'interrupted'
                    )
                )
                OR (
                  launch.status = 'running'
                  AND EXISTS (
                    SELECT 1
                    FROM paired_launch_sides AS missing_turn
                    WHERE missing_turn.launch_id = launch.id
                      AND missing_turn.turn_id IS NULL
                  )
                )
              )
          );
          DELETE FROM paired_launches
          WHERE id IN (
            SELECT launch_id FROM paired_launch_sides
            WHERE conversation_id = OLD.id
          );
        END;
        CREATE TRIGGER IF NOT EXISTS paired_launches_project_delete
        BEFORE DELETE ON projects
        BEGIN
          SELECT RAISE(
            ABORT,
            'Cancel the active Duo launch before removing this project.'
          )
          WHERE EXISTS (
            SELECT 1
            FROM paired_launches AS launch
            JOIN paired_launch_sides AS project_side
              ON project_side.launch_id = launch.id
            WHERE project_side.project_id = OLD.id
              AND (
                launch.status IN (
                  'preparing', 'prepared', 'dispatching', 'recovery-required'
                )
                OR EXISTS (
                  SELECT 1
                  FROM paired_launch_sides AS live_side
                  JOIN agent_turns AS live_turn ON live_turn.id = live_side.turn_id
                  WHERE live_side.launch_id = launch.id
                    AND live_turn.status NOT IN (
                      'completed', 'failed', 'cancelled', 'interrupted'
                    )
                )
                OR (
                  launch.status = 'running'
                  AND EXISTS (
                    SELECT 1
                    FROM paired_launch_sides AS missing_turn
                    WHERE missing_turn.launch_id = launch.id
                      AND missing_turn.turn_id IS NULL
                  )
                )
              )
          );
          DELETE FROM paired_launches
          WHERE id IN (
            SELECT launch_id FROM paired_launch_sides
            WHERE project_id = OLD.id
          );
        END;
      `,
    });
    migrationExtensions.push({
      name: "PersistDuoWorktreeCleanupReceipts",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(paired_launch_sides)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "cleanup_branch_head")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_branch_head TEXT
              CHECK (
                cleanup_branch_head IS NULL
                OR length(cleanup_branch_head) BETWEEN 40 AND 64
              );
          `);
        }
        if (!columns.some(({ name }) => name === "worktree_creation_state")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN worktree_creation_state TEXT NOT NULL DEFAULT 'pending'
              CHECK (
                worktree_creation_state IN (
                  'pending', 'creating', 'created', 'not-created'
                )
                AND (
                  worktree_creation_state = 'created'
                  OR cleanup_branch_head IS NULL
                )
              );
          `);
        }
        if (!columns.some(({ name }) => name === "worktree_removal_confirmed")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN worktree_removal_confirmed INTEGER NOT NULL DEFAULT 0
              CHECK (
                worktree_removal_confirmed IN (0, 1)
                AND (
                  worktree_removal_confirmed = 0
                  OR cleanup_branch_head IS NOT NULL
                )
              );
          `);
        }
        if (!columns.some(({ name }) => name === "worktree_removal_started")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN worktree_removal_started INTEGER NOT NULL DEFAULT 0
              CHECK (worktree_removal_started IN (0, 1));
          `);
        }
        if (!columns.some(({ name }) => name === "worktree_cleanup_outcome")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN worktree_cleanup_outcome TEXT
              CHECK (
                worktree_cleanup_outcome IS NULL
                OR worktree_cleanup_outcome IN ('absent', 'retained')
              );
          `);
        }
        if (!columns.some(({ name }) => name === "branch_cleanup_outcome")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN branch_cleanup_outcome TEXT
              CHECK (
                branch_cleanup_outcome IS NULL
                OR (
                  branch_cleanup_outcome IN ('absent', 'retained')
                  AND worktree_cleanup_outcome = 'absent'
                  AND cleanup_branch_head IS NOT NULL
                )
              );
          `);
        }
        database.exec(`
          UPDATE paired_launch_sides
          SET worktree_removal_started = 1
          WHERE worktree_removal_confirmed = 1;
        `);
      },
    });
    migrationExtensions.push({
      name: "PersistDuoWorktreeRegistrationIdentity",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(paired_launch_sides)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "cleanup_worktree_token")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_worktree_token TEXT
              CHECK (
                cleanup_worktree_token IS NULL
                OR length(cleanup_worktree_token) = 36
              );
          `);
        }
        if (!columns.some(({ name }) => name === "cleanup_worktree_id")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_worktree_id TEXT
              CHECK (
                cleanup_worktree_id IS NULL
                OR length(cleanup_worktree_id) BETWEEN 1 AND 255
              );
          `);
        }
        if (!columns.some(({ name }) => name === "cleanup_repository_identity")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_repository_identity TEXT
              CHECK (
                cleanup_repository_identity IS NULL
                OR length(cleanup_repository_identity) = 64
              );
          `);
        }
        if (!columns.some(({ name }) => name === "worktree_cleanup_topology")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN worktree_cleanup_topology TEXT
              CHECK (
                worktree_cleanup_topology IS NULL
                OR worktree_cleanup_topology IN ('owned', 'conflict')
              );
          `);
        }
        if (!columns.some(({ name }) => name === "cleanup_observed_path")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_observed_path TEXT
              CHECK (
                cleanup_observed_path IS NULL
                OR length(cleanup_observed_path) <= 4096
              );
          `);
        }
        if (!columns.some(({ name }) => name === "cleanup_observed_branch")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_observed_branch TEXT
              CHECK (
                cleanup_observed_branch IS NULL
                OR length(cleanup_observed_branch) <= 255
              );
          `);
        }
        if (!columns.some(({ name }) => name === "cleanup_observed_head")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_observed_head TEXT
              CHECK (
                cleanup_observed_head IS NULL
                OR length(cleanup_observed_head) BETWEEN 40 AND 64
              );
          `);
        }
        rebuildPairedLaunchProjectDeletionTrigger(database);
      },
    });
    migrationExtensions.push({
      name: "PersistDuoWorktreeFilesystemIdentity",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(paired_launch_sides)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) =>
          name === "cleanup_filesystem_identity_json")) {
          database.exec(`
            ALTER TABLE paired_launch_sides
              ADD COLUMN cleanup_filesystem_identity_json TEXT
              CHECK (
                cleanup_filesystem_identity_json IS NULL
                OR length(cleanup_filesystem_identity_json) BETWEEN 1 AND 1024
              );
          `);
        }
      },
    });
    const runtimeMigrations = createRuntimeMigrationCatalog(
      legacyMigrations,
      migrationExtensions,
    );
    runDatabaseMigrations(database, runtimeMigrations, {
      onDiagnostic: (diagnostic) => {
        if (diagnostic.outcome === "failed") {
          console.error(formatMigrationDiagnostic(diagnostic));
        } else if (
          diagnostic.appliedVersions.length > 0
          && (
            diagnostic.sourceReleases.length > 0
            || (diagnostic.legacyBackfill?.responseGroups ?? 0) > 0
          )
        ) {
          console.info(formatMigrationDiagnostic(diagnostic));
        }
      },
    });
  }

function ensureTurnAssociationColumns(database: Database.Database): void {
    const associations = [
      ["messages", "turn_id"],
      ["activities", "turn_id"],
      ["agent_reasonings", "turn_id"],
      ["agent_plans", "turn_id"],
      ["thread_usage", "turn_id"],
      ["checkpoints", "turn_id"],
    ] as const;
    for (const [table, column] of associations) {
      const tableSql = quotedSqlIdentifier(table, TURN_ASSOCIATION_TABLES);
      const columnSql = quotedSqlIdentifier(
        column,
        TURN_ASSOCIATION_COLUMNS,
      );
      const columns = database.prepare(`PRAGMA table_info(${tableSql})`).all() as Array<{ name: string }>;
      if (columns.some(({ name }) => name === column)) continue;
      database.exec(`ALTER TABLE ${tableSql} ADD COLUMN ${columnSql} TEXT REFERENCES agent_turns(id) ON DELETE SET NULL`);
    }
  }
