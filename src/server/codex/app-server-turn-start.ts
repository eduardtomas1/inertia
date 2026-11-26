import { staleProviderSessionDecision } from "../../shared/continuation-policy";
import { INERTIA_VERSION } from "../../shared/version";
import {
  CODEX_THREAD_IN_USE_MESSAGE,
  codexAccessPolicy,
  codexServiceTierMatches,
  isStaleResumeError,
} from "./app-server-config";
import type { OpenCodexTurnOptions } from "./app-server-open-turn-options";
import { codexGoalMayContinue } from "./app-server-orphan-goal-turns";
import { boundedText, objectValue, type JsonObject } from "./protocol";
import { codexWatcherThreadConfig } from "./read-only-thread-config";
import { injectCodexHistory } from "./app-server-history-injection";
import { CodexErrorResponse, isCodexActiveWriterError } from "./app-server-request-errors";
import {
  codexResumedThreadWithheldInstructions,
  codexThreadStartTools,
  recordCodexThreadRegistration,
} from "./app-server-thread-tools";
import {
  CODEX_CONFIG_READ_TIMEOUT_MS,
  codexPromptWithSessionInstruction,
  codexSessionDeveloperInstructions,
  configuredDeveloperInstructions,
} from "./developer-instructions";
import { codexModelProviderThreadConfig } from "./model-provider-config";
import { withoutInternalProviderInstructions } from "../runtime/turns/request-context";
import { withoutSessionInstructions } from "../runtime/turns/turn-instruction-delivery";
import type { CodexAppServerOptions } from "./types";

const CODEX_CLOSING_THREAD_RETRY_DELAY_MS = 200;
const CODEX_REASONING_SUMMARY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export class CodexProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProtocolViolationError";
  }
}

export function isCodexArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bthread\b[^.\n]{0,80}\barchived\b|\barchived\b[^.\n]{0,40}\bthread\b|\bthread_archived\b/iu.test(
    message,
  );
}

export function isCodexClosingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bthread\b[^.\n]{0,80}\bclosing\b|\bclosing\b[^.\n]{0,40}\bthread\b|\bthread_closing\b/iu.test(
    message,
  );
}

function normalizedCodexReasoningSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return CODEX_REASONING_SUMMARY_PATTERN.test(trimmed) ? trimmed : undefined;
}

function configuredReasoningSummary(config: JsonObject | null): string | undefined {
  return normalizedCodexReasoningSummary(
    objectValue(config?.config)?.model_reasoning_summary,
  );
}

function openedReasoningSummary(opened: JsonObject): string | undefined {
  return normalizedCodexReasoningSummary(opened.reasoningSummary)
    ?? normalizedCodexReasoningSummary(opened.summary)
    ?? normalizedCodexReasoningSummary(objectValue(opened.config)?.model_reasoning_summary)
    ?? normalizedCodexReasoningSummary(objectValue(opened.thread)?.reasoningSummary);
}

async function readCodexConfigSnapshot(
  read: () => Promise<JsonObject>,
  timeoutMs = CODEX_CONFIG_READ_TIMEOUT_MS,
): Promise<JsonObject | null> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([read(), timedOut]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForClosingThreadRetry(
  delayMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  if (shouldStop() || delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

export async function openCodexTurn({
  options,
  modelProvider,
  request,
  notify,
  setProviderThreadId,
  activeTurnId,
  setActiveTurnId,
  setRequestedTurnId,
  replayPreResponseTurnNotifications,
  goalTurns,
  phase,
  hasObservedTurn,
  hasCompletedTurn,
  goalProjectionSequence,
  beginGoalMutation,
  endGoalMutation,
  awaitInitialGoalTurn,
  projectGoalResponse,
  setContinuationError,
  setCompatibilityError,
  deferSessionInstruction,
  setPhase,
  isSettled,
  isCancelRequested,
  finish,
}: OpenCodexTurnOptions & {
  hasCompletedTurn?: (turnId: string) => boolean;
}): Promise<void> {
  await request("initialize", {
    clientInfo: {
      name: "inertia",
      title: "Inertia",
      version: INERTIA_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
  notify("initialized");

  const accessPolicy = codexAccessPolicy(options);
  const effectiveConfig = options.readOnlyProfile === "watcher" || modelProvider?.credentialEnvironmentKey
    ? await request("config/read", { includeLayers: false, cwd: options.cwd })
    : null;
  const watcherConfig = options.readOnlyProfile === "watcher" && effectiveConfig
    ? codexWatcherThreadConfig(effectiveConfig)
    : null;
  const providerConfig = modelProvider
    ? codexModelProviderThreadConfig(modelProvider, effectiveConfig)
    : null;
  // A resumed thread keeps the dynamic tools it registered at thread/start,
  // so instructions for packs it did not register leave both channels.
  const withheldInstructions = options.sessionId
    ? codexResumedThreadWithheldInstructions(options.sessionId, options.hostTools)
    : [];
  const sessionDeveloperInstructions = withoutSessionInstructions(
    options.sessionDeveloperInstructions,
    withheldInstructions,
  );
  const configSnapshot = effectiveConfig ?? (
    sessionDeveloperInstructions === undefined
      ? null
      : await readCodexConfigSnapshot(
        () => request("config/read", { includeLayers: false, cwd: options.cwd }, undefined, false),
      )
  );
  const { developerInstructions, sessionInstructionApplied } = codexSessionDeveloperInstructions(
    sessionDeveloperInstructions === undefined
      ? undefined
      : configSnapshot === null
        ? null
        : configuredDeveloperInstructions(configSnapshot),
    sessionDeveloperInstructions,
    options.developerInstructions,
  );
  if (!sessionInstructionApplied) deferSessionInstruction?.();
  const threadConfig = {
    cwd: options.cwd,
    approvalPolicy: accessPolicy.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: accessPolicy.threadSandbox,
    ...(options.model ? { model: options.model } : {}),
    ...(options.serviceTier !== undefined
      ? { serviceTier: options.serviceTier }
      : {}),
    ...(modelProvider ? { modelProvider: modelProvider.providerId } : {}),
    ...(providerConfig || watcherConfig || options.autoCompactTokenLimit
      ? { config: { ...(options.autoCompactTokenLimit ? { model_auto_compact_token_limit: options.autoCompactTokenLimit } : {}), ...watcherConfig, ...providerConfig } }
      : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
  };
  let opened: JsonObject;
  if (options.sessionId) {
    const resumeParams: JsonObject = {
      threadId: options.sessionId,
      excludeTurns: true,
      ...threadConfig,
    };
    try {
      const isRecoverableResumeError = (_code: number | null, message: string): boolean => {
        const probe = new Error(message);
        return isCodexArchivedThreadError(probe) || isCodexClosingThreadError(probe);
      };
      try {
        opened = await request("thread/resume", resumeParams, undefined, (code, message) =>
          !isRecoverableResumeError(code, message));
      } catch (initialError) {
        if (isSettled() || isCancelRequested()) throw initialError;
        if (isCodexArchivedThreadError(initialError)) {
          // T3 9c8942480 / ba962f2d2: archived Codex threads unarchive once before resume.
          await request("thread/unarchive", { threadId: options.sessionId });
          if (isSettled() || isCancelRequested()) throw initialError;
          opened = await request("thread/resume", resumeParams);
        } else if (isCodexClosingThreadError(initialError)) {
          await waitForClosingThreadRetry(
            CODEX_CLOSING_THREAD_RETRY_DELAY_MS,
            () => isSettled() || isCancelRequested(),
          );
          if (isSettled() || isCancelRequested()) throw initialError;
          try {
            opened = await request("thread/resume", resumeParams, undefined, (_code, message) =>
              !isCodexArchivedThreadError(new Error(message)));
          } catch (retryError) {
            if (!isSettled() && !isCancelRequested() && isCodexArchivedThreadError(retryError)) {
              await request("thread/unarchive", { threadId: options.sessionId });
              if (isSettled() || isCancelRequested()) throw retryError;
              opened = await request("thread/resume", resumeParams);
            } else {
              throw retryError;
            }
          }
        } else {
          throw initialError;
        }
      }
    } catch (error) {
      if (isCodexActiveWriterError(error)) {
        setContinuationError("thread-in-use");
        throw new Error(CODEX_THREAD_IN_USE_MESSAGE);
      }
      if (isStaleResumeError(error)) {
        setContinuationError("stale-provider-session");
        throw new Error(staleProviderSessionDecision().reason);
      }
      if (error instanceof CodexErrorResponse) setContinuationError("resume-rejected");
      throw error;
    }
  } else {
    opened = await request("thread/start", {
      ...threadConfig,
      ...(options.hostTools
        ? {
            dynamicTools: codexThreadStartTools(options.hostTools).map((definition) => ({
              name: definition.name,
              description: definition.description,
              inputSchema: definition.inputSchema,
            })),
          }
        : {}),
    });
  }

  const thread = objectValue(opened.thread);
  const openedThreadId = boundedText(thread?.id, 512);
  if (!openedThreadId) {
    throw new Error("Codex did not return a thread identifier.");
  }
  if (options.sessionId && openedThreadId !== options.sessionId) {
    setContinuationError("stale-provider-session");
    throw new Error(staleProviderSessionDecision().reason);
  }
  if (
    options.serviceTier !== undefined
    && !codexServiceTierMatches(options.serviceTier, opened.serviceTier)
  ) {
    setCompatibilityError?.("fast-mode-unsupported");
    throw new Error(
      "Codex did not confirm the requested response service tier.",
    );
  }
  if (!options.sessionId) recordCodexThreadRegistration(openedThreadId, options.hostTools);
  setProviderThreadId(openedThreadId);
  options.onSession?.(openedThreadId);
  await goalTurns?.settle(); // A goal turn no run owns stops before the run's turn starts.
  if (isSettled()) return;
  // Never into an active turn (T3 8b21cbdf1), nor a resumed one Codex may still continue a goal in.
  const prompt = await injectCodexHistory({ history: options.historyInjection, prompt: options.prompt, threadId: openedThreadId,
    thread, turnActive: activeTurnId() !== undefined || goalTurns?.held() === true || codexGoalMayContinue(options),
    cancelRequested: isCancelRequested, request });
  if (isCancelRequested()) {
    finish("cancelled", null, null);
    return;
  }

  if (options.goalStart) {
    setPhase("starting-turn");
    goalTurns?.adopt();
    if (options.reasoningEffort) {
      await request("thread/settings/update", {
        threadId: openedThreadId,
        effort: options.reasoningEffort,
      });
    }
    const params: JsonObject = {
      threadId: openedThreadId,
      status: "active",
    };
    if (options.goalStart.objective !== undefined) {
      params.objective = options.goalStart.objective;
    }
    if (options.goalStart.tokenBudget !== undefined) {
      params.tokenBudget = options.goalStart.tokenBudget;
    }
    beginGoalMutation(true);
    let terminalGoalStart = false;
    try {
      let sequenceAtResponse = goalProjectionSequence();
      const response = await request("thread/goal/set", params, () => {
        sequenceAtResponse = goalProjectionSequence();
      });
      const projectedGoal = projectGoalResponse(
        openedThreadId,
        response.goal,
        sequenceAtResponse,
      );
      if (!projectedGoal) {
        throw new Error("Codex returned a malformed goal response.");
      }
      terminalGoalStart = projectedGoal.status !== "active";
    } finally {
      endGoalMutation(true);
    }
    if (terminalGoalStart && phase() === "starting-turn") {
      finish("completed", 0, null);
    } else if (!terminalGoalStart) {
      awaitInitialGoalTurn();
    }
    return;
  }

  const effectiveModel = boundedText(opened.model, 160) ?? options.model;
  if (options.planMode && !effectiveModel) {
    throw new Error(
      "Codex did not return an effective model for Plan mode.",
    );
  }
  for (const skill of options.skills ?? []) {
    if (
      skill.source !== "codex-native"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(skill.name)
    ) {
      throw new Error("Codex received an invalid selected skill.");
    }
  }
  const turnPrompt = withoutInternalProviderInstructions(prompt, withheldInstructions);
  const input: JsonObject[] = [{
    type: "text",
    text: sessionInstructionApplied || sessionDeveloperInstructions === undefined
      ? turnPrompt
      : codexPromptWithSessionInstruction(turnPrompt, sessionDeveloperInstructions),
    text_elements: [],
  }];
  for (const skill of options.skills ?? []) {
    input.push({
      type: "skill",
      name: skill.name,
      path: skill.path,
    });
  }
  for (const path of options.imagePaths ?? []) {
    input.push({ type: "localImage", path });
  }
  const reasoningSummary =
    normalizedCodexReasoningSummary(
      (options as CodexAppServerOptions & { reasoningSummary?: string }).reasoningSummary,
    )
    ?? configuredReasoningSummary(configSnapshot)
    ?? openedReasoningSummary(opened)
    ?? "auto";
  const isAlreadyCompletedTurn = (turnId: string): boolean =>
    hasCompletedTurn?.(turnId) === true
    || (phase() === "starting-turn" && hasObservedTurn(turnId) && activeTurnId() !== turnId);
  let rejectedCompletedTurnId: string | undefined;
  setPhase("starting-turn");
  setRequestedTurnId?.(null);
  const started = await request("turn/start", {
    threadId: openedThreadId,
    input,
    approvalPolicy: accessPolicy.approvalPolicy,
    approvalsReviewer: "user",
    sandboxPolicy: accessPolicy.turnSandboxPolicy,
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort
      ? { effort: options.reasoningEffort }
      : {}),
    ...(options.serviceTier !== undefined
      ? { serviceTier: options.serviceTier }
      : {}),
    summary: reasoningSummary,
    ...(options.planMode ? {
      collaborationMode: {
        mode: "plan",
        settings: {
          model: effectiveModel,
          reasoning_effort: options.reasoningEffort ?? null,
          developer_instructions: null,
        },
      },
    } : {}),
  }, (result) => {
    const respondedTurnId = boundedText(objectValue(result?.turn)?.id, 512);
    // T3 54d0a161bb: never adopt or emit a native boundary for a turn ID that
    // already completed before turn/start answered.
    if (respondedTurnId && isAlreadyCompletedTurn(respondedTurnId)) {
      rejectedCompletedTurnId = respondedTurnId;
      return;
    }
    setRequestedTurnId?.(respondedTurnId);
    if (respondedTurnId && !isSettled()) options.onNativeBoundary?.(openedThreadId, respondedTurnId, "started");
    if (respondedTurnId) replayPreResponseTurnNotifications?.(respondedTurnId);
  });
  if (isSettled()) return;
  const turn = objectValue(started.turn);
  const startedTurnId = boundedText(turn?.id, 512);
  if (!startedTurnId) {
    throw new Error("Codex did not return a turn identifier.");
  }
  if (rejectedCompletedTurnId === startedTurnId) {
    throw new CodexProtocolViolationError(
      "Codex returned an already-completed turn identifier.",
    );
  }
  if (phase() !== "starting-turn") {
    if (!hasObservedTurn(startedTurnId)) {
      throw new Error("Codex returned inconsistent turn identifiers.");
    }
    return;
  }
  if (isAlreadyCompletedTurn(startedTurnId)) {
    throw new CodexProtocolViolationError(
      "Codex returned an already-completed turn identifier.",
    );
  }
  if (activeTurnId() && activeTurnId() !== startedTurnId) {
    throw new Error("Codex returned inconsistent turn identifiers.");
  }
  setActiveTurnId(startedTurnId);
  setPhase("running");
  options.onStatus?.("running");
}
