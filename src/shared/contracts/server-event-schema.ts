import type { RuntimeMutationEvent, ServerEvent } from "./events";
import {
  conversationDetailCollectionsCoherent,
  modelRouteIdentityCoherent,
  pullRequestCapabilityStateCoherent,
  runtimeEventScopeMatches, SERVER_EVENT_OPTIONS, snapshotIdentityCollectionsCoherent,
} from "./server-event-discriminants";
import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
} from "../keybindings";
import { modelSelectionSchema } from "../model-routing";
import {
  modelBackendDefaultSchema,
  modelBackendProfileDetailSchema,
  modelBackendProfileViewSchema,
} from "../backend-profile-settings";
import { CHAT_ATTACHMENT_MIME_TYPES } from "../attachments";
import { AGENT_TURN_STATUSES } from "../turn-lifecycle";
import { AGENT_GOAL_STATUSES } from "./agent-workflows";
import {
  DUO_COMPARISON_STATES,
  DUO_DISPATCH_STATES,
  DUO_LAUNCH_STATES,
} from "./duo";
import { providerMaintenanceProviderIdSchema } from "../provider-maintenance";
import { usageDashboardSchema } from "./usage-dashboard-schema";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function nonemptyStringField(value: UnknownRecord, key: string): boolean {
  return stringField(value, key) && (value[key] as string).length > 0;
}

function nullableStringField(value: UnknownRecord, key: string): boolean {
  return value[key] === null || stringField(value, key);
}

function booleanField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "boolean";
}

function numberField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function integerField(value: UnknownRecord, key: string): boolean {
  return Number.isSafeInteger(value[key]);
}

function nullableNumberField(value: UnknownRecord, key: string): boolean {
  return value[key] === null || numberField(value, key);
}

function optionalStringField(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || stringField(value, key);
}

function optionalNullableStringField(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || nullableStringField(value, key);
}

function optionalBooleanField(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || booleanField(value, key);
}

function oneOf(value: UnknownRecord, key: string, options: readonly string[]): boolean {
  return typeof value[key] === "string" && options.includes(value[key] as string);
}

function providerId(value: UnknownRecord, key: string): boolean {
  return oneOf(value, key, ["codex", "claude", "cursor", "opencode"]);
}

function recordWithStrings(value: unknown, ...keys: string[]): value is UnknownRecord {
  return record(value) && keys.every((key) => stringField(value, key));
}

function arrayOf(value: unknown, validate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(validate);
}

function uniqueRecordField(values: unknown[], key: string): boolean {
  return new Set(values.map((value) => (value as UnknownRecord)[key])).size === values.length;
}

function modelSelection(value: unknown): boolean {
  return modelSelectionSchema.safeParse(value).success;
}

function continuationIdentity(value: unknown): boolean {
  return recordWithStrings(value, "harnessId", "backendProfileId")
    && integerField(value, "backendConfigurationRevision")
    && nullableStringField(value, "modelIdentity")
    && nullableStringField(value, "endpointIdentity");
}

function backendProfile(value: unknown, detail = false): boolean {
  return (detail ? modelBackendProfileDetailSchema : modelBackendProfileViewSchema)
    .safeParse(value).success;
}

function backendDefault(value: unknown): boolean {
  return modelBackendDefaultSchema.safeParse(value).success;
}

function syncCursor(value: unknown): boolean {
  return recordWithStrings(value, "runtimeGeneration")
    && (value.runtimeGeneration as string).length > 0
    && Number.isSafeInteger(value.latestSequence)
    && Number(value.latestSequence) >= 0;
}

function attachment(value: unknown): boolean {
  return recordWithStrings(value, "id", "name", "path", "mimeType")
    && oneOf(value, "mimeType", CHAT_ATTACHMENT_MIME_TYPES)
    && numberField(value, "size")
    && Number(value.size) >= 0;
}

function chatMessage(value: unknown): boolean {
  return recordWithStrings(value, "id", "conversationId", "role", "content", "createdAt")
    && nullableStringField(value, "turnId")
    && oneOf(value, "role", ["user", "assistant", "system"])
    && arrayOf(value.attachments, attachment)
    && uniqueRecordField(value.attachments as unknown[], "id");
}

function providerMaintenanceStatus(value: unknown): boolean {
  return recordWithStrings(
    value,
    "providerId",
    "versionStatus",
    "freshness",
    "installMethod",
    "updateAvailability",
    "instructionsUrl",
  )
    && providerMaintenanceProviderIdSchema.safeParse(value.providerId).success
    && oneOf(value, "versionStatus", SERVER_EVENT_OPTIONS.maintenanceVersionStatuses)
    && oneOf(value, "freshness", SERVER_EVENT_OPTIONS.maintenanceFreshness)
    && oneOf(value, "installMethod", SERVER_EVENT_OPTIONS.maintenanceInstallMethods)
    && oneOf(
      value,
      "updateAvailability",
      SERVER_EVENT_OPTIONS.maintenanceUpdateAvailability,
    )
    && nullableStringField(value, "installedVersion")
    && nullableStringField(value, "latestVersion")
    && nullableStringField(value, "checkedAt")
    && nullableStringField(value, "updateLabel")
    && nullableStringField(value, "message");
}

function providerMaintenanceOperation(value: unknown): boolean {
  return recordWithStrings(value, "id", "providerId", "status", "message")
    && providerMaintenanceProviderIdSchema.safeParse(value.providerId).success
    && oneOf(value, "status", SERVER_EVENT_OPTIONS.maintenanceOperationStatuses)
    && nullableStringField(value, "startedAt")
    && nullableStringField(value, "finishedAt")
    && nullableStringField(value, "beforeVersion")
    && nullableStringField(value, "afterVersion")
    && nullableStringField(value, "targetVersion")
    && nullableStringField(value, "output")
    && booleanField(value, "outputTruncated");
}

function project(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "name",
    "path",
    "normalizedPath",
    "repositoryRelativePath",
    "color",
    "status",
    "createdAt",
    "updatedAt",
  )
    && oneOf(value, "status", SERVER_EVENT_OPTIONS.projectStatuses)
    && nullableStringField(value, "repositoryIdentity")
    && nullableStringField(value, "repositoryRoot")
    && (value.groupingMode === null
      || oneOf(value, "groupingMode", ["repository", "repository-path", "separate"]))
    && integerField(value, "gitRepositoryLimit")
    && Number(value.gitRepositoryLimit) >= 1;
}

function latestTurn(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "runId",
    "status",
    "providerId",
    "harnessId",
    "backendProfileId",
    "model",
    "reasoningEffort",
    "requestedAt",
    "updatedAt",
  )
    && providerId(value, "providerId")
    && oneOf(value, "status", AGENT_TURN_STATUSES)
    && nullableStringField(value, "startedAt")
    && nullableStringField(value, "completedAt")
    && nullableStringField(value, "terminalReason")
    && modelSelection(value.modelSelection) && continuationIdentity(value.continuationIdentity)
    && modelRouteIdentityCoherent(value);
}

function conversation(value: unknown): value is UnknownRecord {
  return recordWithStrings(
    value,
    "id",
    "projectId",
    "title",
    "providerId",
    "model",
    "reasoningEffort",
    "interactionMode",
    "accessMode",
    "status",
    "createdAt",
    "updatedAt",
  )
    && providerId(value, "providerId")
    && oneOf(value, "interactionMode", ["build", "plan"])
    && oneOf(value, "accessMode", ["supervised", "auto-edit", "full"])
    && oneOf(value, "status", ["idle", "running", "needs-input", "completed", "failed"])
    && modelSelection(value.modelSelection)
    && (value.continuationIdentity === null
      || continuationIdentity(value.continuationIdentity))
    && modelRouteIdentityCoherent(value)
    && (value.attentionKind === null || oneOf(value, "attentionKind", ["approval", "input"]))
    && nullableStringField(value, "branch")
    && nullableStringField(value, "worktreePath")
    && nullableStringField(value, "providerSessionId")
    && nullableStringField(value, "archivedAt")
    && nullableStringField(value, "settledAt")
    && nullableStringField(value, "completedAt")
    && nullableStringField(value, "lastViewedAt")
    && (value.pinnedAt === undefined || nullableStringField(value, "pinnedAt"))
    && (value.snoozedUntil === undefined || nullableStringField(value, "snoozedUntil"));
}

function conversationShell(value: unknown): boolean {
  return conversation(value)
    && (value.latestTurn === null || latestTurn(value.latestTurn))
    && booleanField(value, "pendingApproval")
    && booleanField(value, "pendingInput");
}

function workspaceRun(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "kind",
    "projectId",
    "label",
    "status",
    "attentionState",
    "startedAt",
  )
    && oneOf(value, "kind", ["agent", "check", "service", "source-control"])
    && oneOf(value, "status", ["running", "waiting", "succeeded", "failed", "cancelled"])
    && oneOf(value, "attentionState", ["unseen", "seen", "acknowledged", "dismissed"])
    && nullableStringField(value, "conversationId")
    && nullableStringField(value, "actionId")
    && nullableStringField(value, "detail")
    && nullableNumberField(value, "port")
    && nullableStringField(value, "finishedAt")
    && booleanField(value, "canStop");
}

function providerMetadataField(value: unknown): boolean {
  return recordWithStrings(value, "freshness")
    && oneOf(value, "freshness", SERVER_EVENT_OPTIONS.providerMetadataFreshness)
    && (value.provenance === null
      || oneOf(value, "provenance", SERVER_EVENT_OPTIONS.providerMetadataProvenance))
    && nullableStringField(value, "updatedAt")
    && nullableStringField(value, "lastAttemptedAt")
    && booleanField(value, "refreshing");
}

function providerModel(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "label",
    "description",
    "defaultReasoningEffort",
  )
    && booleanField(value, "isDefault")
    && arrayOf(value.inputModalities, (entry) => entry === "text" || entry === "image")
    && arrayOf(value.reasoningOptions, (entry) =>
      recordWithStrings(entry, "value", "label", "description"));
}

function providerRateLimit(value: unknown): boolean {
  return recordWithStrings(value, "id", "label")
    && numberField(value, "usedPercent")
    && numberField(value, "remainingPercent")
    && nullableNumberField(value, "windowMinutes")
    && nullableStringField(value, "resetsAt");
}

function providerInfo(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "label",
    "command",
    "installState",
    "authState",
  )
    && providerId(value, "id")
    && oneOf(value, "installState", SERVER_EVENT_OPTIONS.providerInstallStates)
    && oneOf(value, "authState", SERVER_EVENT_OPTIONS.providerAuthStates)
    && booleanField(value, "available")
    && nullableStringField(value, "version")
    && (value.executable === undefined || nullableStringField(value, "executable"))
    && booleanField(value, "canRun")
    && nullableStringField(value, "statusMessage")
    && arrayOf(value.models, providerModel)
    && arrayOf(value.rateLimits, providerRateLimit)
    && uniqueRecordField(value.models as unknown[], "id")
    && uniqueRecordField(value.rateLimits as unknown[], "id")
    && record(value.metadataState)
    && providerMetadataField(value.metadataState.models)
    && providerMetadataField(value.metadataState.rateLimits)
    && (value.maintenance === undefined
      || (providerMaintenanceStatus(value.maintenance)
        && record(value.maintenance)
        && value.maintenance.providerId === value.id));
}

function appSettings(value: unknown): boolean {
  if (!record(value)) return false;
  const strings = ["defaultModel", "defaultReasoningEffort", "codexBinaryPath"];
  const enums = {
    theme: ["system", "light", "dark"],
    defaultProvider: ["codex", "claude", "cursor", "opencode"],
    defaultAccessMode: ["supervised", "auto-edit", "full"],
    newThreadMode: ["local", "worktree"],
    usageDisplayMode: ["expanded", "compact", "hidden"],
    interfaceScale: ["compact", "default", "comfortable", "large"],
    responseDensity: ["compact", "default", "comfortable"],
    workspaceStartupSurface: ["summary", "tools"],
    sidebarMode: ["classic", "activity"],
    projectGrouping: ["repository", "repository-path", "separate"],
    defaultInteractionMode: ["build", "plan"],
  } as const;
  const booleans = [
    "compactSidebar", "showTimestamps", "wrapDiffs", "ignoreWhitespace",
    "showThinking", "defaultCodeWrap", "autoCollapseWorkLog",
    "showChangedFileSummaries", "autoScrollToFinalAnswer", "autoOpenPlan",
    "confirmDestructiveActions", "desktopNotifications",
  ];
  return strings.every((key) => stringField(value, key))
    && Object.entries(enums).every(([key, options]) => oneOf(value, key, options))
    && booleans.every((key) => booleanField(value, key))
    && integerField(value, "terminalFontSize")
    && Number(value.terminalFontSize) >= 11
    && Number(value.terminalFontSize) <= 22
    && record(value.providerIdentityLabels)
    && Object.entries(value.providerIdentityLabels).every(([key, label]) => (
      ["codex", "claude", "cursor", "opencode"].includes(key)
      && typeof label === "string"
      && label.length >= 1
      && label.length <= 48
      && label.trim() === label
      && !/[\0\r\n]/u.test(label)
    ))
    && appKeybindings(value.keybindings);
}

function appKeybindings(value: unknown): boolean {
  if (!record(value) || Object.keys(value).length !== 4) return false;
  const bindings = Object.keys(DEFAULT_APP_KEYBINDINGS)
    .map((action) => value[action]);
  return bindings.every((key) => (
    typeof key === "string"
    && APP_SHORTCUT_KEYS.includes(key as typeof APP_SHORTCUT_KEYS[number])
  )) && new Set(bindings).size === 4;
}

function appSnapshot(value: unknown): boolean {
  if (!(record(value)
    && arrayOf(value.projects, project)
    && arrayOf(value.conversations, conversationShell)
    && arrayOf(value.runs, workspaceRun)
    && arrayOf(value.providers, providerInfo)
    && (value.maintenanceOperations === undefined
      || arrayOf(value.maintenanceOperations, providerMaintenanceOperation))
    && (value.backendProfiles === undefined
      || arrayOf(value.backendProfiles, (entry) => backendProfile(entry)))
    && (value.backendDefaults === undefined
      || arrayOf(value.backendDefaults, backendDefault))
    && (value.databaseBackup === undefined
      || (record(value.databaseBackup)
        && nullableStringField(value.databaseBackup, "lastValidatedAt")))
    && appSettings(value.settings)
    && nullableStringField(value, "activeProjectId")
    && nullableStringField(value, "activeConversationId")
    && (value.sync === undefined || syncCursor(value.sync)))) return false;
  return snapshotIdentityCollectionsCoherent(value);
}

function threadUsage(value: unknown): boolean {
  return recordWithStrings(value, "conversationId", "updatedAt")
    && nullableStringField(value, "turnId")
    && [
      "usedTokens", "totalProcessedTokens", "maxTokens", "inputTokens",
      "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
      "reasoningOutputTokens",
    ].every((key) => nullableNumberField(value, key))
    && (value.totalProcessedScope === null
      || oneOf(value, "totalProcessedScope", ["thread", "session", "run"]))
    && (value.compactsAutomatically === null
      || booleanField(value, "compactsAutomatically"));
}

function activity(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "conversationId",
    "runId",
    "kind",
    "title",
    "status",
    "createdAt",
  )
    && oneOf(value, "kind", SERVER_EVENT_OPTIONS.activityKinds)
    && oneOf(value, "status", SERVER_EVENT_OPTIONS.activityStatuses)
    && nullableStringField(value, "turnId")
    && nullableStringField(value, "detail");
}

function subagentTrace(value: unknown): boolean {
  if (!recordWithStrings(
    value,
    "id",
    "conversationId",
    "runId",
    "turnId",
    "providerId",
    "status",
    "createdAt",
    "updatedAt",
  )) return false;
  const nullableStrings = [
    "providerTaskId", "providerAgentId", "parentTraceId",
    "parentProviderAgentId", "parentProviderToolUseId", "providerToolUseId",
    "providerRole", "providerName", "providerStatus", "description",
    "progress", "result",
  ];
  return nullableStrings.every((key) => nullableStringField(value, key))
    && providerId(value, "providerId")
    && oneOf(value, "status", SERVER_EVENT_OPTIONS.subagentStatuses)
    && booleanField(value, "isLive")
    && integerField(value, "sequence");
}

function approvalRequest(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "providerId",
    "conversationId",
    "runId",
    "turnId",
    "kind",
    "title",
  )
    && providerId(value, "providerId")
    && oneOf(value, "kind", SERVER_EVENT_OPTIONS.approvalKinds)
    && ["detail", "command", "cwd", "reason"].every((key) =>
      nullableStringField(value, key))
    && (value.networkScope === null
      || (recordWithStrings(value.networkScope, "host", "protocol")
        && oneOf(
          value.networkScope,
          "protocol",
          SERVER_EVENT_OPTIONS.approvalNetworkProtocols,
        )))
    && arrayOf(value.permissionRoots, (entry) =>
      recordWithStrings(entry, "path", "access")
      && oneOf(entry, "access", SERVER_EVENT_OPTIONS.approvalPermissionAccess))
    && arrayOf(value.availableDecisions, (entry) =>
      entry === "approve" || entry === "deny" || entry === "cancel");
}

function inputRequest(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "providerId",
    "conversationId",
    "runId",
    "turnId",
  )
    && providerId(value, "providerId")
    && nullableNumberField(value, "autoResolutionMs")
    && arrayOf(value.questions, (question) =>
      recordWithStrings(question, "id", "header", "question")
      && booleanField(question, "isOther")
      && booleanField(question, "isSecret")
      && booleanField(question, "allowMultiple")
      && arrayOf(question.options, (option) =>
        recordWithStrings(option, "id", "label", "description")))
    && uniqueRecordField(value.questions as unknown[], "id")
    && (value.questions as UnknownRecord[]).every((question) =>
      uniqueRecordField(question.options as unknown[], "id"));
}

function agentPlan(value: unknown): boolean {
  return recordWithStrings(value, "conversationId", "runId")
    && nullableStringField(value, "turnId")
    && nullableStringField(value, "explanation")
    && arrayOf(value.steps, (step) =>
      recordWithStrings(step, "step", "status")
      && oneOf(step, "status", ["pending", "inProgress", "completed"]));
}

function agentGoal(value: unknown): boolean {
  return recordWithStrings(
    value,
    "conversationId",
    "source",
    "objective",
    "status",
    "createdAt",
    "updatedAt",
  )
    && oneOf(value, "source", ["codex-native", "inertia-local"])
    && oneOf(value, "status", AGENT_GOAL_STATUSES)
    && nullableStringField(value, "providerSessionId")
    && nullableNumberField(value, "tokenBudget")
    && nullableNumberField(value, "tokensUsed")
    && nullableNumberField(value, "timeUsedSeconds")
    && nullableStringField(value, "synchronizedAt");
}

function agentSkill(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "conversationId",
    "name",
    "description",
    "scope",
    "source",
  )
    && nullableStringField(value, "shortDescription")
    && booleanField(value, "enabled")
    && oneOf(value, "scope", ["user", "repo", "system", "admin", "provider"])
    && oneOf(value, "source", ["codex-native", "claude-native"]);
}

function workflowGoalCapability(value: unknown): boolean {
  if (!recordWithStrings(value, "kind", "label") || value.available !== true) {
    return false;
  }
  return value.kind === "codex-native"
    || (value.kind === "inertia-local" && stringField(value, "reason"));
}

function workflowSkillsCapability(value: unknown): boolean {
  if (!recordWithStrings(value, "kind", "label")
    || typeof value.available !== "boolean") return false;
  if (value.kind === "unavailable") {
    return value.available === false && stringField(value, "reason");
  }
  return value.available === true
    && (value.kind === "codex-native" || value.kind === "claude-native");
}

function skillDiscovery(value: unknown): boolean {
  return record(value)
    && booleanField(value, "truncated")
    && integerField(value, "warningCount")
    && Number(value.warningCount) >= 0
    && nullableStringField(value, "synchronizedAt");
}

function agentWorkflow(value: unknown): boolean {
  if (!recordWithStrings(value, "conversationId", "refreshedAt")) return false;
  const conversationId = value.conversationId;
  return arrayOf(value.goals, agentGoal)
    && uniqueRecordField(value.goals as unknown[], "source")
    && (value.goals as UnknownRecord[]).every((goal) =>
      goal.conversationId === conversationId)
    && workflowGoalCapability(value.goalCapability)
    && arrayOf(value.skills, agentSkill)
    && uniqueRecordField(value.skills as unknown[], "id")
    && (value.skills as UnknownRecord[]).every((skill) =>
      skill.conversationId === conversationId)
    && workflowSkillsCapability(value.skillsCapability)
    && nullableStringField(value, "goalRefreshWarning")
    && skillDiscovery(value.skillDiscovery);
}

function gitBranch(value: unknown): boolean {
  return recordWithStrings(value, "name")
    && booleanField(value, "current")
    && booleanField(value, "remote")
    && nullableStringField(value, "worktreePath");
}

function workspaceEntry(value: unknown): boolean {
  return recordWithStrings(value, "path")
    && oneOf(value, "kind", ["file", "directory"]);
}

function workspaceEntriesPage(value: UnknownRecord): boolean {
  return stringField(value, "directory")
    && arrayOf(value.entries, workspaceEntry)
    && booleanField(value, "truncated");
}

function workspaceFile(value: unknown): boolean {
  return recordWithStrings(
    value,
    "path",
    "content",
    "language",
    "contentDigest",
    "modifiedAt",
  )
    && booleanField(value, "truncated")
    && optionalStringField(value, "authorityRef");
}

function projectAction(value: unknown): boolean {
  return recordWithStrings(value, "id", "label", "command")
    && booleanField(value, "preview");
}

function duoPreparedSide(value: unknown): boolean {
  return recordWithStrings(value, "conversationId", "turnId")
    && (value.ordinal === 0 || value.ordinal === 1);
}

function duoLaunchSide(value: unknown): boolean {
  return record(value)
    && (value.ordinal === 0 || value.ordinal === 1)
    && nullableStringField(value, "conversationId")
    && nullableStringField(value, "turnId")
    && oneOf(value, "dispatchState", DUO_DISPATCH_STATES);
}

function duoComparison(value: unknown): boolean {
  return record(value)
    && oneOf(value, "state", DUO_COMPARISON_STATES)
    && nullableStringField(value, "conversationId")
    && nullableStringField(value, "turnId")
    && integerField(value, "attempt")
    && Number(value.attempt) >= 0
    && nullableStringField(value, "error");
}

function duoRecoveryAction(value: unknown): boolean {
  return recordWithStrings(value, "label", "cwd")
    && value.executable === "git"
    && arrayOf(value.args, (entry) => typeof entry === "string");
}

function duoRecoveryGuidance(value: unknown): boolean {
  return recordWithStrings(
    value,
    "repositoryPath",
    "plannedPath",
    "generatedBranch",
  )
    && value.kind === "git-worktree"
    && (value.ordinal === 0 || value.ordinal === 1)
    && oneOf(value, "topology", ["owned", "conflict", "ambiguous", "branch-retained"])
    && nullableStringField(value, "observedPath")
    && nullableStringField(value, "worktreeId")
    && nullableStringField(value, "expectedHead")
    && nullableStringField(value, "observedBranch")
    && nullableStringField(value, "observedHead")
    && arrayOf(value.actions, duoRecoveryAction);
}

function duoPrepared(value: UnknownRecord): boolean {
  return stringField(value, "launchId")
    && value.state === "prepared"
    && Array.isArray(value.sides)
    && value.sides.length === 2
    && value.sides[0]?.ordinal === 0
    && value.sides[1]?.ordinal === 1
    && value.sides.every(duoPreparedSide)
    && (value.comparison === undefined
      || recordWithStrings(value.comparison, "conversationId"));
}

function duoStatus(value: UnknownRecord): boolean {
  return stringField(value, "launchId") && oneOf(value, "state", DUO_LAUNCH_STATES)
    && optionalBooleanField(value, "cancelRequested")
    && nullableStringField(value, "error")
    && Array.isArray(value.sides)
    && value.sides.length === 2
    && value.sides[0]?.ordinal === 0
    && value.sides[1]?.ordinal === 1
    && value.sides.every(duoLaunchSide)
    && (value.comparison === undefined || duoComparison(value.comparison))
    && (value.recoveryGuidance === undefined
      || arrayOf(value.recoveryGuidance, duoRecoveryGuidance));
}

function changedFile(value: unknown): boolean {
  return recordWithStrings(value, "path", "status", "indexStatus", "worktreeStatus")
    && integerField(value, "insertions")
    && Number(value.insertions) >= 0
    && integerField(value, "deletions")
    && Number(value.deletions) >= 0
    && booleanField(value, "untracked")
    && booleanField(value, "staged")
    && booleanField(value, "unstaged");
}

function pullRequestCapability(
  value: unknown,
  isRepository: boolean, hasRemote: boolean, branch: string | null,
): boolean {
  return record(value)
    && booleanField(value, "available")
    && nullableStringField(value, "remoteName")
    && (value.forge === null || oneOf(value, "forge", ["github", "gitlab", "bitbucket"]))
    && (value.unavailableReason === null || oneOf(value, "unavailableReason", [
      "no-branch", "no-remotes", "ambiguous-remote", "missing-remote",
      "unsupported-url", "unsupported-forge", "ambiguous-url",
    ]))
    && pullRequestCapabilityStateCoherent(value, isRepository, hasRemote, branch);
}

function gitStatus(value: unknown): boolean {
  return record(value)
    && booleanField(value, "isRepository")
    && optionalNullableStringField(value, "authorityRef")
    && nullableStringField(value, "root")
    && nullableStringField(value, "branch")
    && nullableStringField(value, "upstream")
    && integerField(value, "ahead")
    && integerField(value, "behind")
    && booleanField(value, "hasRemote")
    && (value.pullRequest === undefined || pullRequestCapability(
      value.pullRequest, value.isRepository as boolean,
      value.hasRemote as boolean, value.branch as string | null,
    ))
    && arrayOf(value.files, changedFile)
    && integerField(value, "insertions")
    && integerField(value, "deletions");
}

function gitDiff(value: unknown): boolean {
  return recordWithStrings(value, "patch")
    && booleanField(value, "truncated")
    && arrayOf(value.files, changedFile)
    && (value.commitReview === undefined || value.commitReview === null || (recordWithStrings(value.commitReview, "authorityRef", "fingerprint")
      && Object.keys(value.commitReview).length === 2 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.commitReview.authorityRef as string)
      && /^[0-9a-f]{64}$/u.test(value.commitReview.fingerprint as string)));
}
function workspaceGitRepository(value: unknown): boolean {
  return recordWithStrings(value, "repositoryPath")
    && optionalNullableStringField(value, "authorityRef")
    && oneOf(value, "state", ["ready", "error"])
    && nullableStringField(value, "error")
    && nullableStringField(value, "branch")
    && nullableStringField(value, "upstream")
    && integerField(value, "ahead")
    && integerField(value, "behind")
    && booleanField(value, "hasRemote")
    && (value.pullRequest === undefined || pullRequestCapability(
      value.pullRequest, true, value.hasRemote as boolean, value.branch as string | null,
    ))
    && arrayOf(value.files, changedFile)
    && integerField(value, "insertions")
    && integerField(value, "deletions")
    && booleanField(value, "clean")
    && booleanField(value, "truncated");
}
function workspaceGitStatus(value: unknown): boolean {
  return record(value)
    && arrayOf(value.repositories, workspaceGitRepository)
    && [
      "files", "insertions", "deletions", "scannedDirectories", "skippedDirectories",
      "discoveredRepositories", "repositoryLimit",
    ].every((key) => integerField(value, key) && Number(value[key]) >= 0)
    && booleanField(value, "partial")
    && booleanField(value, "truncated")
    && arrayOf(value.issues, (issue) =>
      recordWithStrings(issue, "repositoryPath", "message"));
}

function workspaceGitDiff(value: unknown): boolean {
  return gitDiff(value)
    && record(value)
    && stringField(value, "repositoryPath")
    && optionalBooleanField(value, "reviewMetadataChanged");
}

function turnGitDiff(value: unknown): boolean {
  return gitDiff(value)
    && recordWithStrings(value, "artifactId", "turnId", "title")
    && oneOf(value, "completeness", ["complete", "truncated", "partial", "unavailable"])
    && oneOf(value, "patchState", ["none", "available", "truncated", "expired", "failed"]);
}

function reversalValidation(value: unknown): boolean {
  return recordWithStrings(
    value,
    "diffFingerprint",
    "fileFingerprint",
    "hunkFingerprint",
    "selectionFingerprint",
    "gitStateFingerprint",
  );
}

function reversalPlan(value: unknown): boolean {
  return recordWithStrings(value, "filePath", "hunkId", "hunkHeader")
    && optionalStringField(value, "authorityRef")
    && integerField(value, "selectedLineCount")
    && integerField(value, "changedLineCount")
    && arrayOf(value.affectedLayers, (entry) => entry === "index" || entry === "worktree")
    && reversalValidation(value.validation);
}

function reversalOperation(value: unknown): boolean {
  return recordWithStrings(value, "id", "filePath", "createdAt")
    && optionalStringField(value, "authorityRef")
    && optionalStringField(value, "repositoryPath")
    && integerField(value, "selectedLineCount")
    && arrayOf(value.affectedLayers, (entry) => entry === "index" || entry === "worktree");
}

const REVIEW_CLASSIFICATIONS = [
  "behavior-change", "regression-risk", "security-sensitive", "migration",
  "test-impact", "performance-sensitive", "documentation-only",
] as const;

function reviewClassification(value: unknown): boolean {
  return recordWithStrings(value, "evidence")
    && oneOf(value, "classification", REVIEW_CLASSIFICATIONS);
}

function reviewSummary(value: unknown): boolean {
  return recordWithStrings(
    value,
    "conversationId",
    "fingerprint",
    "providerId",
    "overall",
    "generatedAt",
  )
    && providerId(value, "providerId")
    && nullableStringField(value, "harnessId")
    && nullableStringField(value, "backendProfileId")
    && nullableStringField(value, "model")
    && arrayOf(value.classifications, reviewClassification)
    && arrayOf(value.files, (file) =>
      recordWithStrings(file, "path", "summary")
      && arrayOf(file.classifications, reviewClassification)
      && arrayOf(file.hunks, (hunk) =>
        recordWithStrings(hunk, "hunkId", "summary")
        && arrayOf(hunk.classifications, reviewClassification)));
}

function reviewSelectionAnswer(value: unknown): boolean {
  return recordWithStrings(
    value,
    "conversationId",
    "fingerprint",
    "filePath",
    "hunkId",
    "question",
    "answer",
    "providerId",
    "generatedAt",
  )
    && providerId(value, "providerId")
    && optionalStringField(value, "repositoryPath")
    && integerField(value, "selectedLineCount")
    && modelSelection(value.modelSelection) && modelRouteIdentityCoherent(value);
}

function turnUsage(value: unknown): boolean {
  return recordWithStrings(value, "capturedAt")
    && [
      "usedTokens", "totalProcessedTokens", "maxTokens", "inputTokens",
      "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
      "reasoningOutputTokens",
    ].every((key) => nullableNumberField(value, key))
    && (value.totalProcessedScope === null
      || oneOf(value, "totalProcessedScope", ["thread", "session", "run"]))
    && (value.compactsAutomatically === null
      || booleanField(value, "compactsAutomatically"));
}

function agentTurn(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "conversationId",
    "runId",
    "userMessageId",
    "providerId",
    "harnessId",
    "backendProfileId",
    "model",
    "reasoningEffort",
    "interactionMode",
    "accessMode",
    "requestedAt",
    "status",
    "association",
    "createdAt",
    "updatedAt",
  )
    && providerId(value, "providerId")
    && oneOf(value, "interactionMode", SERVER_EVENT_OPTIONS.interactionModes)
    && oneOf(value, "accessMode", SERVER_EVENT_OPTIONS.accessModes)
    && nullableStringField(value, "terminalAssistantMessageId")
    && modelSelection(value.modelSelection) && continuationIdentity(value.continuationIdentity)
    && modelRouteIdentityCoherent(value)
    && nullableStringField(value, "modelAlias")
    && nullableStringField(value, "providerSessionBefore")
    && nullableStringField(value, "providerSessionAfter")
    && nullableStringField(value, "startedAt")
    && nullableStringField(value, "completedAt")
    && nullableStringField(value, "terminalReason")
    && nullableStringField(value, "checkpointId")
    && oneOf(value, "status", AGENT_TURN_STATUSES)
    && (value.usageAtStart === null || turnUsage(value.usageAtStart))
    && (value.usageAtCompletion === null || turnUsage(value.usageAtCompletion))
    && integerField(value, "configurationRevision")
    && oneOf(value, "association", ["authoritative", "inferred"]);
}

function turnGitArtifactFile(value: unknown): boolean {
  return changedFile(value)
    && record(value)
    && nullableStringField(value, "previousPath")
    && booleanField(value, "binary");
}

function turnGitArtifact(value: unknown): boolean {
  return recordWithStrings(value, "id", "turnId", "conversationId", "runId")
    && [
      "repositoryIdentity", "worktreeIdentity", "branch", "beforeCheckpointId",
      "beforeFingerprint", "afterFingerprint", "patchDigest", "capturedAt",
      "terminalAssistantMessageId", "failureReason",
    ].every((key) => nullableStringField(value, key))
    && optionalNullableStringField(value, "absenceReason")
    && (value.absenceReason === undefined
      || value.absenceReason === null
      || value.absenceReason === "not-repository")
    && arrayOf(value.files, turnGitArtifactFile)
    && integerField(value, "insertions")
    && integerField(value, "deletions")
    && oneOf(value, "status", ["pending", "ready", "partial", "unavailable", "failed"])
    && oneOf(value, "completeness", ["complete", "truncated", "partial", "unavailable"])
    && oneOf(value, "patchState", ["none", "available", "truncated", "expired", "failed"]);
}

function agentReasoning(value: unknown): boolean {
  return recordWithStrings(value, "id", "conversationId", "runId", "content", "createdAt")
    && nullableStringField(value, "turnId")
    && oneOf(value, "status", ["running", "completed", "failed"]);
}

function checkpoint(value: unknown): boolean {
  return recordWithStrings(value, "id", "conversationId", "ref", "label", "createdAt")
    && nullableStringField(value, "turnId")
    && integerField(value, "turnIndex")
    && integerField(value, "filesChanged")
    && integerField(value, "insertions")
    && integerField(value, "deletions");
}

function reviewState(value: unknown): boolean {
  return recordWithStrings(value, "conversationId", "path", "targetFingerprint", "updatedAt")
    && optionalStringField(value, "repositoryPath")
    && oneOf(value, "scope", ["file", "hunk"])
    && nullableStringField(value, "hunkId")
    && booleanField(value, "reviewed")
    && booleanField(value, "stale");
}

function reviewNote(value: unknown): boolean {
  return recordWithStrings(
    value,
    "id",
    "conversationId",
    "path",
    "targetFingerprint",
    "body",
    "createdAt",
    "updatedAt",
  )
    && optionalStringField(value, "repositoryPath")
    && nullableStringField(value, "hunkId")
    && arrayOf(value.lineIds, (entry) => typeof entry === "string")
    && booleanField(value, "stale");
}

function conversationDetail(
  value: unknown,
  expectedConversationId?: string,
): boolean {
  if (!record(value) || !conversation(value.conversation)) return false;
  const conversationId = value.conversation.id as string;
  return (expectedConversationId === undefined
      || conversationId === expectedConversationId)
    && arrayOf(value.agentTurns, agentTurn)
    && arrayOf(value.turnGitArtifacts, turnGitArtifact)
    && arrayOf(value.messages, chatMessage)
    && arrayOf(value.activities, activity)
    && arrayOf(value.subagents, subagentTrace)
    && arrayOf(value.reasonings, agentReasoning)
    && arrayOf(value.usage, threadUsage)
    && arrayOf(value.plans, agentPlan)
    && arrayOf(value.goals, agentGoal)
    && arrayOf(value.checkpoints, checkpoint)
    && arrayOf(value.reviewSummaries, reviewSummary)
    && arrayOf(value.reviewStates, reviewState)
    && arrayOf(value.reviewNotes, reviewNote)
    && conversationDetailCollectionsCoherent(value, conversationId);
}

function runtimeMutationEvent(value: unknown): value is RuntimeMutationEvent {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "snapshot.updated":
      return appSnapshot(value.snapshot);
    case "conversation.shell.updated": {
      const conversationValue = value.conversation;
      if (!record(conversationValue) || !conversationShell(conversationValue)) {
        return false;
      }
      return arrayOf(value.runs, (entry) =>
        workspaceRun(entry)
        && record(entry)
        && entry.conversationId === conversationValue.id
        && entry.projectId === conversationValue.projectId)
        && uniqueRecordField(value.runs as unknown[], "id");
    }
    case "workspace.git.invalidated":
      return recordWithStrings(value, "requestId", "projectId")
        && nullableStringField(value, "conversationId");
    case "conversation.detail.invalidated":
      return stringField(value, "conversationId");
    case "conversation.message.persisted":
    case "agent.commentary.persisted":
      return chatMessage(value.message);
    case "provider.maintenance.updated":
      return arrayOf(value.providers, providerMaintenanceStatus)
        && uniqueRecordField(value.providers as unknown[], "providerId");
    case "provider.maintenance.operation":
      return providerMaintenanceOperation(value.operation);
    case "agent.started":
    case "agent.completed":
      return recordWithStrings(value, "conversationId", "runId", "turnId");
    case "agent.text":
    case "agent.reasoning":
      return recordWithStrings(value, "conversationId", "runId", "turnId", "text");
    case "agent.usage":
      return threadUsage(value.usage);
    case "agent.activity":
      return activity(value.activity);
    case "agent.subagent.updated":
      return subagentTrace(value.trace);
    case "agent.approval.requested":
      return approvalRequest(value.request);
    case "agent.approval.resolved":
      return recordWithStrings(
        value,
        "conversationId",
        "runId",
        "turnId",
        "requestId",
        "decision",
      ) && oneOf(value, "decision", ["approve", "deny", "cancel", "cancelled"]);
    case "agent.input.requested":
      return inputRequest(value.request);
    case "agent.input.resolved":
      return recordWithStrings(value, "conversationId", "runId", "turnId", "requestId");
    case "agent.plan.updated":
      return agentPlan(value.plan);
    case "agent.goal.updated":
      return agentGoal(value.goal);
    case "agent.goal.cleared":
      return recordWithStrings(value, "conversationId", "source")
        && oneOf(value, "source", SERVER_EVENT_OPTIONS.goalSources);
    case "agent.failed":
      return recordWithStrings(value, "conversationId", "runId", "turnId", "message");
    default:
      return false;
  }
}

type RequestResult = Extract<ServerEvent, { type: "request.result" }>["result"];
type RequestResultKind = RequestResult["kind"];
const REQUEST_RESULT_VALIDATORS = {
  "message.accepted": (value) =>
    recordWithStrings(value, "conversationId", "turnId", "userMessageId")
    && oneOf(value, "disposition", ["new-turn", "follow-up"]),
  "backend.profile": (value) => backendProfile(value.profile, true),
  "backend.profile.probe": (value) => backendProfile(value.profile, true),
  "backend.default": (value) => value.value === null || backendDefault(value.value),
  "provider.maintenance": (value) => arrayOf(value.providers, providerMaintenanceStatus)
    && uniqueRecordField(value.providers as unknown[], "providerId"),
  "provider.maintenance.operation": (value) =>
    providerMaintenanceOperation(value.operation),
  "usage.dashboard": (value) => usageDashboardSchema(value.dashboard),
  "conversation.created": (value) => stringField(value, "conversationId"),
  "project.created": (value) => stringField(value, "projectId"),
  "git.action": (value) => stringField(value, "message"),
  "external.url": (value) => recordWithStrings(value, "url", "label"),
  "git.branches": (value) => arrayOf(value.branches, gitBranch),
  "workspace.entries": (value) => workspaceEntriesPage(value),
  "workspace.file": (value) => workspaceFile(value.file),
  "project.actions": (value) => arrayOf(value.actions, projectAction)
    && uniqueRecordField(value.actions as unknown[], "id"),
  "agent.workflow": (value) => agentWorkflow(value.workflow),
  "agent.skills": (value) => stringField(value, "conversationId")
    && arrayOf(value.skills, (entry) =>
      agentSkill(entry)
      && record(entry)
      && entry.conversationId === value.conversationId)
    && uniqueRecordField(value.skills as unknown[], "id")
    && skillDiscovery(value.skillDiscovery),
  "conversation.detail": (value) => stringField(value, "conversationId")
    && oneOf(value, "state", ["ready", "missing", "deleted", "failed"])
    && (value.sync === undefined || syncCursor(value.sync))
    && (value.state !== "ready"
      || conversationDetail(value.detail, value.conversationId as string))
    && (value.state !== "failed" || stringField(value, "message")),
  "duo.pending": (value) =>
    arrayOf(value.launchIds, (entry) => typeof entry === "string")
    && new Set(value.launchIds as unknown[]).size === (value.launchIds as unknown[]).length
    && booleanField(value, "hasMore"),
  "duo.prepared": (value) => duoPrepared(value),
  "duo.status": (value) => duoStatus(value),
  "git.status": (value) => gitStatus(value.status),
  "git.workspace.status": (value) => workspaceGitStatus(value.status),
  "git.diff": (value) => gitDiff(value.diff),
  "git.workspace.diff": (value) => workspaceGitDiff(value.diff),
  "git.turn.diff": (value) => turnGitDiff(value.diff),
  "git.reversal.plan": (value) => reversalPlan(value.plan),
  "git.reversal": (value) =>
    gitDiff(value.diff) && reversalOperation(value.operation),
  "review.selection.answer": (value) => reviewSelectionAnswer(value.answer),
  "review.summary": (value) => reviewSummary(value.summary),
} satisfies Record<RequestResultKind, (value: UnknownRecord) => boolean>;

function requestResult(value: unknown): value is RequestResult {
  if (!recordWithStrings(value, "kind")) return false;
  const validator = REQUEST_RESULT_VALIDATORS[value.kind as RequestResultKind];
  return validator?.(value) === true;
}

function isServerEvent(value: unknown): value is ServerEvent {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "server.welcome":
      return value.protocolVersion === 1
        && appSnapshot(value.snapshot)
        && (value.sync === undefined || syncCursor(value.sync));
    case "runtime.resumed":
      return value.protocolVersion === 1 && syncCursor(value.sync);
    case "runtime.sync.completed":
    case "runtime.cursor":
      return syncCursor(value.sync);
    case "runtime.event":
      return syncCursor(value.sync)
        && runtimeMutationEvent(value.event)
        && runtimeEventScopeMatches(value.scope, value.event);
    case "request.ok":
      return stringField(value, "requestId");
    case "request.error":
      return stringField(value, "requestId") && stringField(value, "message");
    case "request.result":
      return stringField(value, "requestId") && requestResult(value.result);
    case "terminal.created":
      return stringField(value, "requestId")
        && stringField(value, "terminalId")
        && (value.providerResume === undefined
          || (recordWithStrings(
            value.providerResume,
            "providerId",
            "providerLabel",
            "sessionId",
          )
            && oneOf(value.providerResume, "providerId", [
              "codex", "claude", "cursor", "opencode",
            ])
            && nonemptyStringField(value.providerResume, "providerLabel")
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
              value.providerResume.sessionId as string,
            )));
    case "terminal.output":
      return stringField(value, "terminalId") && stringField(value, "data");
    case "terminal.exit":
      return stringField(value, "terminalId") && Number.isInteger(value.exitCode);
    default:
      return runtimeMutationEvent(value);
  }
}

/**
 * Single runtime-to-client trust boundary. The custom predicate deliberately
 * preserves legacy-compatible extra fields while requiring the discriminants,
 * identities, and renderer-consumed nested state checked below to have their
 * declared runtime shapes.
 */
export function parseServerEvent(value: unknown): ServerEvent {
  if (!isServerEvent(value)) throw new Error("Malformed server event");
  return value;
}

export const serverEventSchema = Object.freeze({
  parse: parseServerEvent,
  safeParse(value: unknown): | { success: true; data: ServerEvent }
    | { success: false; error: Error } {
    try {
      return { success: true, data: parseServerEvent(value) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error("Malformed server event"),
      };
    }
  },
});
