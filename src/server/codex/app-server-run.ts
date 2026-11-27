import { spawn } from "node:child_process";
import { recordWindowsCleanupFailure } from "../windows-cleanup-diagnostics";
import {
  activeRuntimeOwnedProcessPlatform,
  runtimeOwnedProcessInvocation,
  runtimeOwnedProcessStopConfirmation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";

import type { TurnFailureKind } from "../../shared/turn-lifecycle";
import type { OrchestrationRunFailureCode } from "../../shared/orchestration-v2";
import {
  CODEX_RPC_TIMEOUT_MS,
  CODEX_CHILD_INTERRUPT_OVERALL_TIMEOUT_MS,
  CODEX_CHILD_INTERRUPT_TIMEOUT_MS,
  CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES,
  CODEX_ROOT_INTERRUPT_TIMEOUT_MS,
  CODEX_TRANSPORT_CLOSE_GRACE_MS,
  MAX_CODEX_PENDING_CANCELLATION_REQUESTS,
  MAX_CODEX_PENDING_CLIENT_REQUESTS,
  MAX_CODEX_DIAGNOSTIC_CHARS,
  MAX_CODEX_TEXT_CHARS,
  codexProtocolLimits,
  isUnsupportedFastModeError,
  isUnsupportedFullAccessError,
  validateCodexModelProvider,
  type CodexRunPhase,
} from "./app-server-config";
import { CodexAppServerEvents, type CodexAppServerEventHost } from "./app-server-events";
import { resetCodexRetryBudget } from "./app-server-error-events";
import { codexAppServerExitMessage } from "./app-server-exit-message";
import { CodexOrphanGoalTurns, codexGoalMayContinue } from "./app-server-orphan-goal-turns";
import {
  CodexProtocolViolationError,
  isCodexArchivedThreadError,
  isCodexClosingThreadError,
  openCodexTurn,
} from "./app-server-turn-start";
import { redactCodexErrorHeaders } from "./managed-errors";
import { CodexJsonLineWriter } from "./jsonl-writer";
import {
  boundedText,
  CappedTextBuffer,
  JsonLineDecoder,
  objectValue,
  rpcId,
  stringValue,
  type JsonLineDecoderFailure,
  type JsonObject,
} from "./protocol";
import {
  CodexErrorResponse, CodexRequestRefusedError, type CodexRequestFailureRecording,
} from "./app-server-request-errors";
import { codexModelProviderLaunchArguments } from "./model-provider-config";
import type {
  CodexAppServerOptions,
  CodexAppServerResult,
  CodexAppServerRun,
} from "./types";
export { isCodexArchivedThreadError, isCodexClosingThreadError, openCodexTurn };
import {
  launchCredentialValues,
  sanitizeProviderFailureDetail,
} from "../provider/activity-detail";
import {
  ProviderSteerDeliveryUnknownError,
  type ProviderGoalMutation,
  type ProviderGoalSnapshot,
  type ProviderRunFailure,
  type ProviderSteerInput,
} from "../provider/contracts";
import { providerProcessInvocation } from "../provider/process";
import { providerUnconfirmedCleanup } from "../provider/provider-unconfirmed-cleanup";
import {
  endProviderInput,
  providerNaturalCloseFirst,
  waitForProviderNaturalClose,
} from "../provider/provider-natural-close";
import { createOwnedProcessTreeTermination } from "../process-lifecycle";

const MAX_PRIOR_COMPLETED_TURN_IDS = 4_096;

export const CODEX_REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"] as const;
export type CodexReasoningSummary = (typeof CODEX_REASONING_SUMMARIES)[number];

export type CodexAppServerRunOptions = CodexAppServerOptions & {
  reasoningSummary?: unknown;
  modelSelection?: {
    providerOptions?: Readonly<Record<string, unknown>>;
  };
};

export function validatedCodexReasoningSummary(
  value: unknown,
): CodexReasoningSummary | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return (CODEX_REASONING_SUMMARIES as readonly string[]).includes(trimmed)
    ? (trimmed as CodexReasoningSummary)
    : undefined;
}

const SUBSTANTIVE_PROGRESS_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "thread/tokenUsage/updated",
]);

interface PendingClientRequest {
  method: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  recordFailure: CodexRequestFailureRecording;
  onResponseFrame?: (result?: JsonObject) => void;
}

export function startCodexAppServerRun(
  options: CodexAppServerRunOptions,
): CodexAppServerRun {
  const requestedReasoningSummary = options.reasoningSummary !== undefined
    ? options.reasoningSummary
    : options.modelSelection?.providerOptions?.reasoningSummary;
  const validatedReasoningSummary = validatedCodexReasoningSummary(requestedReasoningSummary);
  const {
    reasoningSummary: _rawReasoningSummary,
    modelSelection: _modelSelection,
    ...baseTurnOptions
  } = options;
  const turnOptions: CodexAppServerOptions & { reasoningSummary?: CodexReasoningSummary } = {
    ...baseTurnOptions,
    ...(validatedReasoningSummary !== undefined ? { reasoningSummary: validatedReasoningSummary } : {}),
  };
  const modelProvider = validateCodexModelProvider(options);
  const protocolLimits = codexProtocolLimits(options.protocolLimits);
  const invocation = providerProcessInvocation(
    options.executable,
    ["app-server", ...(modelProvider ? codexModelProviderLaunchArguments(modelProvider) : [])],
    options.environment,
  );
  const ownedInvocation = runtimeOwnedProcessInvocation(
    invocation.command,
    invocation.args,
  );
  const child = spawnRuntimeOwnedProcess(() => spawn(ownedInvocation.command, ownedInvocation.args, {
    cwd: options.cwd,
    env: options.environment,
    detached: process.platform !== "win32",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }));
  const resultText = new CappedTextBuffer(MAX_CODEX_TEXT_CHARS);
  const diagnostic = new CappedTextBuffer(MAX_CODEX_DIAGNOSTIC_CHARS);
  const pendingRequests = new Map<number, PendingClientRequest>();
  let nextRequestId = 1;
  let providerThreadId = options.sessionId;
  let activeTurnId: string | undefined;
  let requestedTurnId: string | null | undefined;
  let cancelRequested = false;
  let settled = false;
  let spawned = false;
  let phase: CodexRunPhase = "opening";
  let lastError: string | undefined;
  let failure: ProviderRunFailure | undefined;
  let lastProtocolMethod: string | undefined;
  let lastActivityId: string | undefined;
  let terminalEvent: string | undefined;
  let ownedTerminationArmed = false;
  let exitedBeforeOwnedTermination = false;
  let transportCloseTimer: NodeJS.Timeout | undefined;
  let decoder: JsonLineDecoder | undefined;
  let compatibilityError: CodexAppServerResult["compatibilityError"];
  let continuationError: CodexAppServerResult["continuationError"];
  let sessionInstructionDeferred = false;
  let resolveResult!: (result: CodexAppServerResult) => void;
  let startupGateReleased = false;
  let startupFailure: Error | undefined;
  let releaseStartupGate!: () => void;
  const startupGate = new Promise<void>((resolve) => {
    releaseStartupGate = resolve;
  });
  let goalMutationTail = Promise.resolve();
  let events: CodexAppServerEvents;
  let eventHost: CodexAppServerEventHost | undefined;
  const priorCompletedTurnIds = new Set<string>();
  let cancellationStarted = false;
  const terminateOwnedProcessTree = createOwnedProcessTreeTermination(
    child,
    "Codex App Server process tree",
    options.terminateProcessTree,
  );

  const result = new Promise<CodexAppServerResult>((resolve) => {
    resolveResult = resolve;
  });

  const settleStartupGate = (error?: unknown): void => {
    if (startupGateReleased) return;
    startupGateReleased = true;
    if (error) {
      startupFailure = error instanceof Error
        ? error
        : new Error("Codex App Server could not start the turn.");
    }
    releaseStartupGate();
  };

  const serializeGoalMutation = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const current = goalMutationTail.then(async () => {
      await startupGate;
      if (startupFailure) throw startupFailure;
      return await operation();
    });
    goalMutationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const rememberFailure = (
    reason: ProviderRunFailure["reason"],
    message: string,
    technicalDetail?: string,
    usageLimited = false,
    failureKind?: TurnFailureKind,
    code?: OrchestrationRunFailureCode,
  ): void => {
    message = redactCodexErrorHeaders(message);
    failure ??= {
      reason,
      message,
      phase,
      ...(terminalEvent ? { terminalEvent } : {}),
      ...(lastActivityId ? { activityId: lastActivityId } : {}),
      ...(technicalDetail ? { technicalDetail } : {}),
    };
    if (usageLimited && reason === "codex-error" && failure.reason === "codex-error") failure.usageLimited = true;
    if (failureKind && reason === "codex-error" && failure.reason === "codex-error") failure.failureKind ??= failureKind;
    // A managed code names the failure whichever Codex error reported it first; its summary replaces the raw text.
    if (code && reason === "codex-error" && failure.reason === "codex-error" && failure.code === undefined) {
      Object.assign(failure, { code, message });
    }
  };

  const rememberTransportFailure = (message: string, technicalDetail?: string): void => {
    // Node records process exit before stdio closes. Preserve that evidence
    // before arming cleanup; a cleanup-induced exit is not the initiating cause.
    if (!ownedTerminationArmed && (child.exitCode !== null || child.signalCode !== null)) {
      exitedBeforeOwnedTermination = true;
      rememberFailure(
        child.signalCode ? "process-signal" : "process-exit",
        codexAppServerExitMessage(child.exitCode, child.signalCode, diagnostic.toString()),
        technicalDetail,
      );
    } else {
      rememberFailure("transport-closed", message, technicalDetail);
    }
  };

  const settledFailure = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): ProviderRunFailure | undefined => {
    if (!failure) return undefined;
    const details = [
      `Reason: ${failure.reason}`,
      `Phase: ${failure.phase ?? phase}`,
      `Exit code: ${exitCode ?? "none"}`,
      `Signal: ${signal ?? "none"}`,
      `Terminal event: ${
        failure.terminalEvent ?? terminalEvent ?? "not received"
      }`,
      `Turn: ${activeTurnId ?? "not started"}`,
      `Activity: ${
        failure.activityId ?? lastActivityId ?? "not reported"
      }`,
      `Last protocol method: ${lastProtocolMethod ?? "none"}`,
      failure.technicalDetail,
      lastError,
      diagnostic.toString(),
    ].filter((value): value is string => Boolean(value));
    // A custom backend token is materialized in the launch environment, and the pattern scrubber misses
    // JSON-shaped echoes of it; Codex errors and stderr can also carry a service response's header maps.
    const technicalDetail = sanitizeProviderFailureDetail(
      redactCodexErrorHeaders(details.join("\n")),
      launchCredentialValues(options.environment),
      { workspaceRoot: options.cwd },
    );
    return {
      ...failure,
      ...(terminalEvent ? { terminalEvent } : {}),
      ...(lastActivityId ? { activityId: lastActivityId } : {}),
      ...(technicalDetail ? { technicalDetail } : {}),
    };
  };

  const stdinWriter = new CodexJsonLineWriter(
    child.stdin,
    protocolLimits.maxFrameBytes,
    CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES,
  );

  const handleWriteFailure = (error: unknown): void => {
    if (settled) return;
    const message = error instanceof Error
      ? error.message
      : "The Codex App Server input stream closed.";
    lastError ??= message;
    rememberTransportFailure(
      "The Codex App Server connection closed while sending a request.",
      message,
    );
    finish("failed", child.exitCode, child.signalCode);
  };

  const writeMessage = (message: JsonObject): boolean => {
    if (settled || child.stdin.destroyed || !child.stdin.writable) {
      return false;
    }
    void stdinWriter.write(message).catch(handleWriteFailure);
    return true;
  };

  const settlePendingRequests = (message: string): void => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    pendingRequests.clear();
  };

  const finish = (
    status: CodexAppServerResult["status"],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (settled) return;
    if (transportCloseTimer) {
      clearTimeout(transportCloseTimer);
      transportCloseTimer = undefined;
    }
    settled = true;
    phase = "settled";
    orphanGoalTurns.release();
    stdinWriter.close(new Error("The Codex App Server run ended."));
    settleStartupGate(
      new Error("The Codex App Server run ended before startup completed."),
    );
    decoder?.stop();
    settlePendingRequests(
      "Codex App Server stopped before responding.",
    );
    events?.dispose();
    events?.settleInteractions();
    if (eventHost) resetCodexRetryBudget(eventHost);
    ownedTerminationArmed = true;
    void (async () => {
      // Capture an earlier user cancellation at terminal acceptance. A later
      // cancellation cannot rewrite this outcome while owned cleanup drains.
      let finalStatus: CodexAppServerResult["status"] = cancelRequested ? "cancelled" : status;
      let cleanupConfirmed = true;
      if (
        finalStatus !== "cancelled"
        && (!failure || failure.reason === "codex-error")
        && child.exitCode === null
        && child.signalCode === null
        && providerNaturalCloseFirst()
      ) {
        endProviderInput(child);
        await waitForProviderNaturalClose(child);
      }
      try {
        // A terminal App Server turn has no further process work to preserve.
        // Use the same owned promise as cancellation, but avoid adding a
        // graceful-wait window after the provider has already settled.
        await terminateOwnedProcessTree(true);
        if (exitedBeforeOwnedTermination) {
          finalStatus = "failed";
          if (
            activeRuntimeOwnedProcessPlatform() === "win32"
            || runtimeOwnedProcessStopConfirmation(child) !== true
          ) {
            if (process.platform === "win32") recordWindowsCleanupFailure({
              phase: "provider-exited-before-stop", scope: "child", force: true,
              elapsedMs: 0, exitCode: child.exitCode,
            });
            cleanupConfirmed = false;
          }
        }
      } catch {
        cleanupConfirmed = false;
      }
      const finalFailure = finalStatus === "failed"
        ? settledFailure(
            child.exitCode ?? exitCode,
            child.signalCode ?? signal,
          )
        : undefined;
      resolveResult({
        status: finalStatus,
        ...(providerThreadId ? { sessionId: providerThreadId } : {}),
        text: resultText.toString(),
        textTruncated: resultText.truncated,
        exitCode: child.exitCode ?? exitCode,
        signal: child.signalCode ?? signal,
        ...((lastError || diagnostic.toString()) ? { diagnostic: lastError ?? diagnostic.toString() } : {}),
        ...(finalFailure ? { failure: finalFailure } : {}),
        ...(compatibilityError ? { compatibilityError } : {}),
        ...(continuationError ? { continuationError } : {}),
        ...(sessionInstructionDeferred ? { sessionInstructionApplied: false as const } : {}),
        ...events?.hookStop.resultFields(finalStatus, cancelRequested),
        cleanupConfirmed,
        ...(cleanupConfirmed ? {} : providerUnconfirmedCleanup(child)),
      });
    })();
  };

  const requestProcessTermination = (force: boolean): void => {
    ownedTerminationArmed = true;
    void terminateOwnedProcessTree(force).then(
      () => {
        if (!settled) {
          finish(
            cancelRequested ? "cancelled" : "failed",
            child.exitCode,
            child.signalCode,
          );
        }
      },
      (error: unknown) => {
        if (settled) return;
        rememberFailure(
          "process-exit",
          "Codex App Server process tree could not be confirmed stopped.",
          error instanceof Error ? error.message : undefined,
        );
        finish("failed", child.exitCode, child.signalCode);
      },
    );
  };

  const request = (
    method: string,
    params: JsonObject,
    onResponseFrame?: (result?: JsonObject) => void,
    recordFailure: CodexRequestFailureRecording = true,
    timeoutMs = options.rpcTimeoutMs ?? CODEX_RPC_TIMEOUT_MS,
    useCancellationReserve = false,
  ): Promise<JsonObject> => {
    const pendingLimit = MAX_CODEX_PENDING_CLIENT_REQUESTS
      + (useCancellationReserve
        ? MAX_CODEX_PENDING_CANCELLATION_REQUESTS
        : 0);
    if (pendingRequests.size >= pendingLimit) {
      const message =
        `Codex exceeded the ${pendingLimit}-request client RPC limit.`;
      rememberFailure(
        "malformed-protocol",
        "Too many Codex App Server requests were pending.",
        message,
      );
      return Promise.reject(new CodexRequestRefusedError(message));
    }
    if (!Number.isSafeInteger(nextRequestId)) {
      const message = "The Codex App Server JSON-RPC id space was exhausted.";
      rememberFailure("malformed-protocol", message);
      return Promise.reject(new CodexRequestRefusedError(message));
    }
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        if (recordFailure) {
          rememberFailure(
            "rpc-timeout",
            "Codex App Server did not respond in time.",
            `RPC method: ${method}`,
          );
        }
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      timeout.unref();
      pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeout,
        recordFailure,
        ...(onResponseFrame ? { onResponseFrame } : {}),
      });
      if (!writeMessage({ method, id, params })) {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        reject(new CodexRequestRefusedError(`Could not send ${method}.`));
      }
    });
  };

  const notify = (method: string, params?: JsonObject): void => {
    writeMessage(params === undefined ? { method } : { method, params });
  };

  const cancel = (force = false): void => {
    if (settled) return;
    cancelRequested = true;
    events.settleInteractions();
    const parentCompletionWasPending =
      events.cancelPendingParentCompletion();
    if (force || !spawned || !providerThreadId) {
      requestProcessTermination(force);
      return;
    }
    if (cancellationStarted) return;
    cancellationStarted = true;
    void (async () => {
      const childInterrupts = Promise.allSettled(
        events.interruptibleChildTurns().map(({ threadId, turnId }) =>
          request(
            "turn/interrupt",
            { threadId, turnId },
            undefined,
            false,
            CODEX_CHILD_INTERRUPT_TIMEOUT_MS,
            true,
          )),
      );
      let overallTimer: NodeJS.Timeout | undefined;
      const overallDeadline = new Promise<void>((resolve) => {
        overallTimer = setTimeout(
          resolve,
          CODEX_CHILD_INTERRUPT_OVERALL_TIMEOUT_MS,
        );
        overallTimer.unref();
      });
      await Promise.race([childInterrupts, overallDeadline]);
      if (overallTimer) clearTimeout(overallTimer);
      if (settled) return;
      if (parentCompletionWasPending) {
        finish("cancelled", null, null);
        return;
      }
      if (!activeTurnId) {
        requestProcessTermination(false);
        return;
      }
      try {
        await request(
          "turn/interrupt",
          { threadId: providerThreadId, turnId: activeTurnId },
          undefined,
          false,
          CODEX_ROOT_INTERRUPT_TIMEOUT_MS,
          true,
        );
        if (!settled) requestProcessTermination(false);
      } catch {
        if (!settled) requestProcessTermination(true);
      }
    })();
  };

  const orphanGoalTurns = new CodexOrphanGoalTurns(options, () => providerThreadId, request, () => events,
    options.rpcTimeoutMs ?? CODEX_RPC_TIMEOUT_MS);
  eventHost = {
    options,
    orphanGoalTurns,
    resultText,
    isSettled: () => settled,
    phase: () => phase,
    setPhase: (nextPhase) => {
      phase = nextPhase;
    },
    providerThreadId: () => providerThreadId,
    activeTurnId: () => activeTurnId,
    setActiveTurnId: (turnId) => {
      activeTurnId = turnId;
    },
    requestedTurnId: () => requestedTurnId,
    cancelRequested: () => cancelRequested,
    lastError: () => lastError,
    setLastError: (message) => {
      lastError = redactCodexErrorHeaders(message);
    },
    setLastProtocolMethod: (method) => {
      lastProtocolMethod = method;
    },
    setLastActivityId: (activityId) => {
      lastActivityId = activityId;
    },
    setTerminalEvent: (event) => {
      terminalEvent = event;
    },
    writeMessage,
    cancel: (reason) => {
      if (!cancelRequested && reason === "malformed-protocol") {
        // Rejecting unsafe provider output is a failed turn, not a user
        // cancellation. Accept it before a later interrupt/completion races
        // cleanup; finish still joins the same owned process-tree proof.
        rememberFailure(
          "malformed-protocol",
          "Codex sent an invalid App Server request.",
          lastError,
        );
        finish("failed", child.exitCode, child.signalCode);
      } else {
        cancel();
      }
    },
    finish,
    rememberFailure,
  };
  events = new CodexAppServerEvents(eventHost);

  const handleLine = (line: string): void => {
    if (settled) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      rememberFailure(
        "malformed-protocol",
        "Codex App Server returned a malformed protocol message.",
        "A JSONL frame could not be decoded as JSON.",
      );
      finish("failed", null, null);
      return;
    }
    const message = objectValue(parsed);
    if (!message) {
      rememberFailure(
        "malformed-protocol",
        "Codex App Server returned a malformed protocol message.",
        "The decoded JSONL frame was not a JSON object.",
      );
      finish("failed", null, null);
      return;
    }
    const id = rpcId(message.id);
    const method = stringValue(message.method);
    const params = objectValue(message.params) ?? {};
    lastProtocolMethod = method ?? lastProtocolMethod;

    if (id !== undefined && method) {
      try {
        events.handleServerRequest(id, method, params);
      } catch (error) {
        const detail = error instanceof Error
          ? error.message
          : "Codex server request handler threw an unexpected error.";
        lastError = redactCodexErrorHeaders(detail);
        rememberFailure(
          "malformed-protocol",
          "Codex App Server sent a server request that could not be processed.",
          detail,
        );
        finish("failed", null, null);
      }
      return;
    }
    if (id !== undefined && typeof id === "number") {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      try {
        pending.onResponseFrame?.(objectValue(message.result));
      } catch (error) {
        const detail = error instanceof Error
          ? error.message
          : "Codex response frame handler threw an unexpected error.";
        lastError = redactCodexErrorHeaders(detail);
        rememberFailure(
          "malformed-protocol",
          "Codex App Server returned a response frame that could not be processed.",
          detail,
        );
        pending.reject(error instanceof Error ? error : new Error(detail));
        finish("failed", null, null);
        return;
      }
      const error = objectValue(message.error);
      if (error) {
        const errorMessage =
          boundedText(error.message, 4_000) ?? `${pending.method} failed.`;
        const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : null;
        if (typeof pending.recordFailure === "function" ? pending.recordFailure(code, errorMessage) : pending.recordFailure) {
          rememberFailure(
            "codex-error",
            "Codex rejected a protocol request.",
            errorMessage,
          );
        }
        pending.reject(new CodexErrorResponse(errorMessage, code));
      } else {
        pending.resolve(objectValue(message.result) ?? {});
      }
      return;
    }
    if (method) {
      if (
        method === "turn/completed"
        && phase === "opening"
        && priorCompletedTurnIds.size < MAX_PRIOR_COMPLETED_TURN_IDS
      ) {
        const notificationThreadId = boundedText(params.threadId, 512);
        const completedId = boundedText(params.turnId, 512)
          ?? boundedText(objectValue(params.turn)?.id, 512);
        if (
          completedId
          && (!providerThreadId || !notificationThreadId || notificationThreadId === providerThreadId)
        ) {
          priorCompletedTurnIds.add(completedId);
        }
      }
      if (eventHost && SUBSTANTIVE_PROGRESS_METHODS.has(method)) {
        resetCodexRetryBudget(eventHost);
      }
      try {
        events.handleNotification(method, params);
      } catch (error) {
        const detail = error instanceof Error
          ? error.message
          : "Codex notification handler threw an unexpected error.";
        lastError = redactCodexErrorHeaders(detail);
        rememberFailure(
          "malformed-protocol",
          "Codex App Server sent a notification that could not be processed.",
          detail,
        );
        finish("failed", null, null);
      }
      return;
    }
    rememberFailure(
      "malformed-protocol",
      "Codex App Server returned a malformed protocol message.",
      "The JSON-RPC message could not be routed.",
    );
    finish("failed", null, null);
  };

  const decoderFailure = (decoderError: JsonLineDecoderFailure): void => {
    decoder?.stop();
    if (decoderError === "malformed-utf8") {
      rememberFailure(
        "malformed-protocol",
        "Codex App Server returned invalid UTF-8.",
        "The JSONL transport emitted a frame that was not valid UTF-8.",
      );
    } else if (decoderError === "line-overflow") {
      rememberFailure(
        "protocol-overflow",
        "Codex produced a protocol message that was too large to process safely.",
        `A JSONL frame exceeded ${protocolLimits.maxFrameBytes} bytes.`,
      );
    } else {
      rememberFailure(
        "protocol-overflow",
        "Codex produced protocol output too quickly to process safely.",
        `JSONL output exceeded the refillable ${
          protocolLimits.maxWindowBytes
        }-byte burst budget (${protocolLimits.windowMs} ms window).`,
      );
    }
    finish("failed", null, null);
  };

  decoder = new JsonLineDecoder(
    protocolLimits.maxFrameBytes,
    handleLine,
    decoderFailure,
    {
      maxBytes: protocolLimits.maxWindowBytes,
      windowMs: protocolLimits.windowMs,
    },
  );
  child.stdout.on("data", (chunk: Buffer) => decoder?.push(chunk));
  const handleTransportClose = (): void => {
    if (settled || transportCloseTimer) return;
    decoder?.end();
    if (settled) return;
    transportCloseTimer = setTimeout(() => {
      transportCloseTimer = undefined;
      if (settled) return;
      rememberTransportFailure(
        "The Codex App Server connection closed before the turn completed.",
      );
      finish("failed", null, null);
    }, CODEX_TRANSPORT_CLOSE_GRACE_MS);
    transportCloseTimer.unref();
  };
  child.stdout.once("end", handleTransportClose);
  child.stdout.once("close", handleTransportClose);
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic.append(chunk.toString("utf8"));
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    stdinWriter.close(error);
    handleWriteFailure(error);
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    lastError = error.message;
    rememberFailure(
      "process-exit",
      "Codex App Server could not be started.",
      error.message,
    );
    finish(cancelRequested ? "cancelled" : "failed", null, null);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    exitedBeforeOwnedTermination = !ownedTerminationArmed;
    rememberFailure(
      signal ? "process-signal" : "process-exit",
      codexAppServerExitMessage(code, signal, diagnostic.toString()),
    );
    finish(cancelRequested ? "cancelled" : "failed", code, signal);
  });

  child.once("spawn", () => {
    spawned = true;
    void openCodexTurn({
      options: turnOptions,
      modelProvider,
      request,
      notify,
      setProviderThreadId: (threadId) => {
        providerThreadId = threadId;
      },
      activeTurnId: () => activeTurnId,
      setActiveTurnId: (turnId) => {
        activeTurnId = turnId;
      },
      setRequestedTurnId: (turnId) => {
        requestedTurnId = turnId;
      },
      replayPreResponseTurnNotifications: (turnId) =>
        events.replayPreResponseTurnNotifications(turnId),
      goalTurns: { held: () => events.heldTurnStarted(), adopt: () => events.adoptHeldGoalTurn(),
        settle: () => orphanGoalTurns.awaitStopped(codexGoalMayContinue(options)) },
      phase: () => phase,
      hasObservedTurn: (turnId) => events.hasObservedTurn(turnId),
      hasCompletedTurn: (turnId: string) =>
        priorCompletedTurnIds.has(turnId)
        || (events.hasObservedTurn(turnId) && activeTurnId !== turnId),
      goalProjectionSequence: () => events.goalProjectionSequence(),
      beginGoalMutation: (activatesGoal) =>
        events.beginGoalMutation(activatesGoal),
      endGoalMutation: (activatesGoal) =>
        events.endGoalMutation(activatesGoal),
      awaitInitialGoalTurn: () => events.awaitInitialGoalTurn(),
      projectGoalResponse: (threadId, goal, sequenceAtResponse) =>
        events.projectGoalResponse(threadId, goal, sequenceAtResponse),
      setContinuationError: (error) => {
        continuationError = error;
      },
      setCompatibilityError: (error) => {
        compatibilityError = error;
      },
      deferSessionInstruction: () => {
        sessionInstructionDeferred = true;
      },
      setPhase: (nextPhase) => {
        phase = nextPhase;
      },
      isSettled: () => settled,
      isCancelRequested: () => cancelRequested,
      finish,
    }).then(() => {
      settleStartupGate();
    }, (error: unknown) => {
      settleStartupGate(error);
      if (
        options.access === "full"
        && isUnsupportedFullAccessError(error)
      ) {
        compatibilityError = "full-access-unsupported";
      }
      if (
        options.serviceTier !== undefined
        && isUnsupportedFastModeError(error)
      ) {
        compatibilityError = "fast-mode-unsupported";
      }
      lastError = error instanceof Error
        ? error.message
        : "Codex App Server could not start.";
      rememberFailure(
        error instanceof CodexProtocolViolationError ? "malformed-protocol" : "codex-error",
        error instanceof CodexProtocolViolationError
          ? "Codex App Server returned a malformed protocol message."
          : "Codex App Server could not start the turn.",
        lastError,
      );
      finish(cancelRequested ? "cancelled" : "failed", null, null);
    });
  });

  const steer = async (input: ProviderSteerInput): Promise<boolean> => {
    const text = input.content.replaceAll("\0", "").trim();
    if (
      !text
      || settled
      || cancelRequested
      || phase !== "running"
      || !providerThreadId
      || !activeTurnId
    ) return false;
    const expectedTurnId = activeTurnId;
    try {
      const receipt = await request("turn/steer", {
        threadId: providerThreadId,
        input: [
          { type: "text", text, text_elements: [] },
          ...input.imagePaths.map((path) => ({ type: "localImage", path })),
        ],
        expectedTurnId,
      }, (result) => {
        if (result?.turnId === expectedTurnId) events.deferAnswerBoundary();
      }, false);
      // Capture ownership before awaiting: completion can share the response's
      // stdout batch, but only this exact provider turn can acknowledge input.
      if (receipt.turnId === expectedTurnId) return true;
    } catch (error) {
      if (error instanceof CodexRequestRefusedError) return false;
    }
    throw new ProviderSteerDeliveryUnknownError(settled);
  };

  const setGoal = async (
    input: ProviderGoalMutation,
  ): Promise<ProviderGoalSnapshot> => serializeGoalMutation(async () => {
    if (settled || cancelRequested || !providerThreadId) {
      throw new Error("The Codex goal connection is not active.");
    }
    const ownedThreadId = providerThreadId;
    const params: JsonObject = {
      threadId: ownedThreadId,
      status: input.status,
    };
    if (input.objective !== undefined) params.objective = input.objective;
    if (input.tokenBudget !== undefined) {
      params.tokenBudget = input.tokenBudget;
    }
    const activatesGoal = input.status === "active";
    events.beginGoalMutation(activatesGoal);
    try {
      let sequenceAtResponse = events.goalProjectionSequence();
      const response = await request("thread/goal/set", params, () => {
        sequenceAtResponse = events.goalProjectionSequence();
      }, false);
      const parsed = events.projectGoalResponse(
        ownedThreadId,
        response.goal,
        sequenceAtResponse,
      );
      if (!parsed) throw new Error("Codex returned a malformed goal response.");
      return parsed;
    } finally {
      events.endGoalMutation(activatesGoal);
    }
  });

  const clearGoal = async (): Promise<boolean> => serializeGoalMutation(async () => {
    if (settled || cancelRequested || !providerThreadId) {
      throw new Error("The Codex goal connection is not active.");
    }
    const ownedThreadId = providerThreadId;
    events.beginGoalMutation(false);
    try {
      let sequenceAtResponse = events.goalProjectionSequence();
      await request(
        "thread/goal/clear",
        { threadId: ownedThreadId },
        () => {
          sequenceAtResponse = events.goalProjectionSequence();
        },
        false,
      );
      return events.projectGoalClearResponse(
        ownedThreadId,
        sequenceAtResponse,
      );
    } finally {
      events.endGoalMutation(false);
    }
  });

  return {
    child,
    result,
    cancel,
    respondToApproval: (requestId, decision) =>
      events.respondToApproval(requestId, decision),
    respondToInput: (requestId, answers) =>
      events.respondToInput(requestId, answers),
    steer,
    setGoal,
    clearGoal,
  };
}
