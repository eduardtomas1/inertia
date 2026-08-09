import type { RuntimeMutationEvent, ServerEvent } from "./events";
import {
  APP_SHORTCUT_KEYS,
  DEFAULT_APP_KEYBINDINGS,
} from "../keybindings";

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

function oneOf(value: UnknownRecord, key: string, options: readonly string[]): boolean {
  return typeof value[key] === "string" && options.includes(value[key] as string);
}

function recordWithStrings(value: unknown, ...keys: string[]): value is UnknownRecord {
  return record(value) && keys.every((key) => stringField(value, key));
}

function arrayOf(value: unknown, validate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(validate);
}

function modelSelection(value: unknown): boolean {
  return recordWithStrings(
    value,
    "harnessId",
    "backendProfileId",
    "backendProfileDisplayName",
    "modelId",
  )
    && nullableStringField(value, "alias")
    && nullableStringField(value, "reasoningEffort")
    && nullableNumberField(value, "contextWindowOverride")
    && record(value.providerOptions)
    && Array.isArray(value.capabilities)
    && integerField(value, "backendConfigurationRevision");
}

function continuationIdentity(value: unknown): boolean {
  return recordWithStrings(value, "harnessId", "backendProfileId")
    && integerField(value, "backendConfigurationRevision")
    && nullableStringField(value, "modelIdentity")
    && nullableStringField(value, "endpointIdentity");
}

function backendProfile(value: unknown, detail = false): boolean {
  return recordWithStrings(
    value,
    "id",
    "displayName",
    "harnessId",
    "protocol",
    "authenticationMode",
    "preset",
    "source",
    "createdAt",
    "updatedAt",
  )
    && booleanField(value, "enabled")
    && integerField(value, "configurationRevision")
    && nullableStringField(value, "credentialGeneration")
    && nullableStringField(value, "endpointHost")
    && stringField(value, "authState")
    && stringField(value, "connectionState")
    && booleanField(value, "canDelete")
    && booleanField(value, "canDisable")
    && (!detail || nullableStringField(value, "baseUrl"));
}

function backendDefault(value: unknown): boolean {
  return recordWithStrings(value, "scope", "updatedAt")
    && nullableStringField(value, "projectId")
    && modelSelection(value.selection);
}

function syncCursor(value: unknown): boolean {
  return recordWithStrings(value, "runtimeGeneration")
    && (value.runtimeGeneration as string).length > 0
    && Number.isSafeInteger(value.latestSequence)
    && Number(value.latestSequence) >= 0;
}

function attachment(value: unknown): boolean {
  return recordWithStrings(value, "id", "name", "path", "mimeType")
    && numberField(value, "size")
    && Number(value.size) >= 0;
}

function chatMessage(value: unknown): boolean {
  return recordWithStrings(value, "id", "conversationId", "role", "content", "createdAt")
    && nullableStringField(value, "turnId")
    && oneOf(value, "role", ["user", "assistant", "system"])
    && arrayOf(value.attachments, attachment);
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
    && nullableStringField(value, "installedVersion")
    && nullableStringField(value, "latestVersion")
    && nullableStringField(value, "checkedAt")
    && nullableStringField(value, "updateLabel")
    && nullableStringField(value, "message");
}

function providerMaintenanceOperation(value: unknown): boolean {
  return recordWithStrings(value, "id", "providerId", "status", "message")
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
    && nullableStringField(value, "startedAt")
    && nullableStringField(value, "completedAt")
    && nullableStringField(value, "terminalReason")
    && modelSelection(value.modelSelection)
    && continuationIdentity(value.continuationIdentity);
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
    && modelSelection(value.modelSelection)
    && (value.continuationIdentity === null
      || continuationIdentity(value.continuationIdentity))
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
    && nullableStringField(value, "conversationId")
    && nullableStringField(value, "actionId")
    && nullableStringField(value, "detail")
    && nullableNumberField(value, "port")
    && nullableStringField(value, "finishedAt")
    && booleanField(value, "canStop");
}

function providerMetadataField(value: unknown): boolean {
  return recordWithStrings(value, "freshness")
    && nullableStringField(value, "provenance")
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
    && booleanField(value, "available")
    && nullableStringField(value, "version")
    && (value.executable === undefined || nullableStringField(value, "executable"))
    && booleanField(value, "canRun")
    && nullableStringField(value, "statusMessage")
    && arrayOf(value.models, providerModel)
    && arrayOf(value.rateLimits, providerRateLimit)
    && record(value.metadataState)
    && providerMetadataField(value.metadataState.models)
    && providerMetadataField(value.metadataState.rateLimits)
    && (value.maintenance === undefined || providerMaintenanceStatus(value.maintenance));
}

function appSettings(value: unknown): boolean {
  if (!record(value)) return false;
  const strings = [
    "theme", "defaultProvider", "defaultModel", "defaultAccessMode",
    "newThreadMode", "usageDisplayMode", "interfaceScale", "responseDensity",
    "workspaceStartupSurface", "sidebarMode", "projectGrouping",
    "defaultReasoningEffort", "defaultInteractionMode", "codexBinaryPath",
  ];
  const booleans = [
    "compactSidebar", "showTimestamps", "wrapDiffs", "ignoreWhitespace",
    "showThinking", "defaultCodeWrap", "autoCollapseWorkLog",
    "showChangedFileSummaries", "autoOpenPlan", "confirmDestructiveActions",
    "desktopNotifications",
  ];
  return strings.every((key) => stringField(value, key))
    && booleans.every((key) => booleanField(value, key))
    && numberField(value, "terminalFontSize")
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
  return record(value)
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
    && (value.sync === undefined || syncCursor(value.sync));
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
    && ["detail", "command", "cwd", "reason"].every((key) =>
      nullableStringField(value, key))
    && (value.networkScope === null
      || (recordWithStrings(value.networkScope, "host", "protocol")))
    && arrayOf(value.permissionRoots, (entry) =>
      recordWithStrings(entry, "path", "access"))
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
    && nullableNumberField(value, "autoResolutionMs")
    && arrayOf(value.questions, (question) =>
      recordWithStrings(question, "id", "header", "question")
      && booleanField(question, "isOther")
      && booleanField(question, "isSecret")
      && booleanField(question, "allowMultiple")
      && arrayOf(question.options, (option) =>
        recordWithStrings(option, "id", "label", "description")));
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
  return recordWithStrings(value, "conversationId", "refreshedAt")
    && arrayOf(value.goals, agentGoal)
    && workflowGoalCapability(value.goalCapability)
    && arrayOf(value.skills, agentSkill)
    && workflowSkillsCapability(value.skillsCapability)
    && nullableStringField(value, "goalRefreshWarning")
    && skillDiscovery(value.skillDiscovery);
}

function runtimeMutationEvent(value: unknown): value is RuntimeMutationEvent {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "snapshot.updated":
      return appSnapshot(value.snapshot);
    case "conversation.shell.updated":
      return conversationShell(value.conversation)
        && arrayOf(value.runs, workspaceRun);
    case "workspace.git.invalidated":
      return recordWithStrings(value, "requestId", "projectId")
        && nullableStringField(value, "conversationId");
    case "conversation.detail.invalidated":
      return stringField(value, "conversationId");
    case "conversation.message.persisted":
    case "agent.commentary.persisted":
      return chatMessage(value.message);
    case "provider.maintenance.updated":
      return arrayOf(value.providers, providerMaintenanceStatus);
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
      return recordWithStrings(value, "conversationId", "source");
    case "agent.failed":
      return recordWithStrings(value, "conversationId", "runId", "turnId", "message");
    default:
      return false;
  }
}

type RequestResult = Extract<ServerEvent, { type: "request.result" }>["result"];

function requestResult(value: unknown): value is RequestResult {
  if (!recordWithStrings(value, "kind")) return false;
  switch (value.kind) {
    case "message.accepted":
      return recordWithStrings(value, "conversationId", "turnId", "userMessageId")
        && oneOf(value, "disposition", ["new-turn", "follow-up"]);
    case "backend.profile":
    case "backend.profile.probe":
      return backendProfile(value.profile, true);
    case "backend.default":
      return value.value === null || backendDefault(value.value);
    case "provider.maintenance":
      return arrayOf(value.providers, providerMaintenanceStatus);
    case "provider.maintenance.operation":
      return providerMaintenanceOperation(value.operation);
    case "conversation.created":
    case "project.created":
      return stringField(value, value.kind === "conversation.created" ? "conversationId" : "projectId");
    case "worktree.created":
      return recordWithStrings(value, "path", "branch");
    case "git.action":
      return stringField(value, "message");
    case "external.url":
      return recordWithStrings(value, "url", "label");
    case "git.branches":
      return Array.isArray(value.branches);
    case "workspace.entries":
      return Array.isArray(value.entries);
    case "workspace.file":
      return record(value.file) && stringField(value.file, "path");
    case "project.actions":
      return Array.isArray(value.actions);
    case "agent.workflow":
      return agentWorkflow(value.workflow);
    case "agent.skills":
      return stringField(value, "conversationId")
        && arrayOf(value.skills, agentSkill)
        && skillDiscovery(value.skillDiscovery);
    case "conversation.detail":
      return stringField(value, "conversationId")
        && oneOf(value, "state", ["ready", "missing", "deleted", "failed"])
        && (value.sync === undefined || syncCursor(value.sync))
        && (value.state !== "ready" || record(value.detail))
        && (value.state !== "failed" || stringField(value, "message"));
    case "duo.pending":
      return Array.isArray(value.launchIds);
    case "duo.prepared":
    case "duo.status":
      return stringField(value, "launchId") && Array.isArray(value.sides);
    case "git.status":
      return record(value.status) && Array.isArray(value.status.files);
    case "git.workspace.status":
      return record(value.status) && Array.isArray(value.status.repositories);
    case "git.diff":
    case "git.workspace.diff":
    case "git.turn.diff":
      return record(value.diff);
    case "git.reversal.plan":
      return record(value.plan);
    case "git.reversal":
      return record(value.diff) && record(value.operation);
    case "review.selection.answer":
      return record(value.answer);
    case "review.summary":
      return record(value.summary);
    default:
      return false;
  }
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
        && record(value.scope)
        && (value.scope.kind === "shell"
          || (value.scope.kind === "conversation-detail"
            && stringField(value.scope, "conversationId")))
        && runtimeMutationEvent(value.event);
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
  safeParse(value: unknown):
    | { success: true; data: ServerEvent }
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
