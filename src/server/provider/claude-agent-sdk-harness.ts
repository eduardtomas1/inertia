import { randomUUID } from "node:crypto";

import {
  query as claudeQuery,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { NATIVE_ANTHROPIC_PROFILE_ID } from "../../shared/claude-backend-profiles";
import { clipCodeUnits } from "../../shared/code-units";
import { isProviderTerminalSessionId } from "../../shared/provider-terminal-resume";
import { providerUnconfirmedCleanup } from "./provider-unconfirmed-cleanup";
import {
  launchCredentialValues,
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  sanitizeProviderFailureDetail,
} from "./activity-detail";
import {
  claudeEffort,
  claudeFailure,
  claudeLifecycleFailure,
  claudeReadableRuntimeError,
  claudeResultDetail,
  claudeResultFailure,
  claudeResultReason,
  claudeRunEnvironment,
  claudeRuntimeFailure,
  claudeSupportsThinkingDisplay,
  safeError,
  stringValue,
} from "./claude-agent-sdk-errors";
export { claudeSupportsThinkingDisplay };
import {
  createClaudeOwnedQueryProcess,
  type ClaudeOwnedQueryDependencies,
} from "./claude-owned-query";
import {
  PROVIDER_NATURAL_CLOSE_MS,
  providerNaturalCloseFirst,
} from "./provider-natural-close";
import { emitClaudeModelMetadata } from "./claude-agent-sdk-metadata";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { ClaudeChecklistSessions } from "./claude-checklist-projection";
import { ClaudeRunEventBudget } from "./claude-event-budget";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type ClaudeAgentSdkHarnessCapabilities,
} from "./agent-harness";
import type { ProviderSteerReadCallback } from "./types";
import {
  providerRunTerminal,
  type ProviderRunFailure,
  type ProviderRunResult,
} from "./contracts";
import { ClaudeDelegateLifecycle, claudeMessageResumesParent, isClaudeNotificationResult, isClaudeQueuedCompletionAck, isClaudeUnansweredPromptResult } from "./claude-delegate-lifecycle";
import { claudeCredentialCommandHooks } from "./claude-credential-commands";
import { ClaudeLaunchRedactor } from "./claude-launch-redaction";
import { ClaudeMessageProjector } from "./claude-message-projector";
import { ClaudePromptChannel } from "./claude-prompt-channel";
import { CLAUDE_MESSAGE_DRAIN_TIMEOUT, nextClaudeMessage, claudeFastModeFailure } from "./claude-sdk-lifecycle-support";
import { claudeResultUserMessageIds } from "./claude-follow-up-correlation";
import { claudeCommandLifecycleMessage } from "./claude-message-projector-support";
import { ClaudePermissionBroker, claudeSdkPermissionMode } from "./claude-permission-broker";
import {
  claudePrompt,
  claudePromptReservationBytes,
  normalizedClaudeFollowUp,
} from "./claude-prompt";
import {
  CLAUDE_ISOLATED_SKILL_SETTINGS,
  claudePluginLoadedSelectedSkills,
  type StagedClaudeSkillPlugin,
} from "./claude-skill-plugin";
import type { ClaudeSkillFilesystemTestSeam } from "./claude-skill-operation";
import {
  claudeIdentityOptions,
  prepareClaudeTurnIdentity,
} from "./claude-identity";
import type { ClaudeQueryFactory } from "./claude-skill-query";
import { ClaudeSubagentTraceTracker } from "./claude-subagent-trace";
import { createClaudeTaskControls } from "./claude-task-controls";
import {
  claudeSessionNotFound,
  claudeSessionUnavailable,
  claudeStartupExitMessage,
  claudeStartupFailure,
} from "./claude-startup-failure";
import { claudeRouteFailureDetail, claudeRouteFailureMessage } from "./claude-custom-backend-failure";
import {
  ClaudeUsageLedger, readClaudeContextUsage,
} from "./claude-usage";
import { createClaudeHostTools } from "./claude-host-tools";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import { INERTIA_HOST_MCP_NAME } from "./host-tool-mcp-config";
import {
  claudeNativeContinuationOptions, claudeSessionStoredElsewhere, createClaudeNativeConversationOperations, readClaudePersistedNativeHead,
} from "./claude-native-conversation";
import { trackNativeConversationRun } from "./native-conversation-run-tracking";

const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_RUN_EVENTS = 8_192;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const CLAUDE_STOP_TASK_TIMEOUT_MS = 2_000;
const MIN_CLAUDE_STOP_TASK_TIMEOUT_MS = 25;
const CLAUDE_TERMINAL_SUBAGENT_DRAIN_TIMEOUT_MS = 2_000;
const MIN_CLAUDE_TERMINAL_SUBAGENT_DRAIN_TIMEOUT_MS = 25;
const CLAUDE_SKILL_FILESYSTEM_TIMEOUT_MS = 6_000;
export const CLAUDE_RETRY_BUDGET_MS = 10 * 60 * 1_000;
export const CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE =
  "Claude exceeded the retry time limit without making progress.";

export const CLAUDE_AGENT_SDK_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "claude-agent-sdk",
    protocol: "claude-agent-sdk",
    approvals: "native",
    questions: "native",
    plans: "native",
    reasoning: "streaming-thinking",
    usage: "result-usage",
    images: "structured-base64-input",
    authentication: "claude-cli",
    modelMetadata: "agent-sdk",
  },
} as const satisfies ClaudeAgentSdkHarnessCapabilities;

export interface ClaudeAgentSdkHarnessOptions
  extends ClaudeOwnedQueryDependencies {
  createQuery?: ClaudeQueryFactory;
  /**
   * May shorten, but never extend, the production delegated-task stop
   * acknowledgement deadline. Primarily useful for deterministic tests.
   */
  stopTaskTimeoutMs?: number;
  /**
   * May shorten, but never extend, the quiet period used to consume terminal
   * delegate notifications after Claude has already returned the parent
   * result. Primarily useful for deterministic tests.
   */
  terminalSubagentDrainTimeoutMs?: number;
  /**
   * May shorten, but never extend, the 10-minute retry/unanswered budget (T3
   * `943de8fe9`). Primarily useful for deterministic tests.
   */
  retryBudgetMs?: number;
  /** Optional clock override for deterministic retry-budget tests. */
  now?: () => number;
  /** Optional default steer-read observer when not provided on start options. */
  onSteerRead?: ProviderSteerReadCallback;
  skillFilesystem?: ClaudeSkillFilesystemTestSeam;
}

export { readClaudeAgentSdkSkills } from "./claude-skill-query";
export { claudeQuestions } from "./claude-questions";
export {
  parseClaudeRateLimits,
  readClaudeAgentSdkMetadata,
  readClaudeAgentSdkModels,
} from "./claude-agent-sdk-metadata";

function claudeStopTaskTimeout(value: number | undefined): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    return CLAUDE_STOP_TASK_TIMEOUT_MS;
  }
  return Math.max(
    MIN_CLAUDE_STOP_TASK_TIMEOUT_MS,
    Math.min(value, CLAUDE_STOP_TASK_TIMEOUT_MS),
  );
}

function claudeTerminalSubagentDrainTimeout(
  value: number | undefined,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    return CLAUDE_TERMINAL_SUBAGENT_DRAIN_TIMEOUT_MS;
  }
  return Math.max(
    MIN_CLAUDE_TERMINAL_SUBAGENT_DRAIN_TIMEOUT_MS,
    Math.min(value, CLAUDE_TERMINAL_SUBAGENT_DRAIN_TIMEOUT_MS),
  );
}

function claudeRetryBudgetTimeout(value: number | undefined): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 1
  ) {
    return CLAUDE_RETRY_BUDGET_MS;
  }
  return Math.max(1, Math.min(Math.floor(value), CLAUDE_RETRY_BUDGET_MS));
}

function isClaudeRetryMessage(message: SDKMessage): boolean {
  return message.type === "system" && (
    message.subtype === "api_retry"
    || (message.subtype === "control_request_progress" && message.status === "api_retry")
  );
}

function isClaudeSubstantiveProgressMessage(message: SDKMessage): boolean {
  if (message.type === "assistant" || message.type === "stream_event"
    || message.type === "result" || message.type === "tool_progress"
    || message.type === "tool_use_summary" || message.type === "user") {
    return true;
  }
  return message.type === "system" && (
    message.subtype === "compact_boundary"
    || message.subtype === "status"
    || message.subtype === "model_refusal_fallback"
  );
}

export function createClaudeAgentSdkHarness(options: ClaudeAgentSdkHarnessOptions = {}): AgentHarness {
  const stopTaskTimeoutMs = claudeStopTaskTimeout(
    options.stopTaskTimeoutMs,
  );
  const terminalSubagentDrainTimeoutMs = claudeTerminalSubagentDrainTimeout(
    options.terminalSubagentDrainTimeoutMs,
  );
  const retryBudgetMs = claudeRetryBudgetTimeout(options.retryBudgetMs);
  const checklistSessions = new ClaudeChecklistSessions();
  const activeNativeConversations = new Set<string>();
  return {
    id: "claude-agent-sdk",
    providerId: "claude",
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    nativeConversation: createClaudeNativeConversationOperations(activeNativeConversations),
    supports: (input) => input.providerId === "claude",
    start: (startOptions) => trackNativeConversationRun(activeNativeConversations, startOptions, (tracked) => startClaudeRun(
      tracked,
      options.createQuery ?? claudeQuery,
      options,
      stopTaskTimeoutMs,
      terminalSubagentDrainTimeoutMs,
      retryBudgetMs,
      options.now ?? (() => performance.now()),
      startOptions.onSteerRead ?? startOptions.callbacks?.onSteerRead ?? options.onSteerRead,
      options.skillFilesystem,
      checklistSessions,
    )),
  };
}

function startClaudeRun(
  options: AgentHarnessStartOptions,
  createQuery: ClaudeQueryFactory,
  lifecycleDependencies: ClaudeOwnedQueryDependencies,
  stopTaskTimeoutMs: number,
  terminalSubagentDrainTimeoutMs: number,
  retryBudgetMs: number,
  now: () => number,
  harnessOnSteerRead: ProviderSteerReadCallback | undefined,
  skillFilesystem: ClaudeSkillFilesystemTestSeam | undefined,
  checklistSessions: ClaudeChecklistSessions,
): AgentHarnessRun {
  const conversationId = options.input.conversationId;
  const emitter = createAgentHarnessEmitter(
    "claude",
    conversationId,
    options.callbacks,
    options.input.runId,
    options.input.turnId,
    options.input.cwd,
  );
  const text = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const eventBudget = new ClaudeRunEventBudget(
    new ProviderRunEventBudget(
      "Claude",
      MAX_EVENT_TEXT_CHARS,
      MAX_RUN_EVENTS,
      MAX_RUN_EVENT_BYTES,
    ),
  );
  const abortController = new AbortController();
  const preparationAbortController = new AbortController();
  const delegateLifecycle = new ClaudeDelegateLifecycle();
  const promptChannel = new ClaudePromptChannel();
  const subagentTracker = new ClaudeSubagentTraceTracker(emitter.subagent);
  const taskControls = createClaudeTaskControls({
    query: () => query,
    cancelled: () => cancelRequested,
    tracker: subagentTracker,
    timeoutMs: stopTaskTimeoutMs,
  });
  let query: Query | undefined;
  let messageIterator: AsyncIterator<SDKMessage> | undefined;
  let cancelRequested = false;
  let acceptingFollowUps = false;
  let acceptedFollowUp = false;
  const pendingFollowUpIds = new Set<string>();
  // Follow-ups Claude reported starting: read, though no result answers them yet.
  const startedFollowUpIds = new Set<string>();
  // Accepted follow-ups Claude cancelled, discarded or refused before reading them.
  const droppedFollowUpIds: string[] = [];
  const followUpSteerIds = new Map<string, string>();
  // T3 `heldResult`: a completed result keeps the turn open while Claude still
  // holds an unread follow-up, and settles it if Claude drops that follow-up.
  let heldResult: { message: SDKMessage; sawOutputText: boolean; turnEnded: boolean } | null = null;
  let sessionId = options.nativeContinuation?.nativeConversationId ?? options.input.sessionId;
  let authoritativeSessionId = sessionId;
  let checklistTasks = checklistSessions.tasks(sessionId, true);
  let pendingSessionReset: { outgoingId: string; candidateId?: string } | undefined;
  let contextUsageGeneration = 0;
  let latestContextUsage: unknown;
  let contextUsageRequest: Promise<void> | null = null;
  let stagedSkillPlugin: StagedClaudeSkillPlugin | null = null;
  let selectedSkillsVerified = false;
  const requestedFastMode = options.input.modelSelection.providerOptions.fastMode;
  if (requestedFastMode !== undefined && requestedFastMode !== "fast") {
    throw new Error("Claude received an invalid Fast mode option.");
  }
  const supportsFastMode = options.input.supportedFastMode === "fast";
  const requestedFastModeState = supportsFastMode
    ? requestedFastMode === "fast" ? "on" : "off"
    : null;
  let fastModeVerified = requestedFastModeState === null;
  const promptCacheTtl = options.harnessConfiguration?.kind === "claude-messages"
    ? options.harnessConfiguration.promptCacheTtl
    : null;
  const launchSettings = {
    useAutoModeDuringPlan: false,
    ...(supportsFastMode
      ? { fastMode: requestedFastMode === "fast", fastModePerSessionOptIn: true }
      : {}),
    ...(promptCacheTtl ? { promptCacheTtl } : {}),
    ...(options.input.autoCompactWindow ? { autoCompactWindow: options.input.autoCompactWindow } : {}),
  };
  let sessionUnavailable = false;
  let sessionNotFound = false;
  const ownedProcess = createClaudeOwnedQueryProcess(
    "Claude Code process tree",
    lifecycleDependencies,
  );
  const hostToolRuntime = options.hostTools && options.input.turnId
    ? new ProviderHostToolRuntime({
        bridge: options.hostTools,
        conversationId,
        turnId: options.input.turnId,
        cwd: options.input.cwd,
        onApproval: (request) => emitter.rich({ type: "approval", request }),
        onApprovalResolved: (requestId, decision) => {
          emitter.rich({ type: "approval-resolved", requestId, decision });
        },
      })
    : undefined;
  const claudeHostTools = hostToolRuntime
    ? createClaudeHostTools(hostToolRuntime)
    : undefined;
  let hostToolsCleanupFailed = false;

  const refreshContextUsage = (): void => {
    if (!query || contextUsageRequest) return;
    const generation = contextUsageGeneration;
    contextUsageRequest = readClaudeContextUsage(query)
      .then((usage) => {
        if (usage && generation === contextUsageGeneration) latestContextUsage = usage;
      })
      .finally(() => {
        contextUsageRequest = null;
      });
  };

  const launchRedaction = options.input.backendProfile.id === NATIVE_ANTHROPIC_PROFILE_ID
    ? null
    : ClaudeLaunchRedactor.forEnvironment(claudeRunEnvironment(options.environment));
  const redactLaunchText = (value: string): string => launchRedaction?.text(value) ?? value;
  const permissions = new ClaudePermissionBroker({
    input: options.input,
    emitter,
    launchRedaction,
    providerNativeToolsAvailable: options.providerNativeToolsAvailable,
    hostToolNames: claudeHostTools?.providerToolNames,
    cancelled: () => cancelRequested,
  });

  emitter.status("starting");
  const usesNativeAnthropic = options.input.backendProfile.id
    === NATIVE_ANTHROPIC_PROFILE_ID;
  const launchCredentials = launchCredentialValues(claudeRunEnvironment(options.environment));
  const routeFailure = (error: string): string =>
    claudeRouteFailureMessage(usesNativeAnthropic, error, options.input.backendProfile);
  const routeDetail = (rawError: string, detail: string | null): string | null =>
    claudeRouteFailureDetail({
      usesNativeAnthropic, rawError, message: routeFailure(rawError), detail,
      launchCredentials, workspaceRoot: options.input.cwd,
    });
  const messageProjector = new ClaudeMessageProjector({
    emitter,
    text,
    usesNativeAnthropic,
    usage: new ClaudeUsageLedger(Boolean(options.input.sessionId) && options.nativeContinuation?.kind !== "new-session"),
    selectedModelId: options.input.modelSelection.modelId,
    contextWindowOverride:
      options.input.modelSelection.contextWindowOverride,
    contextUsage: () => latestContextUsage,
    acceptContextUsage: (usage) => {
      latestContextUsage = usage;
    },
    refreshContextUsage,
    checklistTasks: () => checklistTasks,
    configuredPromptCacheTtl: promptCacheTtl,
  });
  const providerResult = (async (): Promise<ProviderRunResult> => {
    let providerThrew = false;
    // Only a Claude Code that exits before its first message gets startup-exit guidance.
    let claudeAnswered = false;
    try {
      const continuationOptions = claudeNativeContinuationOptions(options.input.sessionId, options.nativeContinuation);
      if (options.nativeContinuation && options.input.operation) {
        throw new Error("A Claude continuation must be applied to a normal turn.");
      }
      const compactInstruction = options.input.operation?.instruction;
      const promptText = options.input.operation?.kind === "compact"
        ? `/compact${compactInstruction ? ` ${compactInstruction}` : ""}`
        : options.input.prompt;
      const initialImagePaths = options.input.imagePaths ?? [];
      const promptReservation = promptChannel.reserve(
        claudePromptReservationBytes(promptText, initialImagePaths.length > 0),
      );
      if (!promptReservation) return finishResult("cancelled");
      let prompt: SDKUserMessage;
      try {
        prompt = await claudePrompt(promptText, initialImagePaths, preparationAbortController.signal);
      } catch (error) {
        promptChannel.release(promptReservation);
        throw error;
      }
      prompt.uuid = randomUUID();
      delegateLifecycle.expectPrompt(prompt.uuid);
      if (!promptChannel.push(prompt, promptReservation)) {
        return finishResult("cancelled");
      }
      const identity = await prepareClaudeTurnIdentity({
        skills: options.input.skills ?? [],
        ...(options.input.customAgent ? { customAgent: options.input.customAgent } : {}),
        cwd: options.input.cwd,
        environment: options.environment,
        timeoutMs: CLAUDE_SKILL_FILESYSTEM_TIMEOUT_MS,
        signal: preparationAbortController.signal,
        filesystem: skillFilesystem,
      });
      stagedSkillPlugin = identity.skills;
      selectedSkillsVerified = !stagedSkillPlugin?.selectedSkillNames.length;
      query = createQuery({
        prompt: promptChannel,
        options: {
          abortController,
          cwd: options.input.cwd,
          env: claudeRunEnvironment(options.environment, options.input.readOnlyProfile),
          pathToClaudeCodeExecutable: options.executable,
          spawnClaudeCodeProcess: ownedProcess.spawnClaudeCodeProcess,
          includePartialMessages: true,
          ...(options.input.maxBudgetUsd !== undefined
            ? { maxBudgetUsd: options.input.maxBudgetUsd }
            : {}),
          // Claude Code omits thinking content by default, and in multi-step
          // turns Claude often narrates between tools inside thinking. With
          // it omitted, Inertia had nothing to show until the final answer.
          // Summaries stream through the reasoning channel. Only the display
          // flag is set, so each model keeps its own thinking mode, and only
          // on Claude Code versions verified to accept it.
          ...(usesNativeAnthropic
            && claudeSupportsThinkingDisplay(options.installationVersion)
            ? { extraArgs: { "thinking-display": "summarized" } }
            : {}),
          // Inertia owns the approval boundary. Loading filesystem settings
          // here would let a repository's .claude/settings.json install hooks
          // or allow rules that execute before canUseTool can ask the user.
          settingSources: [],
          ...claudeIdentityOptions(identity, options.input.systemInstruction, options.input.sessionInstruction),
          managedSettings: CLAUDE_ISOLATED_SKILL_SETTINGS,
          settings: launchSettings,
          permissionMode: claudeSdkPermissionMode(options.input),
          allowDangerouslySkipPermissions: options.input.access === "full",
          canUseTool: permissions.canUseTool,
          ...(launchRedaction ? { hooks: claudeCredentialCommandHooks() } : {}),
          ...(!options.providerNativeToolsAvailable ? { tools: [] } : {}),
          strictMcpConfig: true,
          ...(claudeHostTools
            ? { mcpServers: { [INERTIA_HOST_MCP_NAME]: claudeHostTools.config } }
            : {}),
          ...continuationOptions,
          ...(options.input.model ? { model: options.input.model } : {}),
          // Custom backends map effort through CLAUDE_CODE_EFFORT_LEVEL instead.
          ...(usesNativeAnthropic && claudeEffort(options.input.reasoningEffort)
            ? { effort: claudeEffort(options.input.reasoningEffort) } : {}),
        },
      });
      acceptingFollowUps = true;
      emitter.status("running");
      if (usesNativeAnthropic) {
        void emitClaudeModelMetadata(query, emitter.rich).catch(() => undefined);
      }
      const sdkIterator = query[Symbol.asyncIterator]();
      messageIterator = launchRedaction ? launchRedaction.iterator(sdkIterator) : sdkIterator;
      let terminalDrainDeadline: number | null = null;
      let retryBudgetDeadline: number | null = null;
      let parentResumedAfterProvisional = false;
      let announcedShortenedEvent = false;
      while (true) {
        const nextDeadline = terminalDrainDeadline === null
          ? retryBudgetDeadline
          : retryBudgetDeadline === null
            ? terminalDrainDeadline
            : Math.min(terminalDrainDeadline, retryBudgetDeadline);
        const next = await nextClaudeMessage(
          messageIterator,
          nextDeadline === null ? null : nextDeadline - now(),
          abortController.signal,
        );
        if (next === CLAUDE_MESSAGE_DRAIN_TIMEOUT) {
          if (
            retryBudgetDeadline !== null
            && (terminalDrainDeadline === null || retryBudgetDeadline <= terminalDrainDeadline)
          ) {
            emitter.activity("system", "failed", CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE);
            return finishResult(
              "failed",
              CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE,
              claudeFailure(CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE, "system/retry-budget-exceeded"),
            );
          }
          break;
        }
        if (next.done) break;
        claudeAnswered = true;
        // One legitimately large update is shortened for Inertia's view
        // instead of failing the turn (#338). Claude keeps the full content.
        const observed = eventBudget.observe(next.value);
        const message = observed.value as SDKMessage;
        if (isClaudeRetryMessage(message)) {
          retryBudgetDeadline ??= now() + retryBudgetMs;
          if (now() >= retryBudgetDeadline) {
            emitter.activity("system", "failed", CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE);
            return finishResult(
              "failed",
              CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE,
              claudeFailure(CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE, "system/retry-budget-exceeded"),
            );
          }
        } else if (isClaudeSubstantiveProgressMessage(message)) {
          retryBudgetDeadline = null;
        }
        sessionUnavailable ||= options.input.sessionId !== undefined && claudeSessionUnavailable(message);
        sessionNotFound ||= options.input.sessionId !== undefined && claudeSessionNotFound(message);
        if (observed.shortened && !announcedShortenedEvent) {
          announcedShortenedEvent = true;
          emitter.activity("system", "info", "Shortened a large Claude update", {
            detail: "An update was larger than Inertia's 1 MB event limit, so its longest fields are shortened here. Claude still has the full content and the turn continues.",
          });
        }
        const record = message as unknown as Record<string, unknown>;
        const childOwned = record.parent_tool_use_id !== null
          && record.parent_tool_use_id !== undefined;
        const messageSessionId = stringValue(record.session_id);
        if (message.type === "conversation_reset") {
          const replacement = message.new_conversation_id;
          if (childOwned || pendingSessionReset || !authoritativeSessionId
            || messageSessionId !== authoritativeSessionId
            || typeof replacement !== "string"
            || !isProviderTerminalSessionId(replacement)
            || options.input.operation) {
            throw new Error("Claude returned an invalid provider session reset.");
          }
        }
        const requiresSessionAttestation = !childOwned && (
          (message.type === "system" && message.subtype === "init")
          || message.type === "result"
        );
        if (requiresSessionAttestation && !messageSessionId) {
          throw new Error("Claude did not attest the requested provider session.");
        }
        if (!childOwned && messageSessionId) {
          const expectedSessionId = pendingSessionReset?.candidateId ?? authoritativeSessionId;
          const authorizedReset = pendingSessionReset !== undefined
            && isProviderTerminalSessionId(messageSessionId)
            && messageSessionId !== pendingSessionReset.outgoingId
            && (!pendingSessionReset.candidateId || messageSessionId === pendingSessionReset.candidateId);
          if (!authorizedReset && (pendingSessionReset
            || (expectedSessionId && messageSessionId !== expectedSessionId))) {
            const attestationFailure = requestedFastModeState === "on"
              ? "Claude did not confirm Fast mode because it did not attest the requested provider session."
              : requestedFastModeState === "off"
                ? "Claude did not confirm Standard speed because it did not attest the requested provider session."
                : options.input.operation?.kind === "compact"
                  ? "Claude did not confirm context compaction for the exact selected session because it did not attest the requested provider session."
                  : "Claude did not attest the requested provider session.";
            throw new Error(attestationFailure);
          }
          if (pendingSessionReset && !requiresSessionAttestation) {
            pendingSessionReset.candidateId = messageSessionId;
          } else {
            authoritativeSessionId = messageSessionId;
            pendingSessionReset = undefined;
          }
        }
        const initAttestsRequestedSession = !childOwned && messageSessionId !== undefined
          && messageSessionId === authoritativeSessionId;
        if (message.type === "system" && message.subtype === "init"
          && initAttestsRequestedSession) {
          emitter.nativeBoundary({ nativeConversationId: messageSessionId, nativeSessionId: messageSessionId,
            nativeTurnId: null, persistedHeadId: null, phase: "started" });
          if (requestedFastModeState === "on"
            && record.fast_mode_state !== requestedFastModeState
            && !(fastModeVerified && record.fast_mode_state === "cooldown")) {
            throw new Error(claudeFastModeFailure(record));
          }
          if (requestedFastModeState === "off"
            && record.fast_mode_state !== requestedFastModeState) {
            throw new Error("Claude did not confirm Standard speed for this session. Start a new chat or update Claude Code.");
          }
          if (requestedFastModeState !== null) {
            fastModeVerified = true;
            // `fast_mode_state` belongs to this exact attested session/init;
            // never infer negotiated support from the requested setting.
            emitter.capability("performance-modes", true);
          }
        }
        if (
          stagedSkillPlugin?.selectedSkillNames.length
          && message.type === "system"
          && message.subtype === "init"
        ) {
          if (!claudePluginLoadedSelectedSkills(message, stagedSkillPlugin)) {
            throw new Error("Claude did not load the selected isolated skills.");
          }
          selectedSkillsVerified = true;
        }
        const provesRequestedCompaction = options.input.operation?.kind === "compact"
          && messageSessionId === options.input.sessionId;
        if (
          !childOwned
          && !pendingSessionReset
          && typeof record.session_id === "string"
          && record.session_id !== sessionId
        ) {
          sessionId = record.session_id;
          checklistTasks = checklistSessions.tasks(sessionId);
          emitter.session(sessionId);
        }
        const hadLiveTaskTrace = subagentTracker.hasLiveTasks();
        if (claudeMessageResumesParent(message, prompt.uuid, pendingFollowUpIds)) {
          terminalDrainDeadline = null;
          if (delegateLifecycle.hasProvisionalResult()) parentResumedAfterProvisional = true;
        }
        if (message.type === "result") parentResumedAfterProvisional = false;
        const lifecycle = delegateLifecycle.observe(message, hadLiveTaskTrace);
        subagentTracker.observe(message);
        taskControls.releaseQueuedStops();
        const hasLiveTaskTrace = subagentTracker.hasLiveTasks();
        messageProjector.observe(message, provesRequestedCompaction);
        if (message.type === "conversation_reset") {
          pendingSessionReset = { outgoingId: authoritativeSessionId! };
          latestContextUsage = undefined;
          contextUsageGeneration += 1;
          fastModeVerified = requestedFastModeState === null;
        }
        const commandLifecycle = !childOwned ? claudeCommandLifecycleMessage(message) : null;
        if (commandLifecycle?.state === "started" && pendingFollowUpIds.has(commandLifecycle.command_uuid)) {
          const firstStart = !startedFollowUpIds.has(commandLifecycle.command_uuid);
          startedFollowUpIds.add(commandLifecycle.command_uuid);
          // Claude now answers this follow-up, and that answer's result ends the turn.
          heldResult = null;
          if (firstStart) {
            const steerId = followUpSteerIds.get(commandLifecycle.command_uuid);
            const onSteerRead = options.onSteerRead ?? options.callbacks?.onSteerRead ?? harnessOnSteerRead;
            if (steerId && onSteerRead) {
              try {
                onSteerRead(steerId, new Date().toISOString());
              } catch {
                // A steer-read observer must not interrupt provider execution.
              }
            }
          }
        }
        if (commandLifecycle && (commandLifecycle.state === "refused"
          || commandLifecycle.state === "cancelled" || commandLifecycle.state === "discarded")) {
          if (pendingFollowUpIds.has(commandLifecycle.command_uuid)) {
            const projectedFailure = messageProjector.preferredFailure();
            if (projectedFailure?.usageLimited || messageProjector.rateLimitRejected) {
              const error = `${routeFailure(projectedFailure?.usageLimited ? projectedFailure.message : "Claude reached an account rate limit.")} Your follow-up was not answered.`;
              return finishResult("failed", error, projectedFailure?.usageLimited
                ? { ...projectedFailure, message: error }
                : claudeFailure(error, `lifecycle/follow-up-${commandLifecycle.state}`));
            }
            if (startedFollowUpIds.has(commandLifecycle.command_uuid)) {
              throw new Error(`Claude ${commandLifecycle.state} an accepted follow-up before returning an answer.`);
            }
            // Claude removed the follow-up before reading it. It is not this
            // turn's input: the runtime sends it as the next turn (T3 `e8c4824b7`).
            pendingFollowUpIds.delete(commandLifecycle.command_uuid);
            droppedFollowUpIds.push(commandLifecycle.command_uuid);
            if (pendingFollowUpIds.size === 0 && heldResult?.turnEnded) {
              if (!hasLiveTaskTrace) break;
              terminalDrainDeadline ??= performance.now() + terminalSubagentDrainTimeoutMs;
            }
            continue;
          }
          if (commandLifecycle.command_uuid === prompt.uuid) break;
        }
        if (commandLifecycle?.state === "completed" && commandLifecycle.command_uuid === prompt.uuid && delegateLifecycle.awaitsUnansweredPrompt()) {
          terminalDrainDeadline ??= performance.now() + terminalSubagentDrainTimeoutMs;
        }
        if (message.type === "result" && lifecycle.turnEnded === false
          && delegateLifecycle.hasProvisionalResult()) {
          // A result emitted while delegated work is live is the parent's
          // pre-notification snapshot. Reset per-result output eligibility so
          // a later resumed result can provide the terminal text fallback.
          messageProjector.resetResultOutput();
        }
        if (!parentResumedAfterProvisional && delegateLifecycle.shouldBoundParentResumeWait(
          message,
          hadLiveTaskTrace,
          hasLiveTaskTrace,
        )) {
          // Once the provider says the roster is empty, or the exact typed
          // trace settles, the parent should auto-resume promptly. Bound a
          // missing resume edge without imposing a timeout on live long work.
          terminalDrainDeadline ??= performance.now() + terminalSubagentDrainTimeoutMs;
        }
        if (
          lifecycle.turnEnded
          && message.type !== "result"
          && pendingFollowUpIds.size === 0
          && !hasLiveTaskTrace
        ) break;
        if (
          lifecycle.turnEnded
          && pendingFollowUpIds.size === 0
          && hasLiveTaskTrace
        ) {
          terminalDrainDeadline ??= performance.now() + terminalSubagentDrainTimeoutMs;
        }
        if (message.type === "result") {
          if (!isClaudeQueuedCompletionAck(message)) heldResult = null;
          if (message.subtype === "success" && !message.is_error && pendingFollowUpIds.size > 0
            && !(isClaudeQueuedCompletionAck(message) && isClaudeNotificationResult(message))) {
            const userMessageIds = claudeResultUserMessageIds(record, pendingFollowUpIds);
            if (userMessageIds.length === 0) {
              if (isClaudeQueuedCompletionAck(message)) continue;
              throw new Error(
                "Claude returned a successful result without correlating an accepted follow-up.",
              );
            }
            for (const userMessageId of userMessageIds) {
              pendingFollowUpIds.delete(userMessageId);
            }
            if (pendingFollowUpIds.size > 0) {
              heldResult = { message, sawOutputText: messageProjector.sawOutputText, turnEnded: lifecycle.turnEnded };
              // Each streaming-input result ends one SDK user turn. Parent
              // snapshots from the next turn must not be suppressed by text
              // that was emitted before the admitted follow-up was handled.
              messageProjector.resetTurnOutput();
              emitter.textBoundary();
              continue;
            }
          } else if ((message.subtype !== "success" || message.is_error) && pendingFollowUpIds.size > 0) {
            for (const userMessageId of claudeResultUserMessageIds(record, pendingFollowUpIds)) {
              pendingFollowUpIds.delete(userMessageId);
            }
            if (pendingFollowUpIds.size > 0 && (message.queued_turn_count ?? 0) > 0) {
              const technicalDetail = claudeResultDetail(message, launchCredentials, options.input.cwd);
              emitter.activity("system", "failed", routeFailure(claudeResultFailure(claudeResultReason(message))), {
                activityId: message.uuid,
                ...(technicalDetail ? { detail: technicalDetail } : {}),
              });
              messageProjector.resetTurnOutput();
              terminalDrainDeadline ??= performance.now() + terminalSubagentDrainTimeoutMs;
              continue;
            }
          }
          if (lifecycle.turnEnded && !hasLiveTaskTrace) break;
          if (lifecycle.turnEnded) terminalDrainDeadline ??= performance.now() + terminalSubagentDrainTimeoutMs;
          continue;
        }
      }
      if (ownedProcess.transportError()) throw ownedProcess.transportError();
      if (pendingSessionReset) {
        throw new Error("Claude did not confirm the replacement provider session.");
      }
      if (!selectedSkillsVerified) {
        throw new Error("Claude did not confirm the selected isolated skills.");
      }
      if (cancelRequested) return finishResult("cancelled");
      if (options.input.operation?.kind === "compact"
        && (messageProjector.compactFailure
          || !messageProjector.compactSucceeded)) {
        const error = routeFailure(
          messageProjector.compactFailure
            ?? "Claude did not confirm that context compaction completed.",
        );
        return finishResult(
          "failed",
          error,
          claudeFailure(error, "system/compact_boundary"),
        );
      }
      if (!fastModeVerified) {
        throw new Error(
          requestedFastMode === "fast"
            ? "Claude did not confirm Fast mode for this session. Choose Standard, refresh models, or update Claude Code."
            : "Claude did not confirm Standard speed for this session. Start a new chat or update Claude Code.",
        );
      }
      const completion = delegateLifecycle.complete();
      if (completion.kind === "incomplete") {
        const projectedFailure = messageProjector.preferredFailure();
        const lifecycleError = projectedFailure?.message
          ?? claudeLifecycleFailure(completion.reason);
        const error = routeFailure(lifecycleError);
        // The stream ended without a thrown error, so this is the only place
        // the CLI's own reason for exiting can reach the failure details.
        const technicalDetail = routeDetail(lifecycleError, sanitizeProviderFailureDetail(
          ownedProcess.stderrTail(), launchCredentials,
          { workspaceRoot: options.input.cwd, maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS },
        ));
        return finishResult(
          "failed",
          error,
          projectedFailure
            ? {
                ...projectedFailure,
                message: error,
                ...(technicalDetail ? { technicalDetail } : {}),
              }
            : claudeFailure(
                error,
                `lifecycle/${completion.reason}`,
                technicalDetail ?? undefined,
              ),
        );
      }
      const finalMessage = completion.result;
      if (finalMessage.subtype !== "success" || finalMessage.is_error) {
        const startupFailure = claudeStartupFailure(finalMessage);
        const resultReason = claudeResultReason(finalMessage);
        const technicalDetail = claudeResultDetail(finalMessage, launchCredentials, options.input.cwd);
        const projectedFailure = messageProjector.preferredFailure();
        const resultError = routeFailure(
          projectedFailure?.message
            ?? startupFailure?.message
            ?? claudeResultFailure(resultReason),
        );
        const error = pendingFollowUpIds.size > 0
          ? `${resultError} Your follow-up was not answered.`
          : resultError;
        return finishResult(
          "failed",
          error,
          projectedFailure
            ? {
                ...projectedFailure,
                message: error,
                ...(technicalDetail ? { technicalDetail } : {}),
              }
            : claudeFailure(
                error,
                `result/${resultReason}`,
                technicalDetail ?? undefined,
              ),
        );
      }
      // A follow-up Claude started but never answered is lost to this turn. One
      // it never started stays unread, and the runtime sends it as the next
      // turn (T3: a steer whose process exited stays pending).
      if ([...pendingFollowUpIds].some((id) => startedFollowUpIds.has(id))) {
        throw new Error(
          "Claude Agent SDK exited before correlating every accepted follow-up.",
        );
      }
      // A held result already streamed its answer before the follow-up reset.
      const sawOutputText = messageProjector.sawOutputText
        || (heldResult?.message === finalMessage && heldResult.sawOutputText);
      if (isClaudeUnansweredPromptResult(finalMessage, sawOutputText, options.input.operation?.kind === "compact", promptText)) {
        const error = routeFailure(claudeLifecycleFailure("prompt-unanswered"));
        return finishResult("failed", error, claudeFailure(error, "result/unanswered"));
      }
      if (!sawOutputText && typeof finalMessage.result === "string") {
        messageProjector.emitTerminalText(finalMessage.result, finalMessage.uuid);
      }
      return finishResult(
        "completed",
        undefined,
        undefined,
        messageProjector.hadSupersession
          ? messageProjector.authoritativeText()
          : undefined,
      );
    } catch (error) {
      providerThrew = true;
      if (cancelRequested || abortController.signal.aborted) return finishResult("cancelled");
      const transportError = ownedProcess.transportError();
      const startupExit = claudeAnswered || transportError
        ? undefined
        : claudeStartupExitMessage(error, ownedProcess.stderrTail());
      const rawError = redactLaunchText(claudeReadableRuntimeError(
        startupExit ?? safeError(transportError ?? error, "Claude Agent SDK stopped unexpectedly."),
      ));
      const message = routeFailure(rawError);
      const technicalDetail = routeDetail(rawError, sanitizeProviderFailureDetail(
        ownedProcess.stderrTail(), launchCredentials,
        { workspaceRoot: options.input.cwd, maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS },
      ));
      return finishResult("failed", message, {
        ...claudeRuntimeFailure(rawError, message),
        ...(technicalDetail ? { technicalDetail } : {}),
      });
    } finally {
      acceptingFollowUps = false;
      hostToolRuntime?.settle();
      try {
        await claudeHostTools?.close();
      } catch {
        hostToolsCleanupFailed = true;
      }
      const naturalClose = !providerThrew
        && !cancelRequested
        && !abortController.signal.aborted
        && !ownedProcess.transportError()
        && providerNaturalCloseFirst();
      // Start the owned shutdown while the SDK child is still an owned live
      // process. The public result below awaits this same memoized attempt
      // after protocol streams and selected-skill resources are closed.
      if (!naturalClose) ownedProcess.requestTermination(true);
      // No consumer survives terminal query cleanup. Discard any admitted
      // input so retained base64 media and its reservations are released.
      promptChannel.cancel();
      permissions.cancelPending();
      delegateLifecycle.dispose();
      try { query?.close(); } catch { /* The SDK process may already be closed. */ }
      if (naturalClose) {
        await ownedProcess.waitForNaturalClose(PROVIDER_NATURAL_CLOSE_MS);
        ownedProcess.requestTermination(true);
      }
      if (messageIterator?.return) {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, terminalSubagentDrainTimeoutMs);
            timer.unref();
          });
          await Promise.race([
            messageIterator.return(),
            timeout,
          ]);
        } catch {
          // Closing an already-exited SDK iterator is best-effort.
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
  })();

  const result = providerResult.then(async (outcome): Promise<ProviderRunResult> => {
    let terminal = outcome;
    try {
      // The SDK has delivered its terminal protocol result and the finally
      // block above has closed its streams. No useful graceful window remains.
      await ownedProcess.terminate(true);
    } catch {
      terminal = { ...outcome, cleanupConfirmed: false };
    }
    const wireError = ownedProcess.transportError();
    if (wireError && outcome.status !== "cancelled") {
      const wireDetail = redactLaunchText(wireError.message);
      const error = routeFailure(wireDetail);
      terminal = { ...terminal, status: "failed", error,
        failure: claudeRuntimeFailure(wireDetail, error) };
    }
    try {
      await stagedSkillPlugin?.cleanup();
    } catch {
      terminal = {
        ...terminal,
        status: "failed",
        error: "Claude selected-skill staging could not be cleaned up.",
      };
    }
    if (hostToolsCleanupFailed) {
      terminal = {
        ...terminal,
        status: "failed",
        error: "Claude Inertia chat tools could not be cleaned up.",
        cleanupConfirmed: false,
      };
    }
    const child = ownedProcess.child();
    // An older Claude Code finds a transcript only in the cwd's project folder; say when the session is still stored.
    const storedElsewhere = sessionNotFound && terminal.failure && options.input.sessionId !== undefined
      && await claudeSessionStoredElsewhere(options.input.sessionId, options.input.cwd, options.environment);
    terminal = {
      ...terminal,
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
      ...(sessionUnavailable && terminal.failure ? { failure: { ...terminal.failure, sessionUnavailable: true as const,
        ...(storedElsewhere ? { sessionStoredElsewhere: true as const } : {}) } } : {}),
    };
    if (terminal.cleanupConfirmed && authoritativeSessionId && terminal.sessionId === authoritativeSessionId) {
      const head = await readClaudePersistedNativeHead(authoritativeSessionId, options.input.cwd, options.environment);
      emitter.nativeBoundary({ nativeConversationId: authoritativeSessionId, nativeSessionId: authoritativeSessionId,
        nativeTurnId: head, persistedHeadId: head, phase: "settled" });
    }
    emitter.status(terminal.status, terminal.error);
    const unconfirmedCleanup = !terminal.cleanupConfirmed && !hostToolsCleanupFailed && child
      ? providerUnconfirmedCleanup(child)
      : undefined;
    return {
      ...terminal,
      ...providerRunTerminal(options.input, terminal.status, terminal.failure),
      ...unconfirmedCleanup,
    };
  });

  function finishResult(
    status: ProviderRunResult["status"],
    error?: string,
    failure?: ProviderRunFailure,
    textOverride?: string,
  ): ProviderRunResult {
    const resultText = textOverride === undefined
      ? text.toString()
      : clipCodeUnits(textOverride, MAX_RESULT_TEXT_CHARS);
    const settledFailure = failure && status === "failed" && messageProjector.rateLimitRejected
      ? { ...failure, usageLimited: true as const }
      : failure;
    // Stop drops unread follow-ups; every other ending hands them back.
    const unreadFollowUps = status === "cancelled" ? [] : [
      ...droppedFollowUpIds,
      ...[...pendingFollowUpIds].filter((id) => !startedFollowUpIds.has(id)),
    ].flatMap((id) => followUpSteerIds.get(id) ?? []);
    return {
      ...providerRunTerminal(options.input, status, settledFailure),
      ...(sessionId ? { sessionId } : {}),
      text: resultText,
      textTruncated: textOverride === undefined
        ? text.truncated
        : textOverride.length > MAX_RESULT_TEXT_CHARS,
      exitCode: null,
      signal: null,
      cleanupConfirmed: true,
      ...(error ? { error } : {}),
      ...(settledFailure ? { failure: settledFailure } : {}),
      ...(unreadFollowUps.length > 0 ? { unreadFollowUps } : {}),
    };
  }

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
    hostToolRuntime?.settle();
    preparationAbortController.abort(
      new Error("Claude input preparation was cancelled."),
    );
    acceptingFollowUps = false;
    promptChannel.cancel();
    emitter.status("cancelling");
    permissions.cancelPending();
    if (force) {
      ownedProcess.requestTermination(true);
      abortController.abort();
      try { query?.close(); } catch { /* Best-effort force close. */ }
      return;
    }
    const runningQuery = query;
    if (!runningQuery) return;
    void runningQuery.interrupt().then((receipt) => {
      // The conservative local admission bit also covers SDK versions that do
      // not return every UUID which may already have crossed into dispatch.
      const queuedInputMaySurvive = acceptedFollowUp
        || Boolean(receipt?.still_queued.length);
      if (!queuedInputMaySurvive) return;
      // The SDK explicitly reports these messages WILL run after interrupt.
      // Close this per-turn Query rather than allowing a stopped run to drain
      // queued input, potentially with full-access tool permissions.
      abortController.abort();
      try { runningQuery.close(); } catch { /* Best-effort queued-input stop. */ }
    }).catch(() => abortController.abort());
  };

  return {
    harnessId: "claude-agent-sdk",
    providerId: "claude",
    result,
    cancel,
    extension: {
      kind: "claude-agent-sdk",
      respondToApproval: (requestId, decision) =>
        hostToolRuntime?.respondToApproval(requestId, decision)
        || permissions.settleApproval(requestId, decision),
      respondToInput: (requestId, answers) => permissions.settleInput(requestId, answers),
      steer: async (input) => {
        const text = normalizedClaudeFollowUp(input.content);
        if (!text || !acceptingFollowUps || cancelRequested) return false;
        const reservation = promptChannel.reserve(
          claudePromptReservationBytes(text, input.imagePaths.length > 0),
        );
        if (!reservation) return false;
        let followUp: SDKUserMessage;
        try {
          followUp = await claudePrompt(text, input.imagePaths, preparationAbortController.signal);
        } catch (error) {
          promptChannel.release(reservation);
          throw error;
        }
        if (!acceptingFollowUps || cancelRequested) {
          promptChannel.release(reservation);
          return false;
        }
        followUp.uuid = randomUUID();
        // "now" makes Claude Code cancel the tool calls in flight (T3 `e8c4824b7`).
        followUp.priority = "next";
        pendingFollowUpIds.add(followUp.uuid);
        if (input.steerId) followUpSteerIds.set(followUp.uuid, input.steerId);
        const accepted = promptChannel.push(followUp, reservation);
        if (accepted) {
          acceptedFollowUp = true;
        } else {
          pendingFollowUpIds.delete(followUp.uuid);
          followUpSteerIds.delete(followUp.uuid);
        }
        return accepted;
      },
      stopSubagent: taskControls.stop,
      backgroundSubagent: taskControls.background,
    },
  };
}
