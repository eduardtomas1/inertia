import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import {
  defaultSettings,
  type AccessMode,
  type AgentActivity,
  type AgentPlan,
  type AgentReasoning,
  type AgentTurn,
  type AgentTurnAssociation,
  type AgentTurnStatus,
  type AgentTurnTerminalStatus,
  type AgentTurnUsageSnapshot,
  type AppSettings,
  type AppSnapshot,
  type ChatAttachment,
  type ChatMessage,
  type CheckpointSummary,
  type Conversation,
  type ConversationDetail,
  type ConversationLatestTurnSummary,
  type ConversationShell,
  type DiffReviewNote,
  type DiffReviewState,
  type DiffReviewSummary,
  type InteractionMode,
  type ContinuationIdentity,
  type ModelSelection,
  type Project,
  type ProjectGroupingMode,
  type ProviderId,
  type ProviderInfo,
  type SubagentTrace,
  type SubagentTraceStatus,
  type ThemePreference,
  type ThreadStatus,
  type ThreadUsageSnapshot,
  type TurnGitArtifact,
  type TurnGitArtifactAbsenceReason,
  type TurnGitArtifactCompleteness,
  type TurnGitArtifactFile,
  type TurnGitArtifactStatus,
  type TurnGitPatchState,
  type WorkspaceRun,
  canTransitionAgentTurnStatus,
  isAgentTurnTerminalStatus,
} from "../shared/contracts";
import {
  continuationIdentityForSelection,
  continuationIdentitySchema,
  knownHarnessIdSchema,
  legacyProviderIdForHarness,
  modelSelectionSchema,
  nativeBackendProfile,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../shared/model-routing";
import {
  containsBackendCredentialMaterial,
  modelBackendDefaultSchema,
  persistedModelBackendProfileSchema,
  type ModelBackendDefault,
  type PersistedModelBackendProfile,
} from "../shared/backend-profile-settings";
import {
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
} from "../shared/backend-probe";
import {
  backfillLegacyAgentTurns,
  formatMigrationDiagnostic,
  runDatabaseMigrations,
  type DatabaseMigration,
} from "./database-migrations";
import {
  nativeProviderMetadataScope,
  providerMetadataScopeKey,
  type PersistedProviderMetadata,
} from "./provider/metadata";
import { providerTimestamp, validateProviderUsage } from "./provider/usage-values";
import {
  boundedSubagentIdentifier,
  boundedSubagentText,
  isTerminalSubagentStatus,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_TRACES_PER_TURN,
} from "./provider/subagent-trace";
import {
  parsePersistedReviewSummaryJson,
  upgradeLegacyPersistedReviewSummary,
  validatePersistedReviewSummary,
} from "./review-summary";
import {
  parseSanitizedTurnExecutionManifest,
  validateExecutionContextReference,
  validatePersistedTurnExecutionContext,
  type PersistedTurnExecutionContext,
  type SanitizedTurnExecutionManifest,
} from "./runtime/turns/request-context";

const PROJECT_COLORS = ["#6f76d9", "#5b8ca8", "#8a73ba", "#a76c79", "#9a814f", "#687f91"] as const;

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  normalized_path: string;
  repository_identity: string | null;
  repository_root: string | null;
  repository_relative_path: string;
  grouping_mode: ProjectGroupingMode | null;
  color: string;
  status: Project["status"];
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  provider_id: ProviderId;
  model_selection_json: string | null;
  continuation_identity_json: string | null;
  model: string;
  reasoning_effort: string;
  interaction_mode: InteractionMode;
  access_mode: AccessMode;
  status: ThreadStatus;
  attention_kind: Conversation["attentionKind"];
  branch: string | null;
  worktree_path: string | null;
  provider_session_id: string | null;
  archived_at: string | null;
  settled_at: string | null;
  completed_at: string | null;
  last_viewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentTurnRow {
  id: string;
  conversation_id: string;
  run_id: string;
  user_message_id: string;
  terminal_assistant_message_id: string | null;
  provider_id: ProviderId;
  model_selection_json: string | null;
  continuation_identity_json: string | null;
  harness_id: string;
  backend_profile_id: string;
  model: string;
  model_alias: string | null;
  reasoning_effort: string;
  interaction_mode: InteractionMode;
  access_mode: AccessMode;
  provider_session_before: string | null;
  provider_session_after: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  status: AgentTurnStatus;
  terminal_reason: string | null;
  checkpoint_id: string | null;
  usage_start_json: string | null;
  usage_completion_json: string | null;
  configuration_revision: number;
  association: AgentTurnAssociation;
  created_at: string;
  updated_at: string;
}

interface TurnGitArtifactRow {
  id: string;
  turn_id: string;
  conversation_id: string;
  run_id: string;
  repository_identity: string | null;
  worktree_identity: string | null;
  branch: string | null;
  before_checkpoint_id: string | null;
  before_ref: string | null;
  after_ref: string | null;
  before_fingerprint: string | null;
  after_fingerprint: string | null;
  files_json: string;
  insertions: number;
  deletions: number;
  status: TurnGitArtifactStatus;
  completeness: TurnGitArtifactCompleteness;
  patch_state: TurnGitPatchState;
  patch_digest: string | null;
  captured_at: string | null;
  terminal_assistant_message_id: string | null;
  failure_reason: string | null;
  absence_reason: TurnGitArtifactAbsenceReason | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  role: ChatMessage["role"];
  content: string;
  attachments_json: string;
  created_at: string;
}

interface ActivityRow {
  id: string;
  conversation_id: string;
  run_id: string;
  turn_id: string | null;
  kind: AgentActivity["kind"];
  title: string;
  detail: string | null;
  status: AgentActivity["status"];
  created_at: string;
}

interface SubagentTraceRow {
  id: string;
  conversation_id: string;
  run_id: string;
  turn_id: string;
  provider_id: ProviderId;
  provider_task_id: string | null;
  provider_agent_id: string | null;
  parent_trace_id: string | null;
  parent_provider_agent_id: string | null;
  parent_provider_tool_use_id: string | null;
  provider_tool_use_id: string | null;
  provider_role: string | null;
  provider_name: string | null;
  status: SubagentTraceStatus;
  description: string | null;
  progress: string | null;
  result: string | null;
  sequence: number;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  ref: string;
  label: string;
  turn_index: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  created_at: string;
}

interface AgentPlanRow {
  conversation_id: string;
  run_id: string;
  turn_id: string | null;
  explanation: string | null;
  steps_json: string;
}

interface AgentReasoningRow {
  id: string;
  conversation_id: string;
  run_id: string;
  turn_id: string | null;
  content: string;
  status: AgentReasoning["status"];
  created_at: string;
}

interface ThreadUsageRow {
  conversation_id: string;
  turn_id: string | null;
  used_tokens: number | null;
  total_processed_tokens: number | null;
  total_processed_scope: ThreadUsageSnapshot["totalProcessedScope"];
  max_tokens: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  compacts_automatically: 0 | 1 | null;
  updated_at: string;
}

interface StateRow {
  theme: ThemePreference;
  compact_sidebar: 0 | 1;
  show_timestamps: 0 | 1;
  terminal_font_size: number;
  default_provider: ProviderId;
  default_model: string;
  default_access_mode: AccessMode;
  new_thread_mode: AppSettings["newThreadMode"];
  wrap_diffs: 0 | 1;
  ignore_whitespace: 0 | 1;
  show_thinking: 0 | 1;
  show_usage: 0 | 1;
  usage_display_mode: AppSettings["usageDisplayMode"];
  interface_scale: AppSettings["interfaceScale"];
  response_density: AppSettings["responseDensity"];
  default_code_wrap: 0 | 1;
  auto_collapse_work_log: 0 | 1;
  show_changed_file_summaries: 0 | 1;
  sidebar_mode: AppSettings["sidebarMode"];
  project_grouping: AppSettings["projectGrouping"];
  auto_open_plan: 0 | 1;
  confirm_destructive_actions: 0 | 1;
  default_reasoning_effort: string;
  default_interaction_mode: InteractionMode;
  codex_binary_path: string;
  active_project_id: string | null;
  active_conversation_id: string | null;
}

interface ProviderMetadataCacheRow {
  scope_key: string;
  provider_id: ProviderId;
  harness_id: PersistedProviderMetadata["scope"]["harnessId"];
  backend_profile_id: string;
  model_id: string;
  executable: string | null;
  version: string | null;
  backend_configuration_revision: number;
  auth_state: PersistedProviderMetadata["scope"]["authState"];
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
}

interface DiffReviewSummaryRow {
  conversation_id: string;
  fingerprint: string;
  provider_id: ProviderId;
  overall: string;
  files_json: string;
  generated_at: string;
  summary_json: string | null;
}

interface DiffReviewStateRow {
  conversation_id: string;
  scope: DiffReviewState["scope"];
  path: string;
  hunk_id: string;
  target_fingerprint: string;
  reviewed: 0 | 1;
  stale: 0 | 1;
  updated_at: string;
}

interface DiffReviewNoteRow {
  id: string;
  conversation_id: string;
  path: string;
  hunk_id: string;
  line_ids_json: string;
  target_fingerprint: string;
  body: string;
  stale: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRunRow {
  id: string;
  kind: WorkspaceRun["kind"];
  project_id: string;
  conversation_id: string | null;
  action_id: string | null;
  label: string;
  detail: string | null;
  status: WorkspaceRun["status"];
  attention_state?: WorkspaceRun["attentionState"];
  port: number | null;
  started_at: string;
  finished_at: string | null;
}

interface ModelBackendProfileRow {
  profile_id: string;
  harness_id: string;
  preset: string;
  protocol: string;
  source: string;
  enabled: 0 | 1;
  configuration_revision: number;
  endpoint_identity: string | null;
  credential_generation: string | null;
  configuration_json: string;
  latest_probe_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ModelBackendDefaultRow {
  scope: ModelBackendDefault["scope"];
  project_id: string | null;
  selection_json: string;
  updated_at: string;
}

const migrations = [
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

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    normalizedPath: row.normalized_path || row.path,
    repositoryIdentity: row.repository_identity,
    repositoryRoot: row.repository_root,
    repositoryRelativePath: row.repository_relative_path || ".",
    groupingMode: row.grouping_mode,
    color: row.color,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function legacyModelSelection(input: {
  providerId: ProviderId;
  harnessId: string;
  backendProfileId: string;
  model: string;
  modelAlias: string | null;
  reasoningEffort: string;
  configurationRevision: number;
}): ModelSelection {
  const native = nativeBackendProfile(input.providerId);
  const nativeProfile = input.backendProfileId === native.id;
  const backendProfileDisplayName = nativeProfile
    ? native.displayName
    : `Unavailable backend (${input.backendProfileId})`.slice(0, 200);
  return modelSelectionSchema.parse({
    harnessId: input.harnessId,
    backendProfileId: input.backendProfileId,
    backendProfileDisplayName,
    modelId: input.model || "provider-default",
    alias: input.modelAlias || null,
    reasoningEffort: input.reasoningEffort || null,
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: input.configurationRevision,
  });
}

function parseModelSelection(
  value: string | null,
  fallback: () => ModelSelection,
): ModelSelection {
  if (value !== null) {
    try {
      const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
      if (parsed.success) return parsed.data;
    } catch {
      // Preserve readable historical state through the safe flattened fallback.
    }
  }
  return fallback();
}

function legacyNativeContinuationIdentity(
  selection: ModelSelection,
): ContinuationIdentity | null {
  const providerId = legacyProviderIdForHarness(selection.harnessId);
  const harnessId = knownHarnessIdSchema.safeParse(selection.harnessId);
  if (!providerId || !harnessId.success) return null;
  const native = nativeBackendProfile(providerId);
  if (native.id !== selection.backendProfileId) return null;
  const compatibility = resolveHarnessBackendCompatibility(
    harnessId.data,
    native,
  );
  return continuationIdentityForSelection(
    selection,
    native.endpointIdentity,
    !compatibility.allowsModelSwitchWithinSession,
  );
}

function parseConversationContinuationIdentity(
  value: string | null,
  selection: ModelSelection,
): ContinuationIdentity | null {
  if (value !== null) {
    try {
      const parsed = continuationIdentitySchema.safeParse(JSON.parse(value));
      if (parsed.success) return parsed.data;
    } catch {
      // A persisted but unreadable identity must never be guessed.
    }
    return null;
  }
  return legacyNativeContinuationIdentity(selection);
}

function parseAgentTurnContinuationIdentity(
  value: string | null,
  selection: ModelSelection,
): ContinuationIdentity {
  const parsed = parseConversationContinuationIdentity(value, selection);
  if (parsed) return parsed;
  throw new Error(
    "An agent turn requires a valid, explicit continuation identity.",
  );
}

function conversationFromRow(row: ConversationRow): Conversation {
  const modelSelection = parseModelSelection(
    row.model_selection_json,
    () => nativeModelSelection({
      providerId: row.provider_id,
      modelId: row.model || "provider-default",
      alias: row.model || null,
      reasoningEffort: row.reasoning_effort || null,
    }),
  );
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    providerId: row.provider_id,
    modelSelection,
    continuationIdentity: row.provider_session_id
      ? parseConversationContinuationIdentity(
        row.continuation_identity_json,
        modelSelection,
      )
      : null,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    interactionMode: row.interaction_mode,
    accessMode: row.access_mode,
    status: row.status,
    attentionKind: row.attention_kind,
    branch: row.branch,
    worktreePath: row.worktree_path,
    providerSessionId: row.provider_session_id,
    archivedAt: row.archived_at,
    settledAt: row.settled_at,
    completedAt: row.completed_at,
    lastViewedAt: row.last_viewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conversationTurnSummary(turn: AgentTurn | null): ConversationLatestTurnSummary | null {
  if (!turn) return null;
  return {
    id: turn.id,
    runId: turn.runId,
    status: turn.status,
    providerId: turn.providerId,
    harnessId: turn.harnessId,
    backendProfileId: turn.backendProfileId,
    modelSelection: turn.modelSelection,
    continuationIdentity: turn.continuationIdentity,
    model: turn.model,
    reasoningEffort: turn.reasoningEffort,
    requestedAt: turn.requestedAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    terminalReason: turn.terminalReason,
    updatedAt: turn.updatedAt,
  };
}

function conversationShellFromRow(
  row: ConversationRow,
  latestTurn: AgentTurn | null,
): ConversationShell {
  const conversation = conversationFromRow(row);
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    providerId: conversation.providerId,
    modelSelection: conversation.modelSelection,
    continuationIdentity: conversation.continuationIdentity,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    status: conversation.status,
    attentionKind: conversation.attentionKind,
    branch: conversation.branch,
    worktreePath: conversation.worktreePath,
    providerSessionId: conversation.providerSessionId,
    archivedAt: conversation.archivedAt,
    settledAt: conversation.settledAt,
    completedAt: conversation.completedAt,
    lastViewedAt: conversation.lastViewedAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    latestTurn: conversationTurnSummary(latestTurn),
    pendingApproval: false,
    pendingInput: false,
  };
}

function settingsFromState(state: StateRow): AppSettings {
  return {
    theme: state.theme,
    compactSidebar: state.compact_sidebar === 1,
    showTimestamps: state.show_timestamps === 1,
    terminalFontSize: state.terminal_font_size,
    defaultProvider: state.default_provider,
    defaultModel: state.default_model,
    defaultAccessMode: state.default_access_mode,
    newThreadMode: state.new_thread_mode,
    wrapDiffs: state.wrap_diffs === 1,
    ignoreWhitespace: state.ignore_whitespace === 1,
    showThinking: state.show_thinking === 1,
    usageDisplayMode: state.usage_display_mode,
    interfaceScale: state.interface_scale,
    responseDensity: state.response_density,
    defaultCodeWrap: state.default_code_wrap === 1,
    autoCollapseWorkLog: state.auto_collapse_work_log === 1,
    showChangedFileSummaries: state.show_changed_file_summaries === 1,
    sidebarMode: state.sidebar_mode,
    projectGrouping: state.project_grouping,
    autoOpenPlan: state.auto_open_plan === 1,
    confirmDestructiveActions: state.confirm_destructive_actions === 1,
    defaultReasoningEffort: state.default_reasoning_effort,
    defaultInteractionMode: state.default_interaction_mode,
    codexBinaryPath: state.codex_binary_path,
  };
}

function requireTimestamp(value: string, label: string): string {
  const timestamp = providerTimestamp(value);
  if (!timestamp) throw new Error(`${label} must be a valid ISO timestamp.`);
  return timestamp;
}

function requiredTurnString(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function optionalTurnString(value: string | null | undefined, label: string, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  return requiredTurnString(value, label, maximum);
}

function normalizeAgentTurnUsage(usage: AgentTurnUsageSnapshot): AgentTurnUsageSnapshot {
  return {
    ...validateProviderUsage(usage),
    capturedAt: requireTimestamp(usage.capturedAt, "Turn usage capture time"),
  };
}

function parseAgentTurnUsage(value: string | null): AgentTurnUsageSnapshot | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("capturedAt" in parsed) || typeof parsed.capturedAt !== "string") {
      return null;
    }
    return normalizeAgentTurnUsage(parsed as AgentTurnUsageSnapshot);
  } catch {
    return null;
  }
}

function agentTurnFromRow(row: AgentTurnRow): AgentTurn {
  const modelSelection = parseModelSelection(
    row.model_selection_json,
    () => legacyModelSelection({
      providerId: row.provider_id,
      harnessId: row.harness_id,
      backendProfileId: row.backend_profile_id,
      model: row.model,
      modelAlias: row.model_alias,
      reasoningEffort: row.reasoning_effort,
      configurationRevision: row.configuration_revision,
    }),
  );
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    userMessageId: row.user_message_id,
    terminalAssistantMessageId: row.terminal_assistant_message_id,
    providerId: row.provider_id,
    modelSelection,
    continuationIdentity: parseAgentTurnContinuationIdentity(
      row.continuation_identity_json,
      modelSelection,
    ),
    harnessId: modelSelection.harnessId,
    backendProfileId: modelSelection.backendProfileId,
    model: modelSelection.modelId,
    modelAlias: modelSelection.alias,
    reasoningEffort: modelSelection.reasoningEffort ?? "",
    interactionMode: row.interaction_mode,
    accessMode: row.access_mode,
    providerSessionBefore: row.provider_session_before,
    providerSessionAfter: row.provider_session_after,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    terminalReason: row.terminal_reason,
    checkpointId: row.checkpoint_id,
    usageAtStart: parseAgentTurnUsage(row.usage_start_json),
    usageAtCompletion: parseAgentTurnUsage(row.usage_completion_json),
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: row.association,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTurnGitArtifactFiles(value: string): TurnGitArtifactFile[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const file = item as Partial<TurnGitArtifactFile>;
      if (
        typeof file.path !== "string"
        || file.path.length === 0
        || file.path.length > 4_096
        || typeof file.status !== "string"
        || !Number.isSafeInteger(file.insertions)
        || (file.insertions ?? -1) < 0
        || !Number.isSafeInteger(file.deletions)
        || (file.deletions ?? -1) < 0
      ) return [];
      return [{
        path: file.path,
        previousPath: typeof file.previousPath === "string" ? file.previousPath : null,
        status: file.status.slice(0, 40),
        insertions: file.insertions!,
        deletions: file.deletions!,
        binary: file.binary === true,
        untracked: file.untracked === true,
        staged: file.staged === true,
        unstaged: file.unstaged === true,
        indexStatus: typeof file.indexStatus === "string" ? file.indexStatus.slice(0, 4) : ".",
        worktreeStatus: typeof file.worktreeStatus === "string" ? file.worktreeStatus.slice(0, 4) : ".",
      }];
    }).slice(0, 200);
  } catch {
    return [];
  }
}

function turnGitArtifactFromRow(row: TurnGitArtifactRow): TurnGitArtifact {
  return {
    id: row.id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    repositoryIdentity: row.repository_identity,
    worktreeIdentity: row.worktree_identity,
    branch: row.branch,
    beforeCheckpointId: row.before_checkpoint_id,
    beforeFingerprint: row.before_fingerprint,
    afterFingerprint: row.after_fingerprint,
    files: parseTurnGitArtifactFiles(row.files_json),
    insertions: row.insertions,
    deletions: row.deletions,
    status: row.status,
    completeness: row.completeness,
    patchState: row.patch_state,
    patchDigest: row.patch_digest,
    capturedAt: row.captured_at,
    terminalAssistantMessageId: row.terminal_assistant_message_id,
    failureReason: row.failure_reason,
    absenceReason: row.absence_reason === "not-repository"
      ? row.absence_reason
      : null,
  };
}

function storedTurnGitArtifactFromRow(row: TurnGitArtifactRow): StoredTurnGitArtifact {
  return {
    ...turnGitArtifactFromRow(row),
    beforeRef: row.before_ref,
    afterRef: row.after_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function optionalSha256(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value;
}

function optionalArtifactRef(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (
    value.length > 500
    || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(value)
  ) throw new Error(`${label} is invalid.`);
  return value;
}

function normalizeTurnGitArtifactFiles(files: readonly TurnGitArtifactFile[]): TurnGitArtifactFile[] {
  if (files.length > 200) throw new Error("A turn Git artifact can contain at most 200 files.");
  return files.map((file) => {
    const path = file.path.trim();
    const previousPath = file.previousPath?.trim() || null;
    if (
      path.length === 0
      || path.length > 4_096
      || path.startsWith("/")
      || path.includes("\0")
      || path.split("/").includes("..")
      || (previousPath !== null && (
        previousPath.length > 4_096
        || previousPath.startsWith("/")
        || previousPath.includes("\0")
        || previousPath.split("/").includes("..")
      ))
    ) throw new Error("A turn Git artifact contains an invalid repository-relative path.");
    if (
      !Number.isSafeInteger(file.insertions)
      || file.insertions < 0
      || !Number.isSafeInteger(file.deletions)
      || file.deletions < 0
    ) throw new Error("Turn Git artifact statistics must be non-negative integers.");
    return {
      ...file,
      path,
      previousPath,
      status: file.status.trim().slice(0, 40) || "unknown",
      indexStatus: file.indexStatus.slice(0, 4),
      worktreeStatus: file.worktreeStatus.slice(0, 4),
    };
  });
}

function parseAttachments(value: string): ChatAttachment[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ChatAttachment[]) : [];
  } catch {
    return [];
  }
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function messageFromRow(row: MessageRow): ChatMessage {
  return { id: row.id, conversationId: row.conversation_id, turnId: row.turn_id, role: row.role, content: row.content, attachments: parseAttachments(row.attachments_json), createdAt: row.created_at };
}

function activityFromRow(row: ActivityRow): AgentActivity {
  return { id: row.id, conversationId: row.conversation_id, runId: row.run_id, turnId: row.turn_id, kind: row.kind, title: row.title, detail: row.detail, status: row.status, createdAt: row.created_at };
}

function subagentTraceFromRow(row: SubagentTraceRow): SubagentTrace {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    providerId: row.provider_id,
    providerTaskId: row.provider_task_id,
    providerAgentId: row.provider_agent_id,
    parentTraceId: row.parent_trace_id,
    parentProviderAgentId: row.parent_provider_agent_id,
    parentProviderToolUseId: row.parent_provider_tool_use_id,
    providerToolUseId: row.provider_tool_use_id,
    providerRole: row.provider_role,
    providerName: row.provider_name,
    status: row.status,
    description: row.description,
    progress: row.progress,
    result: row.result,
    sequence: row.sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function checkpointFromRow(row: CheckpointRow): CheckpointSummary {
  return { id: row.id, conversationId: row.conversation_id, turnId: row.turn_id, ref: row.ref, label: row.label, turnIndex: row.turn_index, filesChanged: row.files_changed, insertions: row.insertions, deletions: row.deletions, createdAt: row.created_at };
}

function planFromRow(row: AgentPlanRow): AgentPlan {
  let steps: AgentPlan["steps"] = [];
  try {
    const parsed: unknown = JSON.parse(row.steps_json);
    if (Array.isArray(parsed)) {
      steps = parsed.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const step = "step" in value && typeof value.step === "string" ? value.step : undefined;
        const status = "status" in value && (value.status === "pending" || value.status === "inProgress" || value.status === "completed") ? value.status : undefined;
        return step && status ? [{ step, status }] : [];
      }).slice(0, 50);
    }
  } catch {
    // A malformed legacy plan is represented as empty rather than breaking startup.
  }
  return { conversationId: row.conversation_id, runId: row.run_id, turnId: row.turn_id, explanation: row.explanation, steps };
}

function reasoningFromRow(row: AgentReasoningRow): AgentReasoning {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
  };
}

function usageFromRow(row: ThreadUsageRow): ThreadUsageSnapshot {
  return {
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    usedTokens: row.used_tokens,
    totalProcessedTokens: row.total_processed_tokens,
    totalProcessedScope: row.total_processed_scope,
    maxTokens: row.max_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteInputTokens: row.cache_write_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    compactsAutomatically: row.compacts_automatically === null ? null : row.compacts_automatically === 1,
    updatedAt: row.updated_at,
  };
}

let malformedReviewSummaryWarningEmitted = false;

function flagMalformedReviewSummary(): null {
  if (!malformedReviewSummaryWarningEmitted) {
    malformedReviewSummaryWarningEmitted = true;
    console.warn("A malformed persisted review summary was omitted from the runtime snapshot.");
  }
  return null;
}

function reviewSummaryFromRow(row: DiffReviewSummaryRow): DiffReviewSummary | null {
  if (row.summary_json !== null) {
    const summary = parsePersistedReviewSummaryJson(row.summary_json);
    if (
      !summary
      || summary.conversationId !== row.conversation_id
      || summary.fingerprint !== row.fingerprint
      || summary.providerId !== row.provider_id
      || summary.overall !== row.overall
      || summary.generatedAt !== row.generated_at
    ) {
      return flagMalformedReviewSummary();
    }
    return summary;
  }

  let files: unknown;
  try {
    files = JSON.parse(row.files_json) as unknown;
  } catch {
    return flagMalformedReviewSummary();
  }
  return upgradeLegacyPersistedReviewSummary({
    conversationId: row.conversation_id,
    fingerprint: row.fingerprint,
    providerId: row.provider_id,
    overall: row.overall,
    files,
    generatedAt: row.generated_at,
  }) ?? flagMalformedReviewSummary();
}

function reviewStateFromRow(row: DiffReviewStateRow): DiffReviewState {
  return {
    conversationId: row.conversation_id,
    scope: row.scope,
    path: row.path,
    hunkId: row.hunk_id || null,
    targetFingerprint: row.target_fingerprint,
    reviewed: row.reviewed === 1,
    stale: row.stale === 1,
    updatedAt: row.updated_at,
  };
}

function reviewNoteFromRow(row: DiffReviewNoteRow): DiffReviewNote {
  const parsed = parseJsonArray(row.line_ids_json).filter((value): value is string => typeof value === "string").slice(0, 500);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    path: row.path,
    hunkId: row.hunk_id || null,
    lineIds: parsed,
    targetFingerprint: row.target_fingerprint,
    body: row.body,
    stale: row.stale === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workspaceRunFromRow(row: WorkspaceRunRow): WorkspaceRun {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    actionId: row.action_id,
    label: row.label,
    detail: row.detail,
    status: row.status,
    // Compatibility for pre-attention fixtures while the v20 migration is
    // pending. Failures and waits fail open; other legacy rows stay quiet.
    attentionState: row.attention_state
      ?? (row.status === "failed" || row.status === "waiting" ? "unseen" : "acknowledged"),
    canStop: false,
    port: row.port,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface NewConversationOptions {
  providerId?: ProviderId;
  modelSelection?: ModelSelection;
  model?: string;
  reasoningEffort?: string;
  interactionMode?: InteractionMode;
  accessMode?: AccessMode;
  branch?: string | null;
  worktreePath?: string | null;
}

export interface CreateAgentTurnInput {
  id?: string;
  conversationId: string;
  runId: string;
  userMessageId: string;
  providerId: ProviderId;
  modelSelection?: ModelSelection;
  continuationIdentity?: ContinuationIdentity;
  /** Legacy database-boundary fields accepted for V0.0.6 compatibility. */
  harnessId?: string;
  backendProfileId?: string;
  model?: string;
  modelAlias?: string | null;
  reasoningEffort: string;
  interactionMode: InteractionMode;
  accessMode: AccessMode;
  providerSessionBefore?: string | null;
  requestedAt?: string;
  usageAtStart?: AgentTurnUsageSnapshot | null;
  configurationRevision: number;
  association: AgentTurnAssociation;
}

export interface AgentTurnLifecycleUpdate {
  status: AgentTurnStatus;
  terminalAssistantMessageId?: string | null;
  providerSessionAfter?: string | null;
  terminalReason?: string | null;
  checkpointId?: string | null;
  usageAtCompletion?: AgentTurnUsageSnapshot | null;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface BeginAgentTurnInput extends Omit<CreateAgentTurnInput, "userMessageId" | "requestedAt"> {
  content: string;
  attachments?: ChatAttachment[];
  executionContext?: PersistedTurnExecutionContext;
  requestedAt?: string;
}

export interface AgentTurnSettlementUpdate extends Omit<AgentTurnLifecycleUpdate, "status"> {
  status: AgentTurnTerminalStatus;
}

export interface AgentTurnSettlementResult {
  settled: boolean;
  turn: AgentTurn;
}

export interface StoredTurnGitArtifact extends TurnGitArtifact {
  beforeRef: string | null;
  afterRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTurnGitArtifactInput {
  id?: string;
  turnId: string;
  repositoryIdentity?: string | null;
  worktreeIdentity?: string | null;
  branch?: string | null;
  beforeCheckpointId?: string | null;
  beforeRef?: string | null;
  beforeFingerprint?: string | null;
  status?: TurnGitArtifactStatus;
  completeness?: TurnGitArtifactCompleteness;
  failureReason?: string | null;
  absenceReason?: TurnGitArtifactAbsenceReason | null;
  createdAt?: string;
}

export interface CompleteTurnGitArtifactInput {
  afterRef?: string | null;
  afterFingerprint?: string | null;
  files?: TurnGitArtifactFile[];
  insertions?: number;
  deletions?: number;
  status: TurnGitArtifactStatus;
  completeness: TurnGitArtifactCompleteness;
  patchState?: TurnGitPatchState;
  patchDigest?: string | null;
  capturedAt?: string | null;
  terminalAssistantMessageId?: string | null;
  failureReason?: string | null;
  absenceReason?: TurnGitArtifactAbsenceReason | null;
  updatedAt?: string;
}

export interface RuntimeStoreSnapshot extends Omit<AppSnapshot, "conversations"> {
  conversations: Conversation[];
  agentTurns: AgentTurn[];
  turnGitArtifacts: TurnGitArtifact[];
  messages: ChatMessage[];
  activities: AgentActivity[];
  subagents: SubagentTrace[];
  reasonings: AgentReasoning[];
  usage: ThreadUsageSnapshot[];
  plans: AgentPlan[];
  checkpoints: CheckpointSummary[];
  reviewSummaries: DiffReviewSummary[];
  reviewStates: DiffReviewState[];
  reviewNotes: DiffReviewNote[];
}

export interface UpsertSubagentTraceInput {
  conversationId: string;
  runId: string;
  turnId: string;
  providerId: ProviderId;
  providerTaskId: string | null;
  providerAgentId: string | null;
  parentProviderAgentId: string | null;
  parentProviderToolUseId: string | null;
  providerToolUseId: string | null;
  providerRole: string | null;
  providerName: string | null;
  status: SubagentTraceStatus;
  description: string | null;
  progress: string | null;
  result: string | null;
  sequence: number;
  updatedAt?: string;
}

export interface UpsertSubagentTraceResult {
  trace: SubagentTrace;
  changed: boolean;
}

export interface StoredModelBackendProfile {
  profile: PersistedModelBackendProfile;
  latestProbe: BackendCompatibilityProbeResult | null;
}

export class RuntimeStore {
  private readonly database: Database.Database;

  constructor(
    databasePath: string,
    _defaultWorkspacePath: string,
    options: { recoverInterruptedRuns?: boolean } = {},
  ) {
    this.database = new Database(databasePath);
    try {
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      this.migrate();
      this.database.pragma("journal_mode = WAL");
      this.initializeState();
      if (options.recoverInterruptedRuns !== false) this.recoverInterruptedRuns();
    } catch (error) {
      if (this.database.open) this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  snapshot(providers: ProviderInfo[] = []): RuntimeStoreSnapshot {
    const state = this.getState();
    return {
      projects: (this.database.prepare("SELECT * FROM projects ORDER BY updated_at DESC, id ASC").all() as ProjectRow[]).map(projectFromRow),
      conversations: (this.database.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, id ASC").all() as ConversationRow[]).map(conversationFromRow),
      agentTurns: (this.database.prepare("SELECT * FROM agent_turns ORDER BY requested_at ASC, id ASC").all() as AgentTurnRow[]).map(agentTurnFromRow),
      turnGitArtifacts: (this.database.prepare(
        "SELECT * FROM turn_git_artifacts ORDER BY created_at ASC, id ASC",
      ).all() as TurnGitArtifactRow[]).map(turnGitArtifactFromRow),
      messages: (this.database.prepare("SELECT * FROM messages ORDER BY created_at ASC, id ASC").all() as MessageRow[]).map(messageFromRow),
      activities: (this.database.prepare("SELECT * FROM activities ORDER BY created_at ASC, id ASC").all() as ActivityRow[]).map(activityFromRow),
      subagents: (this.database.prepare(
        "SELECT * FROM subagent_traces ORDER BY created_at ASC, sequence ASC, id ASC",
      ).all() as SubagentTraceRow[]).map(subagentTraceFromRow),
      reasonings: (this.database.prepare("SELECT * FROM agent_reasonings ORDER BY created_at ASC, id ASC").all() as AgentReasoningRow[]).map(reasoningFromRow),
      usage: (this.database.prepare("SELECT * FROM thread_usage ORDER BY updated_at ASC").all() as ThreadUsageRow[]).map(usageFromRow),
      plans: (this.database.prepare(`
        SELECT conversation_id, run_id, turn_id, explanation, steps_json
        FROM agent_plans
        ORDER BY updated_at ASC, conversation_id ASC, run_id ASC
      `).all() as AgentPlanRow[]).map(planFromRow),
      checkpoints: (this.database.prepare("SELECT * FROM checkpoints ORDER BY created_at ASC, id ASC").all() as CheckpointRow[]).map(checkpointFromRow),
      reviewSummaries: (this.database.prepare("SELECT * FROM diff_review_summaries ORDER BY generated_at ASC").all() as DiffReviewSummaryRow[])
        .flatMap((row) => {
          const summary = reviewSummaryFromRow(row);
          return summary ? [summary] : [];
        }),
      reviewStates: (this.database.prepare("SELECT * FROM diff_review_states ORDER BY updated_at ASC").all() as DiffReviewStateRow[]).map(reviewStateFromRow),
      reviewNotes: (this.database.prepare("SELECT * FROM diff_review_notes ORDER BY created_at ASC").all() as DiffReviewNoteRow[]).map(reviewNoteFromRow),
      runs: (this.database.prepare("SELECT * FROM workspace_runs ORDER BY started_at DESC LIMIT 200").all() as WorkspaceRunRow[]).map(workspaceRunFromRow),
      providers,
      settings: settingsFromState(state),
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  shellSnapshot(providers: ProviderInfo[] = []): AppSnapshot {
    const state = this.getState();
    const latestTurns = new Map(
      (this.database.prepare(`
        SELECT turn.*
        FROM agent_turns AS turn
        WHERE turn.id = (
          SELECT candidate.id
          FROM agent_turns AS candidate
          WHERE candidate.conversation_id = turn.conversation_id
          ORDER BY candidate.requested_at DESC, candidate.id DESC
          LIMIT 1
        )
      `).all() as AgentTurnRow[])
        .map(agentTurnFromRow)
        .map((turn) => [turn.conversationId, turn] as const),
    );
    return {
      projects: (this.database.prepare(
        "SELECT * FROM projects ORDER BY updated_at DESC, id ASC",
      ).all() as ProjectRow[]).map(projectFromRow),
      conversations: (this.database.prepare(
        "SELECT * FROM conversations ORDER BY updated_at DESC, id ASC",
      ).all() as ConversationRow[]).map((row) =>
        conversationShellFromRow(row, latestTurns.get(row.id) ?? null)),
      runs: (this.database.prepare(
        "SELECT * FROM workspace_runs ORDER BY started_at DESC LIMIT 200",
      ).all() as WorkspaceRunRow[]).map(workspaceRunFromRow),
      providers,
      settings: settingsFromState(state),
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  conversationDetail(conversationId: string): ConversationDetail | null {
    const conversationRow = this.database.prepare(
      "SELECT * FROM conversations WHERE id = ?",
    ).get(conversationId) as ConversationRow | undefined;
    if (!conversationRow) return null;

    return {
      conversation: conversationFromRow(conversationRow),
      agentTurns: (this.database.prepare(`
        SELECT * FROM agent_turns
        WHERE conversation_id = ?
        ORDER BY requested_at ASC, id ASC
      `).all(conversationId) as AgentTurnRow[]).map(agentTurnFromRow),
      turnGitArtifacts: (this.database.prepare(`
        SELECT * FROM turn_git_artifacts
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as TurnGitArtifactRow[]).map(turnGitArtifactFromRow),
      messages: (this.database.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as MessageRow[]).map(messageFromRow),
      activities: (this.database.prepare(`
        SELECT * FROM activities
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as ActivityRow[]).map(activityFromRow),
      subagents: (this.database.prepare(`
        SELECT * FROM subagent_traces
        WHERE conversation_id = ?
        ORDER BY created_at ASC, sequence ASC, id ASC
      `).all(conversationId) as SubagentTraceRow[]).map(subagentTraceFromRow),
      reasonings: (this.database.prepare(`
        SELECT * FROM agent_reasonings
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as AgentReasoningRow[]).map(reasoningFromRow),
      usage: (this.database.prepare(`
        SELECT * FROM thread_usage
        WHERE conversation_id = ?
        ORDER BY updated_at ASC
      `).all(conversationId) as ThreadUsageRow[]).map(usageFromRow),
      plans: (this.database.prepare(`
        SELECT conversation_id, run_id, turn_id, explanation, steps_json
        FROM agent_plans
        WHERE conversation_id = ?
        ORDER BY updated_at ASC, conversation_id ASC, run_id ASC
      `).all(conversationId) as AgentPlanRow[]).map(planFromRow),
      checkpoints: (this.database.prepare(`
        SELECT * FROM checkpoints
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(conversationId) as CheckpointRow[]).map(checkpointFromRow),
      reviewSummaries: (this.database.prepare(`
        SELECT * FROM diff_review_summaries
        WHERE conversation_id = ?
        ORDER BY generated_at ASC
      `).all(conversationId) as DiffReviewSummaryRow[]).flatMap((row) => {
        const summary = reviewSummaryFromRow(row);
        return summary ? [summary] : [];
      }),
      reviewStates: (this.database.prepare(`
        SELECT * FROM diff_review_states
        WHERE conversation_id = ?
        ORDER BY updated_at ASC
      `).all(conversationId) as DiffReviewStateRow[]).map(reviewStateFromRow),
      reviewNotes: (this.database.prepare(`
        SELECT * FROM diff_review_notes
        WHERE conversation_id = ?
        ORDER BY created_at ASC
      `).all(conversationId) as DiffReviewNoteRow[]).map(reviewNoteFromRow),
    };
  }

  loadProviderMetadata(): PersistedProviderMetadata[] {
    const rows = this.database.prepare(`
      SELECT *
      FROM provider_metadata_scoped_cache
      ORDER BY provider_id ASC, scope_key ASC
    `).all() as ProviderMetadataCacheRow[];
    return rows.map((row) => ({
      scope: {
        providerId: row.provider_id,
        harnessId: row.harness_id,
        backendProfileId: row.backend_profile_id,
        modelId: row.model_id,
        executable: row.executable,
        version: row.version,
        backendConfigurationRevision: row.backend_configuration_revision,
        authState: row.auth_state,
      },
      models: parseJsonArray(row.models_json),
      modelsUpdatedAt: row.models_updated_at,
      modelsLastAttemptedAt: row.models_last_attempted_at,
      modelsProvenance: row.models_provenance,
      modelsStale: row.models_stale === 1,
      rateLimits: parseJsonArray(row.rate_limits_json),
      rateLimitsUpdatedAt: row.rate_limits_updated_at,
      rateLimitsLastAttemptedAt: row.rate_limits_last_attempted_at,
      rateLimitsProvenance: row.rate_limits_provenance,
      rateLimitsStale: row.rate_limits_stale === 1,
    })) as PersistedProviderMetadata[];
  }

  saveProviderMetadata(metadata: PersistedProviderMetadata): void {
    const modelsJson = JSON.stringify(metadata.models);
    const rateLimitsJson = JSON.stringify(metadata.rateLimits);
    if (modelsJson.length > 262_144 || rateLimitsJson.length > 65_536) return;
    const scopeKey = providerMetadataScopeKey(metadata.scope);
    this.database.prepare(`
      INSERT INTO provider_metadata_scoped_cache (
        scope_key, provider_id, harness_id, backend_profile_id, model_id,
        executable, version, backend_configuration_revision, auth_state,
        models_json, models_updated_at, models_last_attempted_at, models_provenance, models_stale,
        rate_limits_json, rate_limits_updated_at, rate_limits_last_attempted_at, rate_limits_provenance, rate_limits_stale
      ) VALUES (
        @scopeKey, @providerId, @harnessId, @backendProfileId, @modelId,
        @executable, @version, @backendConfigurationRevision, @authState,
        @modelsJson, @modelsUpdatedAt, @modelsLastAttemptedAt, @modelsProvenance, @modelsStaleValue,
        @rateLimitsJson, @rateLimitsUpdatedAt, @rateLimitsLastAttemptedAt, @rateLimitsProvenance, @rateLimitsStaleValue
      ) ON CONFLICT(scope_key) DO UPDATE SET
        executable = excluded.executable,
        version = excluded.version,
        auth_state = excluded.auth_state,
        models_json = excluded.models_json,
        models_updated_at = excluded.models_updated_at,
        models_last_attempted_at = excluded.models_last_attempted_at,
        models_provenance = excluded.models_provenance,
        models_stale = excluded.models_stale,
        rate_limits_json = excluded.rate_limits_json,
        rate_limits_updated_at = excluded.rate_limits_updated_at,
        rate_limits_last_attempted_at = excluded.rate_limits_last_attempted_at,
        rate_limits_provenance = excluded.rate_limits_provenance,
        rate_limits_stale = excluded.rate_limits_stale
    `).run({
      scopeKey,
      ...metadata.scope,
      ...metadata,
      modelsJson,
      rateLimitsJson,
      modelsStaleValue: metadata.modelsStale ? 1 : 0,
      rateLimitsStaleValue: metadata.rateLimitsStale ? 1 : 0,
    });
  }

  createProject(
    name: string,
    projectPath: string,
    identity: Partial<Pick<Project, "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath">> = {},
  ): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    const projectCount = (this.database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    const path = resolve(projectPath);
    const project: Project = {
      id,
      name,
      path,
      normalizedPath: identity.normalizedPath ?? path,
      repositoryIdentity: identity.repositoryIdentity ?? null,
      repositoryRoot: identity.repositoryRoot ?? null,
      repositoryRelativePath: identity.repositoryRelativePath ?? ".",
      groupingMode: null,
      color: PROJECT_COLORS[projectCount % PROJECT_COLORS.length],
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO projects (
          id, name, path, normalized_path, repository_identity, repository_root,
          repository_relative_path, grouping_mode, color, status, created_at, updated_at
        ) VALUES (
          @id, @name, @path, @normalizedPath, @repositoryIdentity, @repositoryRoot,
          @repositoryRelativePath, @groupingMode, @color, @status, @createdAt, @updatedAt
        )
      `).run(project);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = NULL WHERE id = 1").run(project.id);
    })();
    return project;
  }

  updateProject(
    projectId: string,
    update: Partial<Pick<Project, "name" | "groupingMode" | "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath">>,
  ): Project {
    const current = projectFromRow(this.requireProject(projectId));
    const unchanged = Object.entries(update).every(([key, value]) => current[key as keyof Project] === value);
    if (unchanged) return current;
    const next = { ...current, ...update, updatedAt: new Date().toISOString() };
    this.database.prepare(`
      UPDATE projects SET
        name = @name,
        normalized_path = @normalizedPath,
        repository_identity = @repositoryIdentity,
        repository_root = @repositoryRoot,
        repository_relative_path = @repositoryRelativePath,
        grouping_mode = @groupingMode,
        updated_at = @updatedAt
      WHERE id = @id
    `).run(next);
    return next;
  }

  removeProject(projectId: string): void {
    this.requireProject(projectId);
    this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    const next = this.database.prepare("SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (next) this.selectProject(next.id);
  }

  selectProject(projectId: string): void {
    this.requireProject(projectId);
    const conversation = this.database.prepare(`SELECT id FROM conversations WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`).get(projectId) as { id: string } | undefined;
    this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(projectId, conversation?.id ?? null);
  }

  createConversation(projectId: string, title: string, options: NewConversationOptions = {}): Conversation {
    this.requireProject(projectId);
    const state = this.getState();
    const now = new Date().toISOString();
    const legacyProviderId = options.providerId ?? state.default_provider;
    const modelSelection = options.modelSelection
      ? modelSelectionSchema.parse(options.modelSelection)
      : nativeModelSelection({
        providerId: legacyProviderId,
        modelId: options.model || state.default_model || "provider-default",
        alias: options.model || state.default_model || null,
        reasoningEffort: options.reasoningEffort ?? state.default_reasoning_effort,
      });
    const providerId = legacyProviderIdForHarness(modelSelection.harnessId);
    if (!providerId) throw new Error("The selected harness is unavailable in this build.");
    if (options.providerId && options.providerId !== providerId) {
      throw new Error("The legacy provider and model selection harness do not match.");
    }
    const conversation: Conversation = {
      id: randomUUID(), projectId, title,
      providerId,
      modelSelection,
      continuationIdentity: null,
      model: modelSelection.modelId === "provider-default" ? "" : modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort ?? "",
      interactionMode: options.interactionMode ?? state.default_interaction_mode,
      accessMode: options.accessMode ?? state.default_access_mode,
      status: "idle",
      attentionKind: null,
      branch: options.branch ?? null,
      worktreePath: options.worktreePath ?? null,
      providerSessionId: null,
      archivedAt: null,
      settledAt: null,
      completedAt: null,
      lastViewedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const modelSelectionJson = JSON.stringify(modelSelection);
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO conversations (
          id, project_id, title, provider_id, model_selection_json, continuation_identity_json,
          model, reasoning_effort, interaction_mode,
          access_mode, status, attention_kind, branch, worktree_path, provider_session_id,
          archived_at, settled_at, completed_at, last_viewed_at, created_at, updated_at
        ) VALUES (
          @id, @projectId, @title, @providerId, @modelSelectionJson, NULL,
          @model, @reasoningEffort, @interactionMode,
          @accessMode, @status, @attentionKind, @branch, @worktreePath, @providerSessionId,
          @archivedAt, @settledAt, @completedAt, @lastViewedAt, @createdAt, @updatedAt
        )
      `).run({ ...conversation, modelSelectionJson });
      this.touchProject(projectId, now);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(projectId, conversation.id);
    })();
    return conversation;
  }

  selectConversation(conversationId: string): void {
    const conversation = this.requireConversation(conversationId);
    const completedTime = conversation.completed_at ? Date.parse(conversation.completed_at) : 0;
    const now = new Date(Math.max(
      Date.now(),
      Number.isFinite(completedTime) ? completedTime : 0,
    )).toISOString();
    this.database.transaction(() => {
      // This timestamp remains a legacy transcript-visit marker. Canonical
      // run attention is changed only by the explicit attention commands.
      this.database.prepare("UPDATE conversations SET last_viewed_at = ? WHERE id = ?")
        .run(now, conversationId);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1")
        .run(conversation.project_id, conversationId);
    })();
  }

  hasConversationMessages(conversationId: string): boolean {
    this.requireConversation(conversationId);
    return this.database.prepare("SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1").get(conversationId) !== undefined;
  }

  hasConversationTurns(conversationId: string): boolean {
    this.requireConversation(conversationId);
    return this.database.prepare(
      "SELECT 1 FROM agent_turns WHERE conversation_id = ? LIMIT 1",
    ).get(conversationId) !== undefined;
  }

  updateConversation(conversationId: string, update: Partial<Pick<Conversation, "title" | "providerId" | "modelSelection" | "continuationIdentity" | "model" | "reasoningEffort" | "interactionMode" | "accessMode" | "branch" | "worktreePath" | "providerSessionId" | "status" | "attentionKind">>): Conversation {
    const current = conversationFromRow(this.requireConversation(conversationId));
    const requestedProviderId = update.providerId ?? current.providerId;
    const legacySelectionChanged = update.providerId !== undefined
      || update.model !== undefined
      || update.reasoningEffort !== undefined;
    const modelSelection = update.modelSelection
      ? modelSelectionSchema.parse(update.modelSelection)
      : legacySelectionChanged
        ? nativeModelSelection({
          providerId: requestedProviderId,
          modelId: update.model ?? (
            update.providerId && update.providerId !== current.providerId
              ? "provider-default"
              : current.modelSelection.modelId
          ),
          alias: update.model ?? (
            update.providerId && update.providerId !== current.providerId
              ? null
              : current.modelSelection.alias
          ),
          reasoningEffort: update.reasoningEffort ?? (
            update.providerId && update.providerId !== current.providerId
              ? null
              : current.modelSelection.reasoningEffort
          ),
        })
        : current.modelSelection;
    const selectedProviderId = legacyProviderIdForHarness(modelSelection.harnessId);
    if (!selectedProviderId) throw new Error("The selected harness is unavailable in this build.");
    if (update.providerId && update.providerId !== selectedProviderId) {
      throw new Error("The legacy provider and model selection harness do not match.");
    }
    const continuationBoundaryChanged = (
      modelSelection.harnessId !== current.modelSelection.harnessId
      || modelSelection.backendProfileId !== current.modelSelection.backendProfileId
      || modelSelection.backendConfigurationRevision
        !== current.modelSelection.backendConfigurationRevision
    );
    const statusChanged = update.status !== undefined && update.status !== current.status;
    const currentUpdatedTime = Date.parse(current.updatedAt);
    const eventTime = update.status === "completed" && statusChanged
      ? Math.max(Date.now(), Number.isFinite(currentUpdatedTime) ? currentUpdatedTime + 1 : 0)
      : Date.now();
    const now = new Date(eventTime).toISOString();
    const next = {
      ...current,
      ...update,
      providerId: selectedProviderId,
      modelSelection,
      providerSessionId: continuationBoundaryChanged
        ? null
        : (update.providerSessionId ?? current.providerSessionId),
      continuationIdentity: continuationBoundaryChanged
        ? null
        : update.providerSessionId === null
          ? null
          : (update.continuationIdentity ?? current.continuationIdentity),
      model: modelSelection.modelId === "provider-default" ? "" : modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort ?? "",
      attentionKind: update.status && update.status !== "needs-input"
        ? null
        : (update.attentionKind ?? current.attentionKind),
      settledAt: update.status === "running" ? null : current.settledAt,
      completedAt: update.status === "completed" && statusChanged ? now : current.completedAt,
      lastViewedAt: current.lastViewedAt,
      updatedAt: now,
    };
    if (next.providerSessionId && !next.continuationIdentity) {
      const native = nativeBackendProfile(selectedProviderId);
      const harnessId = knownHarnessIdSchema.safeParse(modelSelection.harnessId);
      if (!harnessId.success || native.id !== modelSelection.backendProfileId) {
        throw new Error(
          "A custom or historical provider session requires an explicit continuation identity.",
        );
      }
      const compatibility = resolveHarnessBackendCompatibility(
        harnessId.data,
        native,
      );
      next.continuationIdentity = continuationIdentityForSelection(
        modelSelection,
        native.endpointIdentity,
        !compatibility.allowsModelSwitchWithinSession,
      );
    }
    const modelSelectionJson = JSON.stringify(modelSelection);
    const continuationIdentityJson = next.continuationIdentity
      ? JSON.stringify(continuationIdentitySchema.parse(next.continuationIdentity))
      : null;
    this.database.prepare(`
      UPDATE conversations SET
        title = @title, provider_id = @providerId,
        model_selection_json = @modelSelectionJson,
        continuation_identity_json = @continuationIdentityJson,
        model = @model,
        reasoning_effort = @reasoningEffort, interaction_mode = @interactionMode,
        access_mode = @accessMode, branch = @branch, worktree_path = @worktreePath,
        provider_session_id = @providerSessionId, status = @status,
        attention_kind = @attentionKind, settled_at = @settledAt,
        completed_at = @completedAt, last_viewed_at = @lastViewedAt,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({ ...next, modelSelectionJson, continuationIdentityJson });
    this.touchProject(current.projectId, next.updatedAt);
    return next;
  }

  createAgentTurn(input: CreateAgentTurnInput): AgentTurn {
    this.requireConversation(input.conversationId);
    if (!Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 0) {
      throw new Error("Turn configuration revision must be a non-negative integer.");
    }
    if (input.association !== "authoritative" && input.association !== "inferred") {
      throw new Error("Turn association must be authoritative or inferred.");
    }

    const modelSelection = input.modelSelection
      ? modelSelectionSchema.parse(input.modelSelection)
      : legacyModelSelection({
        providerId: input.providerId,
        harnessId: requiredTurnString(input.harnessId ?? "", "Turn harness ID", 200),
        backendProfileId: requiredTurnString(
          input.backendProfileId ?? "",
          "Turn backend profile ID",
          200,
        ),
        model: requiredTurnString(input.model ?? "", "Turn model", 300),
        modelAlias: input.modelAlias ?? null,
        reasoningEffort: input.reasoningEffort,
        configurationRevision: input.configurationRevision,
      });
    const selectedProviderId = legacyProviderIdForHarness(modelSelection.harnessId);
    if (selectedProviderId && selectedProviderId !== input.providerId) {
      throw new Error("The turn provider and harness identities do not match.");
    }
    if (
      input.modelSelection
      && input.configurationRevision !== modelSelection.backendConfigurationRevision
    ) {
      throw new Error("The turn configuration revision does not match its model selection.");
    }
    const continuationIdentity = input.continuationIdentity
      ? continuationIdentitySchema.parse(input.continuationIdentity)
      : continuationIdentityForSelection(modelSelection);
    if (
      continuationIdentity.harnessId !== modelSelection.harnessId
      || continuationIdentity.backendProfileId !== modelSelection.backendProfileId
      || continuationIdentity.backendConfigurationRevision
        !== modelSelection.backendConfigurationRevision
    ) {
      throw new Error("The turn continuation identity does not match its model selection.");
    }
    const modelSelectionJson = JSON.stringify(modelSelection);
    const continuationIdentityJson = JSON.stringify(continuationIdentity);
    if (new TextEncoder().encode(modelSelectionJson).byteLength > 65_536) {
      throw new Error("Turn model selection is too large.");
    }
    if (new TextEncoder().encode(continuationIdentityJson).byteLength > 4_096) {
      throw new Error("Turn continuation identity is too large.");
    }

    const requestedAt = requireTimestamp(input.requestedAt ?? new Date().toISOString(), "Turn request time");
    const usageAtStart = input.usageAtStart ? normalizeAgentTurnUsage(input.usageAtStart) : null;
    const usageStartJson = usageAtStart ? JSON.stringify(usageAtStart) : null;
    if (usageStartJson && usageStartJson.length > 16_384) throw new Error("Turn usage snapshot is too large.");
    const reasoningEffort = (modelSelection.reasoningEffort ?? "").trim();
    if (reasoningEffort.length > 80) throw new Error("Turn reasoning effort cannot exceed 80 characters.");

    const turn: AgentTurn = {
      id: requiredTurnString(input.id ?? randomUUID(), "Turn ID", 200),
      conversationId: input.conversationId,
      runId: requiredTurnString(input.runId, "Turn run ID", 200),
      userMessageId: requiredTurnString(input.userMessageId, "Turn user message ID", 200),
      terminalAssistantMessageId: null,
      providerId: input.providerId,
      modelSelection,
      continuationIdentity,
      harnessId: modelSelection.harnessId,
      backendProfileId: modelSelection.backendProfileId,
      model: modelSelection.modelId,
      modelAlias: modelSelection.alias,
      reasoningEffort,
      interactionMode: input.interactionMode,
      accessMode: input.accessMode,
      providerSessionBefore: optionalTurnString(input.providerSessionBefore, "Turn provider session", 1_000),
      providerSessionAfter: null,
      requestedAt,
      startedAt: null,
      completedAt: null,
      status: "queued",
      terminalReason: null,
      checkpointId: null,
      usageAtStart,
      usageAtCompletion: null,
      configurationRevision: modelSelection.backendConfigurationRevision,
      association: input.association,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    };

    const userMessage = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(turn.userMessageId) as MessageRow | undefined;
    if (!userMessage || userMessage.conversation_id !== turn.conversationId || userMessage.role !== "user") {
      throw new Error("An agent turn must reference a user message in the same conversation.");
    }
    if (userMessage.turn_id !== null && userMessage.turn_id !== turn.id) {
      throw new Error("The user message is already owned by a different turn.");
    }

    const insertTurn = this.database.prepare(`
      INSERT INTO agent_turns (
        id, conversation_id, run_id, user_message_id, terminal_assistant_message_id,
        provider_id, model_selection_json, continuation_identity_json,
        harness_id, backend_profile_id, model, model_alias, reasoning_effort,
        interaction_mode, access_mode, provider_session_before, provider_session_after,
        requested_at, started_at, completed_at, status, terminal_reason, checkpoint_id,
        usage_start_json, usage_completion_json, configuration_revision, association,
        created_at, updated_at
      ) VALUES (
        @id, @conversationId, @runId, @userMessageId, @terminalAssistantMessageId,
        @providerId, @modelSelectionJson, @continuationIdentityJson,
        @harnessId, @backendProfileId, @model, @modelAlias, @reasoningEffort,
        @interactionMode, @accessMode, @providerSessionBefore, @providerSessionAfter,
        @requestedAt, @startedAt, @completedAt, @status, @terminalReason, @checkpointId,
        @usageStartJson, NULL, @configurationRevision, @association, @createdAt, @updatedAt
      )
    `);
    this.database.transaction(() => {
      insertTurn.run({
        ...turn,
        usageStartJson,
        modelSelectionJson,
        continuationIdentityJson,
      });
      this.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turn.id, turn.userMessageId);
    })();
    return turn;
  }

  /**
   * Persists the visible user request and its queued authoritative turn in one
   * transaction. A failed turn insert rolls the message and conversation touch
   * back, so a submitted request cannot survive as an unowned user message.
   */
  beginAgentTurn(input: BeginAgentTurnInput): { message: ChatMessage; turn: AgentTurn } {
    return this.database.transaction(() => {
      const message = this.createMessage(
        input.conversationId,
        input.content,
        "user",
        input.attachments ?? [],
        null,
        input.requestedAt,
      );
      const turn = this.createAgentTurn({
        ...input,
        userMessageId: message.id,
        requestedAt: message.createdAt,
      });
      if (input.executionContext) {
        this.persistTurnExecutionContext(turn.id, input.executionContext, message.createdAt);
      }
      return { message, turn };
    })();
  }

  /**
   * Privileged server-side debugging view. Ordinary renderer snapshots and
   * WebSocket events intentionally never include this manifest or its blobs.
   */
  turnExecutionManifest(turnId: string): SanitizedTurnExecutionManifest | null {
    this.requireAgentTurn(turnId);
    const row = this.database.prepare(`
      SELECT manifest_json
      FROM turn_execution_manifests
      WHERE turn_id = ?
    `).get(turnId) as { manifest_json: string } | undefined;
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.manifest_json);
    } catch {
      throw new Error("Turn execution manifest contains invalid JSON.");
    }
    const manifest = parseSanitizedTurnExecutionManifest(parsed);
    const references = this.database.prepare(`
      SELECT ordinal, digest, kind, label, byte_size, truncated
      FROM turn_execution_context_refs
      WHERE turn_id = ?
      ORDER BY ordinal ASC
    `).all(turnId) as Array<{
      ordinal: number;
      digest: string;
      kind: string;
      label: string;
      byte_size: number;
      truncated: 0 | 1;
    }>;
    if (references.length !== manifest.references.length) {
      throw new Error("Turn execution manifest reference rows are incomplete.");
    }
    for (const [ordinal, reference] of manifest.references.entries()) {
      const rowReference = references[ordinal];
      const digest = validateExecutionContextReference(reference.reference);
      if (
        !rowReference
        || rowReference.ordinal !== ordinal
        || rowReference.digest !== digest
        || rowReference.kind !== reference.kind
        || rowReference.label !== reference.label
        || rowReference.byte_size !== reference.byteSize
        || Boolean(rowReference.truncated) !== reference.truncated
      ) {
        throw new Error("Turn execution manifest reference metadata is malformed.");
      }
      const blob = this.database.prepare(`
        SELECT byte_size, content
        FROM turn_execution_context_blobs
        WHERE digest = ?
      `).get(digest) as { byte_size: number; content: string } | undefined;
      if (
        !blob
        || blob.byte_size !== reference.byteSize
        || Buffer.byteLength(blob.content, "utf8") !== reference.byteSize
        || createHash("sha256").update(blob.content, "utf8").digest("hex") !== digest
      ) {
        throw new Error("Turn execution manifest refers to missing or malformed content.");
      }
    }
    return manifest;
  }

  private persistTurnExecutionContext(
    turnId: string,
    input: PersistedTurnExecutionContext,
    createdAt: string,
  ): void {
    this.requireAgentTurn(turnId);
    const context = validatePersistedTurnExecutionContext(input);
    const manifestJson = JSON.stringify(context.manifest);
    if (Buffer.byteLength(manifestJson, "utf8") > 65_536) {
      throw new Error("Turn execution manifest exceeds its persistence limit.");
    }
    const insertBlob = this.database.prepare(`
      INSERT INTO turn_execution_context_blobs (digest, byte_size, content, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(digest) DO NOTHING
    `);
    const selectBlob = this.database.prepare(`
      SELECT byte_size, content
      FROM turn_execution_context_blobs
      WHERE digest = ?
    `);
    for (const blob of context.blobs) {
      insertBlob.run(blob.digest, blob.byteSize, blob.content, createdAt);
      const stored = selectBlob.get(blob.digest) as { byte_size: number; content: string } | undefined;
      if (
        !stored
        || stored.byte_size !== blob.byteSize
        || stored.content !== blob.content
      ) {
        throw new Error("Content-addressed execution context collided with different content.");
      }
    }
    this.database.prepare(`
      INSERT INTO turn_execution_manifests (turn_id, manifest_json, created_at)
      VALUES (?, ?, ?)
    `).run(turnId, manifestJson, createdAt);
    const insertReference = this.database.prepare(`
      INSERT INTO turn_execution_context_refs (
        turn_id, ordinal, digest, kind, label, byte_size, truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [ordinal, reference] of context.manifest.references.entries()) {
      insertReference.run(
        turnId,
        ordinal,
        validateExecutionContextReference(reference.reference),
        reference.kind,
        reference.label,
        reference.byteSize,
        Number(reference.truncated),
      );
    }
  }

  agentTurn(turnId: string): AgentTurn {
    return agentTurnFromRow(this.requireAgentTurn(turnId));
  }

  agentTurnForRun(runId: string): AgentTurn | null {
    const row = this.database.prepare("SELECT * FROM agent_turns WHERE run_id = ?").get(runId) as AgentTurnRow | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  latestAgentTurnForConversation(conversationId: string): AgentTurn | null {
    this.requireConversation(conversationId);
    const row = this.database.prepare(`
      SELECT * FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as AgentTurnRow | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  assertAgentTurnIdentity(conversationId: string, runId: string, turnId: string): AgentTurn {
    const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
    if (turn.conversationId !== conversationId || turn.runId !== runId) {
      throw new Error("The event conversation, run, and turn identities do not match.");
    }
    return turn;
  }

  agentTurnsForConversation(conversationId: string): AgentTurn[] {
    this.requireConversation(conversationId);
    return (this.database.prepare(`
      SELECT * FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at ASC, id ASC
    `).all(conversationId) as AgentTurnRow[]).map(agentTurnFromRow);
  }

  unfinishedAgentTurns(): AgentTurn[] {
    return (this.database.prepare(`
      SELECT * FROM agent_turns
      WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY requested_at ASC, id ASC
    `).all() as AgentTurnRow[]).map(agentTurnFromRow);
  }

  terminalAuthoritativeAgentTurnsMissingGitArtifacts(): AgentTurn[] {
    return (this.database.prepare(`
      SELECT turn.*
      FROM agent_turns AS turn
      LEFT JOIN turn_git_artifacts AS artifact ON artifact.turn_id = turn.id
      WHERE turn.association = 'authoritative'
        AND turn.status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND artifact.turn_id IS NULL
      ORDER BY turn.requested_at ASC, turn.id ASC
    `).all() as AgentTurnRow[]).map(agentTurnFromRow);
  }

  createTurnGitArtifact(input: CreateTurnGitArtifactInput): StoredTurnGitArtifact {
    const turn = this.agentTurn(input.turnId);
    const createdAt = requireTimestamp(input.createdAt ?? new Date().toISOString(), "Artifact creation time");
    const beforeCheckpointId = optionalTurnString(
      input.beforeCheckpointId,
      "Artifact checkpoint ID",
      200,
    );
    if (beforeCheckpointId) {
      const checkpoint = this.checkpoint(beforeCheckpointId);
      if (checkpoint.conversationId !== turn.conversationId) {
        throw new Error("The artifact checkpoint belongs to a different conversation.");
      }
      if (checkpoint.turnId !== null && checkpoint.turnId !== turn.id) {
        throw new Error("The artifact checkpoint belongs to a different turn.");
      }
    }
    const status = input.status ?? "pending";
    if (!["pending", "ready", "partial", "unavailable", "failed"].includes(status)) {
      throw new Error("The turn Git artifact status is invalid.");
    }
    const artifact: StoredTurnGitArtifact = {
      id: requiredTurnString(input.id ?? randomUUID(), "Artifact ID", 200),
      turnId: turn.id,
      conversationId: turn.conversationId,
      runId: turn.runId,
      repositoryIdentity: optionalSha256(input.repositoryIdentity, "Repository identity"),
      worktreeIdentity: optionalSha256(input.worktreeIdentity, "Worktree identity"),
      branch: optionalTurnString(input.branch, "Artifact branch", 300),
      beforeCheckpointId,
      beforeRef: optionalArtifactRef(input.beforeRef, "Artifact before reference"),
      afterRef: null,
      beforeFingerprint: optionalSha256(input.beforeFingerprint, "Artifact before fingerprint"),
      afterFingerprint: null,
      files: [],
      insertions: 0,
      deletions: 0,
      status,
      completeness: input.completeness ?? (status === "unavailable" ? "unavailable" : "partial"),
      patchState: "none",
      patchDigest: null,
      capturedAt: null,
      terminalAssistantMessageId: null,
      failureReason: optionalTurnString(input.failureReason, "Artifact failure reason", 1_000),
      absenceReason: input.absenceReason === "not-repository"
        ? input.absenceReason
        : null,
      createdAt,
      updatedAt: createdAt,
    };
    this.database.prepare(`
      INSERT INTO turn_git_artifacts (
        id, turn_id, conversation_id, run_id, repository_identity, worktree_identity,
        branch, before_checkpoint_id, before_ref, after_ref, before_fingerprint,
        after_fingerprint, files_json, insertions, deletions, status, completeness,
        patch_state, patch_digest, captured_at, terminal_assistant_message_id,
        failure_reason, absence_reason, created_at, updated_at
      ) VALUES (
        @id, @turnId, @conversationId, @runId, @repositoryIdentity, @worktreeIdentity,
        @branch, @beforeCheckpointId, @beforeRef, NULL, @beforeFingerprint,
        NULL, '[]', 0, 0, @status, @completeness,
        'none', NULL, NULL, NULL, @failureReason, @absenceReason, @createdAt, @updatedAt
      )
    `).run(artifact);
    return artifact;
  }

  completeTurnGitArtifact(
    turnId: string,
    input: CompleteTurnGitArtifactInput,
  ): StoredTurnGitArtifact {
    const row = this.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    if (!row) throw new RecordNotFoundError("Turn Git artifact not found.");
    const current = storedTurnGitArtifactFromRow(row);
    const updatedAt = requireTimestamp(input.updatedAt ?? new Date().toISOString(), "Artifact update time");
    if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error("Artifact update time cannot move backwards.");
    }
    const files = input.files === undefined
      ? current.files
      : normalizeTurnGitArtifactFiles(input.files);
    const filesJson = JSON.stringify(files);
    if (filesJson.length > 262_144) throw new Error("Turn Git artifact file metadata is too large.");
    const insertions = input.insertions ?? current.insertions;
    const deletions = input.deletions ?? current.deletions;
    if (
      !Number.isSafeInteger(insertions)
      || insertions < 0
      || !Number.isSafeInteger(deletions)
      || deletions < 0
    ) throw new Error("Artifact statistics must be non-negative integers.");
    const afterRef = input.afterRef === undefined
      ? current.afterRef
      : optionalArtifactRef(input.afterRef, "Artifact after reference");
    const afterFingerprint = input.afterFingerprint === undefined
      ? current.afterFingerprint
      : optionalSha256(input.afterFingerprint, "Artifact after fingerprint");
    const patchDigest = input.patchDigest === undefined
      ? current.patchDigest
      : optionalSha256(input.patchDigest, "Artifact patch digest");
    const capturedAt = input.capturedAt === undefined
      ? current.capturedAt
      : input.capturedAt === null
        ? null
        : requireTimestamp(input.capturedAt, "Artifact capture time");
    const terminalAssistantMessageId = input.terminalAssistantMessageId === undefined
      ? current.terminalAssistantMessageId
      : optionalTurnString(input.terminalAssistantMessageId, "Artifact terminal message ID", 200);
    if (
      terminalAssistantMessageId
      && terminalAssistantMessageId !== this.agentTurn(turnId).terminalAssistantMessageId
    ) {
      const message = this.database.prepare("SELECT * FROM messages WHERE id = ?")
        .get(terminalAssistantMessageId) as MessageRow | undefined;
      if (!message || message.turn_id !== turnId || message.role !== "assistant") {
        throw new Error("The artifact terminal message does not belong to this turn.");
      }
    }
    const failureReason = input.failureReason === undefined
      ? current.failureReason
      : optionalTurnString(input.failureReason, "Artifact failure reason", 1_000);
    const absenceReason = input.absenceReason === undefined
      ? current.absenceReason ?? null
      : input.absenceReason === "not-repository"
        ? input.absenceReason
        : null;
    this.database.prepare(`
      UPDATE turn_git_artifacts SET
        after_ref = @afterRef,
        after_fingerprint = @afterFingerprint,
        files_json = @filesJson,
        insertions = @insertions,
        deletions = @deletions,
        status = @status,
        completeness = @completeness,
        patch_state = @patchState,
        patch_digest = @patchDigest,
        captured_at = @capturedAt,
        terminal_assistant_message_id = @terminalAssistantMessageId,
        failure_reason = @failureReason,
        absence_reason = @absenceReason,
        updated_at = @updatedAt
      WHERE turn_id = @turnId
    `).run({
      turnId,
      afterRef,
      afterFingerprint,
      filesJson,
      insertions,
      deletions,
      status: input.status,
      completeness: input.completeness,
      patchState: input.patchState ?? current.patchState,
      patchDigest,
      capturedAt,
      terminalAssistantMessageId,
      failureReason,
      absenceReason,
      updatedAt,
    });
    return this.turnGitArtifactStorage(turnId);
  }

  turnGitArtifact(turnId: string): TurnGitArtifact | null {
    const row = this.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    return row ? turnGitArtifactFromRow(row) : null;
  }

  turnGitArtifactStorage(turnId: string): StoredTurnGitArtifact {
    const row = this.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    if (!row) throw new RecordNotFoundError("Turn Git artifact not found.");
    return storedTurnGitArtifactFromRow(row);
  }

  pendingTurnGitArtifacts(): StoredTurnGitArtifact[] {
    return (this.database.prepare(`
      SELECT * FROM turn_git_artifacts
      WHERE status = 'pending'
      ORDER BY created_at ASC, id ASC
    `).all() as TurnGitArtifactRow[]).map(storedTurnGitArtifactFromRow);
  }

  turnGitPatchDigests(): Set<string> {
    return new Set((this.database.prepare(`
      SELECT DISTINCT patch_digest AS digest
      FROM turn_git_artifacts
      WHERE patch_digest IS NOT NULL AND patch_state IN ('available', 'truncated')
    `).all() as Array<{ digest: string }>).map(({ digest }) => digest));
  }

  expireTurnGitPatch(digest: string): void {
    const validated = optionalSha256(digest, "Artifact patch digest");
    this.database.prepare(`
      UPDATE turn_git_artifacts
      SET patch_state = 'expired', updated_at = ?
      WHERE patch_digest = ? AND patch_state IN ('available', 'truncated')
    `).run(new Date().toISOString(), validated);
  }

  updateAgentTurnLifecycle(turnId: string, update: AgentTurnLifecycleUpdate): AgentTurn {
    const current = agentTurnFromRow(this.requireAgentTurn(turnId));
    if (!canTransitionAgentTurnStatus(current.status, update.status)) {
      throw new Error(`Agent turn cannot transition from ${current.status} to ${update.status}.`);
    }

    const updatedAt = requireTimestamp(update.updatedAt ?? new Date().toISOString(), "Turn update time");
    if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error("Turn update time cannot move backwards.");
    }
    const terminal = isAgentTurnTerminalStatus(update.status);
    const startsWork = update.status !== "queued";
    if (!startsWork && update.startedAt !== undefined) {
      throw new Error("A queued turn cannot have a start time.");
    }

    const requestedStartedAt = update.startedAt === undefined
      ? null
      : requireTimestamp(update.startedAt, "Turn start time");
    if (current.startedAt && requestedStartedAt && requestedStartedAt !== current.startedAt) {
      throw new Error("Turn start time is write-once.");
    }
    const startedAt = current.startedAt ?? (startsWork ? (requestedStartedAt ?? updatedAt) : null);
    if (startedAt && Date.parse(startedAt) < Date.parse(current.requestedAt)) {
      throw new Error("Turn start time cannot precede its request time.");
    }
    if (startedAt && Date.parse(startedAt) > Date.parse(updatedAt)) {
      throw new Error("Turn start time cannot follow its update time.");
    }

    if (!terminal) {
      const hasTerminalMetadata = update.completedAt !== undefined
        || update.terminalAssistantMessageId !== undefined
        || update.providerSessionAfter !== undefined
        || update.terminalReason !== undefined
        || update.checkpointId !== undefined
        || update.usageAtCompletion !== undefined;
      if (hasTerminalMetadata) throw new Error("Terminal turn metadata requires a terminal status.");
    }

    const requestedCompletedAt = update.completedAt === undefined
      ? null
      : requireTimestamp(update.completedAt, "Turn completion time");
    if (current.completedAt && requestedCompletedAt && requestedCompletedAt !== current.completedAt) {
      throw new Error("Turn completion time is write-once.");
    }
    const completedAt = terminal
      ? (current.completedAt ?? requestedCompletedAt ?? updatedAt)
      : null;
    if (completedAt && (!startedAt || Date.parse(completedAt) < Date.parse(startedAt))) {
      throw new Error("Turn completion time cannot precede its start time.");
    }
    if (completedAt && Date.parse(completedAt) > Date.parse(updatedAt)) {
      throw new Error("Turn completion time cannot follow its update time.");
    }

    const writeOnceString = (
      currentValue: string | null,
      requestedValue: string | null | undefined,
      label: string,
      maximum: number,
    ): string | null => {
      if (requestedValue === undefined) return currentValue;
      const normalized = optionalTurnString(requestedValue, label, maximum);
      if (currentValue !== null && normalized !== currentValue) throw new Error(`${label} is write-once.`);
      return normalized;
    };
    const terminalAssistantMessageId = terminal
      ? writeOnceString(current.terminalAssistantMessageId, update.terminalAssistantMessageId, "Terminal assistant message ID", 200)
      : null;
    const providerSessionAfter = terminal
      ? writeOnceString(current.providerSessionAfter, update.providerSessionAfter, "Terminal provider session", 1_000)
      : null;
    const terminalReason = terminal
      ? writeOnceString(current.terminalReason, update.terminalReason, "Turn terminal reason", 4_000)
      : null;
    const checkpointId = terminal
      ? writeOnceString(current.checkpointId, update.checkpointId, "Turn checkpoint ID", 200)
      : null;

    let usageAtCompletion = current.usageAtCompletion;
    if (terminal && update.usageAtCompletion !== undefined) {
      const requestedUsage = update.usageAtCompletion ? normalizeAgentTurnUsage(update.usageAtCompletion) : null;
      if (
        current.usageAtCompletion !== null
        && JSON.stringify(requestedUsage) !== JSON.stringify(current.usageAtCompletion)
      ) {
        throw new Error("Turn completion usage is write-once.");
      }
      usageAtCompletion = requestedUsage;
    }
    const usageCompletionJson = usageAtCompletion ? JSON.stringify(usageAtCompletion) : null;
    if (usageCompletionJson && usageCompletionJson.length > 16_384) throw new Error("Turn usage snapshot is too large.");

    const next: AgentTurn = {
      ...current,
      terminalAssistantMessageId,
      providerSessionAfter,
      startedAt,
      completedAt,
      status: update.status,
      terminalReason,
      checkpointId,
      usageAtCompletion,
      updatedAt,
    };
    let terminalMessage: MessageRow | undefined;
    if (terminalAssistantMessageId) {
      terminalMessage = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(terminalAssistantMessageId) as MessageRow | undefined;
      if (
        !terminalMessage
        || terminalMessage.conversation_id !== current.conversationId
        || terminalMessage.role !== "assistant"
      ) {
        throw new Error("The terminal assistant message must belong to the same conversation.");
      }
      if (terminalMessage.turn_id !== null && terminalMessage.turn_id !== current.id) {
        throw new Error("The terminal assistant message is already owned by a different turn.");
      }
    }
    const updateTurn = this.database.prepare(`
      UPDATE agent_turns SET
        terminal_assistant_message_id = @terminalAssistantMessageId,
        provider_session_after = @providerSessionAfter,
        started_at = @startedAt,
        completed_at = @completedAt,
        status = @status,
        terminal_reason = @terminalReason,
        checkpoint_id = @checkpointId,
        usage_completion_json = @usageCompletionJson,
        updated_at = @updatedAt
      WHERE id = @id
        AND status = @previousStatus
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    `);
    this.database.transaction(() => {
      const result = updateTurn.run({ ...next, usageCompletionJson, previousStatus: current.status });
      if (result.changes !== 1) {
        throw new Error("Agent turn lifecycle changed concurrently or was already settled.");
      }
      if (terminalMessage) {
        this.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(current.id, terminalMessage.id);
      }
    })();
    return next;
  }

  /**
   * Atomically wins one terminal outcome. Callers losing a completion/cancel/
   * process-exit race receive the already-authoritative turn without changing
   * its status, timestamps, reason, session, message, checkpoint, or usage.
   */
  settleAgentTurn(turnId: string, update: AgentTurnSettlementUpdate): AgentTurnSettlementResult {
    const current = this.agentTurn(turnId);
    if (isAgentTurnTerminalStatus(current.status)) return { settled: false, turn: current };
    try {
      return {
        settled: true,
        turn: this.updateAgentTurnLifecycle(turnId, update),
      };
    } catch (error) {
      const latest = this.agentTurn(turnId);
      if (isAgentTurnTerminalStatus(latest.status)) return { settled: false, turn: latest };
      throw error;
    }
  }

  settleConversation(conversationId: string, settled: boolean): Conversation {
    const current = conversationFromRow(this.requireConversation(conversationId));
    if (settled && (current.status === "running" || current.status === "needs-input")) {
      throw new Error("Active threads cannot be settled while the agent is working or waiting for you.");
    }
    const now = new Date().toISOString();
    const settledAt = settled ? now : null;
    this.database.prepare("UPDATE conversations SET settled_at = ?, last_viewed_at = CASE WHEN ? THEN ? ELSE last_viewed_at END, updated_at = ? WHERE id = ?")
      .run(settledAt, Number(settled), now, now, conversationId);
    this.touchProject(current.projectId, now);
    return { ...current, settledAt, lastViewedAt: settled ? now : current.lastViewedAt, updatedAt: now };
  }

  archiveConversation(conversationId: string, archived: boolean): void {
    const conversation = this.requireConversation(conversationId);
    const archivedAt = archived ? new Date().toISOString() : null;
    this.database.prepare("UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?").run(archivedAt, new Date().toISOString(), conversationId);
    const state = this.getState();
    if (archived && state.active_conversation_id === conversationId) this.selectProject(conversation.project_id);
  }

  deleteConversation(conversationId: string): void {
    const conversation = this.requireConversation(conversationId);
    this.database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    if (this.getState().active_conversation_id === null) this.selectProject(conversation.project_id);
  }

  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"] = "user",
    attachments: ChatAttachment[] = [],
    turnId: string | null = null,
    createdAt?: string,
  ): ChatMessage {
    const conversation = this.requireConversation(conversationId);
    if (turnId) {
      const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
      if (turn.conversationId !== conversationId) throw new Error("The message turn belongs to a different conversation.");
      if (role === "user" && turn.userMessageId) {
        throw new Error("Create the user message before creating its agent turn.");
      }
    }
    const now = createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(createdAt, "Message creation time");
    const message: ChatMessage = { id: randomUUID(), conversationId, turnId, role, content, attachments, createdAt: now };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at) VALUES (@id, @conversationId, @turnId, @role, @content, @attachmentsJson, @createdAt)`).run({ ...message, attachmentsJson: JSON.stringify(attachments) });
      this.database.prepare(`
        UPDATE conversations
        SET updated_at = ?, settled_at = NULL,
            last_viewed_at = CASE WHEN ? = 'user' THEN ? ELSE last_viewed_at END
        WHERE id = ?
      `).run(now, role, now, conversationId);
      this.touchProject(conversation.project_id, now);
      if (role === "user") {
        this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1")
          .run(conversation.project_id, conversationId);
      }
    })();
    return message;
  }

  createFollowUpMessage(
    conversationId: string,
    turnId: string,
    content: string,
    createdAt?: string,
  ): ChatMessage {
    const conversation = this.requireConversation(conversationId);
    const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
    if (
      turn.conversationId !== conversationId
      || isAgentTurnTerminalStatus(turn.status)
    ) {
      throw new Error("The active turn cannot accept this follow-up.");
    }
    const now = createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(createdAt, "Follow-up creation time");
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId,
      turnId,
      role: "user",
      content,
      attachments: [],
      createdAt: now,
    };
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO messages (
          id, conversation_id, turn_id, role, content,
          attachments_json, created_at
        ) VALUES (@id, @conversationId, @turnId, 'user', @content, '[]', @createdAt)
      `).run(message);
      this.database.prepare(`
        UPDATE conversations
        SET updated_at = ?, settled_at = NULL, last_viewed_at = ?
        WHERE id = ?
      `).run(now, now, conversationId);
      this.touchProject(conversation.project_id, now);
    })();
    return message;
  }

  deleteFollowUpMessage(
    messageId: string,
    conversationId: string,
    turnId: string,
  ): boolean {
    const result = this.database.prepare(`
      DELETE FROM messages
      WHERE id = ? AND conversation_id = ? AND turn_id = ? AND role = 'user'
        AND id <> (
          SELECT user_message_id FROM agent_turns WHERE id = ?
        )
    `).run(messageId, conversationId, turnId, turnId);
    return result.changes > 0;
  }

  associateMessageWithTurn(messageId: string, conversationId: string, runId: string, turnId: string): ChatMessage {
    const turn = this.assertAgentTurnIdentity(conversationId, runId, turnId);
    const row = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!row || row.conversation_id !== conversationId) throw new RecordNotFoundError("Message not found.");
    if (row.role === "user" && turn.userMessageId !== messageId) {
      throw new Error("The user message is owned by a different turn.");
    }
    if (row.turn_id !== null && row.turn_id !== turnId) {
      throw new Error("The message is already owned by a different turn.");
    }
    if (row.turn_id === null) this.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turnId, messageId);
    return { ...messageFromRow(row), turnId };
  }

  updateMessageContent(messageId: string, content: string): void {
    const message = this.database.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(messageId) as { conversation_id: string } | undefined;
    if (!message) throw new RecordNotFoundError("Message not found.");
    this.database.prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, messageId);
    this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), message.conversation_id);
  }

  upsertAgentPlan(plan: AgentPlan): void {
    this.requireConversation(plan.conversationId);
    if (plan.turnId) this.assertAgentTurnIdentity(plan.conversationId, plan.runId, plan.turnId);
    this.database.prepare(`
      INSERT INTO agent_plans (conversation_id, run_id, turn_id, explanation, steps_json, updated_at)
      VALUES (@conversationId, @runId, @turnId, @explanation, @stepsJson, @updatedAt)
      ON CONFLICT(conversation_id, run_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        explanation = excluded.explanation,
        steps_json = excluded.steps_json,
        updated_at = excluded.updated_at
    `).run({
      conversationId: plan.conversationId,
      runId: plan.runId,
      turnId: plan.turnId,
      explanation: plan.explanation,
      stepsJson: JSON.stringify(plan.steps.slice(0, 50)),
      updatedAt: new Date().toISOString(),
    });
  }

  clearAgentPlan(conversationId: string, runId: string, turnId: string | null): void {
    this.requireConversation(conversationId);
    if (turnId) this.assertAgentTurnIdentity(conversationId, runId, turnId);
    this.database.prepare(`
      DELETE FROM agent_plans
      WHERE conversation_id = ? AND run_id = ? AND turn_id IS ?
    `).run(conversationId, runId, turnId);
  }

  addActivity(
    activity: Omit<AgentActivity, "id" | "createdAt" | "turnId"> & {
      turnId?: string | null;
      createdAt?: string;
    },
  ): AgentActivity {
    this.requireConversation(activity.conversationId);
    const turnId = activity.turnId ?? null;
    if (turnId) this.assertAgentTurnIdentity(activity.conversationId, activity.runId, turnId);
    const record: AgentActivity = {
      ...activity,
      turnId,
      id: randomUUID(),
      createdAt: activity.createdAt ?? new Date().toISOString(),
    };
    this.database.prepare(`INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at) VALUES (@id, @conversationId, @runId, @turnId, @kind, @title, @detail, @status, @createdAt)`).run(record);
    return record;
  }

  updateActivity(id: string, update: Partial<Pick<AgentActivity, "title" | "detail" | "status">>): AgentActivity {
    const row = this.database.prepare("SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | undefined;
    if (!row) throw new RecordNotFoundError("Activity not found.");
    const next = { ...activityFromRow(row), ...update };
    this.database.prepare("UPDATE activities SET title = ?, detail = ?, status = ? WHERE id = ?").run(next.title, next.detail, next.status, id);
    return next;
  }

  subagentTrace(traceId: string): SubagentTrace {
    const row = this.database.prepare(
      "SELECT * FROM subagent_traces WHERE id = ?",
    ).get(traceId) as SubagentTraceRow | undefined;
    if (!row) throw new RecordNotFoundError("Delegated task not found.");
    return subagentTraceFromRow(row);
  }

  upsertSubagentTrace(
    input: UpsertSubagentTraceInput,
  ): UpsertSubagentTraceResult | null {
    this.assertAgentTurnIdentity(input.conversationId, input.runId, input.turnId);
    const providerTaskId = boundedSubagentIdentifier(input.providerTaskId);
    const providerAgentId = boundedSubagentIdentifier(input.providerAgentId);
    if (!providerTaskId && !providerAgentId) return null;
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) return null;
    const identityParams = [
      input.conversationId,
      input.runId,
      input.providerId,
    ] as const;
    const byTask = providerTaskId
      ? this.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_task_id = ?
        `).get(...identityParams, providerTaskId) as SubagentTraceRow | undefined
      : undefined;
    const byAgent = providerAgentId
      ? this.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_agent_id = ?
        `).get(...identityParams, providerAgentId) as SubagentTraceRow | undefined
      : undefined;
    if (byTask && byAgent && byTask.id !== byAgent.id) return null;
    const providerToolUseId = boundedSubagentIdentifier(input.providerToolUseId);
    const byToolUse = !byTask && !byAgent && providerToolUseId
      ? this.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_tool_use_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, providerToolUseId) as SubagentTraceRow | undefined
      : undefined;
    const existing = byTask ?? byAgent ?? byToolUse;
    if (existing && input.sequence <= existing.sequence) {
      return { trace: subagentTraceFromRow(existing), changed: false };
    }
    if (
      existing
      && isTerminalSubagentStatus(existing.status)
      && !isTerminalSubagentStatus(input.status)
    ) {
      return { trace: subagentTraceFromRow(existing), changed: false };
    }

    const parentProviderAgentId = boundedSubagentIdentifier(
      input.parentProviderAgentId,
    );
    const parentProviderToolUseId = boundedSubagentIdentifier(
      input.parentProviderToolUseId,
    );
    const parentByAgent = parentProviderAgentId
      ? this.database.prepare(`
          SELECT id FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_agent_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, parentProviderAgentId) as { id: string } | undefined
      : undefined;
    const parentByToolUse = !parentByAgent && parentProviderToolUseId
      ? this.database.prepare(`
          SELECT id FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_tool_use_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, parentProviderToolUseId) as { id: string } | undefined
      : undefined;
    const parent = parentByAgent ?? parentByToolUse;
    const now = input.updatedAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(input.updatedAt, "Delegated task update time");
    const normalized = {
      providerTaskId,
      providerAgentId,
      parentTraceId: parent?.id ?? null,
      parentProviderAgentId,
      parentProviderToolUseId,
      providerToolUseId,
      providerRole: boundedSubagentIdentifier(input.providerRole, 200),
      providerName: boundedSubagentIdentifier(input.providerName, 200),
      description: boundedSubagentText(
        input.description,
        MAX_SUBAGENT_DESCRIPTION_CHARS,
      ),
      progress: boundedSubagentText(
        input.progress,
        MAX_SUBAGENT_PROGRESS_CHARS,
      ),
      result: boundedSubagentText(input.result, MAX_SUBAGENT_RESULT_CHARS),
    };

    if (existing) {
      this.database.prepare(`
        UPDATE subagent_traces
        SET provider_task_id = COALESCE(@providerTaskId, provider_task_id),
            provider_agent_id = COALESCE(@providerAgentId, provider_agent_id),
            parent_trace_id = COALESCE(@parentTraceId, parent_trace_id),
            parent_provider_agent_id = COALESCE(
              @parentProviderAgentId,
              parent_provider_agent_id
            ),
            parent_provider_tool_use_id = COALESCE(
              @parentProviderToolUseId,
              parent_provider_tool_use_id
            ),
            provider_tool_use_id = COALESCE(
              @providerToolUseId,
              provider_tool_use_id
            ),
            provider_role = COALESCE(@providerRole, provider_role),
            provider_name = COALESCE(@providerName, provider_name),
            status = @status,
            description = COALESCE(@description, description),
            progress = COALESCE(@progress, progress),
            result = COALESCE(@result, result),
            sequence = @sequence,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id: existing.id,
        ...normalized,
        status: input.status,
        sequence: input.sequence,
        updatedAt: now < existing.updated_at ? existing.updated_at : now,
      });
      this.linkSubagentChildren(existing.id);
      return {
        trace: this.subagentTrace(existing.id),
        changed: true,
      };
    }

    const count = (this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM subagent_traces
      WHERE turn_id = ?
    `).get(input.turnId) as { count: number }).count;
    if (count >= MAX_SUBAGENT_TRACES_PER_TURN) return null;
    const trace: SubagentTrace = {
      id: randomUUID(),
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
      providerId: input.providerId,
      ...normalized,
      status: input.status,
      sequence: input.sequence,
      createdAt: now,
      updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO subagent_traces (
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role,
        provider_name, status, description, progress, result, sequence,
        created_at, updated_at
      ) VALUES (
        @id, @conversationId, @runId, @turnId, @providerId,
        @providerTaskId, @providerAgentId, @parentTraceId,
        @parentProviderAgentId, @parentProviderToolUseId,
        @providerToolUseId, @providerRole,
        @providerName, @status, @description, @progress, @result, @sequence,
        @createdAt, @updatedAt
      )
    `).run(trace);
    this.linkSubagentChildren(trace.id);
    return { trace, changed: true };
  }

  settleLiveSubagents(
    turnId: string,
    status: Extract<SubagentTraceStatus, "cancelled" | "lost">,
    updatedAt = new Date().toISOString(),
  ): SubagentTrace[] {
    const now = requireTimestamp(updatedAt, "Delegated task settlement time");
    const rows = this.database.prepare(`
      SELECT * FROM subagent_traces
      WHERE turn_id = ?
        AND status IN ('spawned', 'running', 'waiting')
      ORDER BY created_at ASC, sequence ASC, id ASC
    `).all(turnId) as SubagentTraceRow[];
    if (rows.length === 0) return [];
    const update = this.database.prepare(`
      UPDATE subagent_traces
      SET status = ?, sequence = sequence + 1, updated_at = ?
      WHERE id = ?
        AND status IN ('spawned', 'running', 'waiting')
    `);
    this.database.transaction(() => {
      for (const row of rows) update.run(status, now, row.id);
    })();
    return rows.map(({ id }) => this.subagentTrace(id));
  }

  createReasoning(conversationId: string, runId: string, turnId: string | null = null): AgentReasoning {
    this.requireConversation(conversationId);
    if (turnId) this.assertAgentTurnIdentity(conversationId, runId, turnId);
    const reasoning: AgentReasoning = {
      id: randomUUID(),
      conversationId,
      runId,
      turnId,
      content: "",
      status: "running",
      createdAt: new Date().toISOString(),
    };
    this.database.prepare(`INSERT INTO agent_reasonings (id, conversation_id, run_id, turn_id, content, status, created_at) VALUES (@id, @conversationId, @runId, @turnId, @content, @status, @createdAt)`).run(reasoning);
    return reasoning;
  }

  updateReasoning(id: string, update: Partial<Pick<AgentReasoning, "content" | "status">>): AgentReasoning {
    const row = this.database.prepare("SELECT * FROM agent_reasonings WHERE id = ?").get(id) as AgentReasoningRow | undefined;
    if (!row) throw new RecordNotFoundError("Reasoning summary not found.");
    const next = { ...reasoningFromRow(row), ...update };
    this.database.prepare("UPDATE agent_reasonings SET content = ?, status = ? WHERE id = ?").run(next.content, next.status, id);
    return next;
  }

  upsertUsage(
    usage: Omit<ThreadUsageSnapshot, "updatedAt" | "turnId"> & { turnId?: string | null },
  ): ThreadUsageSnapshot {
    this.requireConversation(usage.conversationId);
    const turnId = usage.turnId ?? null;
    if (turnId) {
      const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
      if (turn.conversationId !== usage.conversationId) {
        throw new Error("The usage snapshot turn belongs to a different conversation.");
      }
    }
    const next: ThreadUsageSnapshot = {
      conversationId: usage.conversationId,
      turnId,
      ...validateProviderUsage(usage),
      updatedAt: new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT INTO thread_usage (conversation_id, turn_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, compacts_automatically, updated_at)
      VALUES (@conversationId, @turnId, @usedTokens, @totalProcessedTokens, @totalProcessedScope, @maxTokens, @inputTokens, @cachedInputTokens, @cacheWriteInputTokens, @outputTokens, @reasoningOutputTokens, @compactsAutomatically, @updatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        used_tokens = excluded.used_tokens,
        total_processed_tokens = excluded.total_processed_tokens,
        total_processed_scope = excluded.total_processed_scope,
        max_tokens = excluded.max_tokens,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_write_input_tokens = excluded.cache_write_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        compacts_automatically = excluded.compacts_automatically,
        updated_at = excluded.updated_at
    `).run({ ...next, compactsAutomatically: next.compactsAutomatically === null ? null : Number(next.compactsAutomatically) });
    return next;
  }

  usageForConversation(conversationId: string): ThreadUsageSnapshot | null {
    this.requireConversation(conversationId);
    const row = this.database.prepare(
      "SELECT * FROM thread_usage WHERE conversation_id = ?",
    ).get(conversationId) as ThreadUsageRow | undefined;
    return row ? usageFromRow(row) : null;
  }

  checkpointCount(conversationId: string): number {
    this.requireConversation(conversationId);
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM checkpoints WHERE conversation_id = ?",
    ).get(conversationId) as { count: number };
    return row.count;
  }

  addCheckpoint(
    input: Omit<CheckpointSummary, "id" | "createdAt" | "turnId"> & { turnId?: string | null },
  ): CheckpointSummary {
    this.requireConversation(input.conversationId);
    const turnId = input.turnId ?? null;
    if (turnId) {
      const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
      if (turn.conversationId !== input.conversationId) {
        throw new Error("The checkpoint turn belongs to a different conversation.");
      }
    }
    const checkpoint: CheckpointSummary = { ...input, turnId, id: randomUUID(), createdAt: new Date().toISOString() };
    this.database.prepare(`INSERT INTO checkpoints (id, conversation_id, turn_id, ref, label, turn_index, files_changed, insertions, deletions, created_at) VALUES (@id, @conversationId, @turnId, @ref, @label, @turnIndex, @filesChanged, @insertions, @deletions, @createdAt)`).run(checkpoint);
    return checkpoint;
  }

  associateCheckpointWithTurn(checkpointId: string, conversationId: string, runId: string, turnId: string): CheckpointSummary {
    this.assertAgentTurnIdentity(conversationId, runId, turnId);
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (!row || row.conversation_id !== conversationId) throw new RecordNotFoundError("Checkpoint not found.");
    if (row.turn_id !== null && row.turn_id !== turnId) {
      throw new Error("The checkpoint is already owned by a different turn.");
    }
    if (row.turn_id === null) this.database.prepare("UPDATE checkpoints SET turn_id = ? WHERE id = ?").run(turnId, checkpointId);
    return { ...checkpointFromRow(row), turnId };
  }

  upsertReviewSummary(summary: DiffReviewSummary): DiffReviewSummary {
    const validated = validatePersistedReviewSummary(summary);
    this.requireConversation(validated.conversationId);
    const filesJson = JSON.stringify(validated.files);
    const summaryJson = JSON.stringify(validated);
    this.database.prepare(`
      INSERT INTO diff_review_summaries
        (conversation_id, fingerprint, provider_id, overall, files_json, generated_at, summary_json)
      VALUES
        (@conversationId, @fingerprint, @providerId, @overall, @filesJson, @generatedAt, @summaryJson)
      ON CONFLICT(conversation_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        provider_id = excluded.provider_id,
        overall = excluded.overall,
        files_json = excluded.files_json,
        generated_at = excluded.generated_at,
        summary_json = excluded.summary_json
    `).run({ ...validated, filesJson, summaryJson });
    return validated;
  }

  setReviewState(input: Omit<DiffReviewState, "stale" | "updatedAt">): DiffReviewState {
    this.requireConversation(input.conversationId);
    if ((input.scope === "file" && input.hunkId !== null) || (input.scope === "hunk" && !input.hunkId)) {
      throw new Error("The review target is invalid.");
    }
    const state: DiffReviewState = { ...input, stale: false, updatedAt: new Date().toISOString() };
    this.database.prepare(`
      INSERT INTO diff_review_states
        (conversation_id, scope, path, hunk_id, target_fingerprint, reviewed, stale, updated_at)
      VALUES (@conversationId, @scope, @path, @hunkId, @targetFingerprint, @reviewedValue, 0, @updatedAt)
      ON CONFLICT(conversation_id, scope, path, hunk_id) DO UPDATE SET
        target_fingerprint = excluded.target_fingerprint,
        reviewed = excluded.reviewed,
        stale = 0,
        updated_at = excluded.updated_at
    `).run({
      ...state,
      hunkId: state.hunkId ?? "",
      reviewedValue: Number(state.reviewed),
    });
    return state;
  }

  createReviewNote(input: Omit<DiffReviewNote, "id" | "stale" | "createdAt" | "updatedAt">): DiffReviewNote {
    this.requireConversation(input.conversationId);
    const now = new Date().toISOString();
    const note: DiffReviewNote = {
      ...input,
      id: randomUUID(),
      body: input.body.trim(),
      lineIds: [...new Set(input.lineIds)].slice(0, 500),
      stale: false,
      createdAt: now,
      updatedAt: now,
    };
    if (!note.body || note.body.length > 8_000) throw new Error("Review notes must contain between 1 and 8,000 characters.");
    const lineIdsJson = JSON.stringify(note.lineIds);
    if (lineIdsJson.length > 65_536) throw new Error("The review note range is too large.");
    this.database.prepare(`
      INSERT INTO diff_review_notes
        (id, conversation_id, path, hunk_id, line_ids_json, target_fingerprint, body, stale, created_at, updated_at)
      VALUES (@id, @conversationId, @path, @hunkId, @lineIdsJson, @targetFingerprint, @body, 0, @createdAt, @updatedAt)
    `).run({ ...note, hunkId: note.hunkId ?? "", lineIdsJson });
    return note;
  }

  updateReviewNote(conversationId: string, noteId: string, body: string): DiffReviewNote {
    this.requireConversation(conversationId);
    const row = this.database.prepare("SELECT * FROM diff_review_notes WHERE id = ? AND conversation_id = ?")
      .get(noteId, conversationId) as DiffReviewNoteRow | undefined;
    if (!row) throw new RecordNotFoundError("Review note not found.");
    const nextBody = body.trim();
    if (!nextBody || nextBody.length > 8_000) throw new Error("Review notes must contain between 1 and 8,000 characters.");
    const updatedAt = new Date().toISOString();
    this.database.prepare("UPDATE diff_review_notes SET body = ?, updated_at = ? WHERE id = ?").run(nextBody, updatedAt, noteId);
    return { ...reviewNoteFromRow(row), body: nextBody, updatedAt };
  }

  deleteReviewNote(conversationId: string, noteId: string): void {
    this.requireConversation(conversationId);
    const result = this.database.prepare("DELETE FROM diff_review_notes WHERE id = ? AND conversation_id = ?").run(noteId, conversationId);
    if (result.changes === 0) throw new RecordNotFoundError("Review note not found.");
  }

  reviewNotesFor(conversationId: string): DiffReviewNote[] {
    this.requireConversation(conversationId);
    return (this.database.prepare("SELECT * FROM diff_review_notes WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId) as DiffReviewNoteRow[]).map(reviewNoteFromRow);
  }

  reconcileReviewTargets(
    conversationId: string,
    targets: {
      files: Readonly<Record<string, string>>;
      hunks: Readonly<Record<string, string>>;
      notes: Readonly<Record<string, string | null>>;
    },
  ): void {
    this.requireConversation(conversationId);
    const stateRows = this.database.prepare("SELECT * FROM diff_review_states WHERE conversation_id = ?")
      .all(conversationId) as DiffReviewStateRow[];
    const noteRows = this.database.prepare("SELECT * FROM diff_review_notes WHERE conversation_id = ?")
      .all(conversationId) as DiffReviewNoteRow[];
    const updateState = this.database.prepare("UPDATE diff_review_states SET reviewed = ?, stale = ?, updated_at = ? WHERE conversation_id = ? AND scope = ? AND path = ? AND hunk_id = ?");
    const updateNote = this.database.prepare("UPDATE diff_review_notes SET stale = ? WHERE id = ?");
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const row of stateRows) {
        const current = row.scope === "file"
          ? targets.files[row.path]
          : targets.hunks[`${row.path}\0${row.hunk_id}`];
        const stale = current !== row.target_fingerprint;
        if (stale !== (row.stale === 1) || (stale && row.reviewed === 1)) {
          updateState.run(stale ? 0 : row.reviewed, Number(stale), now, row.conversation_id, row.scope, row.path, row.hunk_id);
        }
      }
      for (const row of noteRows) {
        const current = Object.prototype.hasOwnProperty.call(targets.notes, row.id)
          ? targets.notes[row.id]
          : row.hunk_id
            ? targets.hunks[`${row.path}\0${row.hunk_id}`]
            : targets.files[row.path];
        const stale = current !== row.target_fingerprint;
        if (stale !== (row.stale === 1)) updateNote.run(Number(stale), row.id);
      }
    })();
  }

  createWorkspaceRun(
    input: Omit<WorkspaceRun, "id" | "actionId" | "attentionState" | "canStop" | "startedAt" | "finishedAt"> & {
      id?: string;
      actionId?: string | null;
      attentionState?: WorkspaceRun["attentionState"];
    },
  ): WorkspaceRun {
    this.requireProject(input.projectId);
    if (input.conversationId) this.requireConversation(input.conversationId);
    const run: WorkspaceRun = {
      ...input,
      id: input.id ?? randomUUID(),
      actionId: input.actionId?.trim().slice(0, 200) || null,
      label: input.label.trim().slice(0, 200),
      detail: input.detail?.slice(0, 1_000) ?? null,
      attentionState: input.attentionState
        ?? (
          input.status === "waiting"
          || input.status === "failed"
          || (input.kind === "agent" && input.status === "succeeded")
            ? "unseen"
            : "acknowledged"
        ),
      canStop: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.database.prepare(`
      INSERT INTO workspace_runs (
        id, kind, project_id, conversation_id, action_id, label, detail,
        status, attention_state, port, started_at, finished_at
      )
      VALUES (
        @id, @kind, @projectId, @conversationId, @actionId, @label, @detail,
        @status, @attentionState, @port, @startedAt, @finishedAt
      )
    `).run(run);
    this.database.prepare(`
      DELETE FROM workspace_runs WHERE id IN (
        SELECT id FROM workspace_runs WHERE status NOT IN ('running', 'waiting') ORDER BY started_at DESC LIMIT -1 OFFSET 200
      )
    `).run();
    return run;
  }

  updateWorkspaceRun(id: string, update: Partial<Pick<WorkspaceRun, "label" | "detail" | "status" | "port" | "finishedAt">>): WorkspaceRun {
    const row = this.database.prepare("SELECT * FROM workspace_runs WHERE id = ?").get(id) as WorkspaceRunRow | undefined;
    if (!row) throw new RecordNotFoundError("Workspace activity not found.");
    const current = workspaceRunFromRow(row);
    const nextStatus = update.status ?? current.status;
    const statusChanged = nextStatus !== current.status;
    const attentionState = !statusChanged
      ? current.attentionState
      : nextStatus === "waiting"
        || nextStatus === "failed"
        || (current.kind === "agent" && nextStatus === "succeeded")
        ? "unseen"
        : nextStatus === "cancelled" || nextStatus === "succeeded"
          ? "acknowledged"
          : current.attentionState;
    const next: WorkspaceRun = {
      ...current,
      ...update,
      attentionState,
      label: update.label === undefined ? current.label : update.label.trim().slice(0, 200),
      detail: update.detail === undefined ? current.detail : update.detail?.slice(0, 1_000) ?? null,
      finishedAt: update.finishedAt !== undefined
        ? update.finishedAt
        : update.status && !["running", "waiting"].includes(update.status)
          ? new Date().toISOString()
          : current.finishedAt,
    };
    this.database.prepare(`
      UPDATE workspace_runs
      SET label = ?, detail = ?, status = ?, attention_state = ?, port = ?, finished_at = ?
      WHERE id = ?
    `).run(next.label, next.detail, next.status, next.attentionState, next.port, next.finishedAt, id);
    return next;
  }

  workspaceRun(id: string): WorkspaceRun {
    const row = this.database.prepare("SELECT * FROM workspace_runs WHERE id = ?").get(id) as WorkspaceRunRow | undefined;
    if (!row) throw new RecordNotFoundError("Workspace activity not found.");
    return workspaceRunFromRow(row);
  }

  hasActiveWorkspaceRunForProject(projectId: string): boolean {
    this.requireProject(projectId);
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM workspace_runs
      WHERE project_id = ? AND status IN ('running', 'waiting')
      LIMIT 1
    `).get(projectId));
  }

  hasActiveWorkspaceRunForConversation(conversationId: string): boolean {
    this.requireConversation(conversationId);
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM workspace_runs
      WHERE conversation_id = ? AND status IN ('running', 'waiting')
      LIMIT 1
    `).get(conversationId));
  }

  markWorkspaceRunSeen(id: string): WorkspaceRun {
    const run = this.workspaceRun(id);
    if (run.attentionState !== "unseen") return run;
    this.database.prepare("UPDATE workspace_runs SET attention_state = 'seen' WHERE id = ? AND attention_state = 'unseen'")
      .run(id);
    return { ...run, attentionState: "seen" };
  }

  acknowledgeWorkspaceRun(id: string): WorkspaceRun {
    const run = this.workspaceRun(id);
    if (run.status === "running" || run.status === "waiting") {
      throw new Error("Active or waiting workspace activity cannot be acknowledged.");
    }
    if (run.attentionState === "acknowledged") return run;
    if (run.attentionState === "dismissed") {
      throw new Error("Dismissed workspace activity cannot be acknowledged.");
    }
    this.database.prepare("UPDATE workspace_runs SET attention_state = 'acknowledged' WHERE id = ?")
      .run(id);
    return { ...run, attentionState: "acknowledged" };
  }

  dismissWorkspaceRun(id: string): void {
    const run = this.workspaceRun(id);
    if (run.status === "running" || run.status === "waiting") {
      throw new Error("Active workspace activity cannot be dismissed.");
    }
    this.database.prepare("UPDATE workspace_runs SET attention_state = 'dismissed' WHERE id = ?")
      .run(id);
  }

  checkpoint(checkpointId: string): CheckpointSummary {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (!row) throw new RecordNotFoundError("Checkpoint not found.");
    return checkpointFromRow(row);
  }

  listModelBackendProfiles(): StoredModelBackendProfile[] {
    return (this.database.prepare(`
      SELECT * FROM model_backend_profiles
      ORDER BY created_at ASC, profile_id ASC
    `).all() as ModelBackendProfileRow[]).map((row) =>
      this.modelBackendProfileFromRow(row));
  }

  modelBackendProfile(profileId: string): StoredModelBackendProfile {
    const row = this.database.prepare(`
      SELECT * FROM model_backend_profiles WHERE profile_id = ?
    `).get(profileId) as ModelBackendProfileRow | undefined;
    if (!row) throw new RecordNotFoundError("Model backend profile not found.");
    return this.modelBackendProfileFromRow(row);
  }

  saveModelBackendProfile(
    profileInput: PersistedModelBackendProfile,
  ): StoredModelBackendProfile {
    const parsed = persistedModelBackendProfileSchema.parse(profileInput);
    const existing = this.database.prepare(`
      SELECT * FROM model_backend_profiles WHERE profile_id = ?
    `).get(parsed.id) as ModelBackendProfileRow | undefined;
    const profile = existing
      ? persistedModelBackendProfileSchema.parse({
          ...parsed,
          createdAt: existing.created_at,
        })
      : parsed;
    if (containsBackendCredentialMaterial(profile)) {
      throw new Error("Model backend profiles cannot contain credential material.");
    }
    const configurationJson = JSON.stringify(profile);
    if (Buffer.byteLength(configurationJson, "utf8") > 262_144) {
      throw new Error("The model backend profile is too large.");
    }
    if (existing && existing.source === "built-in" && profile.source === "custom") {
      throw new Error("Built-in model backend identities cannot be replaced.");
    }
    const invalidatesEvidence = Boolean(existing && (
      existing.configuration_revision !== profile.configurationRevision
      || existing.endpoint_identity !== profile.endpointIdentity
      || existing.protocol !== profile.protocol
    ));
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO model_backend_profiles (
          profile_id, harness_id, preset, protocol, source, enabled,
          configuration_revision, endpoint_identity, credential_generation,
          configuration_json, latest_probe_json, created_at, updated_at
        ) VALUES (
          @profileId, @harnessId, @preset, @protocol, @source, @enabled,
          @configurationRevision, @endpointIdentity, @credentialGeneration,
          @configurationJson, NULL, @createdAt, @updatedAt
        )
        ON CONFLICT(profile_id) DO UPDATE SET
          harness_id = excluded.harness_id,
          preset = excluded.preset,
          protocol = excluded.protocol,
          source = excluded.source,
          enabled = excluded.enabled,
          configuration_revision = excluded.configuration_revision,
          endpoint_identity = excluded.endpoint_identity,
          credential_generation = excluded.credential_generation,
          configuration_json = excluded.configuration_json,
          latest_probe_json = CASE
            WHEN model_backend_profiles.configuration_revision
                   <> excluded.configuration_revision
              OR model_backend_profiles.endpoint_identity
                   IS NOT excluded.endpoint_identity
              OR model_backend_profiles.protocol <> excluded.protocol
              THEN NULL
            ELSE model_backend_profiles.latest_probe_json
          END,
          updated_at = excluded.updated_at
      `).run({
        profileId: profile.id,
        harnessId: profile.harnessId,
        preset: profile.preset,
        protocol: profile.protocol,
        source: profile.source,
        enabled: Number(profile.enabled),
        configurationRevision: profile.configurationRevision,
        endpointIdentity: profile.endpointIdentity,
        credentialGeneration: profile.credentialGeneration,
        configurationJson,
        createdAt: existing?.created_at ?? profile.createdAt,
        updatedAt: profile.updatedAt,
      });
      if (invalidatesEvidence) this.clearModelBackendDefaultsForProfile(profile.id);
    })();
    return this.modelBackendProfile(profile.id);
  }

  reconcileModelBackendCredentialGeneration(
    profileId: string,
    credentialGeneration: string | null,
  ): StoredModelBackendProfile {
    const stored = this.modelBackendProfile(profileId);
    if (stored.profile.credentialGeneration === credentialGeneration) return stored;
    const now = new Date().toISOString();
    const next = persistedModelBackendProfileSchema.parse({
      ...stored.profile,
      enabled: false,
      credentialGeneration,
      configurationRevision: stored.profile.configurationRevision + 1,
      updatedAt: now,
    });
    return this.saveModelBackendProfile(next);
  }

  recordModelBackendProbe(
    profileId: string,
    resultInput: BackendCompatibilityProbeResult,
  ): StoredModelBackendProfile {
    const stored = this.modelBackendProfile(profileId);
    const result = backendCompatibilityProbeResultSchema.parse(resultInput);
    if (
      result.profileId !== stored.profile.id
      || result.backendConfigurationRevision
        !== stored.profile.configurationRevision
      || result.endpointIdentity !== stored.profile.endpointIdentity
      || result.protocol !== stored.profile.protocol
    ) {
      throw new Error("The backend probe result does not match this profile revision.");
    }
    const resultJson = JSON.stringify(result);
    if (Buffer.byteLength(resultJson, "utf8") > 262_144) {
      throw new Error("The backend probe result is too large.");
    }
    this.database.prepare(`
      UPDATE model_backend_profiles
      SET latest_probe_json = ?
      WHERE profile_id = ?
    `).run(resultJson, profileId);
    return this.modelBackendProfile(profileId);
  }

  deleteModelBackendProfile(profileId: string): void {
    const stored = this.modelBackendProfile(profileId);
    if (stored.profile.source === "built-in") {
      throw new Error("Built-in model backend profiles cannot be deleted.");
    }
    this.database.transaction(() => {
      this.clearModelBackendDefaultsForProfile(profileId);
      this.database.prepare(
        "DELETE FROM model_backend_profiles WHERE profile_id = ?",
      ).run(profileId);
    })();
  }

  listModelBackendDefaults(): ModelBackendDefault[] {
    return (this.database.prepare(`
      SELECT * FROM model_backend_defaults
      ORDER BY CASE scope WHEN 'global' THEN 0 ELSE 1 END, project_id ASC
    `).all() as ModelBackendDefaultRow[]).map((row) =>
      modelBackendDefaultSchema.parse({
        scope: row.scope,
        projectId: row.project_id,
        selection: JSON.parse(row.selection_json) as unknown,
        updatedAt: row.updated_at,
      }));
  }

  saveModelBackendDefault(
    projectId: string | null,
    selectionInput: ModelSelection,
  ): ModelBackendDefault {
    if (projectId !== null) this.requireProject(projectId);
    const selection = modelSelectionSchema.parse(selectionInput);
    const value = modelBackendDefaultSchema.parse({
      scope: projectId === null ? "global" : "project",
      projectId,
      selection,
      updatedAt: new Date().toISOString(),
    });
    this.database.transaction(() => {
      if (projectId === null) {
        this.database.prepare(
          "DELETE FROM model_backend_defaults WHERE scope = 'global'",
        ).run();
      } else {
        this.database.prepare(`
          DELETE FROM model_backend_defaults
          WHERE scope = 'project' AND project_id = ?
        `).run(projectId);
      }
      this.database.prepare(`
        INSERT INTO model_backend_defaults (
          scope, project_id, selection_json, updated_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        value.scope,
        value.projectId,
        JSON.stringify(value.selection),
        value.updatedAt,
      );
    })();
    return value;
  }

  clearModelBackendDefault(projectId: string | null): void {
    if (projectId === null) {
      this.database.prepare(
        "DELETE FROM model_backend_defaults WHERE scope = 'global'",
      ).run();
      return;
    }
    this.database.prepare(`
      DELETE FROM model_backend_defaults
      WHERE scope = 'project' AND project_id = ?
    `).run(projectId);
  }

  updateSettings(update: Partial<AppSettings>): void {
    const current = this.snapshot().settings;
    const next = { ...current, ...update };
    this.database.prepare(`
      UPDATE app_state SET
        theme = ?, compact_sidebar = ?, show_timestamps = ?, terminal_font_size = ?,
        default_provider = ?, default_model = ?, default_access_mode = ?,
        new_thread_mode = ?, wrap_diffs = ?, ignore_whitespace = ?, show_thinking = ?,
        show_usage = ?, usage_display_mode = ?, interface_scale = ?, response_density = ?, default_code_wrap = ?,
        auto_collapse_work_log = ?, show_changed_file_summaries = ?,
        sidebar_mode = ?, project_grouping = ?, auto_open_plan = ?,
        confirm_destructive_actions = ?, default_reasoning_effort = ?,
        default_interaction_mode = ?,
        codex_binary_path = ?
      WHERE id = 1
    `).run(
      next.theme,
      Number(next.compactSidebar),
      Number(next.showTimestamps),
      next.terminalFontSize,
      next.defaultProvider,
      next.defaultModel,
      next.defaultAccessMode,
      next.newThreadMode,
      Number(next.wrapDiffs),
      Number(next.ignoreWhitespace),
      Number(next.showThinking),
      Number(next.usageDisplayMode !== "hidden"),
      next.usageDisplayMode,
      next.interfaceScale,
      next.responseDensity,
      Number(next.defaultCodeWrap),
      Number(next.autoCollapseWorkLog),
      Number(next.showChangedFileSummaries),
      next.sidebarMode,
      next.projectGrouping,
      Number(next.autoOpenPlan),
      Number(next.confirmDestructiveActions),
      next.defaultReasoningEffort,
      next.defaultInteractionMode,
      next.codexBinaryPath,
    );
  }

  project(projectId: string): Project {
    return projectFromRow(this.requireProject(projectId));
  }

  conversation(conversationId: string): Conversation {
    return conversationFromRow(this.requireConversation(conversationId));
  }

  projectPath(projectId: string): string {
    return this.requireProject(projectId).path;
  }

  conversationPath(conversationId: string): string {
    const conversation = this.requireConversation(conversationId);
    return conversation.worktree_path ?? this.requireProject(conversation.project_id).path;
  }

  private touchProject(projectId: string, timestamp: string): void {
    this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
  }

  private getState(): StateRow {
    const state = this.database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Runtime state is unavailable.");
    return state;
  }

  private requireProject(projectId: string): ProjectRow {
    const project = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!project) throw new RecordNotFoundError("Project not found.");
    return project;
  }

  private requireConversation(conversationId: string): ConversationRow {
    const conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
    if (!conversation) throw new RecordNotFoundError("Conversation not found.");
    return conversation;
  }

  private requireAgentTurn(turnId: string): AgentTurnRow {
    const turn = this.database.prepare("SELECT * FROM agent_turns WHERE id = ?").get(turnId) as AgentTurnRow | undefined;
    if (!turn) throw new RecordNotFoundError("Agent turn not found.");
    return turn;
  }

  private linkSubagentChildren(parentTraceId: string): void {
    const parent = this.database.prepare(`
      SELECT conversation_id, run_id, provider_id, provider_agent_id,
             provider_tool_use_id
      FROM subagent_traces
      WHERE id = ?
    `).get(parentTraceId) as Pick<
      SubagentTraceRow,
      | "conversation_id"
      | "run_id"
      | "provider_id"
      | "provider_agent_id"
      | "provider_tool_use_id"
    > | undefined;
    if (!parent) return;
    this.database.prepare(`
      UPDATE subagent_traces
      SET parent_trace_id = ?
      WHERE id <> ?
        AND conversation_id = ?
        AND run_id = ?
        AND provider_id = ?
        AND parent_trace_id IS NULL
        AND (
          (
            ? IS NOT NULL
            AND parent_provider_agent_id = ?
          )
          OR
          (
            ? IS NOT NULL
            AND parent_provider_tool_use_id = ?
          )
        )
    `).run(
      parentTraceId,
      parentTraceId,
      parent.conversation_id,
      parent.run_id,
      parent.provider_id,
      parent.provider_agent_id,
      parent.provider_agent_id,
      parent.provider_tool_use_id,
      parent.provider_tool_use_id,
    );
  }

  private migrate(): void {
    const runtimeMigrations: DatabaseMigration[] = migrations.map((sql, index) => {
      const version = index + 1;
      return {
        version,
        name: version === 17 ? "ExplicitTurnOwnership" : `SchemaVersion${version}`,
        up: version === 17
          ? (database) => {
            this.ensureTurnAssociationColumns();
            database.exec(sql);
          }
          : sql,
      };
    });
    runtimeMigrations.push({
      version: migrations.length + 1,
      name: "BackfillLegacyAgentTurns",
      up: (database, context) => {
        context.setLegacyBackfillDiagnostics(backfillLegacyAgentTurns(database, {
          sourceSchemaVersion: context.sourceSchemaVersion,
        }));
      },
    });
    runtimeMigrations.push({
      version: migrations.length + 2,
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
    runtimeMigrations.push({
      version: migrations.length + 3,
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
    runtimeMigrations.push({
      version: migrations.length + 4,
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
    runtimeMigrations.push({
      version: migrations.length + 5,
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
    runtimeMigrations.push({
      version: migrations.length + 6,
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
    runtimeMigrations.push({
      version: migrations.length + 7,
      name: "PersistTurnModelSelection",
      up: (database) => {
        const addColumn = (
          table: "conversations" | "agent_turns",
          column: "model_selection_json" | "continuation_identity_json",
          maximum: number,
        ): void => {
          const columns = database.prepare(`PRAGMA table_info(${table})`)
            .all() as Array<{ name: string }>;
          if (columns.some(({ name }) => name === column)) return;
          database.exec(`
            ALTER TABLE ${table} ADD COLUMN ${column} TEXT
              CHECK (${column} IS NULL OR length(${column}) <= ${maximum});
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
    runtimeMigrations.push({
      version: migrations.length + 8,
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
    runtimeMigrations.push({
      version: migrations.length + 9,
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
    runtimeMigrations.push({
      version: migrations.length + 10,
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
    runtimeMigrations.push({
      version: migrations.length + 11,
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
    runDatabaseMigrations(this.database, runtimeMigrations, {
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

  private modelBackendProfileFromRow(
    row: ModelBackendProfileRow,
  ): StoredModelBackendProfile {
    let profileValue: unknown;
    let probeValue: unknown = null;
    try {
      profileValue = JSON.parse(row.configuration_json) as unknown;
      if (row.latest_probe_json !== null) {
        probeValue = JSON.parse(row.latest_probe_json) as unknown;
      }
    } catch {
      throw new Error("The stored model backend profile is invalid.");
    }
    if (containsBackendCredentialMaterial(profileValue)) {
      throw new Error("The stored model backend profile contains credential material.");
    }
    const profile = persistedModelBackendProfileSchema.parse(profileValue);
    if (
      profile.id !== row.profile_id
      || profile.harnessId !== row.harness_id
      || profile.preset !== row.preset
      || profile.protocol !== row.protocol
      || profile.source !== row.source
      || profile.enabled !== (row.enabled === 1)
      || profile.configurationRevision !== row.configuration_revision
      || profile.endpointIdentity !== row.endpoint_identity
      || profile.credentialGeneration !== row.credential_generation
      || profile.createdAt !== row.created_at
      || profile.updatedAt !== row.updated_at
    ) {
      throw new Error("The stored model backend profile columns do not match its configuration.");
    }
    const latestProbe = probeValue === null
      ? null
      : backendCompatibilityProbeResultSchema.parse(probeValue);
    return { profile, latestProbe };
  }

  private clearModelBackendDefaultsForProfile(profileId: string): void {
    const rows = this.database.prepare(`
      SELECT rowid AS row_id, selection_json
      FROM model_backend_defaults
    `).all() as Array<{ row_id: number; selection_json: string }>;
    const remove = this.database.prepare(
      "DELETE FROM model_backend_defaults WHERE rowid = ?",
    );
    for (const row of rows) {
      try {
        const selection = modelSelectionSchema.parse(
          JSON.parse(row.selection_json) as unknown,
        );
        if (selection.backendProfileId === profileId) remove.run(row.row_id);
      } catch {
        // Invalid defaults fail closed and cannot remain eligible.
        remove.run(row.row_id);
      }
    }
  }

  private ensureTurnAssociationColumns(): void {
    const associations = [
      ["messages", "turn_id"],
      ["activities", "turn_id"],
      ["agent_reasonings", "turn_id"],
      ["agent_plans", "turn_id"],
      ["thread_usage", "turn_id"],
      ["checkpoints", "turn_id"],
    ] as const;
    for (const [table, column] of associations) {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (columns.some(({ name }) => name === column)) continue;
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT REFERENCES agent_turns(id) ON DELETE SET NULL`);
    }
  }

  private initializeState(): void {
    this.database.prepare(`INSERT OR IGNORE INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, default_provider, default_model, default_access_mode, new_thread_mode, wrap_diffs, ignore_whitespace, usage_display_mode, active_project_id, active_conversation_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(defaultSettings.theme, Number(defaultSettings.compactSidebar), Number(defaultSettings.showTimestamps), defaultSettings.terminalFontSize, defaultSettings.defaultProvider, defaultSettings.defaultModel, defaultSettings.defaultAccessMode, defaultSettings.newThreadMode, Number(defaultSettings.wrapDiffs), Number(defaultSettings.ignoreWhitespace), defaultSettings.usageDisplayMode);
  }

  recoverInterruptedRuns(): void {
    const interrupted = this.database.prepare(`
      SELECT DISTINCT conversations.id
      FROM conversations
      LEFT JOIN agent_turns ON agent_turns.conversation_id = conversations.id
      WHERE conversations.status IN ('running', 'needs-input')
         OR agent_turns.status IN (
           'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input'
         )
    `).all() as Array<{ id: string }>;
    const interruptedRunByConversation = new Map(
      (this.database.prepare(`
        SELECT conversation_id, id
        FROM workspace_runs
        WHERE kind = 'agent'
          AND conversation_id IS NOT NULL
          AND status IN ('running', 'waiting')
        ORDER BY started_at ASC, id ASC
      `).all() as Array<{ conversation_id: string; id: string }>)
        .map(({ conversation_id, id }) => [conversation_id, id] as const),
    );
    const wallClockNow = new Date().toISOString();
    const latestTurnTimestamp = (this.database.prepare(`
      SELECT MAX(updated_at) AS timestamp
      FROM agent_turns
      WHERE status IN (
        'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input'
      )
    `).get() as { timestamp: string | null }).timestamp;
    const now = latestTurnTimestamp && latestTurnTimestamp > wallClockNow
      ? latestTurnTimestamp
      : wallClockNow;
    this.database.prepare(`
      UPDATE workspace_runs
      SET status = 'failed',
          attention_state = 'unseen',
          detail = substr(
            CASE
              WHEN detail IS NULL OR detail = '' THEN 'Interrupted when the local runtime stopped.'
              ELSE detail || ' · Interrupted when the local runtime stopped.'
            END,
            1,
            1000
          ),
          finished_at = ?
      WHERE status IN ('running', 'waiting')
    `).run(now);
    this.database.prepare(`
      UPDATE subagent_traces
      SET status = 'lost',
          sequence = sequence + 1,
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE status IN ('spawned', 'running', 'waiting')
        AND turn_id IN (
          SELECT id FROM agent_turns
          WHERE status IN (
            'queued', 'starting', 'running',
            'waiting-for-approval', 'waiting-for-input'
          )
        )
    `).run(now, now);
    if (interrupted.length === 0) return;

    const markConversation = this.database.prepare("UPDATE conversations SET status = 'failed', attention_kind = NULL, updated_at = ? WHERE id = ?");
    const markTurnActivities = this.database.prepare("UPDATE activities SET status = 'failed' WHERE conversation_id = ? AND turn_id = ? AND status = 'running'");
    const markTurnReasonings = this.database.prepare("UPDATE agent_reasonings SET status = 'failed' WHERE conversation_id = ? AND turn_id = ? AND status = 'running'");
    const markLegacyActivities = this.database.prepare("UPDATE activities SET status = 'failed' WHERE conversation_id = ? AND turn_id IS NULL AND status = 'running'");
    const markLegacyReasonings = this.database.prepare("UPDATE agent_reasonings SET status = 'failed' WHERE conversation_id = ? AND turn_id IS NULL AND status = 'running'");
    const markInterruptedTurn = this.database.prepare(`
      UPDATE agent_turns
      SET status = 'interrupted',
          started_at = COALESCE(started_at, requested_at),
          completed_at = ?,
          terminal_reason = COALESCE(terminal_reason, 'runtime-restart'),
          updated_at = ?
      WHERE id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    `);
    const addRecoveryActivity = this.database.prepare(`
      INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at)
      VALUES (?, ?, ?, ?, 'error', ?, NULL, 'failed', ?)
    `);
    const explicitTurnForRun = this.database.prepare(`
      SELECT id, conversation_id, run_id
      FROM agent_turns
      WHERE conversation_id = ?
        AND run_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      LIMIT 1
    `);
    const latestExplicitTurn = this.database.prepare(`
      SELECT id, conversation_id, run_id
      FROM agent_turns
      WHERE conversation_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `);
    this.database.transaction(() => {
      for (const { id } of interrupted) {
        markConversation.run(now, id);
        const interruptedRunId = interruptedRunByConversation.get(id);
        const turn = (
          (interruptedRunId
            ? explicitTurnForRun.get(id, interruptedRunId)
            : undefined) as Pick<AgentTurnRow, "id" | "conversation_id" | "run_id"> | undefined
        ) ?? (
          latestExplicitTurn.get(id) as Pick<AgentTurnRow, "id" | "conversation_id" | "run_id"> | undefined
        );
        if (turn) {
          markTurnActivities.run(id, turn.id);
          markTurnReasonings.run(id, turn.id);
          markInterruptedTurn.run(now, now, turn.id);
        } else {
          // Preserve recovery for databases that predate authoritative turn ownership.
          markLegacyActivities.run(id);
          markLegacyReasonings.run(id);
        }
        addRecoveryActivity.run(
          randomUUID(),
          id,
          turn?.run_id ?? `recovery-${randomUUID()}`,
          turn?.id ?? null,
          "The previous run ended when Inertia closed. Send another message to continue.",
          now,
        );
      }
    })();
  }

}

export class RecordNotFoundError extends Error {}
