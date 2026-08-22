import { randomUUID } from "node:crypto";

import {
  query as claudeQuery,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { NATIVE_ANTHROPIC_PROFILE_ID } from "../../shared/claude-backend-profiles";
import type { ProviderModel, ProviderRateLimit } from "../../shared/contracts";
import {
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  sanitizeProviderActivityDetail,
} from "./activity-detail";
import { isSafeApprovalDisplayText } from "./approval-display";
import {
  createClaudeOwnedQueryProcess,
  type ClaudeOwnedQueryDependencies,
} from "./claude-owned-query";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { ClaudeRunEventBudget } from "./claude-event-budget";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type ClaudeAgentSdkHarnessCapabilities,
} from "./agent-harness";
import type { ProviderRunFailure, ProviderRunResult } from "./contracts";
import type { AgentApprovalDecision, AgentPlanStep } from "./interactions";
import { providerFailureMessage } from "./adapters";
import { ClaudeDelegateLifecycle } from "./claude-delegate-lifecycle";
import { ClaudeMessageProjector } from "./claude-message-projector";
import { ClaudePromptChannel } from "./claude-prompt-channel";
import { claudeQuestions } from "./claude-questions";
import {
  claudePrompt,
  claudePromptReservationBytes,
  normalizedClaudeFollowUp,
} from "./claude-prompt";
import {
  CLAUDE_ISOLATED_SKILL_SETTINGS,
  claudePluginLoadedSelectedSkills,
  stageClaudeSkillPlugin,
} from "./claude-skill-plugin";
import {
  createClaudeSkillDeadline,
  raceClaudeSkillStaging,
  type ClaudeSkillFilesystemTestSeam,
} from "./claude-skill-operation";
import type { ClaudeQueryFactory } from "./claude-skill-query";
import { ClaudeSubagentTraceTracker } from "./claude-subagent-trace";
import {
  readClaudeContextUsage,
} from "./claude-usage";
import { clampProviderPercent, providerTimestamp } from "./usage-values";
import { createClaudeHostTools } from "./claude-host-tools";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import { INERTIA_HOST_MCP_NAME } from "./host-tool-mcp-config";

const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_RUN_EVENTS = 8_192;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_INTERACTIONS = 64;
const CLAUDE_STOP_TASK_TIMEOUT_MS = 2_000;
const MIN_CLAUDE_STOP_TASK_TIMEOUT_MS = 25;
const CLAUDE_TERMINAL_SUBAGENT_DRAIN_TIMEOUT_MS = 2_000;
const MIN_CLAUDE_TERMINAL_SUBAGENT_DRAIN_TIMEOUT_MS = 25;
const CLAUDE_SKILL_FILESYSTEM_TIMEOUT_MS = 6_000;
const CLAUDE_MESSAGE_DRAIN_TIMEOUT = Symbol("claude-message-drain-timeout");

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
  skillFilesystem?: ClaudeSkillFilesystemTestSeam;
}

export { readClaudeAgentSdkSkills } from "./claude-skill-query";
export { claudeQuestions } from "./claude-questions";

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

async function nextClaudeMessage(
  iterator: AsyncIterator<SDKMessage>,
  timeoutMs: number | null,
): Promise<IteratorResult<SDKMessage> | typeof CLAUDE_MESSAGE_DRAIN_TIMEOUT> {
  if (timeoutMs === null) return await iterator.next();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof CLAUDE_MESSAGE_DRAIN_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CLAUDE_MESSAGE_DRAIN_TIMEOUT), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function claudeModels(models: Awaited<ReturnType<Query["supportedModels"]>>): ProviderModel[] {
  return models.slice(0, 64).map((model, index) => {
    const efforts = model.supportedEffortLevels ?? [];
    return {
      id: model.value,
      label: model.displayName || model.value,
      description: model.description || "Claude model",
      isDefault: index === 0,
      inputModalities: ["text", "image"],
      reasoningOptions: efforts.map((effort) => ({
        value: effort,
        label: effort === "xhigh" ? "Extra high" : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`,
        description: `${effort === "xhigh" ? "Extra-high" : effort} reasoning effort`,
      })),
      defaultReasoningEffort: efforts.includes("high") ? "high" : efforts[0] ?? "",
      fastMode: model.supportsFastMode === true
        ? {
            providerValue: "fast",
            label: "Fast",
            description: "Faster output with premium usage.",
            isDefault: false,
          }
        : null,
    };
  });
}

function claudeFastModeFailure(record: Record<string, unknown>): string {
  const reason = stringValue(record.fast_mode_disabled_reason);
  const detail = reason === "model_not_allowed"
    ? "The selected Claude model does not allow Fast mode."
    : reason === "sdk_opt_in_required"
      ? "This Claude Agent SDK version did not accept the Fast mode opt-in."
      : reason === "extra_usage_disabled"
        ? "Fast mode requires extra usage to be enabled for this Claude account."
        : reason === "not_first_party"
          ? "Fast mode is unavailable through this Claude backend."
          : reason === "disabled_by_env"
            ? "Fast mode is disabled by the Claude environment."
            : reason === "free"
              ? "Fast mode is unavailable on this Claude account tier."
              : "Claude did not activate Fast mode for this session.";
  return `${detail} Choose Standard, refresh models, or update Claude Code.`;
}

export function parseClaudeRateLimits(value: unknown): ProviderRateLimit[] {
  const response = objectValue(value);
  if (response?.rate_limits_available !== true) return [];
  const limits = objectValue(response.rate_limits);
  if (!limits) return [];
  const windows: Array<{ key: string; label: string; minutes: number | null; value: unknown }> = [
    { key: "five_hour", label: "Claude · 5 hour", minutes: 300, value: limits.five_hour },
    { key: "seven_day", label: "Claude · 7 day", minutes: 10_080, value: limits.seven_day },
    { key: "seven_day_oauth_apps", label: "Claude apps · 7 day", minutes: 10_080, value: limits.seven_day_oauth_apps },
    { key: "seven_day_opus", label: "Claude Opus · 7 day", minutes: 10_080, value: limits.seven_day_opus },
    { key: "seven_day_sonnet", label: "Claude Sonnet · 7 day", minutes: 10_080, value: limits.seven_day_sonnet },
  ];
  const modelScoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
  modelScoped.slice(0, 8).forEach((entry, index) => {
    const model = objectValue(entry);
    windows.push({
      key: `model_${index}`,
      label: stringValue(model?.display_name) ?? `Claude model ${index + 1}`,
      minutes: 10_080,
      value: model,
    });
  });
  return windows.flatMap((window) => {
    const current = objectValue(window.value);
    const utilization = clampProviderPercent(current?.utilization);
    if (utilization === null) return [];
    return [{
      id: `claude:${window.key}`,
      label: window.label,
      usedPercent: utilization,
      remainingPercent: 100 - utilization,
      windowMinutes: window.minutes,
      resetsAt: providerTimestamp(current?.resets_at),
    }];
  }).slice(0, 12);
}

export async function readClaudeAgentSdkMetadata(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 6_000,
  createQuery: ClaudeQueryFactory = claudeQuery,
  fields: readonly ("models" | "rateLimits")[] = ["models", "rateLimits"],
  lifecycleDependencies: ClaudeOwnedQueryDependencies = {},
): Promise<{ models?: ProviderModel[]; rateLimits?: ProviderRateLimit[] }> {
  const abortController = new AbortController();
  const ownedProcess = createClaudeOwnedQueryProcess(
    "Claude metadata process tree",
    lifecycleDependencies,
  );
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  async function* dormantPrompt(): AsyncIterable<SDKUserMessage> {
    await hold;
    yield* [] as SDKUserMessage[];
  }
  let query: Query | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    query = createQuery({
      prompt: dormantPrompt(),
      options: {
        abortController,
        cwd,
        env: environment,
        pathToClaudeCodeExecutable: executable,
        spawnClaudeCodeProcess: ownedProcess.spawnClaudeCodeProcess,
        settingSources: [],
      },
    });
    const usageReader = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new Error("Claude metadata discovery timed out."));
      }, timeoutMs);
      timer.unref();
    });
    const [modelsResult, limitsResult] = await Promise.race([
      Promise.allSettled([
        fields.includes("models") ? query.supportedModels() : Promise.resolve(undefined),
        fields.includes("rateLimits") && typeof usageReader === "function"
          ? usageReader.call(query)
          : Promise.resolve(undefined),
      ]),
      timeout,
    ]);
    return {
      ...(modelsResult.status === "fulfilled" && modelsResult.value !== undefined ? { models: claudeModels(modelsResult.value) } : {}),
      ...(limitsResult.status === "fulfilled" && limitsResult.value !== undefined ? { rateLimits: parseClaudeRateLimits(limitsResult.value) } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    ownedProcess.requestTermination(true);
    release();
    abortController.abort();
    try { query?.close(); } catch { /* The metadata subprocess may already have exited. */ }
    await ownedProcess.terminate(true);
  }
}

export async function readClaudeAgentSdkModels(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 6_000,
  createQuery: ClaudeQueryFactory = claudeQuery,
  lifecycleDependencies: ClaudeOwnedQueryDependencies = {},
): Promise<ProviderModel[]> {
  return (await readClaudeAgentSdkMetadata(
    executable,
    environment,
    cwd,
    timeoutMs,
    createQuery,
    ["models"],
    lifecycleDependencies,
  )).models ?? [];
}

interface PendingApproval {
  resolve: (decision: AgentApprovalDecision) => void;
  settled: boolean;
}

interface PendingInput {
  resolve: (answers: Record<string, string[]>) => void;
  settled: boolean;
}

export function createClaudeAgentSdkHarness(options: ClaudeAgentSdkHarnessOptions = {}): AgentHarness {
  const stopTaskTimeoutMs = claudeStopTaskTimeout(
    options.stopTaskTimeoutMs,
  );
  const terminalSubagentDrainTimeoutMs = claudeTerminalSubagentDrainTimeout(
    options.terminalSubagentDrainTimeoutMs,
  );
  return {
    id: "claude-agent-sdk",
    providerId: "claude",
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    supports: (input) => input.providerId === "claude",
    start: (startOptions) => startClaudeRun(
      startOptions,
      options.createQuery ?? claudeQuery,
      options,
      stopTaskTimeoutMs,
      terminalSubagentDrainTimeoutMs,
      options.skillFilesystem,
    ),
  };
}

function startClaudeRun(
  options: AgentHarnessStartOptions,
  createQuery: ClaudeQueryFactory,
  lifecycleDependencies: ClaudeOwnedQueryDependencies,
  stopTaskTimeoutMs: number,
  terminalSubagentDrainTimeoutMs: number,
  skillFilesystem: ClaudeSkillFilesystemTestSeam | undefined,
): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter(
    "claude",
    conversationId,
    options.callbacks,
    options.input.runId ?? conversationId,
    options.input.turnId ?? null,
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
  const approvals = new Map<string, PendingApproval>();
  const inputs = new Map<string, PendingInput>();
  const abortController = new AbortController();
  const skillAbortController = new AbortController();
  const delegateLifecycle = new ClaudeDelegateLifecycle();
  const promptChannel = new ClaudePromptChannel();
  const subagentTracker = new ClaudeSubagentTraceTracker(emitter.subagent);
  let query: Query | undefined;
  let messageIterator: AsyncIterator<SDKMessage> | undefined;
  let cancelRequested = false;
  let acceptingFollowUps = false;
  let acceptedFollowUp = false;
  const pendingFollowUpIds = new Set<string>();
  let sessionId = options.input.sessionId;
  let authoritativeSessionId = options.input.sessionId;
  let latestContextUsage: unknown;
  let contextUsageRequest: Promise<void> | null = null;
  let stagedSkillPlugin: Awaited<ReturnType<
    typeof stageClaudeSkillPlugin
  >> = null;
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
    contextUsageRequest = readClaudeContextUsage(query)
      .then((usage) => {
        if (usage) latestContextUsage = usage;
      })
      .finally(() => {
        contextUsageRequest = null;
      });
  };

  const settleApproval = (requestId: string, decision: AgentApprovalDecision): boolean => {
    const pending = approvals.get(requestId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    approvals.delete(requestId);
    emitter.rich({ type: "approval-resolved", requestId, decision });
    pending.resolve(decision);
    return true;
  };
  const settleInput = (requestId: string, answers: Record<string, string[]>): boolean => {
    const pending = inputs.get(requestId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    inputs.delete(requestId);
    emitter.rich({ type: "input-resolved", requestId });
    pending.resolve(answers);
    return true;
  };
  const cancelPending = (): void => {
    for (const requestId of approvals.keys()) settleApproval(requestId, "cancel");
    for (const [requestId, pending] of inputs) {
      pending.settled = true;
      inputs.delete(requestId);
      emitter.rich({ type: "input-resolved", requestId });
      pending.resolve({});
    }
  };

  const canUseTool: CanUseTool = async (toolName, toolInput, callbackOptions) => {
    if (callbackOptions.signal.aborted || cancelRequested) return deny("User cancelled the request.", true);
    if (claudeHostTools?.providerToolNames.has(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    if (toolName === "AskUserQuestion") {
      if (inputs.size >= MAX_PENDING_INTERACTIONS) {
        return deny("Claude exceeded the bounded question budget.", true);
      }
      const requestId = randomUUID();
      const request = claudeQuestions(requestId, callbackOptions.toolUseID, toolInput);
      if (request.questions.length === 0) return deny("Claude sent an invalid question request.");
      const answers = await new Promise<Record<string, string[]>>((resolve) => {
        inputs.set(requestId, { resolve, settled: false });
        callbackOptions.signal.addEventListener("abort", () => settleInput(requestId, {}), { once: true });
        emitter.rich({ type: "input", request });
      });
      if (callbackOptions.signal.aborted || cancelRequested) return deny("User cancelled the request.", true);
      const sdkAnswers: Record<string, string> = {};
      for (const question of request.questions) {
        const labelsById = new Map(question.options.map((option) => [option.id, option.label]));
        const values = (answers[question.id] ?? []).map((value) => labelsById.get(value) ?? value);
        sdkAnswers[question.question] = values.join(", ");
      }
      return { behavior: "allow", updatedInput: { questions: toolInput.questions, answers: sdkAnswers } };
    }

    if (toolName === "ExitPlanMode") {
      const plan = stringValue(toolInput.plan) ?? stringValue(toolInput.content);
      if (plan) emitter.rich({ type: "plan", explanation: plan, steps: planSteps(plan) });
      return deny("The proposed plan was returned to the user for review.");
    }

    if (options.input.access === "full") {
      return { behavior: "allow", updatedInput: toolInput };
    }
    const approvalTitle = callbackOptions.title
      ?? `Claude wants to use ${toolName}`;
    const approvalDetail = callbackOptions.description
      ?? summarizeInput(toolInput);
    const approvalCommand = toolName === "Bash"
      && typeof toolInput.command === "string"
      ? toolInput.command
      : undefined;
    const approvalReason = callbackOptions.decisionReason;
    const approvalBlockedPath = callbackOptions.blockedPath;
    if (
      !isSafeApprovalDisplayText(approvalTitle)
      || !isSafeApprovalDisplayText(approvalDetail, true)
      || (
        approvalCommand !== undefined
        && !isSafeApprovalDisplayText(approvalCommand, true)
      )
      || (
        approvalReason !== undefined
        && !isSafeApprovalDisplayText(approvalReason, true)
      )
      || (
        approvalBlockedPath !== undefined
        && !isSafeApprovalDisplayText(approvalBlockedPath)
      )
    ) {
      return deny("Claude sent unsafe permission display text.");
    }

    if (approvals.size >= MAX_PENDING_INTERACTIONS) {
      return deny("Claude exceeded the bounded approval budget.", true);
    }
    const requestId = randomUUID();
    const decision = await new Promise<AgentApprovalDecision>((resolve) => {
      approvals.set(requestId, { resolve, settled: false });
      callbackOptions.signal.addEventListener("abort", () => settleApproval(requestId, "cancel"), { once: true });
      emitter.rich({
        type: "approval",
        request: {
          requestId,
          kind: toolName === "Bash" ? "command" : /edit|write|notebook/iu.test(toolName) ? "file-change" : "permissions",
          title: bounded(approvalTitle),
          detail: bounded(approvalDetail),
          ...(approvalCommand !== undefined
            ? { command: bounded(approvalCommand) }
            : {}),
          cwd: options.input.cwd,
          ...(approvalReason ? { reason: bounded(approvalReason) } : {}),
          permissionRoots: approvalBlockedPath
            ? [{ path: bounded(approvalBlockedPath), access: "write" }]
            : [],
          availableDecisions: ["approve", "deny", "cancel"],
        },
      });
    });
    if (callbackOptions.signal.aborted || cancelRequested) {
      return deny("User cancelled the request.", true);
    }
    if (decision === "approve") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
      } satisfies PermissionResult;
    }
    return deny(decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.", decision === "cancel");
  };

  emitter.status("starting");
  const usesNativeAnthropic = options.input.backendProfile.id
    === NATIVE_ANTHROPIC_PROFILE_ID;
  const routeFailure = (error: string): string => usesNativeAnthropic
    ? error
    : providerFailureMessage(
        "claude",
        undefined,
        error,
        "",
        options.input.backendProfile,
      );
  const messageProjector = new ClaudeMessageProjector({
    emitter,
    text,
    usesNativeAnthropic,
    selectedModelId: options.input.modelSelection.modelId,
    contextWindowOverride:
      options.input.modelSelection.contextWindowOverride,
    contextUsage: () => latestContextUsage,
    acceptContextUsage: (usage) => {
      latestContextUsage = usage;
    },
    refreshContextUsage,
  });
  const providerResult = (async (): Promise<ProviderRunResult> => {
    try {
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
        prompt = await claudePrompt(promptText, initialImagePaths);
      } catch (error) {
        promptChannel.release(promptReservation);
        throw error;
      }
      prompt.uuid = randomUUID();
      if (!promptChannel.push(prompt, promptReservation)) {
        return finishResult("cancelled");
      }
      const selectedClaudeSkills = (options.input.skills ?? []).filter(
        (skill) => skill.source === "claude-native",
      );
      const skillDeadline = createClaudeSkillDeadline(
        CLAUDE_SKILL_FILESYSTEM_TIMEOUT_MS,
        "Claude selected-skill staging timed out.",
        skillAbortController.signal,
      );
      const staging = stageClaudeSkillPlugin(
        selectedClaudeSkills,
        options.input.cwd,
        options.environment,
        { ...skillFilesystem, signal: skillDeadline.signal },
      );
      try {
        stagedSkillPlugin = await raceClaudeSkillStaging(
          staging,
          skillDeadline.signal,
        );
      } finally {
        skillDeadline.dispose();
      }
      selectedSkillsVerified = stagedSkillPlugin === null;
      query = createQuery({
        prompt: promptChannel,
        options: {
          abortController,
          cwd: options.input.cwd,
          env: options.environment,
          pathToClaudeCodeExecutable: options.executable,
          spawnClaudeCodeProcess: ownedProcess.spawnClaudeCodeProcess,
          includePartialMessages: true,
          // Inertia owns the approval boundary. Loading filesystem settings
          // here would let a repository's .claude/settings.json install hooks
          // or allow rules that execute before canUseTool can ask the user.
          settingSources: [],
          managedSettings: CLAUDE_ISOLATED_SKILL_SETTINGS,
          ...(supportsFastMode
            ? {
                settings: {
                  fastMode: requestedFastMode === "fast",
                  fastModePerSessionOptIn: true,
                },
              }
            : {}),
          permissionMode: options.input.interactionMode === "plan"
            ? "plan"
            : options.input.access === "full"
              ? "bypassPermissions"
              : options.input.access === "auto-edit"
                ? "acceptEdits"
                : "default",
          allowDangerouslySkipPermissions: options.input.access === "full",
          canUseTool,
          ...(claudeHostTools
            ? {
                mcpServers: { [INERTIA_HOST_MCP_NAME]: claudeHostTools.config },
                strictMcpConfig: true,
              }
            : {}),
          ...(options.input.sessionId ? { resume: options.input.sessionId } : {}),
          ...(options.input.model ? { model: options.input.model } : {}),
          ...(claudeEffort(options.input.reasoningEffort) ? { effort: claudeEffort(options.input.reasoningEffort) } : {}),
          ...(stagedSkillPlugin
            ? {
                plugins: [{
                  type: "local" as const,
                  path: stagedSkillPlugin.path,
                  skipMcpDiscovery: true,
                }],
                skills: stagedSkillPlugin.skillNames,
              }
            : {}),
        },
      });
      if (usesNativeAnthropic) {
        await emitClaudeModelMetadata(query, emitter.rich);
      }
      acceptingFollowUps = true;
      emitter.status("running");
      messageIterator = query[Symbol.asyncIterator]();
      let drainTerminalSubagents = false;
      while (true) {
        const next = await nextClaudeMessage(
          messageIterator,
          drainTerminalSubagents ? terminalSubagentDrainTimeoutMs : null,
        );
        if (next === CLAUDE_MESSAGE_DRAIN_TIMEOUT || next.done) break;
        const message = next.value;
        drainTerminalSubagents = false;
        eventBudget.observe(message);
        const record = message as unknown as Record<string, unknown>;
        const childOwned = record.parent_tool_use_id !== null
          && record.parent_tool_use_id !== undefined;
        const messageSessionId = stringValue(record.session_id);
        const requiresSessionAttestation = !childOwned && (
          (message.type === "system" && message.subtype === "init")
          || message.type === "result"
        );
        if (requiresSessionAttestation && !messageSessionId) {
          throw new Error("Claude did not attest the requested provider session.");
        }
        if (!childOwned && messageSessionId) {
          if (authoritativeSessionId && messageSessionId !== authoritativeSessionId) {
            const attestationFailure = requestedFastModeState === "on"
              ? "Claude did not confirm Fast mode because it did not attest the requested provider session."
              : requestedFastModeState === "off"
                ? "Claude did not confirm Standard speed because it did not attest the requested provider session."
                : options.input.operation?.kind === "compact"
                  ? "Claude did not confirm context compaction for the exact selected session because it did not attest the requested provider session."
                  : "Claude did not attest the requested provider session.";
            throw new Error(attestationFailure);
          }
          authoritativeSessionId = messageSessionId;
        }
        const initAttestsRequestedSession = messageSessionId !== undefined
          && (options.input.sessionId === undefined
            || messageSessionId === options.input.sessionId);
        if (message.type === "system" && message.subtype === "init"
          && initAttestsRequestedSession) {
          if (requestedFastModeState === "on"
            && record.fast_mode_state !== requestedFastModeState) {
            throw new Error(claudeFastModeFailure(record));
          }
          if (requestedFastModeState === "off"
            && record.fast_mode_state !== requestedFastModeState) {
            throw new Error("Claude did not confirm Standard speed for this session. Start a new chat or update Claude Code.");
          }
          if (requestedFastModeState !== null) fastModeVerified = true;
        }
        if (
          stagedSkillPlugin
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
          && typeof record.session_id === "string"
          && record.session_id !== sessionId
        ) {
          sessionId = record.session_id;
          emitter.session(sessionId);
        }
        const lifecycle = delegateLifecycle.observe(message);
        subagentTracker.observe(message);
        messageProjector.observe(message, provesRequestedCompaction);
        if (
          lifecycle.turnEnded
          && message.type !== "result"
          && pendingFollowUpIds.size === 0
          && !subagentTracker.hasLiveTasks()
        ) break;
        if (
          lifecycle.turnEnded
          && pendingFollowUpIds.size === 0
          && subagentTracker.hasLiveTasks()
        ) {
          drainTerminalSubagents = true;
        }
        if (message.type === "result") {
          if (message.subtype === "success" && pendingFollowUpIds.size > 0) {
            const userMessageId = stringValue(record.user_message_uuid);
            if (!userMessageId) {
              throw new Error(
                "Claude returned a successful result without correlating an accepted follow-up.",
              );
            }
            pendingFollowUpIds.delete(userMessageId);
            if (pendingFollowUpIds.size > 0) {
              // Each streaming-input result ends one SDK user turn. Parent
              // snapshots from the next turn must not be suppressed by text
              // that was emitted before the admitted follow-up was handled.
              messageProjector.resetTurnOutput();
              continue;
            }
          }
          if (lifecycle.turnEnded && !subagentTracker.hasLiveTasks()) break;
          if (lifecycle.turnEnded) drainTerminalSubagents = true;
          continue;
        }
      }
      if (!selectedSkillsVerified) {
        throw new Error("Claude did not confirm the selected isolated skills.");
      }
      if (cancelRequested) return finishResult("cancelled");
      if (pendingFollowUpIds.size > 0) {
        throw new Error(
          "Claude Agent SDK exited before correlating every accepted follow-up.",
        );
      }
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
        const error = routeFailure(
          projectedFailure?.message
            ?? claudeLifecycleFailure(completion.reason),
        );
        return finishResult(
          "failed",
          error,
          projectedFailure
            ? { ...projectedFailure, message: error }
            : claudeFailure(error, `lifecycle/${completion.reason}`),
        );
      }
      const finalMessage = completion.result;
      if (finalMessage.subtype !== "success") {
        const technicalDetail = sanitizeProviderActivityDetail(
          finalMessage.errors
            .filter((value): value is string => typeof value === "string")
            .join("\n"),
          {
            workspaceRoot: options.input.cwd,
            maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS,
          },
        );
        const projectedFailure = messageProjector.preferredFailure();
        const error = routeFailure(
          projectedFailure?.message
            ?? claudeResultFailure(finalMessage.subtype),
        );
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
                `result/${finalMessage.subtype}`,
                technicalDetail ?? undefined,
              ),
        );
      }
      if (!messageProjector.sawOutputText && typeof finalMessage.result === "string") {
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
      if (cancelRequested || abortController.signal.aborted) return finishResult("cancelled");
      const rawError = safeError(error, "Claude Agent SDK stopped unexpectedly.");
      const message = routeFailure(rawError);
      return finishResult(
        "failed",
        message,
        claudeRuntimeFailure(rawError, message),
      );
    } finally {
      acceptingFollowUps = false;
      hostToolRuntime?.settle();
      try {
        await claudeHostTools?.close();
      } catch {
        hostToolsCleanupFailed = true;
      }
      // Start the owned shutdown while the SDK child is still an owned live
      // process. The public result below awaits this same memoized attempt
      // after protocol streams and selected-skill resources are closed.
      ownedProcess.requestTermination(true);
      // No consumer survives terminal query cleanup. Discard any admitted
      // input so retained base64 media and its reservations are released.
      promptChannel.cancel();
      cancelPending();
      delegateLifecycle.dispose();
      try { query?.close(); } catch { /* The SDK process may already be closed. */ }
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
      terminal = {
        ...outcome,
        status: "failed",
        error: "Claude Code process tree could not be confirmed stopped.",
        cleanupConfirmed: false,
      };
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
    terminal = {
      ...terminal,
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
    };
    emitter.status(terminal.status, terminal.error);
    return terminal;
  });

  function finishResult(
    status: ProviderRunResult["status"],
    error?: string,
    failure?: ProviderRunFailure,
    textOverride?: string,
  ): ProviderRunResult {
    const resultText = textOverride === undefined
      ? text.toString()
      : textOverride.slice(0, MAX_RESULT_TEXT_CHARS);
    return {
      providerId: "claude",
      conversationId,
      status,
      ...(sessionId ? { sessionId } : {}),
      text: resultText,
      textTruncated: textOverride === undefined
        ? text.truncated
        : textOverride.length > MAX_RESULT_TEXT_CHARS,
      exitCode: null,
      signal: null,
      cleanupConfirmed: true,
      ...(error ? { error } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
    hostToolRuntime?.settle();
    skillAbortController.abort(
      new Error("Claude selected-skill staging was cancelled."),
    );
    acceptingFollowUps = false;
    promptChannel.cancel();
    emitter.status("cancelling");
    cancelPending();
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
        || settleApproval(requestId, decision),
      respondToInput: settleInput,
      steer: async (input) => {
        const text = normalizedClaudeFollowUp(input.content);
        if (!text || !acceptingFollowUps || cancelRequested) return false;
        const reservation = promptChannel.reserve(
          claudePromptReservationBytes(text, input.imagePaths.length > 0),
        );
        if (!reservation) return false;
        let followUp: SDKUserMessage;
        try {
          followUp = await claudePrompt(text, input.imagePaths);
        } catch (error) {
          promptChannel.release(reservation);
          throw error;
        }
        if (!acceptingFollowUps || cancelRequested) {
          promptChannel.release(reservation);
          return false;
        }
        followUp.uuid = randomUUID();
        pendingFollowUpIds.add(followUp.uuid);
        const accepted = promptChannel.push(followUp, reservation);
        if (accepted) {
          acceptedFollowUp = true;
        } else {
          pendingFollowUpIds.delete(followUp.uuid);
        }
        return accepted;
      },
      stopSubagent: async (providerTaskId) => {
        if (
          !query
          || cancelRequested
          || !subagentTracker.isLiveTask(providerTaskId)
        ) return false;
        let timer: NodeJS.Timeout | undefined;
        try {
          const deadline = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), stopTaskTimeoutMs);
            timer.unref();
          });
          return await Promise.race([
            query.stopTask(providerTaskId).then(
              () => true as const,
              () => false as const,
            ),
            deadline,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    },
  };
}

async function emitClaudeModelMetadata(
  query: Query,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2_000);
      timer.unref();
    });
    const models = await Promise.race([query.supportedModels().catch(() => undefined), timeout]);
    if (!models) return;
    const mapped = claudeModels(models);
    if (mapped.length > 0) emit({ type: "metadata", metadata: { models: mapped }, source: "provider", complete: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function planSteps(markdown: string): AgentPlanStep[] {
  const steps = markdown.split("\n").map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)/u)?.[1]?.trim()).filter((value): value is string => Boolean(value));
  return (steps.length > 0 ? steps : [markdown]).slice(0, 100).map((step) => ({ step: bounded(step), status: "pending" }));
}

function claudeLifecycleFailure(
  reason: "missing-result" | "delegates-abandoned" | "parent-not-resumed",
): string {
  switch (reason) {
    case "delegates-abandoned":
      return "Claude Agent SDK exited while delegated work was still running.";
    case "parent-not-resumed":
      return "Claude Agent SDK exited before the parent resumed after delegated work.";
    case "missing-result":
      return "Claude Agent SDK exited without a final result.";
  }
}

function claudeResultFailure(
  subtype: Exclude<
    Extract<SDKMessage, { type: "result" }>["subtype"],
    "success"
  >,
): string {
  switch (subtype) {
    case "error_during_execution":
      return "Claude could not complete the request.";
    case "error_max_turns":
      return "Claude reached the maximum number of agent turns.";
    case "error_max_budget_usd":
      return "Claude reached the configured spending limit.";
    case "error_max_structured_output_retries":
      return "Claude could not produce a valid structured response.";
  }
}

function claudeFailure(
  message: string,
  terminalEvent: string,
  technicalDetail?: string,
): ProviderRunFailure {
  return {
    reason: "provider-error",
    message,
    phase: "turn",
    terminalEvent,
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}

function claudeRuntimeFailure(
  rawError: string,
  message: string,
): ProviderRunFailure {
  const reason: ProviderRunFailure["reason"] = /oversized|(?:stream|text)-correlation|trace state|bounded(?: [\w-]+)* event rate/iu.test(rawError)
    ? "protocol-overflow"
    : /unserializable|malformed|non-canonical/iu.test(rawError)
      ? "malformed-protocol"
      : "provider-error";
  return {
    reason,
    message,
    phase: "runtime",
    terminalEvent: "sdk/exception",
  };
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

function summarizeInput(input: Record<string, unknown>): string {
  try { return bounded(JSON.stringify(input)); } catch { return "Claude requested permission to use a tool."; }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deny(message: string, interrupt = false): PermissionResult {
  return { behavior: "deny", message, ...(interrupt ? { interrupt: true } : {}) };
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? bounded(error.message) : fallback;
}

function claudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}
