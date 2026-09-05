import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";

import {
  terminateProcessTreeAndWait,
  type OwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type OpenCodeSdkHarnessCapabilities,
} from "./agent-harness";
import {
  providerRunTerminal,
  type ProviderRunFailure,
  type ProviderRunResult,
} from "./contracts";
import type { AgentApprovalDecision } from "./interactions";
import {
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "./activity-detail";
import {
  CappedProviderBuffer,
  ProviderRunEventBudget,
  PROVIDER_RUN_BUDGET_BURSTS,
} from "./io";
import {
  createOwnedOpenCodeClient,
  ownedOpenCodeCredentials,
  ownedOpenCodeEnvironment,
  openCodeOptionId,
  openCodeQuestionId,
} from "./opencode-boundary";
import {
  openCodeCleanupFailureMessage,
  OpenCodeServerCleanupUnconfirmedError,
  startOwnedOpenCodeServer,
  waitForOpenCodeHealth,
  withOpenCodeRequestDeadline,
} from "./opencode-owned-server";
import {
  createOpenCodeEventState,
  openCodeCanonicalResult,
  settleOpenCodePromptOutput,
  type OpenCodeUsageState,
} from "./opencode-event-projection";
import {
  createOpenCodeHostTools,
  openCodePermissions,
} from "./opencode-host-tools";
import { OpenCodeRunOwnership } from "./opencode-run-ownership";
import { OpenCodeSessionOwnership } from "./opencode-session-ownership";
import { openCodeModels } from "./opencode-sdk-metadata";
import {
  createOpenCodeInteractionState,
  handleOpenCodeInteractionEvent,
  handleOpenCodeEvent,
  openCodeEventRequiresPromptAdmission,
  openCodeWorkingActivityId,
  replyOpenCodePermission,
  type OpenCodeFailureState,
  type OpenCodePendingApproval,
  type OpenCodePendingInput,
  type OpenCodePromptLifecycle,
} from "./opencode-sdk-events";
import {
  findOpenCodeModel,
  finite,
  imageMime,
  isOpenCodeIdleEvent,
  objectValue,
  openCodeRuntimeFailure,
  resolveOpenCodeAgent,
  resolveOpenCodeModel,
  safeError,
  serverDiagnostic,
} from "./opencode-sdk-support";

export {
  openCodeApprovalDisplay,
  resolveOpenCodeModel,
} from "./opencode-sdk-support";
export {
  readOpenCodeSdkModels,
  type OpenCodeSdkMetadataOptions,
} from "./opencode-sdk-metadata";
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_RUN_EVENTS = 8_192;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_SERVER_OUTPUT_CHARS = 32 * 1024;
const START_TIMEOUT_MS = 10_000;
const INITIALIZATION_TIMEOUT_MS = 30_000;
const CANCEL_FORCE_MS = 2_000;
const RUN_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const EVENT_INACTIVITY_DEADLINE_MS = 30 * 60 * 1_000;
const MIN_DEADLINE_MS = 25;
const EXTERNAL_INTERACTION_CONFIRMATION_MS = 250;
export const OPENCODE_SDK_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "opencode-sdk",
    protocol: "owned-server-sse",
    approvals: "native",
    questions: "native",
    plans: "native",
    reasoning: "native",
    usage: "message-token-usage",
    images: "native-file-input",
    authentication: "opencode-cli",
    modelMetadata: "server-config",
  },
} as const satisfies OpenCodeSdkHarnessCapabilities;

interface OpenCodeManualCompactionProof {
  initiatedAt: number | null;
  messageId: string | null;
  startedAt: number | null;
}

export interface OpenCodeSdkHarnessOptions {
  /**
   * May shorten, but never extend, the production run lifetime.
   * Primarily useful for deterministic lifecycle verification.
   */
  runDeadlineMs?: number;
  /**
   * May shorten, but never extend, the production owned-session inactivity
   * window. Verified descendant activity resets it; unrelated sessions do not.
   */
  eventInactivityDeadlineMs?: number;
  /**
   * May shorten, but never extend, the production provider/session
   * initialization deadline. Primarily useful for deterministic lifecycle
   * verification.
   */
  initializationTimeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
  /** Test seam for the local manual-compaction initiation timestamp. */
  compactionTimestampNow?: () => number;
}

interface OpenCodeRunDeadlines {
  runDeadlineMs: number;
  eventInactivityDeadlineMs: number;
  initializationTimeoutMs: number;
}

export function createOpenCodeSdkHarness(
  options: OpenCodeSdkHarnessOptions = {},
): AgentHarness {
  const deadlines = openCodeRunDeadlines(options);
  const terminateOwnedProcessTree = options.terminateProcessTree ?? terminateProcessTreeAndWait;
  const compactionTimestampNow = options.compactionTimestampNow ?? Date.now;
  return {
    id: "opencode-sdk",
    providerId: "opencode",
    capabilities: OPENCODE_SDK_CAPABILITIES,
    supports: (input) => input.providerId === "opencode",
    start: (startOptions) => startOpenCodeRun(
      startOptions,
      deadlines,
      terminateOwnedProcessTree,
      compactionTimestampNow,
    ),
  };
}

function startOpenCodeRun(
  options: AgentHarnessStartOptions,
  deadlines: OpenCodeRunDeadlines,
  terminateOwnedProcessTree: ProcessTreeTerminator,
  compactionTimestampNow: () => number,
): AgentHarnessRun {
  const conversationId = options.input.conversationId;
  const emitter = createAgentHarnessEmitter(
    "opencode",
    conversationId,
    options.callbacks,
    options.input.runId,
    options.input.turnId,
    options.input.cwd,
  );
  const text = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const serverOutput = new CappedProviderBuffer(MAX_SERVER_OUTPUT_CHARS);
  const approvals = new Map<string, OpenCodePendingApproval>();
  const inputs = new Map<string, OpenCodePendingInput>();
  const interactionState = createOpenCodeInteractionState();
  const eventAbort = new AbortController();
  const emittedParts = new Map<string, string>();
  const usageState: OpenCodeUsageState = {
    maxTokens: null,
    currentContextTokens: null,
    messages: new Map(),
    totalProcessedTokens: 0,
    unknownTotalMessages: 0,
    last: null,
    compactsAutomatically: null,
  };
  const eventState = createOpenCodeEventState();
  const failureState: OpenCodeFailureState = {};
  const promptLifecycle: OpenCodePromptLifecycle = {
    messageId: `msg_${randomUUID().replaceAll("-", "")}`,
    observed: false,
    activityObserved: false,
    workingActivityStarted: false,
  };
  const hostTools = createOpenCodeHostTools({
    bridge: options.hostTools,
    conversationId,
    turnId: options.input.turnId,
    cwd: options.input.cwd,
    onApproval: (request) => emitter.rich({ type: "approval", request }),
    onApprovalResolved: (requestId, decision) => {
      emitter.rich({ type: "approval-resolved", requestId, decision });
    },
  });
  const ownership = new OpenCodeRunOwnership(promptLifecycle.messageId);
  const pendingFollowUps = new Set<Promise<boolean>>();
  let sessionId = options.input.sessionId;
  let client: OpencodeClient | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let terminateOwnedRun: OwnedProcessTreeTermination | undefined;
  let cancelRequested = false;
  let acceptingFollowUps = false;
  let terminalError: string | undefined;
  let cancelOwnedRun: (force: boolean) => void = () => {};
  let activeV2Operations = 0;
  const usesV2PrimaryOperation = options.input.operation?.kind === "compact";
  let hasAdmittedV2Work = usesV2PrimaryOperation;
  let cancelForceTimer: NodeJS.Timeout | undefined;
  let runDeadlineTimer: NodeJS.Timeout | undefined;
  let eventInactivityTimer: NodeJS.Timeout | undefined;
  let interruptRun!: (error: Error) => void;
  const runInterrupted = new Promise<never>((_resolve, reject) => {
    interruptRun = reject;
  });
  void runInterrupted.catch(() => undefined);

  const clearDeadlineTimers = (): void => {
    if (runDeadlineTimer) clearTimeout(runDeadlineTimer);
    if (eventInactivityTimer) clearTimeout(eventInactivityTimer);
    runDeadlineTimer = undefined;
    eventInactivityTimer = undefined;
  };
  const redactHostMcp = (value: string): string =>
    hostTools?.redact(value) ?? value;
  const failDeadline = (message: string, terminalEvent: string): void => {
    if (cancelRequested || terminalError) return;
    terminalError = message;
    failureState.terminal = {
      reason: "rpc-timeout",
      message,
      phase: "runtime",
      terminalEvent,
    };
    eventAbort.abort();
    interruptRun(new Error(message));
  };
  const armEventInactivityDeadline = (): void => {
    if (cancelRequested || terminalError) return;
    if (eventInactivityTimer) clearTimeout(eventInactivityTimer);
    eventInactivityTimer = setTimeout(() => {
      failDeadline(
        "OpenCode's event stream became inactive before the session completed.",
        "event/inactivity-deadline",
      );
    }, deadlines.eventInactivityDeadlineMs);
    eventInactivityTimer.unref();
  };
  const failInteraction = (error: unknown): void => {
    terminalError = redactHostMcp(
      safeError(error, "OpenCode could not deliver an interactive response."),
    );
    failureState.terminal = openCodeRuntimeFailure(
      terminalError,
      terminalError,
      "interaction/response",
      undefined,
      options.input.cwd,
    );
    eventAbort.abort();
    interruptRun(new Error(terminalError));
  };
  const settleApproval = (requestId: string, decision: AgentApprovalDecision): boolean => {
    const pending = approvals.get(requestId);
    if (!pending || pending.settled || !client) return false;
    pending.settled = true;
    if (decision === "cancel") {
      approvals.delete(requestId);
      emitter.rich({ type: "approval-resolved", requestId, decision });
      cancelOwnedRun(false);
      return true;
    }
    const reply = decision === "approve" ? "once" : "reject";
    void replyOpenCodePermission(
      client,
      pending.protocol,
      pending.sessionId,
      pending.nativeId,
      reply,
    ).then(() => {
      if (approvals.get(requestId) !== pending) return;
      approvals.delete(requestId);
      emitter.rich({ type: "approval-resolved", requestId, decision });
    }).catch(async (error) => {
      if (approvals.get(requestId) !== pending) return;
      await waitForOpenCodeExternalResolution(pending.externalResolution);
      if (approvals.get(requestId) === pending) failInteraction(error);
    });
    return true;
  };
  const settleInput = (requestId: string, answers: Record<string, string[]>): boolean => {
    const pending = inputs.get(requestId);
    if (!pending || pending.settled || !client) return false;
    pending.settled = true;
    const ordered = pending.questions.map((question, index) => {
      const labelsById = new Map(question.options.map((option, optionIndex) => [
        openCodeOptionId(optionIndex),
        option.label,
      ]));
      return (answers[openCodeQuestionId(index)] ?? []).map((value) => labelsById.get(value) ?? value);
    });
    void replyOpenCodeQuestion(client, pending, ordered).then(() => {
      if (inputs.get(requestId) !== pending) return;
      inputs.delete(requestId);
      emitter.rich({ type: "input-resolved", requestId });
    }).catch(async (error) => {
      if (inputs.get(requestId) !== pending) return;
      await waitForOpenCodeExternalResolution(pending.externalResolution);
      if (inputs.get(requestId) === pending) failInteraction(error);
    });
    return true;
  };
  const rejectPending = (): void => {
    if (!client) return;
    for (const [requestId, pending] of approvals) {
      pending.settled = true;
      approvals.delete(requestId);
      void replyOpenCodePermission(
        client,
        pending.protocol,
        pending.sessionId,
        pending.nativeId,
        "reject",
      ).catch(() => {});
      emitter.rich({ type: "approval-resolved", requestId, decision: "cancelled" });
    }
    for (const [requestId, pending] of inputs) {
      pending.settled = true;
      inputs.delete(requestId);
      void rejectOpenCodeQuestion(client, pending).catch(() => {});
      emitter.rich({ type: "input-resolved", requestId });
    }
  };

  emitter.status("starting");
  runDeadlineTimer = setTimeout(() => {
    failDeadline(
      "OpenCode exceeded the maximum run duration.",
      "run/deadline",
    );
  }, deadlines.runDeadlineMs);
  runDeadlineTimer.unref();
  const result = (async (): Promise<ProviderRunResult> => {
    let outcome: {
      status: ProviderRunResult["status"];
      error?: string;
      failure?: ProviderRunFailure;
    };
    let cleanupConfirmed = true;
    try {
      const credentials = ownedOpenCodeCredentials(options.environment);
      const started = await startOwnedOpenCodeServer(
        options.executable,
        options.input.cwd,
        ownedOpenCodeEnvironment(options.environment, credentials),
        serverOutput,
        terminateOwnedProcessTree,
        "OpenCode server process tree",
        eventAbort.signal,
      );
      child = started.child;
      terminateOwnedRun = started.terminate;
      if (cancelRequested) throw new Error("OpenCode startup was cancelled.");
      if (terminalError) throw new Error(terminalError);
      client = createOwnedOpenCodeClient(started.url, options.input.cwd, credentials);
      await waitForOpenCodeHealth(
        client,
        child,
        START_TIMEOUT_MS,
        eventAbort.signal,
      );

      const initialize = async <T>(
        label: string,
        operation: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> => await withOpenCodeRequestDeadline(
        deadlines.initializationTimeoutMs,
        `Timed out waiting for OpenCode ${label}.`,
        operation,
        eventAbort.signal,
      );

      if (hostTools) await hostTools.install(client, initialize);

      const [providerResponse, agentResponse] = await initialize(
        "provider and agent discovery",
        async (signal) => await Promise.all([
          client!.provider.list(
            { directory: options.input.cwd },
            { signal, throwOnError: true },
          ),
          client!.app.agents(
            { directory: options.input.cwd },
            { signal, throwOnError: true },
          ),
        ]),
      );
      const providerData = {
        ...providerResponse,
        data: hostTools?.redactPayload(providerResponse.data)
          ?? providerResponse.data,
      };
      const agents = {
        ...agentResponse,
        data: hostTools?.redactPayload(agentResponse.data)
          ?? agentResponse.data,
      };
      const discoveredModels = openCodeModels(
        providerData.data.all,
        providerData.data.default,
        providerData.data.connected,
      );
      if (discoveredModels.length > 0) {
        emitter.rich({ type: "metadata", metadata: { models: discoveredModels }, source: "provider", complete: true });
      }
      const selectedModel = resolveOpenCodeModel(
        options.input.model,
        providerData.data.all,
        providerData.data.connected,
      );
      const agent = resolveOpenCodeAgent(options.input.interactionMode, agents.data);
      if (options.input.reasoningEffort && selectedModel && !selectedModel.variants?.[options.input.reasoningEffort]) {
        throw new Error(`OpenCode does not advertise the selected reasoning variant '${options.input.reasoningEffort}'.`);
      }

      if (sessionId) {
        await initialize(
          "session resume",
          async (signal) => await client!.session.get(
            { sessionID: sessionId!, directory: options.input.cwd },
            { signal, throwOnError: true },
          ),
        );
        await initialize(
          "session permission update",
          async (signal) => await client!.session.update(
            {
              sessionID: sessionId!,
              directory: options.input.cwd,
              permission: openCodePermissions(options.input.access),
            },
            { signal, throwOnError: true },
          ),
        );
      } else {
        const created = await initialize(
          "session creation",
          async (signal) => await client!.session.create({
            directory: options.input.cwd,
            ...(selectedModel ? { model: { id: selectedModel.id, providerID: selectedModel.providerID, ...(options.input.reasoningEffort ? { variant: options.input.reasoningEffort } : {}) } } : {}),
            ...(agent ? { agent: agent.name } : {}),
            permission: openCodePermissions(options.input.access),
          }, { signal, throwOnError: true }),
        );
        const safeSessionId = hostTools?.redactPayload(created.data.id)
          ?? created.data.id;
        if (safeSessionId !== created.data.id) {
          throw new Error(
            "OpenCode returned a session identity containing an Inertia bridge credential.",
          );
        }
        sessionId = created.data.id;
        emitter.session(created.data.id);
      }
      if (!sessionId) throw new Error("OpenCode did not return a session ID.");

      const session = await initialize(
        "active session",
        async (signal) => await client!.session.get(
          { sessionID: sessionId!, directory: options.input.cwd },
          { signal, throwOnError: true },
        ),
      );
      const effectiveModel = selectedModel ?? (session.data.model ? findOpenCodeModel(session.data.model.providerID, session.data.model.id, providerData.data.all) : undefined);
      // OpenCode image support is model-negotiated. Publish the exact-run
      // observation before any attachment can cross the provider boundary.
      emitter.capability(
        "images",
        effectiveModel?.capabilities.input.image === true,
      );
      if (options.input.reasoningEffort && (!effectiveModel || !effectiveModel.variants?.[options.input.reasoningEffort])) {
        throw new Error(`The active OpenCode model does not advertise reasoning variant '${options.input.reasoningEffort}'.`);
      }
      if ((options.input.imagePaths?.length ?? 0) > 0 && effectiveModel?.capabilities.input.image !== true) {
        throw new Error("The active OpenCode model does not advertise image input support.");
      }
      usageState.maxTokens = finite(effectiveModel?.limit.context);
      const subscribed = await client.event.subscribe({ directory: options.input.cwd }, { signal: eventAbort.signal, throwOnError: true });
      armEventInactivityDeadline();
      const compacting = options.input.operation?.kind === "compact";
      if (compacting) {
        ownership.rejectPromptAdmission(promptLifecycle.messageId);
      }
      const manualCompaction: OpenCodeManualCompactionProof = {
        initiatedAt: null,
        messageId: null,
        startedAt: null,
      };
      let sessionIdleObserved = false;
      let awaitingParentContinuation = false;
      const pump = pumpOpenCodeEvents(subscribed.stream, sessionId, {
        onDescendantLive: () => {
          awaitingParentContinuation = true;
        },
        onDescendantActivity: () => {
          armEventInactivityDeadline();
          emitter.status(
            "running",
            undefined,
            "verified descendant session activity",
          );
        },
        onDescendantInteraction: (event) => {
          const safeEvent = hostTools?.redactPayload(event) ?? event;
          handleOpenCodeInteractionEvent(
            safeEvent,
            options,
            client!,
            emitter,
            approvals,
            inputs,
            interactionState,
            promptLifecycle,
            ownership,
            "verified-descendant",
            failInteraction,
          );
        },
        onEvent: async (
          event,
          hasLiveDescendants,
          novelRootActivity,
        ) => {
          if (openCodeEventRequiresPromptAdmission(event)) {
            const admission = ownership.pendingPromptAdmission();
            if (admission && !(await admission)) return;
          }
          const safeEvent = hostTools?.redactPayload(event) ?? event;
          const ownershipSequence = ownership.eventSequence();
          handleOpenCodeEvent(
            safeEvent,
            options,
            client!,
            text,
            emitter,
            approvals,
            inputs,
            interactionState,
            emittedParts,
            usageState,
            eventState,
            promptLifecycle,
            ownership,
            failureState,
            failInteraction,
          );
          if (
            awaitingParentContinuation
            && !hasLiveDescendants
            && novelRootActivity
            && ownership.eventSequence() !== ownershipSequence
            && event.type !== "session.next.prompt.admitted"
            && event.type !== "session.next.prompted"
          ) {
            awaitingParentContinuation = false;
          }
          if (
            (
              ownership.eventSequence() !== ownershipSequence
              && (!awaitingParentContinuation || novelRootActivity)
            )
            || event.type === "session.error"
            || event.type === "session.deleted"
          ) armEventInactivityDeadline();
        },
        isDone: async (event, hasLiveDescendants) => {
          if (compacting) {
            return event.type === "session.error"
              || completesRequestedOpenCodeCompaction(event, manualCompaction);
          }
          if (event.type === "session.error") return true;
          if (!isOpenCodeIdleEvent(event)) return false;
          if (!promptLifecycle.observed || !promptLifecycle.activityObserved) return false;
          if (failureState.pending) {
            terminalError = failureState.pending.message;
            failureState.terminal = failureState.pending;
            return true;
          }
          if (hasLiveDescendants) {
            awaitingParentContinuation = true;
            return false;
          }
          if (awaitingParentContinuation) return false;
          acceptingFollowUps = false;
          const admissions = [...pendingFollowUps];
          if (admissions.length > 0) {
            await Promise.allSettled(admissions);
          }
          if (cancelRequested || terminalError) return true;
          if (ownership.acceptedFollowUpsAwaitingWork()) {
            acceptingFollowUps = true;
            return false;
          }
          for (const promptId of ownership.workedPromptIds()) {
            settleOpenCodePromptOutput(
              promptId,
              ownership.assistantIds(promptId),
              emittedParts,
              eventState,
              usageState,
            );
            ownership.settlePrompt(promptId);
          }
          sessionIdleObserved = true;
          return true;
        },
      });
      const providerOperation = compacting
        ? (() => {
            manualCompaction.initiatedAt = compactionTimestampNow();
            return client!.v2.session.compact(
              { sessionID: sessionId },
              { signal: eventAbort.signal, throwOnError: true },
            );
          })()
        : client.session.promptAsync({
            sessionID: sessionId,
            messageID: promptLifecycle.messageId,
            directory: options.input.cwd,
            ...(effectiveModel ? { model: { providerID: effectiveModel.providerID, modelID: effectiveModel.id } } : {}),
            ...(agent ? { agent: agent.name } : {}),
            ...(options.input.reasoningEffort ? { variant: options.input.reasoningEffort } : {}),
            parts: [
              { type: "text", text: options.input.prompt },
              ...(options.input.imagePaths ?? []).map((path) => ({ type: "file" as const, mime: imageMime(path), filename: path.split(/[\\/]/u).at(-1), url: pathToFileURL(path).href })),
            ],
          }, { throwOnError: true }).then((response) => {
            // Older OpenCode servers do not emit prompt-admission events. The
            // successful prompt receipt is the earliest safe compatibility
            // boundary after which an idle event can belong to this run.
            promptLifecycle.observed = true;
            ownership.acceptPrompt(promptLifecycle.messageId);
            armEventInactivityDeadline();
            return response;
          }).catch((error) => {
            ownership.rejectPromptAdmission(promptLifecycle.messageId);
            throw error;
          });
      const completion = Promise.all([providerOperation, pump]);
      await Promise.race([providerOperation, completion, runInterrupted]);
      if (!cancelRequested && !terminalError && !sessionIdleObserved) {
        acceptingFollowUps = true;
        emitter.status("running");
      }
      await Promise.race([completion, runInterrupted]);
      outcome = cancelRequested
        ? { status: "cancelled" }
        : terminalError
          ? {
              status: "failed",
              error: terminalError,
              ...(failureState.terminal
                ? { failure: failureState.terminal }
                : {}),
            }
          : { status: "completed" };
    } catch (error) {
      if (error instanceof OpenCodeServerCleanupUnconfirmedError) {
        cleanupConfirmed = false;
      }
      const rawError = redactHostMcp(terminalError ?? safeError(
        error,
        redactHostMcp(serverDiagnostic(serverOutput)),
      ));
      outcome = cancelRequested
        ? { status: "cancelled" }
        : {
            status: "failed",
            error: rawError,
            failure: failureState.terminal ?? openCodeRuntimeFailure(
              rawError,
              rawError,
              "sdk/exception",
              child,
              options.input.cwd,
            ),
          };
    }
    acceptingFollowUps = false;
    ownership.rejectPendingAdmissions();
    hostTools?.settle();
    await Promise.allSettled(pendingFollowUps);
    clearDeadlineTimers();
    if (cancelForceTimer) clearTimeout(cancelForceTimer);
    try {
      await hostTools?.cleanup(client);
    } catch (error) {
      cleanupConfirmed = false;
      const rawCleanupError = redactHostMcp(safeError(
        error,
        "OpenCode Inertia chat tools could not be cleaned up.",
      ));
      const cleanupError = sanitizeProviderFailureSummary(
        rawCleanupError,
        "OpenCode Inertia chat tools could not be cleaned up.",
        { workspaceRoot: options.input.cwd },
      );
      const cleanupDetail = sanitizeProviderActivityDetail(
        rawCleanupError,
        { workspaceRoot: options.input.cwd, maxChars: 16 * 1024 },
      );
      outcome = {
        ...outcome,
        status: "failed",
        error: cleanupError,
        failure: {
          reason: "provider-error",
          message: cleanupError,
          phase: "cleanup",
          terminalEvent: "host-tools/cleanup",
          ...(cleanupDetail ? { technicalDetail: cleanupDetail } : {}),
        },
      };
    }
    eventAbort.abort();
    rejectPending();
    if (child) {
      try {
        await terminateOwnedRun?.(true);
      } catch (error) {
        cleanupConfirmed = false;
        const cleanupError = sanitizeProviderFailureSummary(
          openCodeCleanupFailureMessage(outcome.error, error),
          "OpenCode could not confirm process cleanup.",
          { workspaceRoot: options.input.cwd },
        );
        const priorFailure = outcome.failure;
        const cleanupDetail = sanitizeProviderActivityDetail(
          [
            priorFailure?.technicalDetail,
            safeError(error, "OpenCode process-tree cleanup was not confirmed."),
          ].filter((value): value is string => Boolean(value)).join("\n"),
          { workspaceRoot: options.input.cwd, maxChars: 16 * 1024 },
        );
        outcome = {
          ...outcome,
          status: "failed",
          error: cleanupError,
          failure: {
            reason: "provider-error",
            message: cleanupError,
            phase: "cleanup",
            terminalEvent: "process-tree/cleanup",
            ...(cleanupDetail ? { technicalDetail: cleanupDetail } : {}),
          },
        };
      }
    }
    return finish(
      outcome.status,
      outcome.error,
      outcome.failure,
      cleanupConfirmed,
    );
  })();

  function finish(
    status: ProviderRunResult["status"],
    error?: string,
    failure?: ProviderRunFailure,
    cleanupConfirmed = true,
  ): ProviderRunResult {
    const canonical = openCodeCanonicalResult(emittedParts, eventState);
    if (promptLifecycle.workingActivityStarted) {
      emitter.activity(
        "turn",
        status === "failed" ? "failed" : "completed",
        status === "completed"
          ? "OpenCode completed work"
          : status === "cancelled"
            ? "OpenCode stopped work"
            : "OpenCode work failed",
        { activityId: openCodeWorkingActivityId(promptLifecycle.messageId) },
      );
      promptLifecycle.workingActivityStarted = false;
    }
    emitter.status(status, error);
    return {
      ...providerRunTerminal(options.input, status, failure),
      ...(sessionId ? { sessionId } : {}),
      text: canonical.text,
      textTruncated: canonical.truncated || text.truncated,
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
      ...(error ? { error } : {}),
      ...(failure ? { failure } : {}),
      cleanupConfirmed,
    };
  }

  cancelOwnedRun = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
    ownership.rejectPendingAdmissions();
    hostTools?.settle();
    void hostTools?.revoke().catch(() => {
      eventAbort.abort();
    });
    acceptingFollowUps = false;
    clearDeadlineTimers();
    emitter.status("cancelling");
    rejectPending();
    if (!force && client && sessionId) {
      cancelForceTimer ??= setTimeout(() => {
        eventAbort.abort();
        interruptRun(new Error("OpenCode cancellation did not settle before the force deadline."));
      }, CANCEL_FORCE_MS);
      cancelForceTimer.unref();
      const acknowledgeCancellation = (): void => {
        interruptRun(new Error("OpenCode acknowledged session cancellation."));
      };
      const requiresV2Cancellation = hasAdmittedV2Work || activeV2Operations > 0;
      const legacyCancellation = client.session.abort(
        { sessionID: sessionId, directory: options.input.cwd },
        { throwOnError: true },
      ).then((response) => response.data === true).catch(() => false);
      const v2Cancellation = requiresV2Cancellation
        ? client.v2.session.interrupt(
            { sessionID: sessionId },
            { throwOnError: true },
          ).then(() => true).catch(() => false)
        : Promise.resolve(false);
      void Promise.all([legacyCancellation, v2Cancellation]).then(([
        legacyAccepted,
        v2Accepted,
      ]) => {
        if (requiresV2Cancellation ? v2Accepted : legacyAccepted) {
          acknowledgeCancellation();
          return;
        }
        eventAbort.abort();
        interruptRun(new Error("OpenCode session cancellation failed."));
      });
      return;
    }
    if (cancelForceTimer) clearTimeout(cancelForceTimer);
    eventAbort.abort();
    interruptRun(new Error(
      force
        ? "OpenCode cancellation was forced."
        : "OpenCode cancellation was requested before the session became ready.",
    ));
  };

  return {
    harnessId: "opencode-sdk",
    providerId: "opencode",
    result,
    cancel: cancelOwnedRun,
    extension: {
      kind: "opencode-sdk",
      respondToApproval: (requestId, decision) =>
        hostTools?.respondToApproval(requestId, decision)
        || settleApproval(requestId, decision),
      respondToInput: settleInput,
      steer: async (input) => {
        const activeClient = client;
        const activeSessionId = sessionId;
        const text = input.content.replaceAll("\0", "").trim();
        if (
          !acceptingFollowUps
          || cancelRequested
          || !activeClient
          || !activeSessionId
          || !text
        ) return false;
        const id = randomUUID();
        if (!ownership.reserveFollowUp(id)) return false;
        const files = input.imagePaths.map((path) => ({
          uri: pathToFileURL(path).href,
          name: path.split(/[\\/]/u).at(-1),
        }));
        const followUp = (async (): Promise<boolean> => {
          activeV2Operations += 1;
          try {
            const response = await withOpenCodeRequestDeadline(
              deadlines.initializationTimeoutMs,
              "Timed out waiting for OpenCode to admit the follow-up.",
              async (signal) => await activeClient.v2.session.prompt({
                sessionID: activeSessionId,
                id,
                delivery: "steer",
                prompt: {
                  text,
                  ...(files.length > 0 ? { files } : {}),
                },
              }, { signal, throwOnError: true }),
              eventAbort.signal,
            );
            const accepted = exactOpenCodeSteerReceipt(
              response.data,
              id,
              activeSessionId,
              text,
              files.map(({ uri }) => uri),
            );
            if (accepted) {
              hasAdmittedV2Work = true;
              ownership.acceptPrompt(id);
              armEventInactivityDeadline();
            } else {
              ownership.rejectFollowUp(id);
            }
            return accepted;
          } catch {
            ownership.rejectFollowUp(id);
            return false;
          } finally {
            activeV2Operations -= 1;
          }
        })();
        pendingFollowUps.add(followUp);
        try {
          return await followUp;
        } finally {
          pendingFollowUps.delete(followUp);
        }
      },
    },
  };
}

async function replyOpenCodeQuestion(
  client: OpencodeClient,
  pending: OpenCodePendingInput,
  answers: string[][],
): Promise<void> {
  if (pending.protocol === "v2") {
    await client.v2.session.question.reply({
      sessionID: pending.sessionId,
      requestID: pending.nativeId,
      questionV2Reply: { answers },
    }, { throwOnError: true });
    return;
  }
  await client.question.reply(
    { requestID: pending.nativeId, answers },
    { throwOnError: true },
  );
}

async function rejectOpenCodeQuestion(
  client: OpencodeClient,
  pending: OpenCodePendingInput,
): Promise<void> {
  if (pending.protocol === "v2") {
    await client.v2.session.question.reject({
      sessionID: pending.sessionId,
      requestID: pending.nativeId,
    }, { throwOnError: true });
    return;
  }
  await client.question.reject(
    { requestID: pending.nativeId },
    { throwOnError: true },
  );
}

async function waitForOpenCodeExternalResolution(
  resolution: Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      resolution,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EXTERNAL_INTERACTION_CONFIRMATION_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function exactOpenCodeSteerReceipt(
  value: unknown,
  id: string,
  sessionId: string,
  text: string,
  fileUris: readonly string[],
): boolean {
  const envelope = objectValue(value);
  const receipt = objectValue(envelope?.data);
  const prompt = objectValue(receipt?.prompt);
  const files = Array.isArray(prompt?.files) ? prompt.files : [];
  if (
    receipt?.id !== id
    || receipt.sessionID !== sessionId
    || receipt.delivery !== "steer"
    || prompt?.text !== text
    || files.length !== fileUris.length
  ) return false;
  return files.every((file, index) =>
    objectValue(file)?.uri === fileUris[index]);
}

function completesRequestedOpenCodeCompaction(
  event: Event,
  proof: OpenCodeManualCompactionProof,
): boolean {
  if (
    proof.initiatedAt === null
    || (
      event.type !== "session.next.compaction.started"
      && event.type !== "session.next.compaction.ended"
    )
  ) return false;
  const properties = event.properties;
  const timestamp = properties.timestamp;
  const messageId = properties.messageID;
  if (
    properties.reason !== "manual"
    || typeof timestamp !== "number"
    || !Number.isFinite(timestamp)
    || timestamp < proof.initiatedAt
    || typeof messageId !== "string"
    || !messageId.trim()
    || messageId.length > 512
    || messageId.includes("\0")
  ) return false;
  if (event.type === "session.next.compaction.started") {
    if (proof.messageId !== null) return false;
    proof.messageId = messageId;
    proof.startedAt = timestamp;
    return false;
  }
  return proof.messageId !== null
    && proof.startedAt !== null
    && timestamp >= proof.startedAt
    && messageId === proof.messageId;
}

async function pumpOpenCodeEvents(
  stream: AsyncGenerator<Event>,
  sessionId: string,
  handlers: {
    onDescendantLive: () => void;
    onDescendantActivity: () => void;
    onDescendantInteraction: (event: Event) => void | Promise<void>;
    onEvent: (
      event: Event,
      hasLiveDescendants: boolean,
      novelRootActivity: boolean,
    ) => void | Promise<void>;
    isDone: (
      event: Event,
      hasLiveDescendants: boolean,
    ) => boolean | Promise<boolean>;
  },
): Promise<void> {
  const maxRunEvents = MAX_RUN_EVENTS * PROVIDER_RUN_BUDGET_BURSTS;
  const sessionOwnership = new OpenCodeSessionOwnership(
    sessionId,
    maxRunEvents,
  );
  const eventBudget = new ProviderRunEventBudget(
    "OpenCode",
    MAX_EVENT_BYTES,
    MAX_RUN_EVENTS,
    MAX_RUN_EVENT_BYTES,
    { maxRunEvents },
  );
  for await (const event of stream) {
    eventBudget.observe(event);
    const {
      scope,
      active,
      lifecycleProgress,
      novelRootActivity,
    } = sessionOwnership.observe(event);
    if (scope === "unrelated") continue;
    if (scope === "descendant") {
      if (sessionOwnership.hasLiveDescendants()) handlers.onDescendantLive();
      if (active || lifecycleProgress) handlers.onDescendantActivity();
      if (active && openCodeEventRequiresPromptAdmission(event)) {
        await handlers.onDescendantInteraction(event);
      }
      continue;
    }
    await handlers.onEvent(
      event,
      sessionOwnership.hasLiveDescendants(),
      novelRootActivity === true,
    );
    if (await handlers.isDone(
      event,
      sessionOwnership.hasLiveDescendants(),
    )) return;
  }
  throw new Error("OpenCode closed its event stream before the session completed.");
}

function openCodeRunDeadlines(
  options: OpenCodeSdkHarnessOptions,
): OpenCodeRunDeadlines {
  return {
    runDeadlineMs: shortenedDeadline(
      options.runDeadlineMs,
      RUN_DEADLINE_MS,
      "runDeadlineMs",
    ),
    eventInactivityDeadlineMs: shortenedDeadline(
      options.eventInactivityDeadlineMs,
      EVENT_INACTIVITY_DEADLINE_MS,
      "eventInactivityDeadlineMs",
    ),
    initializationTimeoutMs: shortenedDeadline(
      options.initializationTimeoutMs,
      INITIALIZATION_TIMEOUT_MS,
      "initializationTimeoutMs",
    ),
  };
}

function shortenedDeadline(
  value: number | undefined,
  maximum: number,
  name: keyof OpenCodeSdkHarnessOptions,
): number {
  return shortenedTimeout(value, maximum, name);
}

function shortenedTimeout(
  value: number | undefined,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`OpenCode ${name} must be a positive integer.`);
  }
  return Math.max(MIN_DEADLINE_MS, Math.min(value, maximum));
}
