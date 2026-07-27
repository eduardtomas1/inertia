/**
 * Released schema migrations 1–17. These strings are immutable historical
 * artifacts: append new migrations to the runtime catalog instead of editing
 * or reordering this list.
 */
export const LEGACY_SCHEMA_SQL = [
  `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ready', 'working', 'attention')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX conversations_project_id_idx ON conversations(project_id);

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX messages_conversation_id_idx ON messages(conversation_id);

    CREATE TABLE app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
      compact_sidebar INTEGER NOT NULL CHECK (compact_sidebar IN (0, 1)),
      show_timestamps INTEGER NOT NULL CHECK (show_timestamps IN (0, 1)),
      terminal_font_size INTEGER NOT NULL CHECK (terminal_font_size BETWEEN 11 AND 22),
      active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      active_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
    );
  `,
  `
    ALTER TABLE conversations ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'codex';
    ALTER TABLE conversations ADD COLUMN model TEXT NOT NULL DEFAULT '';
    ALTER TABLE conversations ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'build';
    ALTER TABLE conversations ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'supervised';
    ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
    ALTER TABLE conversations ADD COLUMN branch TEXT;
    ALTER TABLE conversations ADD COLUMN worktree_path TEXT;
    ALTER TABLE conversations ADD COLUMN provider_session_id TEXT;
    ALTER TABLE conversations ADD COLUMN archived_at TEXT;
    ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';

    ALTER TABLE app_state ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'codex';
    ALTER TABLE app_state ADD COLUMN default_model TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_state ADD COLUMN default_access_mode TEXT NOT NULL DEFAULT 'supervised';
    ALTER TABLE app_state ADD COLUMN new_thread_mode TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE app_state ADD COLUMN wrap_diffs INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE app_state ADD COLUMN ignore_whitespace INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('status', 'tool', 'command', 'file', 'reasoning', 'error')),
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX activities_conversation_id_idx ON activities(conversation_id, created_at);

    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      label TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      files_changed INTEGER NOT NULL DEFAULT 0,
      insertions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX checkpoints_conversation_id_idx ON checkpoints(conversation_id, turn_index);
  `,
  `
    CREATE TABLE agent_plans (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      explanation TEXT,
      steps_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';

    ALTER TABLE app_state ADD COLUMN show_thinking INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE app_state ADD COLUMN show_usage INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE app_state ADD COLUMN auto_open_plan INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE app_state ADD COLUMN confirm_destructive_actions INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE app_state ADD COLUMN default_reasoning_effort TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_state ADD COLUMN default_interaction_mode TEXT NOT NULL DEFAULT 'build';

    CREATE TABLE agent_reasonings (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX agent_reasonings_conversation_id_idx ON agent_reasonings(conversation_id, created_at);

    CREATE TABLE thread_usage (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      used_tokens INTEGER NOT NULL,
      total_processed_tokens INTEGER,
      max_tokens INTEGER,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      compacts_automatically INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE provider_metadata_cache (
      provider_id TEXT PRIMARY KEY CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
      executable TEXT CHECK (executable IS NULL OR length(executable) <= 4096),
      version TEXT CHECK (version IS NULL OR length(version) <= 200),
      auth_state TEXT CHECK (auth_state IS NULL OR auth_state IN ('checking', 'authenticated', 'unauthenticated', 'configured', 'unknown', 'error')),
      models_json TEXT NOT NULL DEFAULT '[]' CHECK (length(models_json) <= 262144),
      models_updated_at TEXT,
      models_last_attempted_at TEXT,
      models_provenance TEXT CHECK (models_provenance IS NULL OR models_provenance IN ('provider', 'session', 'persistent-cache')),
      models_stale INTEGER NOT NULL DEFAULT 0 CHECK (models_stale IN (0, 1)),
      rate_limits_json TEXT NOT NULL DEFAULT '[]' CHECK (length(rate_limits_json) <= 65536),
      rate_limits_updated_at TEXT,
      rate_limits_last_attempted_at TEXT,
      rate_limits_provenance TEXT CHECK (rate_limits_provenance IS NULL OR rate_limits_provenance IN ('provider', 'session', 'persistent-cache')),
      rate_limits_stale INTEGER NOT NULL DEFAULT 0 CHECK (rate_limits_stale IN (0, 1))
    );
  `,
  `
    CREATE TABLE thread_usage_v2 (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      used_tokens INTEGER,
      total_processed_tokens INTEGER,
      total_processed_scope TEXT CHECK (total_processed_scope IS NULL OR total_processed_scope IN ('thread', 'session', 'run')),
      max_tokens INTEGER,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      cache_write_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      compacts_automatically INTEGER CHECK (compacts_automatically IS NULL OR compacts_automatically IN (0, 1)),
      updated_at TEXT NOT NULL
    );
    INSERT INTO thread_usage_v2 (
      conversation_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens,
      input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
      reasoning_output_tokens, compacts_automatically, updated_at
    )
    SELECT
      usage.conversation_id,
      CASE WHEN conversations.provider_id = 'codex' THEN usage.used_tokens ELSE NULL END,
      CASE WHEN conversations.provider_id IN ('codex', 'cursor') THEN usage.total_processed_tokens ELSE NULL END,
      CASE conversations.provider_id WHEN 'codex' THEN 'thread' WHEN 'cursor' THEN 'session' ELSE NULL END,
      usage.max_tokens, usage.input_tokens, usage.cached_input_tokens, NULL, usage.output_tokens,
      usage.reasoning_output_tokens, NULL, usage.updated_at
    FROM thread_usage AS usage
    JOIN conversations ON conversations.id = usage.conversation_id;
    DROP TABLE thread_usage;
    ALTER TABLE thread_usage_v2 RENAME TO thread_usage;
  `,
  `
    CREATE TABLE diff_review_summaries (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 8),
      provider_id TEXT NOT NULL CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
      overall TEXT NOT NULL CHECK (length(overall) <= 4000),
      files_json TEXT NOT NULL CHECK (length(files_json) <= 262144),
      generated_at TEXT NOT NULL
    );

    CREATE TABLE workspace_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('agent', 'check', 'service', 'source-control')),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
      detail TEXT CHECK (detail IS NULL OR length(detail) <= 1000),
      status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
      port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX workspace_runs_started_at_idx ON workspace_runs(started_at DESC);
    CREATE INDEX workspace_runs_active_idx ON workspace_runs(status, started_at DESC);
  `,
  `
    CREATE TABLE diff_review_summaries_sha256 (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) IN (8, 64)),
      provider_id TEXT NOT NULL CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
      overall TEXT NOT NULL CHECK (length(overall) <= 4000),
      files_json TEXT NOT NULL CHECK (length(files_json) <= 262144),
      generated_at TEXT NOT NULL
    );
    INSERT INTO diff_review_summaries_sha256
      (conversation_id, fingerprint, provider_id, overall, files_json, generated_at)
    SELECT conversation_id, fingerprint, provider_id, overall, files_json, generated_at
    FROM diff_review_summaries;
    DROP TABLE diff_review_summaries;
    ALTER TABLE diff_review_summaries_sha256 RENAME TO diff_review_summaries;
  `,
  `
    CREATE TABLE diff_review_states (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('file', 'hunk')),
      path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
      hunk_id TEXT NOT NULL DEFAULT '' CHECK (length(hunk_id) <= 128),
      target_fingerprint TEXT NOT NULL CHECK (length(target_fingerprint) = 64),
      reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, scope, path, hunk_id)
    );
    CREATE INDEX diff_review_states_conversation_idx ON diff_review_states(conversation_id, stale, reviewed);

    CREATE TABLE diff_review_notes (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
      hunk_id TEXT NOT NULL DEFAULT '' CHECK (length(hunk_id) <= 128),
      line_ids_json TEXT NOT NULL CHECK (length(line_ids_json) <= 65536),
      target_fingerprint TEXT NOT NULL CHECK (length(target_fingerprint) = 64),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX diff_review_notes_conversation_idx ON diff_review_notes(conversation_id, path, hunk_id);
  `,
  `
    ALTER TABLE app_state ADD COLUMN response_density TEXT NOT NULL DEFAULT 'default'
      CHECK (response_density IN ('compact', 'default', 'comfortable'));
    ALTER TABLE app_state ADD COLUMN default_code_wrap INTEGER NOT NULL DEFAULT 0
      CHECK (default_code_wrap IN (0, 1));
    ALTER TABLE app_state ADD COLUMN auto_collapse_work_log INTEGER NOT NULL DEFAULT 1
      CHECK (auto_collapse_work_log IN (0, 1));
    ALTER TABLE app_state ADD COLUMN show_changed_file_summaries INTEGER NOT NULL DEFAULT 1
      CHECK (show_changed_file_summaries IN (0, 1));
  `,
  `
    ALTER TABLE projects ADD COLUMN normalized_path TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN repository_identity TEXT;
    ALTER TABLE projects ADD COLUMN repository_root TEXT;
    ALTER TABLE projects ADD COLUMN repository_relative_path TEXT NOT NULL DEFAULT '.';
    ALTER TABLE projects ADD COLUMN grouping_mode TEXT
      CHECK (grouping_mode IS NULL OR grouping_mode IN ('repository', 'repository-path', 'separate'));
    UPDATE projects SET normalized_path = path WHERE normalized_path = '';
    CREATE INDEX projects_repository_identity_idx ON projects(repository_identity, repository_relative_path);

    ALTER TABLE conversations ADD COLUMN attention_kind TEXT
      CHECK (attention_kind IS NULL OR attention_kind IN ('approval', 'input'));
    ALTER TABLE conversations ADD COLUMN settled_at TEXT;
    ALTER TABLE conversations ADD COLUMN completed_at TEXT;
    ALTER TABLE conversations ADD COLUMN last_viewed_at TEXT;
    UPDATE conversations
      SET completed_at = CASE WHEN status = 'completed' THEN updated_at ELSE NULL END,
          last_viewed_at = updated_at;
    CREATE INDEX conversations_activity_idx ON conversations(settled_at, status, updated_at DESC);

    ALTER TABLE app_state ADD COLUMN sidebar_mode TEXT NOT NULL DEFAULT 'classic'
      CHECK (sidebar_mode IN ('classic', 'activity'));
    ALTER TABLE app_state ADD COLUMN project_grouping TEXT NOT NULL DEFAULT 'separate'
      CHECK (project_grouping IN ('repository', 'repository-path', 'separate'));
  `,
  `
    ALTER TABLE workspace_runs ADD COLUMN action_id TEXT
      CHECK (action_id IS NULL OR length(action_id) BETWEEN 1 AND 200);
    CREATE INDEX workspace_runs_action_idx ON workspace_runs(project_id, action_id, started_at DESC);
  `,
  `
    ALTER TABLE app_state ADD COLUMN codex_binary_path TEXT NOT NULL DEFAULT ''
      CHECK (length(codex_binary_path) <= 4096);
  `,
  `
    ALTER TABLE app_state ADD COLUMN interface_scale TEXT NOT NULL DEFAULT 'default'
      CHECK (interface_scale IN ('compact', 'default', 'comfortable', 'large'));
  `,
  `
    ALTER TABLE app_state ADD COLUMN usage_display_mode TEXT NOT NULL DEFAULT 'expanded'
      CHECK (usage_display_mode IN ('expanded', 'compact', 'hidden'));
    UPDATE app_state SET usage_display_mode = 'hidden' WHERE show_usage = 0;
  `,
  `
    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 200),
      user_message_id TEXT NOT NULL CHECK (length(user_message_id) BETWEEN 1 AND 200),
      terminal_assistant_message_id TEXT
        CHECK (terminal_assistant_message_id IS NULL OR length(terminal_assistant_message_id) BETWEEN 1 AND 200),
      provider_id TEXT NOT NULL CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
      harness_id TEXT NOT NULL CHECK (length(harness_id) BETWEEN 1 AND 200),
      backend_profile_id TEXT NOT NULL CHECK (length(backend_profile_id) BETWEEN 1 AND 200),
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 300),
      model_alias TEXT CHECK (model_alias IS NULL OR length(model_alias) BETWEEN 1 AND 300),
      reasoning_effort TEXT NOT NULL CHECK (length(reasoning_effort) <= 80),
      interaction_mode TEXT NOT NULL CHECK (interaction_mode IN ('build', 'plan')),
      access_mode TEXT NOT NULL CHECK (access_mode IN ('supervised', 'auto-edit', 'full')),
      provider_session_before TEXT
        CHECK (provider_session_before IS NULL OR length(provider_session_before) BETWEEN 1 AND 1000),
      provider_session_after TEXT
        CHECK (provider_session_after IS NULL OR length(provider_session_after) BETWEEN 1 AND 1000),
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input',
        'completed', 'failed', 'cancelled', 'interrupted'
      )),
      terminal_reason TEXT CHECK (terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 4000),
      checkpoint_id TEXT CHECK (checkpoint_id IS NULL OR length(checkpoint_id) BETWEEN 1 AND 200),
      usage_start_json TEXT CHECK (usage_start_json IS NULL OR length(usage_start_json) <= 16384),
      usage_completion_json TEXT CHECK (usage_completion_json IS NULL OR length(usage_completion_json) <= 16384),
      configuration_revision INTEGER NOT NULL CHECK (configuration_revision >= 0),
      association TEXT NOT NULL CHECK (association IN ('authoritative', 'inferred')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (started_at IS NULL OR started_at >= requested_at),
      CHECK (started_at IS NULL OR started_at <= updated_at),
      CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)),
      CHECK (completed_at IS NULL OR completed_at <= updated_at),
      CHECK (
        (status IN ('completed', 'failed', 'cancelled', 'interrupted') AND completed_at IS NOT NULL)
        OR
        (status NOT IN ('completed', 'failed', 'cancelled', 'interrupted') AND completed_at IS NULL)
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
    CREATE INDEX IF NOT EXISTS agent_turns_conversation_requested_idx
      ON agent_turns(conversation_id, requested_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS agent_turns_status_requested_idx
      ON agent_turns(status, requested_at ASC);
  `,
  `
    CREATE INDEX IF NOT EXISTS messages_conversation_turn_created_idx
      ON messages(conversation_id, turn_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS activities_conversation_turn_created_idx
      ON activities(conversation_id, turn_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS agent_reasonings_conversation_turn_created_idx
      ON agent_reasonings(conversation_id, turn_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS agent_plans_conversation_turn_idx
      ON agent_plans(conversation_id, turn_id);
    CREATE INDEX IF NOT EXISTS thread_usage_conversation_turn_idx
      ON thread_usage(conversation_id, turn_id);
    CREATE INDEX IF NOT EXISTS checkpoints_conversation_turn_created_idx
      ON checkpoints(conversation_id, turn_id, created_at ASC, id ASC);
  `,
] as const;
