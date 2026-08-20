import type { DatabaseMigrationDefinition } from "./catalog";
import { protectCancellingDuoDeletion } from "./duo-deletion-trigger";

/**
 * Widen the released provider constraints without rewriting historical
 * migrations. SQLite cannot alter an unnamed CHECK constraint in place, so
 * each affected table is rebuilt byte-for-byte with only Kimi's provider and
 * harness identities added.
 */
export const nativeKimiProviderMigration: DatabaseMigrationDefinition = {
  name: "SupportNativeKimiProvider",
  foreignKeys: "off",
  up: (database) => {
    database.exec(`
    CREATE TABLE provider_metadata_cache_v61 (
      provider_id TEXT PRIMARY KEY
        CHECK (provider_id IN ('codex', 'claude', 'cursor', 'kimi', 'opencode')),
      executable TEXT CHECK (executable IS NULL OR length(executable) <= 4096),
      version TEXT CHECK (version IS NULL OR length(version) <= 200),
      auth_state TEXT CHECK (
        auth_state IS NULL
        OR auth_state IN (
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
    INSERT INTO provider_metadata_cache_v61 (
      provider_id, executable, version, auth_state,
      models_json, models_updated_at, models_last_attempted_at,
      models_provenance, models_stale, rate_limits_json,
      rate_limits_updated_at, rate_limits_last_attempted_at,
      rate_limits_provenance, rate_limits_stale
    )
    SELECT
      provider_id, executable, version, auth_state,
      models_json, models_updated_at, models_last_attempted_at,
      models_provenance, models_stale, rate_limits_json,
      rate_limits_updated_at, rate_limits_last_attempted_at,
      rate_limits_provenance, rate_limits_stale
    FROM provider_metadata_cache;
    DROP TABLE provider_metadata_cache;
    ALTER TABLE provider_metadata_cache_v61 RENAME TO provider_metadata_cache;

    CREATE TABLE diff_review_summaries_v61 (
      conversation_id TEXT PRIMARY KEY
        REFERENCES conversations(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) IN (8, 64)),
      provider_id TEXT NOT NULL
        CHECK (provider_id IN ('codex', 'claude', 'cursor', 'kimi', 'opencode')),
      overall TEXT NOT NULL CHECK (length(overall) <= 4000),
      files_json TEXT NOT NULL CHECK (length(files_json) <= 262144),
      generated_at TEXT NOT NULL,
      summary_json TEXT
        CHECK (summary_json IS NULL OR length(summary_json) <= 524288)
    );
    INSERT INTO diff_review_summaries_v61 (
      conversation_id, fingerprint, provider_id, overall, files_json,
      generated_at, summary_json
    )
    SELECT
      conversation_id, fingerprint, provider_id, overall, files_json,
      generated_at, summary_json
    FROM diff_review_summaries;
    DROP TABLE diff_review_summaries;
    ALTER TABLE diff_review_summaries_v61 RENAME TO diff_review_summaries;

    CREATE TABLE provider_metadata_scoped_cache_v61 (
      scope_key TEXT PRIMARY KEY CHECK (length(scope_key) BETWEEN 2 AND 8192),
      provider_id TEXT NOT NULL CHECK (
        provider_id IN ('codex', 'claude', 'cursor', 'kimi', 'opencode')
      ),
      harness_id TEXT NOT NULL CHECK (
        harness_id IN (
          'codex-app-server', 'codex-cli', 'claude-agent-sdk', 'claude-cli',
          'cursor-acp', 'cursor-cli', 'kimi-acp',
          'opencode-sdk', 'opencode-cli'
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
    INSERT INTO provider_metadata_scoped_cache_v61 (
      scope_key, provider_id, harness_id, backend_profile_id, model_id,
      executable, version, backend_configuration_revision, auth_state,
      models_json, models_updated_at, models_last_attempted_at,
      models_provenance, models_stale, rate_limits_json,
      rate_limits_updated_at, rate_limits_last_attempted_at,
      rate_limits_provenance, rate_limits_stale
    )
    SELECT
      scope_key, provider_id, harness_id, backend_profile_id, model_id,
      executable, version, backend_configuration_revision, auth_state,
      models_json, models_updated_at, models_last_attempted_at,
      models_provenance, models_stale, rate_limits_json,
      rate_limits_updated_at, rate_limits_last_attempted_at,
      rate_limits_provenance, rate_limits_stale
    FROM provider_metadata_scoped_cache;
    DROP TABLE provider_metadata_scoped_cache;
    ALTER TABLE provider_metadata_scoped_cache_v61
      RENAME TO provider_metadata_scoped_cache;
    CREATE INDEX provider_metadata_scoped_identity_idx
      ON provider_metadata_scoped_cache(
        provider_id, harness_id, backend_profile_id, model_id,
        backend_configuration_revision
      );

    DROP TRIGGER IF EXISTS paired_launches_conversation_delete;
    DROP TRIGGER IF EXISTS paired_launches_project_delete;

    CREATE TABLE agent_turns_v61 (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 200),
      user_message_id TEXT NOT NULL CHECK (length(user_message_id) BETWEEN 1 AND 200),
      terminal_assistant_message_id TEXT CHECK (
        terminal_assistant_message_id IS NULL
        OR length(terminal_assistant_message_id) BETWEEN 1 AND 200
      ),
      provider_id TEXT NOT NULL
        CHECK (provider_id IN ('codex', 'claude', 'cursor', 'kimi', 'opencode')),
      harness_id TEXT NOT NULL CHECK (length(harness_id) BETWEEN 1 AND 200),
      backend_profile_id TEXT NOT NULL
        CHECK (length(backend_profile_id) BETWEEN 1 AND 200),
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 300),
      model_alias TEXT
        CHECK (model_alias IS NULL OR length(model_alias) BETWEEN 1 AND 300),
      reasoning_effort TEXT NOT NULL CHECK (length(reasoning_effort) <= 80),
      interaction_mode TEXT NOT NULL CHECK (interaction_mode IN ('build', 'plan')),
      access_mode TEXT NOT NULL
        CHECK (access_mode IN ('supervised', 'auto-edit', 'full')),
      provider_session_before TEXT CHECK (
        provider_session_before IS NULL
        OR length(provider_session_before) BETWEEN 1 AND 1000
      ),
      provider_session_after TEXT CHECK (
        provider_session_after IS NULL
        OR length(provider_session_after) BETWEEN 1 AND 1000
      ),
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'starting', 'running', 'waiting-for-approval',
        'waiting-for-input', 'completed', 'failed', 'cancelled', 'interrupted'
      )),
      terminal_reason TEXT
        CHECK (terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 4000),
      checkpoint_id TEXT
        CHECK (checkpoint_id IS NULL OR length(checkpoint_id) BETWEEN 1 AND 200),
      usage_start_json TEXT
        CHECK (usage_start_json IS NULL OR length(usage_start_json) <= 16384),
      usage_completion_json TEXT CHECK (
        usage_completion_json IS NULL OR length(usage_completion_json) <= 16384
      ),
      configuration_revision INTEGER NOT NULL
        CHECK (configuration_revision >= 0),
      association TEXT NOT NULL
        CHECK (association IN ('authoritative', 'inferred')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_selection_json TEXT CHECK (
        model_selection_json IS NULL OR length(model_selection_json) <= 65536
      ),
      continuation_identity_json TEXT CHECK (
        continuation_identity_json IS NULL
        OR length(continuation_identity_json) <= 4096
      ),
      CHECK (started_at IS NULL OR started_at >= requested_at),
      CHECK (started_at IS NULL OR started_at <= updated_at),
      CHECK (
        completed_at IS NULL
        OR (started_at IS NOT NULL AND completed_at >= started_at)
      ),
      CHECK (completed_at IS NULL OR completed_at <= updated_at),
      CHECK (
        (
          status IN ('completed', 'failed', 'cancelled', 'interrupted')
          AND completed_at IS NOT NULL
        )
        OR
        (
          status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
          AND completed_at IS NULL
        )
      ),
      CHECK (
        status IN ('completed', 'failed', 'cancelled', 'interrupted')
        OR (
          terminal_assistant_message_id IS NULL
          AND provider_session_after IS NULL
          AND terminal_reason IS NULL
          AND checkpoint_id IS NULL
          AND usage_completion_json IS NULL
        )
      ),
      CHECK (created_at <= updated_at)
    );
    INSERT INTO agent_turns_v61 (
      id, conversation_id, run_id, user_message_id,
      terminal_assistant_message_id, provider_id, harness_id,
      backend_profile_id, model, model_alias, reasoning_effort,
      interaction_mode, access_mode, provider_session_before,
      provider_session_after, requested_at, started_at, completed_at,
      status, terminal_reason, checkpoint_id, usage_start_json,
      usage_completion_json, configuration_revision, association,
      created_at, updated_at, model_selection_json,
      continuation_identity_json
    )
    SELECT
      id, conversation_id, run_id, user_message_id,
      terminal_assistant_message_id, provider_id, harness_id,
      backend_profile_id, model, model_alias, reasoning_effort,
      interaction_mode, access_mode, provider_session_before,
      provider_session_after, requested_at, started_at, completed_at,
      status, terminal_reason, checkpoint_id, usage_start_json,
      usage_completion_json, configuration_revision, association,
      created_at, updated_at, model_selection_json,
      continuation_identity_json
    FROM agent_turns;
    DROP TABLE agent_turns;
    ALTER TABLE agent_turns_v61 RENAME TO agent_turns;
    CREATE INDEX agent_turns_conversation_requested_idx
      ON agent_turns(conversation_id, requested_at ASC, id ASC);
    CREATE INDEX agent_turns_status_requested_idx
      ON agent_turns(status, requested_at ASC);
    CREATE UNIQUE INDEX agent_turns_provider_run_identity_idx
      ON agent_turns(id, conversation_id, run_id);
    CREATE INDEX agent_turns_usage_dashboard_completed_idx
      ON agent_turns(association, completed_at ASC, id ASC);

    CREATE TABLE subagent_traces_v61 (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
      turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL
        CHECK (provider_id IN ('codex', 'claude', 'cursor', 'kimi', 'opencode')),
      provider_task_id TEXT CHECK (
        provider_task_id IS NULL
        OR length(provider_task_id) BETWEEN 1 AND 1000
      ),
      provider_agent_id TEXT CHECK (
        provider_agent_id IS NULL
        OR length(provider_agent_id) BETWEEN 1 AND 1000
      ),
      parent_trace_id TEXT
        REFERENCES subagent_traces_v61(id) ON DELETE SET NULL,
      parent_provider_agent_id TEXT CHECK (
        parent_provider_agent_id IS NULL
        OR length(parent_provider_agent_id) BETWEEN 1 AND 1000
      ),
      parent_provider_tool_use_id TEXT CHECK (
        parent_provider_tool_use_id IS NULL
        OR length(parent_provider_tool_use_id) BETWEEN 1 AND 1000
      ),
      provider_tool_use_id TEXT CHECK (
        provider_tool_use_id IS NULL
        OR length(provider_tool_use_id) BETWEEN 1 AND 1000
      ),
      provider_role TEXT CHECK (
        provider_role IS NULL OR length(provider_role) BETWEEN 1 AND 200
      ),
      provider_name TEXT CHECK (
        provider_name IS NULL OR length(provider_name) BETWEEN 1 AND 200
      ),
      provider_status TEXT CHECK (
        provider_status IS NULL OR length(provider_status) BETWEEN 1 AND 200
      ),
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'spawned', 'running', 'waiting', 'completed', 'failed',
        'cancelled', 'interrupted', 'unknown', 'lost'
      )),
      description TEXT CHECK (
        description IS NULL OR length(description) BETWEEN 1 AND 4000
      ),
      progress TEXT CHECK (
        progress IS NULL OR length(progress) BETWEEN 1 AND 4000
      ),
      result TEXT CHECK (
        result IS NULL OR length(result) BETWEEN 1 AND 16000
      ),
      sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 2147483647),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_live INTEGER NOT NULL DEFAULT 0 CHECK (is_live IN (0, 1)),
      CHECK (provider_task_id IS NOT NULL OR provider_agent_id IS NOT NULL),
      CHECK (created_at <= updated_at)
    );
    INSERT INTO subagent_traces_v61 (
      id, conversation_id, run_id, turn_id, provider_id,
      provider_task_id, provider_agent_id, parent_trace_id,
      parent_provider_agent_id, parent_provider_tool_use_id,
      provider_tool_use_id, provider_role, provider_name, provider_status,
      status, description, progress, result, sequence, created_at,
      updated_at, is_live
    )
    SELECT
      id, conversation_id, run_id, turn_id, provider_id,
      provider_task_id, provider_agent_id, parent_trace_id,
      parent_provider_agent_id, parent_provider_tool_use_id,
      provider_tool_use_id, provider_role, provider_name, provider_status,
      status, description, progress, result, sequence, created_at,
      updated_at, is_live
    FROM subagent_traces;
    DROP TABLE subagent_traces;
    ALTER TABLE subagent_traces_v61 RENAME TO subagent_traces;
    CREATE INDEX subagent_traces_turn_order_idx
      ON subagent_traces(turn_id, created_at ASC, sequence ASC, id ASC);
    CREATE UNIQUE INDEX subagent_traces_task_identity_idx
      ON subagent_traces(
        conversation_id, run_id, provider_id, provider_task_id
      )
      WHERE provider_task_id IS NOT NULL;
    CREATE UNIQUE INDEX subagent_traces_agent_identity_idx
      ON subagent_traces(
        conversation_id, run_id, provider_id, provider_agent_id
      )
      WHERE provider_agent_id IS NOT NULL;
    CREATE INDEX subagent_traces_parent_idx
      ON subagent_traces(parent_trace_id, created_at ASC);
    CREATE INDEX subagents_conversation_created_idx
      ON subagent_traces(
        conversation_id, created_at ASC, sequence ASC, id ASC
      );
    `);
    protectCancellingDuoDeletion(database);
  },
};
