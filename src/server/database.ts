import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import {
  defaultSettings,
  type AccessMode,
  type AgentActivity,
  type AgentPlan,
  type AgentReasoning,
  type AppSettings,
  type AppSnapshot,
  type ChatAttachment,
  type ChatMessage,
  type CheckpointSummary,
  type Conversation,
  type DiffReviewNote,
  type DiffReviewState,
  type DiffReviewSummary,
  type InteractionMode,
  type Project,
  type ProjectGroupingMode,
  type ProviderId,
  type ProviderInfo,
  type ThemePreference,
  type ThreadStatus,
  type ThreadUsageSnapshot,
  type WorkspaceRun,
} from "../shared/contracts";
import type { PersistedProviderMetadata } from "./provider/metadata";
import { validateProviderUsage } from "./provider/usage-values";

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

interface MessageRow {
  id: string;
  conversation_id: string;
  role: ChatMessage["role"];
  content: string;
  attachments_json: string;
  created_at: string;
}

interface ActivityRow {
  id: string;
  conversation_id: string;
  run_id: string;
  kind: AgentActivity["kind"];
  title: string;
  detail: string | null;
  status: AgentActivity["status"];
  created_at: string;
}

interface CheckpointRow {
  id: string;
  conversation_id: string;
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
  explanation: string | null;
  steps_json: string;
}

interface AgentReasoningRow {
  id: string;
  conversation_id: string;
  run_id: string;
  content: string;
  status: AgentReasoning["status"];
  created_at: string;
}

interface ThreadUsageRow {
  conversation_id: string;
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
  provider_id: ProviderId;
  executable: string | null;
  version: string | null;
  auth_state: PersistedProviderMetadata["authState"];
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
  port: number | null;
  started_at: string;
  finished_at: string | null;
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

function conversationFromRow(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    providerId: row.provider_id,
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
  return { id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, attachments: parseAttachments(row.attachments_json), createdAt: row.created_at };
}

function activityFromRow(row: ActivityRow): AgentActivity {
  return { id: row.id, conversationId: row.conversation_id, runId: row.run_id, kind: row.kind, title: row.title, detail: row.detail, status: row.status, createdAt: row.created_at };
}

function checkpointFromRow(row: CheckpointRow): CheckpointSummary {
  return { id: row.id, conversationId: row.conversation_id, ref: row.ref, label: row.label, turnIndex: row.turn_index, filesChanged: row.files_changed, insertions: row.insertions, deletions: row.deletions, createdAt: row.created_at };
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
  return { conversationId: row.conversation_id, runId: row.run_id, explanation: row.explanation, steps };
}

function reasoningFromRow(row: AgentReasoningRow): AgentReasoning {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
  };
}

function usageFromRow(row: ThreadUsageRow): ThreadUsageSnapshot {
  return {
    conversationId: row.conversation_id,
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

function reviewSummaryFromRow(row: DiffReviewSummaryRow): DiffReviewSummary {
  let files: DiffReviewSummary["files"] = [];
  try {
    const value: unknown = JSON.parse(row.files_json);
    if (Array.isArray(value)) files = value as DiffReviewSummary["files"];
  } catch {
    files = [];
  }
  return {
    conversationId: row.conversation_id,
    fingerprint: row.fingerprint,
    providerId: row.provider_id,
    overall: row.overall,
    files,
    generatedAt: row.generated_at,
  };
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
    canStop: false,
    port: row.port,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface NewConversationOptions {
  providerId?: ProviderId;
  model?: string;
  reasoningEffort?: string;
  interactionMode?: InteractionMode;
  accessMode?: AccessMode;
  branch?: string | null;
  worktreePath?: string | null;
}

export class RuntimeStore {
  private readonly database: Database.Database;

  constructor(databasePath: string, _defaultWorkspacePath: string) {
    this.database = new Database(databasePath);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.migrate();
    this.initializeState();
    this.recoverInterruptedRuns();
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  snapshot(providers: ProviderInfo[] = []): AppSnapshot {
    const state = this.getState();
    return {
      projects: (this.database.prepare("SELECT * FROM projects ORDER BY updated_at DESC, id ASC").all() as ProjectRow[]).map(projectFromRow),
      conversations: (this.database.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, id ASC").all() as ConversationRow[]).map(conversationFromRow),
      messages: (this.database.prepare("SELECT * FROM messages ORDER BY created_at ASC, id ASC").all() as MessageRow[]).map(messageFromRow),
      activities: (this.database.prepare("SELECT * FROM activities ORDER BY created_at ASC, id ASC").all() as ActivityRow[]).map(activityFromRow),
      reasonings: (this.database.prepare("SELECT * FROM agent_reasonings ORDER BY created_at ASC, id ASC").all() as AgentReasoningRow[]).map(reasoningFromRow),
      usage: (this.database.prepare("SELECT * FROM thread_usage ORDER BY updated_at ASC").all() as ThreadUsageRow[]).map(usageFromRow),
      plans: (this.database.prepare("SELECT conversation_id, run_id, explanation, steps_json FROM agent_plans ORDER BY updated_at ASC").all() as AgentPlanRow[]).map(planFromRow),
      checkpoints: (this.database.prepare("SELECT * FROM checkpoints ORDER BY turn_index ASC, created_at ASC").all() as CheckpointRow[]).map(checkpointFromRow),
      reviewSummaries: (this.database.prepare("SELECT * FROM diff_review_summaries ORDER BY generated_at ASC").all() as DiffReviewSummaryRow[]).map(reviewSummaryFromRow),
      reviewStates: (this.database.prepare("SELECT * FROM diff_review_states ORDER BY updated_at ASC").all() as DiffReviewStateRow[]).map(reviewStateFromRow),
      reviewNotes: (this.database.prepare("SELECT * FROM diff_review_notes ORDER BY created_at ASC").all() as DiffReviewNoteRow[]).map(reviewNoteFromRow),
      runs: (this.database.prepare("SELECT * FROM workspace_runs ORDER BY started_at DESC LIMIT 200").all() as WorkspaceRunRow[]).map(workspaceRunFromRow),
      providers,
      settings: {
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
      },
      activeProjectId: state.active_project_id,
      activeConversationId: state.active_conversation_id,
    };
  }

  loadProviderMetadata(): PersistedProviderMetadata[] {
    const rows = this.database.prepare("SELECT * FROM provider_metadata_cache ORDER BY provider_id ASC").all() as ProviderMetadataCacheRow[];
    return rows.map((row) => ({
      providerId: row.provider_id,
      executable: row.executable,
      version: row.version,
      authState: row.auth_state,
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
    this.database.prepare(`
      INSERT INTO provider_metadata_cache (
        provider_id, executable, version, auth_state, models_json, models_updated_at, models_last_attempted_at, models_provenance, models_stale,
        rate_limits_json, rate_limits_updated_at, rate_limits_last_attempted_at, rate_limits_provenance, rate_limits_stale
      ) VALUES (
        @providerId, @executable, @version, @authState, @modelsJson, @modelsUpdatedAt, @modelsLastAttemptedAt, @modelsProvenance, @modelsStaleValue,
        @rateLimitsJson, @rateLimitsUpdatedAt, @rateLimitsLastAttemptedAt, @rateLimitsProvenance, @rateLimitsStaleValue
      ) ON CONFLICT(provider_id) DO UPDATE SET
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
    const conversation: Conversation = {
      id: randomUUID(), projectId, title,
      providerId: options.providerId ?? state.default_provider,
      model: options.model ?? state.default_model,
      reasoningEffort: options.reasoningEffort ?? state.default_reasoning_effort,
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
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO conversations (
          id, project_id, title, provider_id, model, reasoning_effort, interaction_mode,
          access_mode, status, attention_kind, branch, worktree_path, provider_session_id,
          archived_at, settled_at, completed_at, last_viewed_at, created_at, updated_at
        ) VALUES (
          @id, @projectId, @title, @providerId, @model, @reasoningEffort, @interactionMode,
          @accessMode, @status, @attentionKind, @branch, @worktreePath, @providerSessionId,
          @archivedAt, @settledAt, @completedAt, @lastViewedAt, @createdAt, @updatedAt
        )
      `).run(conversation);
      this.touchProject(projectId, now);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(projectId, conversation.id);
    })();
    return conversation;
  }

  selectConversation(conversationId: string): void {
    const conversation = this.requireConversation(conversationId);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare("UPDATE conversations SET last_viewed_at = ? WHERE id = ?").run(now, conversationId);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(conversation.project_id, conversationId);
    })();
  }

  hasConversationMessages(conversationId: string): boolean {
    this.requireConversation(conversationId);
    return this.database.prepare("SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1").get(conversationId) !== undefined;
  }

  updateConversation(conversationId: string, update: Partial<Pick<Conversation, "title" | "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode" | "branch" | "worktreePath" | "providerSessionId" | "status" | "attentionKind">>): Conversation {
    const current = conversationFromRow(this.requireConversation(conversationId));
    const providerChanged = update.providerId !== undefined && update.providerId !== current.providerId;
    const statusChanged = update.status !== undefined && update.status !== current.status;
    const currentViewedTime = current.lastViewedAt ? Date.parse(current.lastViewedAt) : 0;
    const eventTime = update.status === "completed" && statusChanged
      ? Math.max(Date.now(), Number.isFinite(currentViewedTime) ? currentViewedTime + 1 : 0)
      : Date.now();
    const now = new Date(eventTime).toISOString();
    const activeConversationId = this.getState().active_conversation_id;
    const next = {
      ...current,
      ...update,
      providerSessionId: providerChanged ? null : (update.providerSessionId ?? current.providerSessionId),
      model: providerChanged && update.model === undefined ? "" : (update.model ?? current.model),
      reasoningEffort: providerChanged && update.reasoningEffort === undefined ? "" : (update.reasoningEffort ?? current.reasoningEffort),
      attentionKind: update.status && update.status !== "needs-input"
        ? null
        : (update.attentionKind ?? current.attentionKind),
      settledAt: update.status === "running" ? null : current.settledAt,
      completedAt: update.status === "completed" && statusChanged ? now : current.completedAt,
      lastViewedAt: update.status === "completed" && activeConversationId === conversationId ? now : current.lastViewedAt,
      updatedAt: now,
    };
    this.database.prepare(`
      UPDATE conversations SET
        title = @title, provider_id = @providerId, model = @model,
        reasoning_effort = @reasoningEffort, interaction_mode = @interactionMode,
        access_mode = @accessMode, branch = @branch, worktree_path = @worktreePath,
        provider_session_id = @providerSessionId, status = @status,
        attention_kind = @attentionKind, settled_at = @settledAt,
        completed_at = @completedAt, last_viewed_at = @lastViewedAt,
        updated_at = @updatedAt
      WHERE id = @id
    `).run(next);
    this.touchProject(current.projectId, next.updatedAt);
    return next;
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

  createMessage(conversationId: string, content: string, role: ChatMessage["role"] = "user", attachments: ChatAttachment[] = []): ChatMessage {
    const conversation = this.requireConversation(conversationId);
    const now = new Date().toISOString();
    const message: ChatMessage = { id: randomUUID(), conversationId, role, content, attachments, createdAt: now };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (@id, @conversationId, @role, @content, @attachmentsJson, @createdAt)`).run({ ...message, attachmentsJson: JSON.stringify(attachments) });
      this.database.prepare("UPDATE conversations SET updated_at = ?, settled_at = NULL, last_viewed_at = ? WHERE id = ?").run(now, now, conversationId);
      this.touchProject(conversation.project_id, now);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(conversation.project_id, conversationId);
    })();
    return message;
  }

  updateMessageContent(messageId: string, content: string): void {
    const message = this.database.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(messageId) as { conversation_id: string } | undefined;
    if (!message) throw new RecordNotFoundError("Message not found.");
    this.database.prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, messageId);
    this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), message.conversation_id);
  }

  upsertAgentPlan(plan: AgentPlan): void {
    this.requireConversation(plan.conversationId);
    this.database.prepare(`
      INSERT INTO agent_plans (conversation_id, run_id, explanation, steps_json, updated_at)
      VALUES (@conversationId, @runId, @explanation, @stepsJson, @updatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET
        run_id = excluded.run_id,
        explanation = excluded.explanation,
        steps_json = excluded.steps_json,
        updated_at = excluded.updated_at
    `).run({
      conversationId: plan.conversationId,
      runId: plan.runId,
      explanation: plan.explanation,
      stepsJson: JSON.stringify(plan.steps.slice(0, 50)),
      updatedAt: new Date().toISOString(),
    });
  }

  clearAgentPlan(conversationId: string): void {
    this.requireConversation(conversationId);
    this.database.prepare("DELETE FROM agent_plans WHERE conversation_id = ?").run(conversationId);
  }

  addActivity(activity: Omit<AgentActivity, "id" | "createdAt">): AgentActivity {
    this.requireConversation(activity.conversationId);
    const record: AgentActivity = { ...activity, id: randomUUID(), createdAt: new Date().toISOString() };
    this.database.prepare(`INSERT INTO activities (id, conversation_id, run_id, kind, title, detail, status, created_at) VALUES (@id, @conversationId, @runId, @kind, @title, @detail, @status, @createdAt)`).run(record);
    return record;
  }

  updateActivity(id: string, update: Partial<Pick<AgentActivity, "title" | "detail" | "status">>): AgentActivity {
    const row = this.database.prepare("SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | undefined;
    if (!row) throw new RecordNotFoundError("Activity not found.");
    const next = { ...activityFromRow(row), ...update };
    this.database.prepare("UPDATE activities SET title = ?, detail = ?, status = ? WHERE id = ?").run(next.title, next.detail, next.status, id);
    return next;
  }

  createReasoning(conversationId: string, runId: string): AgentReasoning {
    this.requireConversation(conversationId);
    const reasoning: AgentReasoning = {
      id: randomUUID(),
      conversationId,
      runId,
      content: "",
      status: "running",
      createdAt: new Date().toISOString(),
    };
    this.database.prepare(`INSERT INTO agent_reasonings (id, conversation_id, run_id, content, status, created_at) VALUES (@id, @conversationId, @runId, @content, @status, @createdAt)`).run(reasoning);
    return reasoning;
  }

  updateReasoning(id: string, update: Partial<Pick<AgentReasoning, "content" | "status">>): AgentReasoning {
    const row = this.database.prepare("SELECT * FROM agent_reasonings WHERE id = ?").get(id) as AgentReasoningRow | undefined;
    if (!row) throw new RecordNotFoundError("Reasoning summary not found.");
    const next = { ...reasoningFromRow(row), ...update };
    this.database.prepare("UPDATE agent_reasonings SET content = ?, status = ? WHERE id = ?").run(next.content, next.status, id);
    return next;
  }

  upsertUsage(usage: Omit<ThreadUsageSnapshot, "updatedAt">): ThreadUsageSnapshot {
    this.requireConversation(usage.conversationId);
    const next: ThreadUsageSnapshot = {
      conversationId: usage.conversationId,
      ...validateProviderUsage(usage),
      updatedAt: new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT INTO thread_usage (conversation_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, compacts_automatically, updated_at)
      VALUES (@conversationId, @usedTokens, @totalProcessedTokens, @totalProcessedScope, @maxTokens, @inputTokens, @cachedInputTokens, @cacheWriteInputTokens, @outputTokens, @reasoningOutputTokens, @compactsAutomatically, @updatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET
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

  addCheckpoint(input: Omit<CheckpointSummary, "id" | "createdAt">): CheckpointSummary {
    this.requireConversation(input.conversationId);
    const checkpoint: CheckpointSummary = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.database.prepare(`INSERT INTO checkpoints (id, conversation_id, ref, label, turn_index, files_changed, insertions, deletions, created_at) VALUES (@id, @conversationId, @ref, @label, @turnIndex, @filesChanged, @insertions, @deletions, @createdAt)`).run(checkpoint);
    return checkpoint;
  }

  upsertReviewSummary(summary: DiffReviewSummary): DiffReviewSummary {
    this.requireConversation(summary.conversationId);
    const filesJson = JSON.stringify(summary.files);
    if (summary.overall.length > 4_000 || filesJson.length > 262_144) throw new Error("Review summary is too large.");
    this.database.prepare(`
      INSERT INTO diff_review_summaries (conversation_id, fingerprint, provider_id, overall, files_json, generated_at)
      VALUES (@conversationId, @fingerprint, @providerId, @overall, @filesJson, @generatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        provider_id = excluded.provider_id,
        overall = excluded.overall,
        files_json = excluded.files_json,
        generated_at = excluded.generated_at
    `).run({ ...summary, filesJson });
    return summary;
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
    input: Omit<WorkspaceRun, "id" | "actionId" | "canStop" | "startedAt" | "finishedAt"> & {
      id?: string;
      actionId?: string | null;
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
      canStop: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.database.prepare(`
      INSERT INTO workspace_runs (id, kind, project_id, conversation_id, action_id, label, detail, status, port, started_at, finished_at)
      VALUES (@id, @kind, @projectId, @conversationId, @actionId, @label, @detail, @status, @port, @startedAt, @finishedAt)
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
    const next: WorkspaceRun = {
      ...current,
      ...update,
      label: update.label === undefined ? current.label : update.label.trim().slice(0, 200),
      detail: update.detail === undefined ? current.detail : update.detail?.slice(0, 1_000) ?? null,
      finishedAt: update.finishedAt !== undefined
        ? update.finishedAt
        : update.status && !["running", "waiting"].includes(update.status)
          ? new Date().toISOString()
          : current.finishedAt,
    };
    this.database.prepare("UPDATE workspace_runs SET label = ?, detail = ?, status = ?, port = ?, finished_at = ? WHERE id = ?")
      .run(next.label, next.detail, next.status, next.port, next.finishedAt, id);
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

  dismissWorkspaceRun(id: string): void {
    const run = this.workspaceRun(id);
    if (run.status === "running" || run.status === "waiting" || run.finishedAt === null) {
      throw new Error("Active workspace activity cannot be dismissed.");
    }
    this.database.prepare("DELETE FROM workspace_runs WHERE id = ?").run(id);
  }

  checkpoint(checkpointId: string): CheckpointSummary {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (!row) throw new RecordNotFoundError("Checkpoint not found.");
    return checkpointFromRow(row);
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

  private migrate(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = new Set((this.database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(({ version }) => version));
    migrations.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.database.transaction(() => {
        this.database.exec(sql);
        this.database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      })();
    });
  }

  private initializeState(): void {
    this.database.prepare(`INSERT OR IGNORE INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, default_provider, default_model, default_access_mode, new_thread_mode, wrap_diffs, ignore_whitespace, usage_display_mode, active_project_id, active_conversation_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(defaultSettings.theme, Number(defaultSettings.compactSidebar), Number(defaultSettings.showTimestamps), defaultSettings.terminalFontSize, defaultSettings.defaultProvider, defaultSettings.defaultModel, defaultSettings.defaultAccessMode, defaultSettings.newThreadMode, Number(defaultSettings.wrapDiffs), Number(defaultSettings.ignoreWhitespace), defaultSettings.usageDisplayMode);
  }

  private recoverInterruptedRuns(): void {
    const interrupted = this.database.prepare("SELECT id FROM conversations WHERE status IN ('running', 'needs-input')").all() as Array<{ id: string }>;
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE workspace_runs
      SET status = 'failed',
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
    if (interrupted.length === 0) return;

    const markConversation = this.database.prepare("UPDATE conversations SET status = 'failed', attention_kind = NULL, updated_at = ? WHERE id = ?");
    const markActivities = this.database.prepare("UPDATE activities SET status = 'failed' WHERE conversation_id = ? AND status = 'running'");
    const markReasonings = this.database.prepare("UPDATE agent_reasonings SET status = 'failed' WHERE conversation_id = ? AND status = 'running'");
    const addRecoveryActivity = this.database.prepare(`
      INSERT INTO activities (id, conversation_id, run_id, kind, title, detail, status, created_at)
      VALUES (?, ?, ?, 'error', ?, NULL, 'failed', ?)
    `);
    this.database.transaction(() => {
      for (const { id } of interrupted) {
        markConversation.run(now, id);
        markActivities.run(id);
        markReasonings.run(id);
        addRecoveryActivity.run(
          randomUUID(),
          id,
          `recovery-${randomUUID()}`,
          "The previous run ended when Inertia closed. Send another message to continue.",
          now,
        );
      }
    })();
  }

}

export class RecordNotFoundError extends Error {}
