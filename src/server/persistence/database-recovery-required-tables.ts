export type DatabaseRequiredTables = readonly (
  readonly [number, readonly string[]]
)[];

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
  [65, ["system_suspend_intervals"]],
];
