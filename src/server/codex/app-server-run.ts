import { spawn } from "node:child_process";
import { spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";

import { staleProviderSessionDecision } from "../../shared/continuation-policy";
import { INERTIA_VERSION } from "../../shared/version";
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
  codexAccessPolicy,
  codexProtocolLimits,
  codexServiceTierMatches,
  isStaleResumeError,
  isUnsupportedFastModeError,
  isUnsupportedFullAccessError,
  validateCodexModelProvider,
  type CodexRunPhase,
} from "./app-server-config";
import { CodexAppServerEvents } from "./app-server-events";
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
import type {
  CodexAppServerOptions,
  CodexAppServerResult,
  CodexAppServerRun,
} from "./types";
import {
  sanitizeProviderActivityDetail,
} from "../provider/activity-detail";
import type {
  ProviderGoalMutation,
  ProviderGoalSnapshot,
  ProviderRunFailure,
  ProviderSteerInput,
} from "../provider/contracts";
import { providerProcessInvocation } from "../provider/process";
import {
  createOwnedProcessTreeTermination,
} from "../process-lifecycle";

interface PendingClientRequest {
  method: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  recordFailure: boolean;
  onResponseFrame?: () => void;
}

export function startCodexAppServerRun(
  options: CodexAppServerOptions,
): CodexAppServerRun {
  const modelProvider = validateCodexModelProvider(options);
  const protocolLimits = codexProtocolLimits(options.protocolLimits);
  const invocation = providerProcessInvocation(
    options.executable,
    ["app-server"],
    options.environment,
  );
  const child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
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
  let resolveResult!: (result: CodexAppServerResult) => void;
  let startupGateReleased = false;
  let startupFailure: Error | undefined;
  let releaseStartupGate!: () => void;
  const startupGate = new Promise<void>((resolve) => {
    releaseStartupGate = resolve;
  });
  let goalMutationTail = Promise.resolve();
  let events: CodexAppServerEvents;
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
  ): void => {
    failure ??= {
      reason,
      message,
      phase,
      ...(terminalEvent ? { terminalEvent } : {}),
      ...(lastActivityId ? { activityId: lastActivityId } : {}),
      ...(technicalDetail ? { technicalDetail } : {}),
    };
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
    const technicalDetail = sanitizeProviderActivityDetail(
      details.join("\n"),
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
    rememberFailure(
      "transport-closed",
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
    ownedTerminationArmed = true;
    void (async () => {
      let finalStatus = status;
      let cleanupConfirmed = true;
      try {
        // A terminal App Server turn has no further process work to preserve.
        // Use the same owned promise as cancellation, but avoid adding a
        // graceful-wait window after the provider has already settled.
        await terminateOwnedProcessTree(true);
        if (exitedBeforeOwnedTermination) {
          finalStatus = "failed";
          cleanupConfirmed = false;
        }
      } catch (error) {
        finalStatus = "failed";
        cleanupConfirmed = false;
        rememberFailure(
          "process-exit",
          "Codex App Server process tree could not be confirmed stopped.",
          error instanceof Error ? error.message : undefined,
        );
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
        ...((lastError || diagnostic.toString())
          ? { diagnostic: lastError ?? diagnostic.toString() }
          : {}),
        ...(finalFailure ? { failure: finalFailure } : {}),
        ...(compatibilityError ? { compatibilityError } : {}),
        ...(continuationError ? { continuationError } : {}),
        cleanupConfirmed,
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
    onResponseFrame?: () => void,
    recordFailure = true,
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
      return Promise.reject(new Error(message));
    }
    if (!Number.isSafeInteger(nextRequestId)) {
      const message = "The Codex App Server JSON-RPC id space was exhausted.";
      rememberFailure("malformed-protocol", message);
      return Promise.reject(new Error(message));
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
        reject(new Error(`Could not send ${method}.`));
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

  events = new CodexAppServerEvents({
    options,
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
    cancelRequested: () => cancelRequested,
    lastError: () => lastError,
    setLastError: (message) => {
      lastError = message;
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
    cancel,
    finish,
    rememberFailure,
  });

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
      events.handleServerRequest(id, method, params);
      return;
    }
    if (id !== undefined && typeof id === "number") {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      pending.onResponseFrame?.();
      const error = objectValue(message.error);
      if (error) {
        const errorMessage =
          boundedText(error.message, 4_000) ?? `${pending.method} failed.`;
        if (pending.recordFailure) {
          rememberFailure(
            "codex-error",
            "Codex rejected a protocol request.",
            errorMessage,
          );
        }
        pending.reject(new Error(errorMessage));
      } else {
        pending.resolve(objectValue(message.result) ?? {});
      }
      return;
    }
    if (method) {
      events.handleNotification(method, params);
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
      rememberFailure(
        "transport-closed",
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
      signal
        ? "Codex App Server stopped unexpectedly."
        : "Codex App Server exited before the turn completed.",
    );
    finish(cancelRequested ? "cancelled" : "failed", code, signal);
  });

  child.once("spawn", () => {
    spawned = true;
    void openCodexTurn({
      options,
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
      phase: () => phase,
      hasObservedTurn: (turnId) => events.hasObservedTurn(turnId),
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
        "codex-error",
        "Codex App Server could not start the turn.",
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
    try {
      await request("turn/steer", {
        threadId: providerThreadId,
        input: [
          { type: "text", text, text_elements: [] },
          ...input.imagePaths.map((path) => ({ type: "localImage", path })),
        ],
        expectedTurnId: activeTurnId,
      }, undefined, false);
      return true;
    } catch {
      return false;
    }
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

interface OpenCodexTurnOptions {
  options: CodexAppServerOptions;
  modelProvider: CodexAppServerOptions["modelProvider"];
  request: (
    method: string,
    params: JsonObject,
    onResponseFrame?: () => void,
    recordFailure?: boolean,
  ) => Promise<JsonObject>;
  notify: (method: string, params?: JsonObject) => void;
  setProviderThreadId: (threadId: string) => void;
  activeTurnId: () => string | undefined;
  setActiveTurnId: (turnId: string | undefined) => void;
  phase: () => CodexRunPhase;
  hasObservedTurn: (turnId: string) => boolean;
  goalProjectionSequence: () => number;
  beginGoalMutation: (activatesGoal: boolean) => void;
  endGoalMutation: (activatesGoal: boolean) => void;
  awaitInitialGoalTurn: () => void;
  projectGoalResponse: (
    threadId: string,
    goal: unknown,
    sequenceAtResponse: number,
  ) => ProviderGoalSnapshot | null;
  setContinuationError: (
    error: CodexAppServerResult["continuationError"],
  ) => void;
  setCompatibilityError?: (
    error: CodexAppServerResult["compatibilityError"],
  ) => void;
  setPhase: (phase: CodexRunPhase) => void;
  isSettled: () => boolean;
  isCancelRequested: () => boolean;
  finish: (
    status: CodexAppServerResult["status"],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
}

export async function openCodexTurn({
  options,
  modelProvider,
  request,
  notify,
  setProviderThreadId,
  activeTurnId,
  setActiveTurnId,
  phase,
  hasObservedTurn,
  goalProjectionSequence,
  beginGoalMutation,
  endGoalMutation,
  awaitInitialGoalTurn,
  projectGoalResponse,
  setContinuationError,
  setCompatibilityError,
  setPhase,
  isSettled,
  isCancelRequested,
  finish,
}: OpenCodexTurnOptions): Promise<void> {
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
  const threadConfig = {
    cwd: options.cwd,
    approvalPolicy: accessPolicy.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: accessPolicy.threadSandbox,
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort
      ? { effort: options.reasoningEffort }
      : {}),
    ...(options.serviceTier !== undefined
      ? { serviceTier: options.serviceTier }
      : {}),
    ...(modelProvider ? {
      modelProvider: modelProvider.providerId,
      config: {
        [`model_providers.${modelProvider.providerId}`]: {
          name: modelProvider.displayName,
          base_url: modelProvider.baseUrl,
          wire_api: "responses",
          requires_openai_auth: false,
          ...(modelProvider.credentialEnvironmentKey
            ? { env_key: modelProvider.credentialEnvironmentKey }
            : {}),
        },
      },
    } : {}),
  };
  let opened: JsonObject;
  if (options.sessionId) {
    try {
      // The audited App Server protocol persists thread/start dynamic tools in
      // its rollout/state DB and exposes no registration field on resume.
      // Schema 65 clears Codex identities from before the current Browser tool
      // capability epoch, so persisted sessions reaching this path own them.
      opened = await request("thread/resume", {
        threadId: options.sessionId,
        excludeTurns: true,
        ...threadConfig,
      });
    } catch (error) {
      if (!isStaleResumeError(error)) throw error;
      setContinuationError("stale-provider-session");
      throw new Error(staleProviderSessionDecision().reason);
    }
  } else {
    opened = await request("thread/start", {
      ...threadConfig,
      ...(options.hostTools
        ? {
            dynamicTools: options.hostTools.definitions.map((definition) => ({
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
  setProviderThreadId(openedThreadId);
  options.onSession?.(openedThreadId);
  if (isCancelRequested()) {
    finish("cancelled", null, null);
    return;
  }

  if (options.goalStart) {
    setPhase("starting-turn");
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
  // The visible user message already contains Codex's explicit `$name`
  // invocation. Keep the structured item only as the authoritative path
  // capability; prepending another token would make provider input diverge
  // from the persisted transcript.
  for (const skill of options.skills ?? []) {
    if (
      skill.source !== "codex-native"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(skill.name)
    ) {
      throw new Error("Codex received an invalid selected skill.");
    }
  }
  const input: JsonObject[] = [{
    type: "text",
    text: options.prompt,
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
  setPhase("starting-turn");
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
    summary: "auto",
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
  });
  if (isSettled()) return;
  const turn = objectValue(started.turn);
  const startedTurnId = boundedText(turn?.id, 512);
  if (!startedTurnId) {
    throw new Error("Codex did not return a turn identifier.");
  }
  // Notifications can share the response's stdout chunk and complete the
  // turn before this await resumes. Preserve the event-driven phase instead
  // of resurrecting a completed turn as running.
  if (phase() !== "starting-turn") {
    if (!hasObservedTurn(startedTurnId)) {
      throw new Error("Codex returned inconsistent turn identifiers.");
    }
    return;
  }
  if (activeTurnId() && activeTurnId() !== startedTurnId) {
    throw new Error("Codex returned inconsistent turn identifiers.");
  }
  setActiveTurnId(startedTurnId);
  setPhase("running");
  options.onStatus?.("running");
}
