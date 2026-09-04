import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

import {
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";
import { INERTIA_VERSION } from "../../shared/version";
import {
  createOwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { providerActivityDetailSections } from "./activity-detail";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type GeminiAcpHarnessCapabilities,
} from "./agent-harness";
import { isSafeApprovalDisplayText } from "./approval-display";
import type { ProviderRunFailure, ProviderRunResult } from "./contracts";
import type { AgentApprovalDecision } from "./interactions";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import {
  createProviderHostToolMcpSession,
  type ProviderHostToolMcpConnection,
  type ProviderHostToolMcpSession,
} from "./host-tool-mcp-http";
import { acpHostMcpServers } from "./host-tool-mcp-config";
import {
  GeminiAcpSecretRedactor,
  geminiDotenvSecretValues,
} from "./gemini-acp-redaction";
import {
  cleanupGeminiSessionArtifacts,
  type GeminiSessionCleanupRequest,
} from "./gemini-session-cleanup";
import {
  BoundedGeminiJsonLineTransform,
  geminiErrorDetail,
  geminiRuntimeFailure,
  geminiSpawnFailure,
  geminiStopFailure,
  observeGeminiProcessExit,
} from "./gemini-acp-support";
import {
  configureGeminiSession,
  geminiPrompt,
  geminiPromptWithReconstructedHistory,
  parseGeminiNewSessionResponse,
  parseGeminiPromptResponse,
  type GeminiSessionModels,
  withGeminiRpcDeadline,
} from "./gemini-acp-session";
import { providerProcessInvocation } from "./process";
import {
  emitGeminiMetadata,
  emitGeminiPromptUsage,
  planSteps,
  tokenCount,
  toolActivityPhase,
  validateGeminiInitialize,
} from "./gemini-acp-projection";
import { parseAcpSessionNotification } from "./acp-json-rpc";

const MAX_WIRE_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_PENDING_INTERACTIONS = 64;
const MAX_TRACKED_TOOL_ACTIVITIES = 1_024;
const MAX_TOOL_STATE_TEXT_CHARS = 4 * 1024;
const MAX_RUN_EVENTS = 8_192;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const CONTROL_RPC_TIMEOUT_MS = 30_000;

export const GEMINI_ACP_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "application-context", identity: "conversation" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "gemini-acp",
    protocol: "acp-v1-json-rpc",
    approvals: "native",
    questions: "unavailable-in-current-acp",
    plans: "mode-and-acp-updates",
    reasoning: "native",
    usage: "prompt-response-and-acp-updates",
    images: "capability-negotiated",
    authentication: "gemini-cli",
    modelMetadata: "experimental-session-models",
  },
} as const satisfies GeminiAcpHarnessCapabilities;

export interface GeminiAcpHarnessOptions {
  /** Test seam for the owned ACP process-tree lifecycle. */
  terminateProcessTree?: ProcessTreeTerminator;
  /** Test seam for bounded initialize/auth/session/configuration RPCs. */
  controlRpcTimeoutMs?: number;
  /** Test seam for proving host-tool cleanup authority. */
  createHostMcpSession?(
    runtime: ProviderHostToolRuntime,
  ): ProviderHostToolMcpSession;
  /** Test seam for exact provider-owned local session-record cleanup. */
  cleanupSessionArtifacts?(request: GeminiSessionCleanupRequest): Promise<void>;
}

interface PendingApproval {
  resolve: (decision: AgentApprovalDecision) => void;
  settled: boolean;
}

interface TurnEvidence {
  assistantText: boolean;
}

interface GeminiContextUsage {
  usedTokens: number | null;
  maxTokens: number | null;
}

interface ToolActivity {
  kind: "command" | "tool";
  label: string;
  command?: string;
  status?: ToolCallStatus | null;
}

export function geminiAcpProcessInvocation(
  executable: string,
  outerSessionId: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  return providerProcessInvocation(
    executable,
    ["--acp", "--session-id", outerSessionId],
    environment,
    platform,
  );
}

/**
 * Gemini 0.58 includes only the first eight session-id characters in its chat
 * filename. Keep 48 bits of entropy at the beginning to avoid the deterministic
 * collision that a shared product-name prefix would cause for concurrent runs.
 */
export function createGeminiOuterSessionId(
  entropy: Uint8Array = randomBytes(18),
): string {
  if (entropy.byteLength !== 18) {
    throw new Error("Gemini outer-session entropy must contain exactly 18 bytes.");
  }
  return `${Buffer.from(entropy).toString("base64url")}-inertia`;
}

export function createGeminiAcpHarness(
  options: GeminiAcpHarnessOptions = {},
): AgentHarness {
  return {
    id: "gemini-acp",
    providerId: "gemini",
    capabilities: GEMINI_ACP_CAPABILITIES,
    supports: (input) => input.providerId === "gemini",
    start: (startOptions) => startGeminiRun(
      startOptions,
      options.terminateProcessTree,
      options.controlRpcTimeoutMs,
      options.createHostMcpSession,
      options.cleanupSessionArtifacts,
    ),
  };
}

function startGeminiRun(
  options: AgentHarnessStartOptions,
  terminateProcessTree?: ProcessTreeTerminator,
  controlRpcTimeoutMs = CONTROL_RPC_TIMEOUT_MS,
  createHostMcpSession = createProviderHostToolMcpSession,
  cleanupSessionArtifacts = cleanupGeminiSessionArtifacts,
): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter(
    "gemini",
    conversationId,
    options.callbacks,
    options.input.runId ?? conversationId,
    options.input.turnId ?? null,
    options.input.cwd,
  );
  if (options.input.operation?.kind === "compact") {
    return failedGeminiRun(conversationId, {
      reason: "provider-error",
      message: "Gemini ACP does not expose a context-compaction command.",
      phase: "configuration",
      terminalEvent: "session/compaction:unsupported",
    }, emitter, options.input.sessionId);
  }
  if (options.input.sessionId) {
    return failedGeminiRun(conversationId, {
      reason: "provider-error",
      message:
        "Gemini ACP native session loading is disabled because the current CLI cannot replay it safely.",
      phase: "configuration",
      terminalEvent: "session/load:unsupported",
    }, emitter);
  }
  let activeRun: AgentHarnessRun | undefined;
  let cancelBeforeStart = false;
  emitter.status("starting");

  const result = geminiDotenvSecretValues(
    options.input.cwd,
    options.environment,
  ).then(
    (dotenvSecrets): Promise<ProviderRunResult> | ProviderRunResult => {
      if (cancelBeforeStart) {
        emitter.status("cancelled");
        return {
          providerId: "gemini",
          conversationId,
          status: "cancelled",
          text: "",
          textTruncated: false,
          exitCode: null,
          signal: null,
          cleanupConfirmed: true,
        };
      }
      activeRun = startPreparedGeminiRun(
        options,
        terminateProcessTree,
        controlRpcTimeoutMs,
        createHostMcpSession,
        cleanupSessionArtifacts,
        dotenvSecrets,
        emitter,
      );
      return activeRun.result;
    },
    (): Promise<ProviderRunResult> => {
      const failure: ProviderRunFailure = {
        reason: "provider-error",
        message: "Gemini environment files could not be inspected safely.",
        phase: "configuration",
        terminalEvent: "environment/dotenv",
      };
      return failedGeminiRun(
        conversationId,
        failure,
        emitter,
      ).result;
    },
  );

  const cancel = (force: boolean): void => {
    if (activeRun) {
      activeRun.cancel(force);
      return;
    }
    if (cancelBeforeStart && !force) return;
    cancelBeforeStart = true;
    emitter.status("cancelling");
  };

  return {
    harnessId: "gemini-acp",
    providerId: "gemini",
    result,
    cancel,
    extension: {
      kind: "gemini-acp",
      respondToApproval: (requestId, decision) => {
        const extension = activeRun?.extension;
        return extension?.kind === "gemini-acp"
          ? extension.respondToApproval(requestId, decision)
          : false;
      },
      respondToInput: () => false,
    },
  };
}

function startPreparedGeminiRun(
  options: AgentHarnessStartOptions,
  terminateProcessTree: ProcessTreeTerminator | undefined,
  controlRpcTimeoutMs: number,
  createHostMcpSession: (
    runtime: ProviderHostToolRuntime,
  ) => ProviderHostToolMcpSession,
  cleanupSessionArtifacts: (
    request: GeminiSessionCleanupRequest,
  ) => Promise<void>,
  dotenvSecrets: readonly string[],
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const resultText = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const stderr = new CappedProviderBuffer(MAX_STDERR_CHARS);
  const secretRedactor = new GeminiAcpSecretRedactor(options.environment);
  secretRedactor.addSecrets(dotenvSecrets);
  const promptPreparationAbort = new AbortController();
  const approvals = new Map<string, PendingApproval>();
  const toolActivities = new Map<string, ToolActivity>();
  const turnEvidence: TurnEvidence = { assistantText: false };
  const contextUsage: GeminiContextUsage = {
    usedTokens: null,
    maxTokens: null,
  };
  // Gemini CLI initializes one outer CLI chat before ACP session/new creates
  // its separate protocol chat. Own both exact identities so neither local
  // transcript survives this application-reconstructed session boundary.
  const outerSessionId = createGeminiOuterSessionId();
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
  const hostMcpSession = hostToolRuntime
    ? createHostMcpSession(hostToolRuntime)
    : undefined;
  let hostMcpConnection: ProviderHostToolMcpConnection | undefined;
  const redactGeminiPayload = <T>(value: T): T => secretRedactor.payload(value);
  let sessionId = options.input.sessionId;
  let cancelRequested = false;
  let sessionReady = false;
  let outerSessionRecordExpected = false;
  let innerSessionRecordExpected = false;
  let promptInFlight = false;
  let supportsImages = false;
  let activeContext: acp.ClientContext | undefined;
  let activeFailurePhase = "initialize";
  let activeTerminalEvent = "initialize";
  let callbackError: unknown;
  let processError: Error | undefined;
  let wireError: Error | undefined;
  let child: ChildProcessWithoutNullStreams;
  let requestProcessTermination = (_force: boolean): void => {};

  const settleApproval = (
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean => {
    const pending = approvals.get(requestId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    approvals.delete(requestId);
    emitter.rich({ type: "approval-resolved", requestId, decision });
    pending.resolve(decision);
    return true;
  };
  const cancelPending = (): void => {
    for (const requestId of approvals.keys()) settleApproval(requestId, "cancel");
  };

  const client = acp.client({ name: "Inertia" })
    .onRequest(
      acp.methods.client.session.requestPermission,
      async ({ params, signal }) => {
        if (
          cancelRequested
          || !sessionId
          || !sessionReady
          || !promptInFlight
          || params.sessionId !== sessionId
        ) return { outcome: { outcome: "cancelled" } };
        return geminiPermission(
          params,
          redactGeminiPayload(params),
          signal,
          options,
          emitter.rich,
          approvals,
        );
      },
    )
    .onNotification(acp.methods.client.session.update, (value) => {
      try {
        return parseAcpSessionNotification(value) as SessionNotification;
      } catch (error) {
        wireError = error instanceof Error
          ? error
          : new Error("Gemini ACP sent an invalid session update.");
        requestProcessTermination(true);
        throw wireError;
      }
    }, ({ params: rawParams }) => {
      try {
        const params = redactGeminiPayload(rawParams);
        if (!sessionId || params.sessionId !== sessionId) return;
        if (!sessionReady || !promptInFlight) return;
        if (cancelRequested && !isTerminalToolUpdate(params)) return;
        handleGeminiUpdate(
          params,
          resultText,
          emitter,
          toolActivities,
          turnEvidence,
          contextUsage,
          secretRedactor,
        );
      } catch (error) {
        wireError = error instanceof Error
          ? error
          : new Error("Gemini ACP sent an invalid session update.");
        requestProcessTermination(true);
      }
    });

  try {
    const invocation = geminiAcpProcessInvocation(
      options.executable,
      outerSessionId,
      options.environment,
    );
    const ownedInvocation = runtimeOwnedProcessInvocation(
      invocation.command,
      invocation.args,
    );
    child = spawnRuntimeOwnedProcess(() => spawn(ownedInvocation.command, ownedInvocation.args, {
      cwd: options.input.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    const failure = geminiSpawnFailure(
      error,
      options.input.cwd,
      (value) => redactGeminiPayload(value),
    );
    return failedGeminiRun(
      conversationId,
      failure,
      emitter,
    );
  }
  child.once("error", (error) => {
    processError = error;
    stderr.append(secretRedactor.stderrChunk(
      geminiErrorDetail(
        error,
        "Gemini ACP process error.",
        (value) => redactGeminiPayload(value),
      ),
    ));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr.append(secretRedactor.stderrChunk(chunk));
  });
  child.stderr.once("end", () => {
    stderr.append(secretRedactor.finishStderr());
  });
  child.stdin.on("error", () => { /* The ACP SDK surfaces connection failures. */ });

  const wireGuard = new BoundedGeminiJsonLineTransform(
    MAX_WIRE_LINE_BYTES,
    new ProviderRunEventBudget(
      "Gemini ACP",
      MAX_WIRE_LINE_BYTES,
      MAX_RUN_EVENTS,
      MAX_RUN_EVENT_BYTES,
    ),
  );
  wireGuard.once("error", (error: Error) => {
    wireError = error;
  });
  child.stdout.pipe(wireGuard);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(wireGuard) as ReadableStream<Uint8Array>,
  );
  const terminateOwnedProcessTree = createOwnedProcessTreeTermination(
    child,
    "Gemini ACP process tree",
    terminateProcessTree,
  );
  requestProcessTermination = (force: boolean): void => {
    void terminateOwnedProcessTree(force).catch(() => undefined);
  };
  const requestControl = <T>(request: Promise<T>, method: string): Promise<T> =>
    withGeminiRpcDeadline(
      request,
      controlRpcTimeoutMs,
      method,
      () => requestProcessTermination(true),
    ).then(redactGeminiPayload);

  const providerResult = client.connectWith(
    stream,
    async (context): Promise<ProviderRunResult> => {
      try {
      activeContext = context;
      activeFailurePhase = "initialize";
      activeTerminalEvent = "initialize";
      const initializeResponse = await requestControl(
        context.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          // Do not advertise fs/terminal or compaction: Inertia does not expose
          // those client RPCs, and Gemini has no ACP compaction command.
          clientCapabilities: { plan: {} },
          clientInfo: { name: "Inertia", version: INERTIA_VERSION },
        }),
        "initialize",
      );
      // A successful initialize RPC means Gemini has initialized and recorded
      // its outer CLI chat, even if its returned capabilities later fail our
      // stricter validation.
      outerSessionRecordExpected = true;
      const initialized = validateGeminiInitialize(initializeResponse);
      supportsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
      // Gemini always advertises every auth mechanism. Calling authenticate
      // here would mutate the user's selected CLI auth method and can clear
      // cached credentials. session/new is the auth authority.
      hostMcpConnection = await hostMcpSession?.start();
      if (hostMcpConnection) {
        secretRedactor.addSecrets([
          hostMcpConnection.bearerToken,
          hostMcpConnection.url,
        ]);
      }
      const hostMcpServers = hostMcpConnection
        ? acpHostMcpServers(
            hostMcpConnection,
            initialized.agentCapabilities?.mcpCapabilities?.http === true,
          )
        : [];

      activeFailurePhase = "session";
      activeTerminalEvent = "session/new";
      const created = parseGeminiNewSessionResponse(await requestControl(
        context.request(acp.methods.agent.session.new, {
          cwd: options.input.cwd,
          mcpServers: hostMcpServers,
        }),
        "session/new",
      ));
      sessionId = created.sessionId;
      innerSessionRecordExpected = true;
      let models: GeminiSessionModels | null = created.models;

      activeFailurePhase = "configuration";
      activeTerminalEvent = "session/configuration";
      models = await configureGeminiSession(
        context,
        sessionId,
        created.modes,
        models,
        options.input.interactionMode,
        options.input.model,
        options.input.reasoningEffort,
        requestControl,
      );
      emitGeminiMetadata(models, supportsImages, emitter.rich);

      const prompt = await geminiPrompt(
        geminiPromptWithReconstructedHistory(
          options.input.prompt,
          options.input.reconstructedHistory,
        ),
        options.input.imagePaths ?? [],
        initialized,
        promptPreparationAbort.signal,
      );
      if (cancelRequested) {
        requestProcessTermination(true);
        return finish("cancelled");
      }
      sessionReady = true;
      emitter.status("running");
      activeFailurePhase = "turn";
      activeTerminalEvent = "session/prompt";
      promptInFlight = true;
      const response = parseGeminiPromptResponse(redactGeminiPayload(await context.request(
        acp.methods.agent.session.prompt,
        { sessionId, prompt },
      ).finally(() => {
        promptInFlight = false;
      })));
      if (wireError) throw wireError;
      finishOutputStreams();
      emitGeminiPromptUsage(response, contextUsage, emitter.rich);
      const outcome = cancelRequested || response.stopReason === "cancelled"
        ? finish("cancelled")
        : response.stopReason === "end_turn"
          // Current Gemini ACP collapses most internal failed turns into
          // end_turn. Empty turns can fail closed; partial-output failures are
          // wire-indistinguishable until the upstream adapter exposes them.
          ? turnEvidence.assistantText
            ? finish("completed")
            : (() => {
                const failure: ProviderRunFailure = {
                  reason: "provider-error",
                  message:
                    "Gemini ACP ended without returning assistant text; the underlying Gemini turn may have failed.",
                  phase: "turn",
                  terminalEvent: "session/prompt:empty-end-turn",
                };
                return finish("failed", failure.message, failure);
              })()
          : (() => {
              const failure = geminiStopFailure(response.stopReason);
              return finish("failed", failure.message, failure);
            })();
      child.stdin.end();
      requestProcessTermination(false);
      return outcome;
      } catch (error) {
        // The ACP SDK may surface a generic closed-transport error after a
        // client callback rejects. Preserve the authoritative validation or
        // configuration failure so diagnostics and retry policy stay exact.
        callbackError = error;
        throw error;
      }
    },
  ).catch(async (error: unknown) => {
    // A failed or externally-cancelled prompt is not an authoritative stream
    // boundary. Never release a buffered suffix that may be the beginning of a
    // credential; only a validated session/prompt response flushes it.
    discardOutputStreams();
    if (cancelRequested) {
      requestProcessTermination(true);
      return finish("cancelled");
    }
    await observeGeminiProcessExit(child);
    stderr.append(secretRedactor.finishStderr());
    const diagnostic = redactGeminiPayload(stderr.toString().trim());
    const safeError = geminiErrorDetail(
      callbackError ?? error,
      "Gemini ACP stopped unexpectedly.",
      (value) => redactGeminiPayload(value),
    );
    const safeWireError = wireError
      ? new Error(geminiErrorDetail(
          wireError,
          "Gemini ACP wire error.",
          (value) => redactGeminiPayload(value),
        ))
      : undefined;
    const safeProcessError = processError
      ? new Error(geminiErrorDetail(
          processError,
          "Gemini ACP process error.",
          (value) => redactGeminiPayload(value),
        ))
      : undefined;
    const failure = geminiRuntimeFailure(safeError, {
      child,
      processError: safeProcessError,
      wireError: safeWireError,
      diagnostic,
      phase: activeFailurePhase,
      terminalEvent: activeTerminalEvent,
      workspaceRoot: options.input.cwd,
    });
    requestProcessTermination(true);
    return finish("failed", failure.message, failure);
  });

  const result = providerResult.then(async (outcome): Promise<ProviderRunResult> => {
    cancelPending();
    hostToolRuntime?.settle();
    let hostToolsCleanupFailed = false;
    let processCleanupFailed = false;
    let sessionCleanupFailed = false;
    try {
      await hostMcpSession?.close();
    } catch {
      hostToolsCleanupFailed = true;
    }
    try {
      await terminateOwnedProcessTree(false);
    } catch {
      processCleanupFailed = true;
    }
    if (!processCleanupFailed) {
      try {
        await cleanupSessionArtifacts({
          cwd: options.input.cwd,
          environment: options.environment,
          sessionIds: [
            outerSessionId,
            ...(sessionId ? [sessionId] : []),
          ],
          requiredSessionIds: [
            ...(outerSessionRecordExpected ? [outerSessionId] : []),
            ...(innerSessionRecordExpected && sessionId ? [sessionId] : []),
          ],
        });
      } catch {
        sessionCleanupFailed = true;
      }
    }
    const cleanupFailure = processCleanupFailed
      ? {
          reason: "process-exit" as const,
          message: "Gemini ACP process tree could not be confirmed stopped.",
          terminalEvent: "process/cleanup",
        }
      : sessionCleanupFailed
        ? {
            reason: "provider-error" as const,
            message: "Gemini provider session artifacts could not be cleaned up.",
            terminalEvent: "gemini-session/cleanup",
          }
        : hostToolsCleanupFailed
          ? {
              reason: "provider-error" as const,
              message: "Gemini Inertia chat tools could not be cleaned up.",
              terminalEvent: "host-tools/cleanup",
            }
          : null;
    if (cleanupFailure) {
      const error = cleanupFailure.message;
      emitter.status("failed", error);
      return {
        ...outcome,
        status: "failed",
        exitCode: child.exitCode,
        signal: child.signalCode,
        error,
        failure: {
          reason: cleanupFailure.reason,
          message: error,
          phase: "cleanup",
          terminalEvent: cleanupFailure.terminalEvent,
        },
        cleanupConfirmed: false,
      };
    }
    emitter.status(outcome.status, outcome.error);
    return {
      ...outcome,
      exitCode: child.exitCode,
      signal: child.signalCode,
    };
  });

  function finish(
    status: ProviderRunResult["status"],
    error?: string,
    failure?: ProviderRunFailure,
  ): ProviderRunResult {
    return {
      providerId: "gemini",
      conversationId,
      status,
      text: resultText.toString(),
      textTruncated: resultText.truncated,
      exitCode: child.exitCode,
      signal: child.signalCode,
      cleanupConfirmed: true,
      ...(error ? { error } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  function finishOutputStreams(): void {
    const assistant = secretRedactor.finishAssistant();
    if (assistant) {
      if (assistant.trim()) turnEvidence.assistantText = true;
      resultText.append(assistant);
      emitter.text(assistant);
    }
    const reasoning = secretRedactor.finishReasoning();
    if (reasoning) {
      emitter.rich({ type: "reasoning-summary", text: reasoning });
    }
  }

  function discardOutputStreams(): void {
    secretRedactor.discardStreams();
  }

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    discardOutputStreams();
    cancelRequested = true;
    promptPreparationAbort.abort();
    hostToolRuntime?.settle();
    void hostMcpSession?.close().catch(() => requestProcessTermination(true));
    emitter.status("cancelling");
    cancelPending();
    if (!force && promptInFlight && sessionId && activeContext) {
      void activeContext.notify(acp.methods.agent.session.cancel, { sessionId })
        .catch(() => requestProcessTermination(true));
      return;
    }
    requestProcessTermination(force);
  };

  return {
    harnessId: "gemini-acp",
    providerId: "gemini",
    result,
    cancel,
    extension: {
      kind: "gemini-acp",
      respondToApproval: (requestId, decision) =>
        hostToolRuntime?.respondToApproval(requestId, decision)
        || settleApproval(requestId, decision),
      respondToInput: () => false,
    },
  };
}

async function geminiPermission(
  params: RequestPermissionRequest,
  displayParams: RequestPermissionRequest,
  signal: AbortSignal,
  options: AgentHarnessStartOptions,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
  approvals: Map<string, PendingApproval>,
): Promise<RequestPermissionResponse> {
  const allow = oneShotPermissionOption(params.options, true);
  const fileMutation = isFileMutationKind(params.toolCall.kind);
  if (options.input.interactionMode === "plan") {
    return { outcome: { outcome: "cancelled" } };
  }
  if (
    options.input.access === "full"
    || (options.input.access === "auto-edit" && fileMutation)
  ) {
    return allow
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  if (!permissionDisplayIsSafe(displayParams)) {
    return { outcome: { outcome: "cancelled" } };
  }
  const requestId = randomUUID();
  const decision = await new Promise<AgentApprovalDecision>((resolve) => {
    if (approvals.size >= MAX_PENDING_INTERACTIONS) {
      throw new Error("Gemini exceeded the bounded approval budget.");
    }
    approvals.set(requestId, { resolve, settled: false });
    signal.addEventListener("abort", () => {
      const pending = approvals.get(requestId);
      if (!pending || pending.settled) return;
      pending.settled = true;
      approvals.delete(requestId);
      emit({ type: "approval-resolved", requestId, decision: "cancelled" });
      resolve("cancel");
    }, { once: true });
    emit({
      type: "approval",
      request: {
        requestId,
        kind: params.toolCall.kind === "execute"
          ? "command"
          : fileMutation
            ? "file-change"
            : "permissions",
        title: bounded(
          displayParams.toolCall.title || "Gemini requested permission",
        ),
        detail: bounded(permissionDetail(displayParams)),
        cwd: options.input.cwd,
        permissionRoots: [],
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
  });
  if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
  const selected = oneShotPermissionOption(
    params.options,
    decision === "approve",
  );
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function permissionDisplayIsSafe(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  return isSafeApprovalDisplayText(
    params.toolCall.title || "Gemini requested permission",
  ) && isSafeApprovalDisplayText(permissionDetail(params), true);
}

function isFileMutationKind(kind: ToolKind | null | undefined): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

function oneShotPermissionOption(
  options: PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  return options.find(({ kind }) =>
    kind === (allow ? "allow_once" : "reject_once"),
  );
}

function isTerminalToolUpdate(notification: SessionNotification): boolean {
  const update = notification.update;
  return update.sessionUpdate === "tool_call_update"
    && (update.status === "completed" || update.status === "failed");
}

function handleGeminiUpdate(
  notification: SessionNotification,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  toolActivities: Map<string, ToolActivity>,
  turnEvidence: TurnEvidence,
  contextUsage: GeminiContextUsage,
  secretRedactor: GeminiAcpSecretRedactor,
): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return;
    case "agent_message_chunk":
      if (update.content.type === "text") {
        const value = secretRedactor.assistantChunk(bounded(update.content.text));
        if (value.trim()) turnEvidence.assistantText = true;
        if (value) {
          resultText.append(value);
          emitter.text(value);
        }
      }
      return;
    case "agent_thought_chunk":
      if (update.content.type === "text") {
        const value = secretRedactor.reasoningChunk(bounded(update.content.text));
        if (value) {
          emitter.rich({
            type: "reasoning-summary",
            text: value,
          });
        }
      }
      return;
    case "tool_call": {
      const activityId = boundedId(update.toolCallId, "tool call");
      if (
        !toolActivities.has(activityId)
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) throw new Error("Gemini exceeded the bounded tool activity budget.");
      const kind = update.kind === "execute" ? "command" : "tool";
      const label = boundedToolStateText(update.title || "Gemini tool");
      const phase = toolActivityPhase(update.status);
      const rawInput = objectValue(update.rawInput);
      const command = typeof rawInput?.command === "string"
        ? boundedToolStateText(rawInput.command)
        : undefined;
      const detail = providerActivityDetailSections({
        command,
        [phase === "failed" ? "error" : "output"]:
          update.rawOutput ?? update.content,
      });
      emitter.activity(kind, phase, label, {
        activityId,
        ...(detail ? { detail } : {}),
      });
      if (phase === "completed" || phase === "failed") {
        toolActivities.delete(activityId);
      } else {
        toolActivities.set(activityId, {
          kind,
          label,
          ...(command ? { command } : {}),
          status: update.status,
        });
      }
      return;
    }
    case "tool_call_update": {
      const activityId = boundedId(update.toolCallId, "tool call");
      const existing = toolActivities.get(activityId);
      if (
        !existing
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) throw new Error("Gemini exceeded the bounded tool activity budget.");
      const kind = update.kind === "execute"
        ? "command"
        : existing?.kind ?? "tool";
      const label = boundedToolStateText(
        update.title ?? update.name ?? existing?.label ?? "Gemini tool",
      );
      const status = update.status ?? existing?.status;
      const phase = toolActivityPhase(status);
      const rawInput = objectValue(update.rawInput);
      const command = typeof rawInput?.command === "string"
        ? boundedToolStateText(rawInput.command)
        : existing?.command;
      const detail = providerActivityDetailSections({
        command,
        [phase === "failed" ? "error" : "output"]:
          update.rawOutput ?? update.content,
      });
      emitter.activity(kind, phase, label, {
        activityId,
        ...(detail ? { detail } : {}),
      });
      if (phase === "completed" || phase === "failed") {
        toolActivities.delete(activityId);
      } else {
        toolActivities.set(activityId, {
          kind,
          label,
          ...(command ? { command } : {}),
          status,
        });
      }
      return;
    }
    case "plan":
      emitter.rich({
        type: "plan",
        explanation: null,
        steps: planSteps(update.entries),
      });
      return;
    case "plan_update":
      if (update.plan.type === "items") {
        emitter.rich({
          type: "plan",
          explanation: null,
          steps: planSteps(update.plan.entries),
        });
      } else if (update.plan.type === "markdown") {
        emitter.rich({
          type: "plan",
          explanation: bounded(update.plan.content),
          steps: [],
        });
      } else {
        emitter.rich({
          type: "plan",
          explanation: `Gemini plan: ${bounded(update.plan.uri)}`,
          steps: [],
        });
      }
      return;
    case "plan_removed":
      emitter.rich({ type: "plan", explanation: null, steps: [] });
      return;
    case "available_commands_update":
      return;
    case "current_mode_update":
      emitter.activity(
        "system",
        "info",
        `Gemini switched to ${bounded(update.currentModeId)} mode`,
      );
      return;
    case "config_option_update":
      // Gemini model metadata uses its experimental session models response,
      // not ACP config options.
      return;
    case "session_info_update":
      if (update.title) {
        emitter.activity(
          "system",
          "info",
          `Gemini session: ${bounded(update.title)}`,
        );
      }
      return;
    case "usage_update":
      contextUsage.usedTokens = tokenCount(update.used);
      contextUsage.maxTokens = tokenCount(update.size);
      if (
        contextUsage.usedTokens === null
        || contextUsage.maxTokens === null
        || contextUsage.usedTokens > contextUsage.maxTokens
      ) {
        throw new Error("Gemini ACP sent a malformed usage update.");
      }
      emitter.rich({
        type: "usage",
        usage: {
          usedTokens: contextUsage.usedTokens,
          totalProcessedTokens: null,
          totalProcessedScope: "session",
          maxTokens: contextUsage.maxTokens,
          inputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          compactsAutomatically: null,
        },
      });
      return;
    case "compaction_update":
      return;
    case "compaction_summary_chunk":
      return;
  }
  const unsupportedUpdate: never = update;
  throw new Error(
    `Gemini ACP sent an unsupported session update: ${String(
      (unsupportedUpdate as { sessionUpdate?: unknown }).sessionUpdate,
    )}.`,
  );
}

function failedGeminiRun(
  conversationId: string,
  failure: ProviderRunFailure,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  sessionId?: string,
): AgentHarnessRun {
  emitter.status("failed", failure.message);
  return {
    harnessId: "gemini-acp",
    providerId: "gemini",
    result: Promise.resolve({
      providerId: "gemini",
      conversationId,
      status: "failed",
      ...(sessionId ? { sessionId } : {}),
      text: "",
      textTruncated: false,
      exitCode: null,
      signal: null,
      error: failure.message,
      failure,
      cleanupConfirmed: true,
    }),
    cancel: () => {},
    extension: {
      kind: "gemini-acp",
      respondToApproval: () => false,
      respondToInput: () => false,
    },
  };
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

function boundedToolStateText(value: string): string {
  return value.slice(0, MAX_TOOL_STATE_TEXT_CHARS);
}

function boundedId(value: string, label: string): string {
  if (!value || value.length > 1_000 || value.includes("\0")) {
    throw new Error(`Gemini ACP sent an invalid ${label} identity.`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function permissionDetail(
  params: Pick<RequestPermissionRequest, "toolCall">,
): string {
  const { rawInput, content, locations } = params.toolCall;
  if (rawInput === undefined && content === undefined && locations === undefined) {
    return "Gemini requested permission.";
  }
  return jsonSummary({
    ...(rawInput === undefined ? {} : { input: rawInput }),
    ...(content === undefined ? {} : { content }),
    ...(locations === undefined ? {} : { locations }),
  });
}

function jsonSummary(value: unknown): string {
  try {
    return value === undefined
      ? "Gemini requested permission."
      : JSON.stringify(value);
  } catch {
    return "Gemini requested permission.";
  }
}
