import type {
  AccessMode,
  AgentGoal,
  AgentActivity,
  AgentReasoning,
  AgentTurnAssociation,
  AgentTurnStatus,
  AppSettings,
  ChatMessage,
  Conversation,
  DiffReviewState,
  InteractionMode,
  Project,
  ProjectGroupingMode,
  ProviderId,
  SubagentTraceStatus,
  ThemePreference,
  ThreadUsageSnapshot,
  TurnGitArtifactAbsenceReason,
  TurnGitArtifactCompleteness,
  TurnGitArtifactStatus,
  TurnGitPatchState,
  WorkspaceRun,
  DuoDispatchState,
  DuoLaunchState,
} from "../../shared/contracts";
import type { ModelBackendDefault } from "../../shared/backend-profile-settings";
import type { PersistedProviderMetadata } from "../provider/metadata";

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  normalized_path: string;
  repository_identity: string | null;
  repository_root: string | null;
  repository_relative_path: string;
  grouping_mode: ProjectGroupingMode | null;
  git_repository_limit: number;
  color: string;
  status: Project["status"];
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
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
  status: Conversation["status"];
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

export interface AgentTurnRow {
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

export interface PairedLaunchRow {
  id: string;
  status: DuoLaunchState;
  cancel_requested: 0 | 1;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PairedLaunchSideRow {
  launch_id: string;
  ordinal: 0 | 1;
  project_id: string;
  planned_conversation_id: string;
  conversation_id: string | null;
  turn_id: string | null;
  planned_worktree_path: string | null;
  planned_branch: string | null;
  owns_worktree: 0 | 1;
  cleanup_branch_head: string | null;
  worktree_removal_confirmed: 0 | 1;
  dispatch_state: DuoDispatchState;
}

export interface TurnGitArtifactRow {
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

export interface MessageRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  role: ChatMessage["role"];
  content: string;
  attachments_json: string;
  created_at: string;
}

export interface ActivityRow {
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

export interface SubagentTraceRow {
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
  provider_status: string | null;
  status: SubagentTraceStatus;
  is_live: 0 | 1;
  description: string | null;
  progress: string | null;
  result: string | null;
  sequence: number;
  created_at: string;
  updated_at: string;
}

export interface CheckpointRow {
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

export interface AgentPlanRow {
  conversation_id: string;
  run_id: string;
  turn_id: string | null;
  explanation: string | null;
  steps_json: string;
}

export interface AgentGoalRow {
  conversation_id: string;
  source: AgentGoal["source"];
  provider_session_id: string | null;
  objective: string;
  status: AgentGoal["status"];
  token_budget: number | null;
  tokens_used: number | null;
  time_used_seconds: number | null;
  created_at: string;
  updated_at: string;
  synchronized_at: string | null;
}

export interface AgentReasoningRow {
  id: string;
  conversation_id: string;
  run_id: string;
  turn_id: string | null;
  content: string;
  status: AgentReasoning["status"];
  created_at: string;
}

export interface ThreadUsageRow {
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

export interface StateRow {
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
  workspace_startup_surface: AppSettings["workspaceStartupSurface"];
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

export interface ProviderMetadataCacheRow {
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

export interface DiffReviewSummaryRow {
  conversation_id: string;
  fingerprint: string;
  provider_id: ProviderId;
  overall: string;
  files_json: string;
  generated_at: string;
  summary_json: string | null;
}

export interface DiffReviewStateRow {
  conversation_id: string;
  repository_path: string;
  scope: DiffReviewState["scope"];
  path: string;
  hunk_id: string;
  target_fingerprint: string;
  reviewed: 0 | 1;
  stale: 0 | 1;
  updated_at: string;
}

export interface DiffReviewNoteRow {
  id: string;
  conversation_id: string;
  repository_path: string;
  path: string;
  hunk_id: string;
  line_ids_json: string;
  target_fingerprint: string;
  body: string;
  stale: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRunRow {
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

export interface ModelBackendProfileRow {
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

export interface ModelBackendDefaultRow {
  scope: ModelBackendDefault["scope"];
  project_id: string | null;
  selection_json: string;
  updated_at: string;
}
