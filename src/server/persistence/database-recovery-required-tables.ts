export type DatabaseRequiredTables = readonly (
  readonly [number, readonly string[]]
)[];

export interface DatabaseSchemaRequirements {
  tables: DatabaseRequiredTables;
  columns: readonly (readonly [number, string, readonly string[]])[];
  indexes: readonly (readonly [number, string])[];
}

const REQUIRED_COLUMNS_BY_SCHEMA_VERSION: DatabaseSchemaRequirements["columns"] = [
  [1, "projects", ["id", "name", "path"]],
  [1, "conversations", ["id", "project_id"]],
  [1, "messages", ["id", "conversation_id", "content"]],
  [1, "app_state", ["id"]],
  [75, "messages", ["private_connect_device_id"]],
  [88, "app_state", [
    "quota_warnings_enabled",
    "quota_warning_threshold",
    "notify_only_in_background",
  ]],
  [90, "subagent_traces", [
    "model",
    "activity",
    "usage_json",
    "tool_use_count",
    "duration_ms",
  ]],
  [91, "app_state", ["muted_custom_colors"]],
  [92, "agent_turns", ["origin"]],
  [93, "messages", ["html_render_json"]],
  [95, "conversation_context_packets", ["supplement_json"]],
];

export const REQUIRED_TABLES_BY_SCHEMA_VERSION: DatabaseRequiredTables = [
  [1, ["projects", "conversations", "messages", "app_state"]],
  [2, ["activities", "checkpoints"]],
  [3, ["agent_plans"]],
  [4, ["agent_reasonings", "thread_usage"]],
  [5, ["provider_metadata_cache"]],
  [7, ["diff_review_summaries", "workspace_runs"]],
  [9, ["diff_review_states", "diff_review_notes"]],
  [16, ["agent_turns"]],
  [22, [
    "turn_execution_context_blobs",
    "turn_execution_manifests",
    "turn_execution_context_refs",
  ]],
  [23, ["turn_git_artifacts"]],
  [25, ["model_backend_profiles", "model_backend_defaults"]],
  [26, ["provider_metadata_scoped_cache"]],
  [28, ["subagent_traces"]],
  [32, ["agent_goals"]],
  [38, ["paired_launches", "paired_launch_sides"]],
  [42, ["message_content_chunks", "reasoning_content_chunks"]],
  [43, ["recovery_import_receipts", "recovery_import_journals"]],
  [52, ["conversation_worktree_ownership"]],
  [53, [
    "project_path_authorities",
    "conversation_path_authorities",
    "workspace_path_authority_enrollment",
  ]],
  [54, ["prompt_presets"]],
  [55, ["provider_run_ownership"]],
  [60, ["agent_managed_conversations", "agent_thread_operations"]],
  [61, ["conversation_context_packets", "agent_context_requests"]],
  [66, ["system_suspend_intervals"]],
  [74, ["usage_limit_sources", "usage_reset_attempts"]],
  [81, ["queued_messages"]],
  [87, ["usage_limit_resume_plans", "usage_limited_turns"]],
  [92, ["cli_conversation_imports"]],
  [93, ["html_renders"]],
  [94, ["agent_context_reads"]],
];

export const DATABASE_SCHEMA_REQUIREMENTS: DatabaseSchemaRequirements = {
  tables: REQUIRED_TABLES_BY_SCHEMA_VERSION,
  columns: REQUIRED_COLUMNS_BY_SCHEMA_VERSION,
  indexes: [
    [90, "workspace_runs_conversation_started_idx"],
    [92, "agent_turns_provider_session_before_idx"],
    [92, "agent_turns_provider_session_after_idx"],
    [93, "html_renders_conversation_idx"],
    [93, "html_renders_turn_idx"],
    [94, "agent_context_reads_identity_idx"],
    [94, "agent_context_reads_target_idx"],
  ],
};
