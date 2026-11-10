import { AcpSecretRedactor } from "./acp-redaction";
import { acpPermissionDetail } from "./acp-permission-detail";
import { acpAttachmentReadAllowed } from "./attachment-read-grant";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";

import {
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";
import { INERTIA_VERSION } from "../../shared/version";
import {
  createOwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { providerUnconfirmedCleanup } from "./provider-unconfirmed-cleanup";
import { providerActivityDetailSections } from "./activity-detail";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type GrokAcpHarnessCapabilities,
} from "./agent-harness";
import { isSafeApprovalDisplayText } from "./approval-display";
import {
  providerRunTerminal,
  type ProviderRunFailure,
  type ProviderRunInput,
  type ProviderRunResult,
} from "./contracts";
import type { AgentApprovalDecision } from "./interactions";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import {
  createProviderHostToolMcpSession,
  type ProviderHostToolMcpConnection,
  type ProviderHostToolMcpSession,
} from "./host-tool-mcp-http";
import {
  acpHostMcpServers,
  acpPromptForHostMcp,
  type HostMcpProxyRuntimeOptions,
} from "./host-tool-mcp-config";
import {
  BoundedGrokJsonLineTransform,
  grokErrorDetail,
  grokRuntimeFailure,
  grokSpawnFailure,
  grokStopFailure,
  observeGrokProcessExit,
} from "./grok-acp-support";
import {
  configureGrokSession,
  grokPrompt,
  withGrokRpcDeadline,
} from "./grok-acp-session";
import { providerProcessInvocation } from "./process";
import {
  emitGrokMetadata,
  emitGrokPromptUsage,
  type GrokContextUsage,
  planSteps,
  tokenCount,
  toolActivityPhase,
  validateGrokInitialize,
} from "./grok-acp-projection";
import { selectGrokAcpAuthMethod } from "./grok-acp-auth";
import { AcpCompactionProjection } from "./acp-compaction-projection";
import { parseAcpSessionNotification } from "./acp-json-rpc";
import {
  endProviderInput,
  providerNaturalCloseFirst,
  waitForProviderNaturalClose,
} from "./provider-natural-close";
import { ACP_WATCHER_PLAN_DECLINED, ACP_WATCHER_QUESTION_DECLINED, acpFileMutation, acpReadOnlyWatcher } from "./acp-watcher";
import { GROK_EXPLICIT_COMPACTION_UNAVAILABLE_REASON } from "../../shared/provider";
import {
  GROK_EXIT_PLAN_METHODS,
  GROK_PLAN_CAPTURED_RESPONSE,
  GROK_QUESTION_CANCELLED_RESPONSE,
  GROK_QUESTION_METHODS,
  grokInputRequest,
  grokQuestionResponse,
  parseGrokExitPlanRequest,
  parseGrokQuestionRequest,
} from "./grok-acp-extensions";
import { markdownPlanSteps } from "./markdown-plan-steps";

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

export const GROK_ACP_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "grok-acp",
    protocol: "acp-v1-json-rpc",
    approvals: "native",
    questions: "xai-extension",
    plans: "xai-extension",
    reasoning: "native",
    usage: "optional-acp-v1",
    images: "capability-negotiated",
    authentication: "grok-cli",
    modelMetadata: "session-config-options",
  },
} as const satisfies GrokAcpHarnessCapabilities;

export interface GrokAcpHarnessOptions {
  terminateProcessTree?: ProcessTreeTerminator;
  controlRpcTimeoutMs?: number;
  createHostMcpSession?(
    runtime: ProviderHostToolRuntime,
  ): ProviderHostToolMcpSession;
  hostMcpProxyRuntime?: HostMcpProxyRuntimeOptions;
}

interface PendingApproval {
  resolve: (decision: AgentApprovalDecision) => void;
  settled: boolean;
}

interface PendingInput {
  resolve: (answers: Record<string, string[]>) => void;
  settled: boolean;
}

interface TurnEvidence {
  seen: boolean;
}

interface AssistantSegment {
  open: boolean;
  afterTool: boolean;
}

interface ToolActivity {
  kind: "command" | "tool";
  label: string;
  command?: string;
  status?: ToolCallStatus | null;
  toolKind?: ToolKind | null;
}

export function grokAcpLaunchArguments(
  input: Pick<ProviderRunInput, "interactionMode" | "access" | "readOnlyProfile">,
): string[] {
  if (input.interactionMode === "plan") return ["--permission-mode", "plan", "agent", "stdio"];
  if (input.access === "full" && !acpReadOnlyWatcher(input)) {
    return ["agent", "--always-approve", "stdio"];
  }
  return ["--permission-mode", "default", "agent", "stdio"];
}

export function grokAcpProcessInvocation(
  executable: string,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
) {
  return providerProcessInvocation(executable, args, environment, platform);
}

export function createGrokAcpHarness(
  options: GrokAcpHarnessOptions = {},
): AgentHarness {
  return {
    id: "grok-acp",
    providerId: "grok",
    capabilities: GROK_ACP_CAPABILITIES,
    supports: (input) => input.providerId === "grok",
    start: (startOptions) => startGrokRun(
      startOptions,
      options.terminateProcessTree,
      options.controlRpcTimeoutMs,
      options.createHostMcpSession,
      options.hostMcpProxyRuntime,
    ),
  };
}

function startGrokRun(
  options: AgentHarnessStartOptions,
  terminateProcessTree?: ProcessTreeTerminator,
  controlRpcTimeoutMs = CONTROL_RPC_TIMEOUT_MS,
  createHostMcpSession = createProviderHostToolMcpSession,
  hostMcpProxyRuntime: HostMcpProxyRuntimeOptions = {},
): AgentHarnessRun {
  const conversationId = options.input.conversationId;
  const emitter = createAgentHarnessEmitter(
    "grok",
    conversationId,
    options.callbacks,
    options.input.runId,
    options.input.turnId,
    options.input.cwd,
  );
  const resultText = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const promptPreparationAbort = new AbortController();
  const stderr = new CappedProviderBuffer(MAX_STDERR_CHARS);
  const secretRedactor = new AcpSecretRedactor(options.environment);
  const approvals = new Map<string, PendingApproval>();
  const inputs = new Map<string, PendingInput>();
  const toolActivities = new Map<string, ToolActivity>();
  const contextUsage: GrokContextUsage = {
    usedTokens: null,
    maxTokens: null,
  };
  const turnEvidence: TurnEvidence = { seen: false };
  const assistantSegment: AssistantSegment = { open: false, afterTool: false };
  const compactions = new AcpCompactionProjection(
    "Grok",
    "grok",
    emitter,
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
  const hostMcpSession = hostToolRuntime
    ? createHostMcpSession(hostToolRuntime)
    : undefined;
  let hostMcpConnection: ProviderHostToolMcpConnection | undefined;
  const redactHostMcpPayload = <T>(value: T): T => secretRedactor.payload(value);
  let sessionId = options.input.sessionId;
  let cancelRequested = false;
  let sessionReady = false;
  let promptInFlight = false;
  let supportsImages = false;
  let activeContext: acp.ClientContext | undefined;
  let activeFailurePhase = "initialize";
  let activeTerminalEvent = "initialize";
  let processError: Error | undefined;
  let wireError: Error | undefined;
  let child: ChildProcessWithoutNullStreams;
  let requestProcessTermination = (_force: boolean): void => {};
  let naturalCloseRequested = false;

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
  const settleInput = (
    requestId: string,
    answers: Record<string, string[]>,
  ): boolean => {
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

  const ownsActivePrompt = (requestSessionId: string): boolean =>
    !cancelRequested
    && Boolean(sessionId)
    && sessionReady
    && promptInFlight
    && requestSessionId === sessionId;

  const client = acp.client({ name: "Inertia" })
    .onRequest(
      acp.methods.client.session.requestPermission,
      async ({ params, signal }) => {
        if (!ownsActivePrompt(params.sessionId)) return { outcome: { outcome: "cancelled" } };
        return grokPermission(
          params,
          redactHostMcpPayload(params),
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
          : new Error("Grok ACP sent an invalid session update.");
        requestProcessTermination(true);
        throw wireError;
      }
    }, ({ params: rawParams }) => {
      try {
        const params = secretRedactor.streamNotification(rawParams);
        if (
          cancelRequested
          || !sessionId
          || params.sessionId !== sessionId
        ) return;
        if (
          !sessionReady
          || !promptInFlight
        ) return;
        handleGrokUpdate(
          params,
          resultText,
          emitter,
          supportsImages,
          contextUsage,
          toolActivities,
          turnEvidence,
          assistantSegment,
          compactions,
          secretRedactor,
        );
      } catch (error) {
        wireError = error instanceof Error
          ? error
          : new Error("Grok ACP sent an invalid session update.");
        requestProcessTermination(true);
      }
    });

  for (const method of GROK_QUESTION_METHODS) {
    client.onRequest(method, (value) => value, async ({ params: rawParams, signal }) => {
      const providerRequest = parseGrokQuestionRequest(rawParams);
      if (!ownsActivePrompt(providerRequest.sessionId)) return GROK_QUESTION_CANCELLED_RESPONSE;
      if (acpReadOnlyWatcher(options.input)) {
        emitter.activity("system", "info", ACP_WATCHER_QUESTION_DECLINED);
        return GROK_QUESTION_CANCELLED_RESPONSE;
      }
      const displayRequest = parseGrokQuestionRequest(redactHostMcpPayload(rawParams));
      const requestId = randomUUID();
      const answers = await new Promise<Record<string, string[]>>((resolve) => {
        if (inputs.size >= MAX_PENDING_INTERACTIONS) {
          throw new Error("Grok exceeded the bounded input budget.");
        }
        inputs.set(requestId, { resolve, settled: false });
        signal.addEventListener("abort", () => settleInput(requestId, {}), { once: true });
        emitter.capability("structured-input", true);
        emitter.rich({ type: "input", request: grokInputRequest(requestId, displayRequest) });
      });
      if (signal.aborted || !ownsActivePrompt(providerRequest.sessionId)) {
        return GROK_QUESTION_CANCELLED_RESPONSE;
      }
      const response = grokQuestionResponse(providerRequest, answers);
      return Object.keys(response.answers).length > 0 ? response : GROK_QUESTION_CANCELLED_RESPONSE;
    });
  }

  for (const method of GROK_EXIT_PLAN_METHODS) {
    client.onRequest(method, (value) => value, async ({ params: rawParams }) => {
      const request = parseGrokExitPlanRequest(redactHostMcpPayload(rawParams));
      if (!ownsActivePrompt(request.sessionId)) return GROK_PLAN_CAPTURED_RESPONSE;
      if (request.plan) {
        turnEvidence.seen = true;
        emitter.rich({
          type: "plan",
          explanation: request.plan,
          steps: markdownPlanSteps(request.plan, MAX_TOOL_STATE_TEXT_CHARS),
          handoff: true,
        });
      }
      if (acpReadOnlyWatcher(options.input)) {
        emitter.activity("system", "info", ACP_WATCHER_PLAN_DECLINED);
      }
      return GROK_PLAN_CAPTURED_RESPONSE;
    });
  }

  emitter.status("starting");
  if (options.input.operation?.kind === "compact") {
    return failedGrokRun(options.input, {
      reason: "provider-error",
      message: GROK_EXPLICIT_COMPACTION_UNAVAILABLE_REASON,
      phase: "operation",
      terminalEvent: "operation/compact-unsupported",
    }, emitter);
  }
  try {
    const invocation = grokAcpProcessInvocation(
      options.executable,
      options.environment,
      grokAcpLaunchArguments(options.input),
    );
    const ownedInvocation = runtimeOwnedProcessInvocation(
      invocation.command,
      invocation.args,
    );
    child = spawnRuntimeOwnedProcess(() => spawn(ownedInvocation.command, ownedInvocation.args, {
      cwd: options.input.cwd,
      env: { ...options.environment, GROK_DISABLE_AUTOUPDATER: "1" },
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    const failure = grokSpawnFailure(error, options.input.cwd);
    return failedGrokRun(
      options.input,
      failure,
      emitter,
    );
  }
  child.once("error", (error) => {
    processError = error;
    stderr.append(grokErrorDetail(error, "Grok ACP process error."));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.append(secretRedactor.stderrChunk(chunk)));
  child.stdin.on("error", () => undefined);

  const wireGuard = new BoundedGrokJsonLineTransform(
    MAX_WIRE_LINE_BYTES,
    new ProviderRunEventBudget(
      "Grok ACP",
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
    "Grok ACP process tree",
    terminateProcessTree,
  );
  requestProcessTermination = (force: boolean): void => {
    void terminateOwnedProcessTree(force).catch(() => undefined);
  };
  const requestControl = <T>(request: Promise<T>, method: string): Promise<T> =>
    withGrokRpcDeadline(
      request,
      controlRpcTimeoutMs,
      method,
      () => requestProcessTermination(true),
    ).then(redactHostMcpPayload);

  const providerResult = client.connectWith(
    stream,
    async (context): Promise<ProviderRunResult> => {
      activeContext = context;
      activeFailurePhase = "initialize";
      activeTerminalEvent = "initialize";
      const initialized = await requestControl(
        context.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: { auth: { terminal: true }, plan: {}, session: { compaction: {} } },
          clientInfo: { name: "Inertia", version: INERTIA_VERSION },
        }),
        "initialize",
      );
      validateGrokInitialize(initialized);
      supportsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
      emitter.capability("images", supportsImages);
      activeFailurePhase = "auth";
      activeTerminalEvent = "authenticate";
      await requestControl(
        context.request(acp.methods.agent.authenticate, {
          methodId: selectGrokAcpAuthMethod(initialized.authMethods, options.environment),
          _meta: { headless: true },
        }),
        "authenticate",
      );
      activeFailurePhase = "session";
      activeTerminalEvent = "host-tools/start";
      hostMcpConnection = await hostMcpSession?.start();
      if (hostMcpConnection) {
        secretRedactor.addSecrets([hostMcpConnection.bearerToken, hostMcpConnection.url]);
      }
      const hostMcpServers = hostMcpConnection
        ? acpHostMcpServers(
            hostMcpConnection,
            initialized.agentCapabilities?.mcpCapabilities?.http === true,
            options.environment,
            hostMcpProxyRuntime,
          )
        : [];
      const turnPrompt = acpPromptForHostMcp(
        options.input.prompt,
        options.hostTools,
        hostMcpServers,
        options.input.conversationId,
      );

      let session: { configOptions?: SessionConfigOption[] | null };
      if (options.input.sessionId) {
        const canResume = Boolean(initialized.agentCapabilities?.sessionCapabilities?.resume);
        const canLoad = initialized.agentCapabilities?.loadSession === true;
        emitter.capability("session-resume", canResume || canLoad);
        activeFailurePhase = "session";
        activeTerminalEvent = canResume ? "session/resume" : "session/load";
        if (!canResume && !canLoad) {
          throw new Error(
            "This Grok ACP server does not advertise session resume support.",
          );
        }
        const restore = {
          sessionId: options.input.sessionId,
          cwd: options.input.cwd,
          mcpServers: hostMcpServers,
        };
        session = canResume
          ? await requestControl(
              context.request(acp.methods.agent.session.resume, restore),
              "session/resume",
            )
          : await requestControl(
              context.request(acp.methods.agent.session.load, restore),
              "session/load",
            );
      } else {
        activeFailurePhase = "session";
        activeTerminalEvent = "session/new";
        const created = await requestControl(
          context.request(acp.methods.agent.session.new, {
            cwd: options.input.cwd,
            mcpServers: hostMcpServers,
          }),
          "session/new",
        );
        sessionId = created.sessionId;
        emitter.session(sessionId);
        session = created;
      }
      if (!sessionId) throw new Error("Grok ACP did not return a session ID.");

      activeFailurePhase = "configuration";
      if (options.input.sessionId) {
        activeTerminalEvent = "session/set_mode";
        await requestControl(
          context.request(acp.methods.agent.session.setMode, {
            sessionId,
            modeId: options.input.interactionMode === "plan" ? "plan" : "default",
          }),
          "session/set_mode",
        );
      }
      activeTerminalEvent = "session/configuration";
      const configuredOptions = await configureGrokSession(
        context,
        sessionId,
        session.configOptions ?? [],
        options.input.model,
        options.input.reasoningEffort,
        requestControl,
        Boolean(options.input.sessionId),
      );
      emitGrokMetadata(configuredOptions, supportsImages, emitter);

      const prompt = await grokPrompt(
        turnPrompt,
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
      const response = redactHostMcpPayload(await context.request(
        acp.methods.agent.session.prompt,
        { sessionId, prompt },
      ).finally(() => {
        promptInFlight = false;
      }));
      if (wireError) throw wireError;
      if (response.usage) {
        emitGrokPromptUsage(response.usage, contextUsage, emitter);
      }
      if (
        !cancelRequested
        && response.stopReason === "end_turn"
        && turnEvidence.seen
      ) {
        finishOutputStreams();
      } else {
        secretRedactor.discardStreams();
      }
      const outcome = cancelRequested || response.stopReason === "cancelled"
        ? finish("cancelled")
        : response.stopReason === "end_turn"
          ? turnEvidence.seen
            ? finish("completed")
            : (() => {
                const failure: ProviderRunFailure = {
                  reason: "provider-error",
                  message:
                    "Grok ACP ended without returning any turn output; the underlying Grok turn may have failed.",
                  phase: "turn",
                  terminalEvent: "session/prompt:empty-end-turn",
                };
                return finish("failed", failure.message, failure);
              })()
          : (() => {
              const failure = grokStopFailure(response.stopReason);
              return finish("failed", failure.message, failure);
            })();
      naturalCloseRequested = outcome.status !== "cancelled" && providerNaturalCloseFirst();
      if (!naturalCloseRequested) requestProcessTermination(true);
      return outcome;
    },
  ).catch(async (error: unknown) => {
    secretRedactor.discardStreams();
    if (cancelRequested) {
      requestProcessTermination(true);
      return finish("cancelled");
    }
    await observeGrokProcessExit(child);
    const diagnostic = secretRedactor.payload(redactHostMcpPayload(
      (stderr.toString() + secretRedactor.finishStderr()).trim(),
    ));
    const safeError = redactHostMcpPayload(grokErrorDetail(
      error,
      "Grok ACP stopped unexpectedly.",
    ));
    const safeWireError = wireError
      ? new Error(redactHostMcpPayload(grokErrorDetail(
          wireError,
          "Grok ACP wire error.",
        )))
      : undefined;
    const safeProcessError = processError
      ? new Error(redactHostMcpPayload(grokErrorDetail(
          processError,
          "Grok ACP process error.",
        )))
      : undefined;
    const failure = grokRuntimeFailure(safeError, {
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
    try {
      await hostMcpSession?.close();
    } catch {
      hostToolsCleanupFailed = true;
    }
    let processCleanupConfirmed = true;
    if (naturalCloseRequested) {
      endProviderInput(child);
      await waitForProviderNaturalClose(child);
    }
    try {
      await terminateOwnedProcessTree(true);
    } catch {
      processCleanupConfirmed = false;
    }
    if (hostToolsCleanupFailed) {
      const error = "Grok Inertia chat tools could not be cleaned up.";
      emitter.status("failed", error);
      return {
        ...outcome,
        status: "failed",
        exitCode: child.exitCode,
        signal: child.signalCode,
        error,
        failure: {
          reason: "provider-error",
          message: error,
          phase: "cleanup",
          terminalEvent: "host-tools/cleanup",
        },
        cleanupConfirmed: false,
      };
    }
    emitter.status(outcome.status, outcome.error);
    return {
      ...outcome,
      exitCode: child.exitCode,
      signal: child.signalCode,
      ...(processCleanupConfirmed ? {} : {
        cleanupConfirmed: false,
        ...providerUnconfirmedCleanup(child),
      }),
    };
  }).then((outcome) => ({
    ...outcome,
    ...providerRunTerminal(options.input, outcome.status, outcome.failure),
  }));

  function finish(
    status: ProviderRunResult["status"],
    error?: string,
    failure?: ProviderRunFailure,
  ): ProviderRunResult {
    return {
      ...providerRunTerminal(options.input, status, failure),
      ...(sessionId ? { sessionId } : {}),
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
      resultText.append(assistant);
      emitter.text(assistant);
    }
    const reasoning = secretRedactor.finishReasoning();
    if (reasoning) emitter.rich({ type: "reasoning-summary", text: reasoning });
  }

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    secretRedactor.discardStreams();
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
    harnessId: "grok-acp",
    providerId: "grok",
    result,
    cancel,
    extension: {
      kind: "grok-acp",
      respondToApproval: (requestId, decision) =>
        hostToolRuntime?.respondToApproval(requestId, decision)
        || settleApproval(requestId, decision),
      respondToInput: settleInput,
    },
  };
}

async function grokPermission(
  params: RequestPermissionRequest,
  displayParams: RequestPermissionRequest,
  signal: AbortSignal,
  options: AgentHarnessStartOptions,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
  approvals: Map<string, PendingApproval>,
): Promise<RequestPermissionResponse> {
  const allow = oneShotPermissionOption(params.options, true);
  if (allow && acpAttachmentReadAllowed(params, options.input.attachmentReadRoots)) {
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  if (options.input.interactionMode === "plan" && !acpReadOnlyWatcher(options.input)) {
    return { outcome: { outcome: "cancelled" } };
  }
  const fileMutation = isFileMutationKind(params.toolCall.kind);
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
      throw new Error("Grok exceeded the bounded approval budget.");
    }
    approvals.set(requestId, { resolve, settled: false });
    signal.addEventListener("abort", () => {
      const pending = approvals.get(requestId);
      if (!pending || pending.settled) return;
      pending.settled = true;
      approvals.delete(requestId);
      emit({ type: "approval-resolved", requestId, decision: "cancel" });
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
          displayParams.toolCall.title || "Grok requested permission",
        ),
        ...grokApprovalBody(displayParams),
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

function grokApprovalBody(
  params: RequestPermissionRequest,
): { command?: string; detail?: string } {
  const rawInput = objectValue(params.toolCall.rawInput);
  if (params.toolCall.kind === "execute" && typeof rawInput?.command === "string") {
    const description = typeof rawInput.description === "string" ? rawInput.description.trim() : "";
    return {
      command: bounded(rawInput.command),
      ...(description ? { detail: bounded(description) } : {}),
    };
  }
  return { detail: bounded(acpPermissionDetail(params, "Grok requested permission.")) };
}

export function permissionDisplayIsSafe(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  return isSafeApprovalDisplayText(
    params.toolCall.title || "Grok requested permission",
  ) && isSafeApprovalDisplayText(acpPermissionDetail(params, "Grok requested permission."), true);
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

function handleGrokUpdate(
  notification: SessionNotification,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  supportsImages: boolean,
  contextUsage: GrokContextUsage,
  toolActivities: Map<string, ToolActivity>,
  turnEvidence: TurnEvidence,
  assistantSegment: AssistantSegment,
  compactions: AcpCompactionProjection,
  secretRedactor: AcpSecretRedactor,
): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return;
    case "agent_message_chunk":
      if (update.content.type === "text") {
        const text = bounded(update.content.text);
        if (text.trim()) {
          turnEvidence.seen = true;
          if (assistantSegment.afterTool) {
            const tail = secretRedactor.flushAssistant();
            if (tail) {
              resultText.append(tail);
              emitter.text(tail);
            }
            emitter.textBoundary();
            resultText.append("\n\n");
            assistantSegment.afterTool = false;
          }
          assistantSegment.open = true;
        }
        const value = secretRedactor.assistantChunk(text);
        if (value) {
          resultText.append(value);
          emitter.text(value);
        }
      }
      return;
    case "agent_thought_chunk":
      if (update.content.type === "text") {
        if (update.content.text.trim()) turnEvidence.seen = true;
        const value = secretRedactor.reasoningChunk(bounded(update.content.text));
        if (value) emitter.rich({ type: "reasoning-summary", text: value });
      }
      return;
    case "tool_call": {
      turnEvidence.seen = true;
      if (assistantSegment.open) assistantSegment.afterTool = true;
      const activityId = boundedId(update.toolCallId, "tool call");
      if (
        !toolActivities.has(activityId)
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) throw new Error("Grok exceeded the bounded tool activity budget.");
      const kind = update.kind === "execute" ? "command" : "tool";
      const label = boundedToolStateText(update.title || "Grok tool");
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
        ...acpFileMutation(update.kind, update.status),
      });
      if (phase === "completed" || phase === "failed") {
        toolActivities.delete(activityId);
      } else {
        toolActivities.set(activityId, {
          kind,
          label,
          ...(command ? { command } : {}),
          status: update.status,
          toolKind: update.kind,
        });
      }
      return;
    }
    case "tool_call_update": {
      turnEvidence.seen = true;
      if (assistantSegment.open) assistantSegment.afterTool = true;
      const activityId = boundedId(update.toolCallId, "tool call");
      const existing = toolActivities.get(activityId);
      if (
        !existing
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) throw new Error("Grok exceeded the bounded tool activity budget.");
      const kind = update.kind === "execute"
        ? "command"
        : existing?.kind ?? "tool";
      const label = boundedToolStateText(
        update.title ?? update.name ?? existing?.label ?? "Grok tool",
      );
      const status = update.status ?? existing?.status;
      const toolKind = update.kind ?? existing?.toolKind;
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
        ...acpFileMutation(toolKind, status),
      });
      if (phase === "completed" || phase === "failed") {
        toolActivities.delete(activityId);
      } else {
        toolActivities.set(activityId, {
          kind,
          label,
          ...(command ? { command } : {}),
          status,
          toolKind,
        });
      }
      return;
    }
    case "plan":
      turnEvidence.seen = true;
      emitter.rich({
        type: "plan",
        explanation: null,
        steps: planSteps(update.entries),
      });
      return;
    case "plan_update":
      turnEvidence.seen = true;
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
          explanation: `Grok plan: ${bounded(update.plan.uri)}`,
          steps: [],
        });
      }
      return;
    case "plan_removed":
      emitter.rich({ type: "plan", explanation: "", steps: [] });
      return;
    case "available_commands_update":
      return;
    case "current_mode_update":
      emitter.activity(
        "system",
        "info",
        `Grok switched to ${bounded(update.currentModeId)} mode`,
      );
      return;
    case "config_option_update":
      emitGrokMetadata(update.configOptions, supportsImages, emitter);
      return;
    case "session_info_update":
      if (update.title) {
        emitter.activity(
          "system",
          "info",
          `Grok session: ${bounded(update.title)}`,
        );
      }
      return;
    case "usage_update": {
      const usedTokens = tokenCount(update.used);
      const maxTokens = tokenCount(update.size);
      if (usedTokens === null || maxTokens === null) {
        throw new Error("Grok ACP sent a malformed usage update.");
      }
      if (usedTokens > maxTokens) return;
      contextUsage.usedTokens = usedTokens;
      contextUsage.maxTokens = maxTokens;
      emitter.capability("usage-tokens", true);
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
    }
    case "compaction_update":
      compactions.observeUpdate(update);
      return;
    case "compaction_summary_chunk":
      compactions.observeSummaryChunk(update);
      return;
    case "notice":
      throw new Error("Grok ACP sent a notice without negotiated support.");
    case "subagent_update":
    case "session_message":
    case "session_message_chunk":
      throw new Error("Grok ACP sent a subagent update without negotiated support.");
  }
}

function failedGrokRun(
  input: ProviderRunInput,
  failure: ProviderRunFailure,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): AgentHarnessRun {
  emitter.status("failed", failure.message);
  return {
    harnessId: "grok-acp",
    providerId: "grok",
    result: Promise.resolve({
      ...providerRunTerminal(input, "failed", failure),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
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
      kind: "grok-acp",
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
    throw new Error(`Grok ACP sent an invalid ${label} identity.`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
