import {
  type AgentActivity,
  type AgentGoal,
  type AgentPlan,
  type AgentReasoning,
  type AgentTurn,
  type AgentTurnUsageSnapshot,
  type AppSettings,
  type ChatAttachment,
  type ChatMessage,
  type CheckpointSummary,
  type ContinuationIdentity,
  type Conversation,
  type ConversationLatestTurnSummary,
  type ConversationShell,
  type ModelSelection,
  type Project,
  type ProviderId,
  type SubagentTrace,
  type ThreadUsageSnapshot,
  type WorkspaceRun,
} from "../../shared/contracts";
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentMimeTypeForName,
} from "../../shared/attachments";
import { officiallyAllowsModelSwitchWithinSession } from "../../shared/continuation-policy";
import { parseProviderIdentityLabels } from "../../shared/provider-identities";
import { parseAppKeybindings } from "../../shared/keybindings";
import {
  continuationIdentityForSelection,
  continuationIdentitySchema,
  knownHarnessIdSchema,
  legacyProviderIdForHarness,
  modelSelectionSchema,
  nativeBackendProfile,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../shared/model-routing";
import { providerTimestamp, validateProviderUsage } from "../provider/usage-values";
import { parseWorktreeFilesystemReceipt } from "../worktree-filesystem-identity";
import type {
  ActivityRow,
  AgentPlanRow,
  AgentGoalRow,
  AgentReasoningRow,
  AgentTurnRow,
  CheckpointRow,
  ConversationRow,
  ConversationWorktreeOwnershipRow,
  MessageRow,
  ProjectRow,
  StateRow,
  SubagentTraceRow,
  ThreadUsageRow,
  WorkspaceRunRow,
} from "./rows";
import type { StoredConversationWorktreeOwnership } from "./types";

export function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    normalizedPath: row.normalized_path || row.path,
    repositoryIdentity: row.repository_identity,
    repositoryRoot: row.repository_root,
    repositoryRelativePath: row.repository_relative_path || ".",
    groupingMode: row.grouping_mode,
    gitRepositoryLimit: row.git_repository_limit,
    color: row.color,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function legacyModelSelection(input: {
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

export function parseModelSelection(
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
    !officiallyAllowsModelSwitchWithinSession(compatibility),
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

export function parseAgentTurnContinuationIdentity(
  value: string | null,
  selection: ModelSelection,
): ContinuationIdentity {
  const parsed = parseConversationContinuationIdentity(value, selection);
  if (parsed) return parsed;
  throw new Error(
    "An agent turn requires a valid, explicit continuation identity.",
  );
}

export function conversationFromRow(row: ConversationRow): Conversation {
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
    pinnedAt: row.pinned_at,
    snoozedUntil: row.snoozed_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function conversationWorktreeOwnershipFromRow(
  row: ConversationWorktreeOwnershipRow,
): StoredConversationWorktreeOwnership {
  const base = {
    conversationId: row.conversation_id,
    path: row.path,
    branch: row.branch,
  };
  if (row.owns_worktree === 0 && row.creation_state === "external") {
    return {
      ...base,
      ownsWorktree: false,
      creationState: "external",
      ownershipToken: null,
      worktreeId: null,
      repositoryIdentity: null,
      filesystemReceipt: null,
      branchHead: null,
    };
  }
  if (
    row.owns_worktree === 1
    && row.creation_state === "creating"
    && row.branch !== null
    && row.ownership_token !== null
  ) {
    return {
      ...base,
      branch: row.branch,
      ownsWorktree: true,
      creationState: "creating",
      ownershipToken: row.ownership_token,
      worktreeId: null,
      repositoryIdentity: null,
      filesystemReceipt: null,
      branchHead: null,
    };
  }
  const filesystemReceipt = parseWorktreeFilesystemReceipt(
    row.filesystem_identity_json,
  );
  if (
    row.owns_worktree !== 1
    || row.creation_state !== "created"
    || row.branch === null
    || row.ownership_token === null
    || row.worktree_id === null
    || row.repository_identity === null
    || filesystemReceipt === null
    || row.branch_head === null
  ) {
    throw new Error("The conversation worktree ownership receipt is invalid.");
  }
  return {
    ...base,
    branch: row.branch,
    ownsWorktree: true,
    creationState: "created",
    ownershipToken: row.ownership_token,
    worktreeId: row.worktree_id,
    repositoryIdentity: row.repository_identity,
    filesystemReceipt,
    branchHead: row.branch_head,
  };
}

function conversationTurnSummary(
  turn: AgentTurn | null,
): ConversationLatestTurnSummary | null {
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

export function conversationShellFromRow(
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
    pinnedAt: conversation.pinnedAt,
    snoozedUntil: conversation.snoozedUntil,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    latestTurn: conversationTurnSummary(latestTurn),
    pendingApproval: false,
    pendingInput: false,
  };
}

function providerIdentityLabelsFromJson(value: string): AppSettings["providerIdentityLabels"] {
  try {
    return parseProviderIdentityLabels(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function keybindingsFromJson(value: string): AppSettings["keybindings"] {
  try {
    return parseAppKeybindings(JSON.parse(value) as unknown);
  } catch {
    return parseAppKeybindings(null);
  }
}

export function settingsFromState(state: StateRow): AppSettings {
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
    workspaceStartupSurface: state.workspace_startup_surface,
    defaultCodeWrap: state.default_code_wrap === 1,
    autoCollapseWorkLog: state.auto_collapse_work_log === 1,
    showChangedFileSummaries: state.show_changed_file_summaries === 1,
    autoScrollToFinalAnswer: state.auto_scroll_to_final_answer === 1,
    sidebarMode: state.sidebar_mode,
    projectGrouping: state.project_grouping,
    autoOpenPlan: state.auto_open_plan === 1,
    confirmDestructiveActions: state.confirm_destructive_actions === 1,
    desktopNotifications: state.desktop_notifications === 1,
    providerIdentityLabels: providerIdentityLabelsFromJson(
      state.provider_identity_labels_json,
    ),
    keybindings: keybindingsFromJson(state.keybindings_json),
    defaultReasoningEffort: state.default_reasoning_effort,
    defaultInteractionMode: state.default_interaction_mode,
    codexBinaryPath: state.codex_binary_path,
  };
}

export function requireTimestamp(value: string, label: string): string {
  const timestamp = providerTimestamp(value);
  if (!timestamp) throw new Error(`${label} must be a valid ISO timestamp.`);
  return timestamp;
}

export function requiredTurnString(
  value: string,
  label: string,
  maximum: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

export function optionalTurnString(
  value: string | null | undefined,
  label: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  return requiredTurnString(value, label, maximum);
}

export function normalizeAgentTurnUsage(
  usage: AgentTurnUsageSnapshot,
): AgentTurnUsageSnapshot {
  return {
    ...validateProviderUsage(usage),
    // Legacy snapshots have no durable session provenance and must never be
    // promoted to a cumulative resume boundary.
    providerSessionBound: usage.providerSessionBound === true,
    capturedAt: requireTimestamp(usage.capturedAt, "Turn usage capture time"),
  };
}

export function parseAgentTurnUsage(
  value: string | null,
): AgentTurnUsageSnapshot | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed
      || typeof parsed !== "object"
      || !("capturedAt" in parsed)
      || typeof parsed.capturedAt !== "string"
    ) {
      return null;
    }
    return normalizeAgentTurnUsage(parsed as AgentTurnUsageSnapshot);
  } catch {
    return null;
  }
}

export function agentTurnFromRow(row: AgentTurnRow): AgentTurn {
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

function isPersistedChatAttachment(
  attachment: unknown,
): attachment is ChatAttachment {
  return typeof attachment === "object"
    && attachment !== null
    && !Array.isArray(attachment)
    && "id" in attachment
    && typeof attachment.id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(attachment.id)
    && "name" in attachment
    && typeof attachment.name === "string"
    && attachment.name.length >= 1
    && attachment.name.length <= 255
    && !/[\0-\x1f\x7f]/u.test(attachment.name)
    && !/[\\/]/u.test(attachment.name)
    && chatAttachmentMimeTypeForName(attachment.name)
      === ("mimeType" in attachment ? attachment.mimeType : null)
    && "path" in attachment
    && typeof attachment.path === "string"
    && attachment.path.length >= 1
    && attachment.path.length <= 4_096
    && !attachment.path.includes("\0")
    && "mimeType" in attachment
    && typeof attachment.mimeType === "string"
    && (CHAT_ATTACHMENT_MIME_TYPES as readonly string[])
      .includes(attachment.mimeType)
    && "size" in attachment
    && typeof attachment.size === "number"
    && Number.isSafeInteger(attachment.size)
    && attachment.size >= 1
    && attachment.size <= MAX_CHAT_ATTACHMENT_BYTES;
}

export function parseAttachments(value: string): ChatAttachment[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const attachments: ChatAttachment[] = [];
    const ids = new Set<string>();
    let totalBytes = 0;
    for (const attachment of parsed) {
      if (
        !isPersistedChatAttachment(attachment)
        || ids.has(attachment.id)
        || attachments.length >= MAX_CHAT_ATTACHMENTS
        || totalBytes + attachment.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES
      ) continue;
      attachments.push({
        id: attachment.id,
        name: attachment.name,
        path: attachment.path,
        mimeType: attachment.mimeType,
        size: attachment.size,
      });
      ids.add(attachment.id);
      totalBytes += attachment.size;
    }
    return attachments;
  } catch {
    return [];
  }
}

export function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rendererSafeAttachments(
  attachments: readonly ChatAttachment[],
): ChatAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    path: attachment.id,
  }));
}

export function messageFromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    role: row.role,
    content: row.content,
    attachments: rendererSafeAttachments(
      parseAttachments(row.attachments_json),
    ),
    createdAt: row.created_at,
  };
}

export function activityFromRow(row: ActivityRow): AgentActivity {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function subagentTraceFromRow(row: SubagentTraceRow): SubagentTrace {
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
    providerStatus: row.provider_status,
    status: row.status,
    isLive: row.is_live === 1,
    description: row.description,
    progress: row.progress,
    result: row.result,
    sequence: row.sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function agentGoalFromRow(row: AgentGoalRow): AgentGoal {
  return {
    conversationId: row.conversation_id,
    source: row.source,
    providerSessionId: row.provider_session_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synchronizedAt: row.synchronized_at,
  };
}

export function checkpointFromRow(row: CheckpointRow): CheckpointSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    ref: row.ref,
    label: row.label,
    turnIndex: row.turn_index,
    filesChanged: row.files_changed,
    insertions: row.insertions,
    deletions: row.deletions,
    createdAt: row.created_at,
  };
}

export function planFromRow(row: AgentPlanRow): AgentPlan {
  let steps: AgentPlan["steps"] = [];
  try {
    const parsed: unknown = JSON.parse(row.steps_json);
    if (Array.isArray(parsed)) {
      steps = parsed.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const step = "step" in value && typeof value.step === "string"
          ? value.step
          : undefined;
        const status = "status" in value && (
          value.status === "pending"
          || value.status === "inProgress"
          || value.status === "completed"
        )
          ? value.status
          : undefined;
        return step && status ? [{ step, status }] : [];
      }).slice(0, 50);
    }
  } catch {
    // A malformed legacy plan is represented as empty rather than breaking startup.
  }
  return {
    conversationId: row.conversation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    explanation: row.explanation,
    steps,
  };
}

export function reasoningFromRow(row: AgentReasoningRow): AgentReasoning {
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

export function usageFromRow(row: ThreadUsageRow): ThreadUsageSnapshot {
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
    compactsAutomatically: row.compacts_automatically === null
      ? null
      : row.compacts_automatically === 1,
    updatedAt: row.updated_at,
  };
}

export function workspaceRunFromRow(row: WorkspaceRunRow): WorkspaceRun {
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
      ?? (
        row.status === "failed" || row.status === "waiting"
          ? "unseen"
          : "acknowledged"
      ),
    canStop: false,
    port: row.port,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
