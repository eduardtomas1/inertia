import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";

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
  type InteractionMode,
  type Project,
  type ProviderId,
  type ProviderInfo,
  type ThemePreference,
  type ThreadStatus,
  type ThreadUsageSnapshot,
} from "../shared/contracts";
import type { PersistedProviderMetadata } from "./provider/metadata";

const PROJECT_COLORS = ["#6f76d9", "#5b8ca8", "#8a73ba", "#a76c79", "#9a814f", "#687f91"] as const;

interface ProjectRow {
  id: string;
  name: string;
  path: string;
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
  branch: string | null;
  worktree_path: string | null;
  provider_session_id: string | null;
  archived_at: string | null;
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
  used_tokens: number;
  total_processed_tokens: number | null;
  max_tokens: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  compacts_automatically: 0 | 1;
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
  auto_open_plan: 0 | 1;
  confirm_destructive_actions: 0 | 1;
  default_reasoning_effort: string;
  default_interaction_mode: InteractionMode;
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
] as const;

function projectFromRow(row: ProjectRow): Project {
  return { id: row.id, name: row.name, path: row.path, color: row.color, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
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
    branch: row.branch,
    worktreePath: row.worktree_path,
    providerSessionId: row.provider_session_id,
    archivedAt: row.archived_at,
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
    maxTokens: row.max_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    compactsAutomatically: row.compacts_automatically === 1,
    updatedAt: row.updated_at,
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

  constructor(databasePath: string, defaultWorkspacePath: string) {
    this.database = new Database(databasePath);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.migrate();
    this.initializeState();
    this.recoverInterruptedRuns();
    this.seed(resolve(defaultWorkspacePath));
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
        showUsage: state.show_usage === 1,
        autoOpenPlan: state.auto_open_plan === 1,
        confirmDestructiveActions: state.confirm_destructive_actions === 1,
        defaultReasoningEffort: state.default_reasoning_effort,
        defaultInteractionMode: state.default_interaction_mode,
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

  createProject(name: string, projectPath: string): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    const projectCount = (this.database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    const project: Project = { id, name, path: resolve(projectPath), color: PROJECT_COLORS[projectCount % PROJECT_COLORS.length], status: "ready", createdAt: now, updatedAt: now };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO projects (id, name, path, color, status, created_at, updated_at) VALUES (@id, @name, @path, @color, @status, @createdAt, @updatedAt)`).run(project);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = NULL WHERE id = 1").run(project.id);
    })();
    return project;
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
      status: "idle", branch: options.branch ?? null, worktreePath: options.worktreePath ?? null,
      providerSessionId: null, archivedAt: null, createdAt: now, updatedAt: now,
    };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO conversations (id, project_id, title, provider_id, model, reasoning_effort, interaction_mode, access_mode, status, branch, worktree_path, provider_session_id, archived_at, created_at, updated_at) VALUES (@id, @projectId, @title, @providerId, @model, @reasoningEffort, @interactionMode, @accessMode, @status, @branch, @worktreePath, @providerSessionId, @archivedAt, @createdAt, @updatedAt)`).run(conversation);
      this.touchProject(projectId, now);
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(projectId, conversation.id);
    })();
    return conversation;
  }

  selectConversation(conversationId: string): void {
    const conversation = this.requireConversation(conversationId);
    this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(conversation.project_id, conversationId);
  }

  updateConversation(conversationId: string, update: Partial<Pick<Conversation, "title" | "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode" | "branch" | "worktreePath" | "providerSessionId" | "status">>): Conversation {
    const current = conversationFromRow(this.requireConversation(conversationId));
    const providerChanged = update.providerId !== undefined && update.providerId !== current.providerId;
    const next = {
      ...current,
      ...update,
      providerSessionId: providerChanged ? null : (update.providerSessionId ?? current.providerSessionId),
      model: providerChanged && update.model === undefined ? "" : (update.model ?? current.model),
      reasoningEffort: providerChanged && update.reasoningEffort === undefined ? "" : (update.reasoningEffort ?? current.reasoningEffort),
      updatedAt: new Date().toISOString(),
    };
    this.database.prepare(`UPDATE conversations SET title = @title, provider_id = @providerId, model = @model, reasoning_effort = @reasoningEffort, interaction_mode = @interactionMode, access_mode = @accessMode, branch = @branch, worktree_path = @worktreePath, provider_session_id = @providerSessionId, status = @status, updated_at = @updatedAt WHERE id = @id`).run(next);
    this.touchProject(current.projectId, next.updatedAt);
    return next;
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
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
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
    const next: ThreadUsageSnapshot = { ...usage, updatedAt: new Date().toISOString() };
    this.database.prepare(`
      INSERT INTO thread_usage (conversation_id, used_tokens, total_processed_tokens, max_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, compacts_automatically, updated_at)
      VALUES (@conversationId, @usedTokens, @totalProcessedTokens, @maxTokens, @inputTokens, @cachedInputTokens, @outputTokens, @reasoningOutputTokens, @compactsAutomatically, @updatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET
        used_tokens = excluded.used_tokens,
        total_processed_tokens = excluded.total_processed_tokens,
        max_tokens = excluded.max_tokens,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        compacts_automatically = excluded.compacts_automatically,
        updated_at = excluded.updated_at
    `).run({ ...next, compactsAutomatically: Number(next.compactsAutomatically) });
    return next;
  }

  addCheckpoint(input: Omit<CheckpointSummary, "id" | "createdAt">): CheckpointSummary {
    this.requireConversation(input.conversationId);
    const checkpoint: CheckpointSummary = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.database.prepare(`INSERT INTO checkpoints (id, conversation_id, ref, label, turn_index, files_changed, insertions, deletions, created_at) VALUES (@id, @conversationId, @ref, @label, @turnIndex, @filesChanged, @insertions, @deletions, @createdAt)`).run(checkpoint);
    return checkpoint;
  }

  checkpoint(checkpointId: string): CheckpointSummary {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (!row) throw new RecordNotFoundError("Checkpoint not found.");
    return checkpointFromRow(row);
  }

  updateSettings(update: Partial<AppSettings>): void {
    const current = this.snapshot().settings;
    const next = { ...current, ...update };
    this.database.prepare(`UPDATE app_state SET theme = ?, compact_sidebar = ?, show_timestamps = ?, terminal_font_size = ?, default_provider = ?, default_model = ?, default_access_mode = ?, new_thread_mode = ?, wrap_diffs = ?, ignore_whitespace = ?, show_thinking = ?, show_usage = ?, auto_open_plan = ?, confirm_destructive_actions = ?, default_reasoning_effort = ?, default_interaction_mode = ? WHERE id = 1`).run(next.theme, Number(next.compactSidebar), Number(next.showTimestamps), next.terminalFontSize, next.defaultProvider, next.defaultModel, next.defaultAccessMode, next.newThreadMode, Number(next.wrapDiffs), Number(next.ignoreWhitespace), Number(next.showThinking), Number(next.showUsage), Number(next.autoOpenPlan), Number(next.confirmDestructiveActions), next.defaultReasoningEffort, next.defaultInteractionMode);
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
    this.database.prepare(`INSERT OR IGNORE INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, default_provider, default_model, default_access_mode, new_thread_mode, wrap_diffs, ignore_whitespace, active_project_id, active_conversation_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(defaultSettings.theme, Number(defaultSettings.compactSidebar), Number(defaultSettings.showTimestamps), defaultSettings.terminalFontSize, defaultSettings.defaultProvider, defaultSettings.defaultModel, defaultSettings.defaultAccessMode, defaultSettings.newThreadMode, Number(defaultSettings.wrapDiffs), Number(defaultSettings.ignoreWhitespace));
  }

  private recoverInterruptedRuns(): void {
    const interrupted = this.database.prepare("SELECT id FROM conversations WHERE status IN ('running', 'needs-input')").all() as Array<{ id: string }>;
    if (interrupted.length === 0) return;

    const now = new Date().toISOString();
    const markConversation = this.database.prepare("UPDATE conversations SET status = 'failed', updated_at = ? WHERE id = ?");
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

  private seed(workspacePath: string): void {
    const projectCount = (this.database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    if (projectCount > 0) return;
    const baseTime = Date.now() - 10;
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const projectTime = new Date(baseTime).toISOString();
    const workspaceName = basename(workspacePath) || "your workspace";
    const messages = [
      { role: "system" as const, content: "Welcome to Inertia — your local coding workspace." },
      { role: "assistant" as const, content: "Start a conversation, open the terminal, and keep the work moving in one calm place." },
      { role: "assistant" as const, content: `Getting Started is connected to ${workspaceName}.` },
    ];
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO projects (id, name, path, color, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', ?, ?)`).run(projectId, "Getting Started", workspacePath, PROJECT_COLORS[0], projectTime, projectTime);
      this.database.prepare(`INSERT INTO conversations (id, project_id, title, provider_id, model, interaction_mode, access_mode, status, created_at, updated_at) VALUES (?, ?, ?, 'codex', '', 'build', 'supervised', 'idle', ?, ?)`).run(conversationId, projectId, "Welcome to Inertia", projectTime, projectTime);
      const insertMessage = this.database.prepare(`INSERT INTO messages (id, conversation_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, '[]', ?)`);
      messages.forEach((message, index) => insertMessage.run(randomUUID(), conversationId, message.role, message.content, new Date(baseTime + index + 1).toISOString()));
      this.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(projectId, conversationId);
    })();
  }
}

export class RecordNotFoundError extends Error {}
