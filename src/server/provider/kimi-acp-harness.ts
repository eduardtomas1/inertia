import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

import { spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";
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
  type KimiAcpHarnessCapabilities,
} from "./agent-harness";
import { isSafeApprovalDisplayText } from "./approval-display";
import type { ProviderRunFailure, ProviderRunResult } from "./contracts";
import type {
  AgentApprovalDecision,
  AgentInputRequest,
} from "./interactions";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import {
  createProviderHostToolMcpSession,
  type ProviderHostToolMcpConnection,
  type ProviderHostToolMcpSession,
} from "./host-tool-mcp-http";
import { acpHostMcpServers } from "./host-tool-mcp-config";
import { redactHostToolPayload } from "./host-tool-redaction";
import {
  BoundedKimiJsonLineTransform,
  kimiErrorDetail,
  kimiRuntimeFailure,
  kimiSpawnFailure,
  kimiStopFailure,
  observeKimiProcessExit,
} from "./kimi-acp-support";
import {
  configureKimiSession,
  kimiCompactCommand,
  kimiPrompt,
  waitForKimiCommandAdvertisement,
  withKimiRpcDeadline,
} from "./kimi-acp-session";
import { providerProcessInvocation } from "./process";
import {
  emitKimiMetadata,
  emitKimiPromptUsage,
  type KimiContextUsage,
  planSteps,
  tokenCount,
  toolActivityPhase,
  validateKimiInitialize,
} from "./kimi-acp-projection";
import { selectAcpAgentAuthMethod } from "./acp-auth";
import {
  AcpCompactionProjection,
  unconfirmedAcpCompactionFailure,
} from "./acp-compaction-projection";
import { parseAcpSessionNotification } from "./acp-json-rpc";

const MAX_WIRE_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_PENDING_INTERACTIONS = 64;
const MAX_INPUT_OPTIONS = 20;
const MAX_TRACKED_TOOL_ACTIVITIES = 1_024;
const MAX_TOOL_STATE_TEXT_CHARS = 4 * 1024;
const MAX_AVAILABLE_COMMANDS = 256;
const MAX_RUN_EVENTS = 8_192;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const COMMAND_ADVERTISEMENT_TIMEOUT_MS = 2_000;
const CONTROL_RPC_TIMEOUT_MS = 30_000;

export const KIMI_ACP_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "kimi-acp",
    protocol: "acp-v1-json-rpc",
    approvals: "native",
    questions: "native-over-permission",
    plans: "native",
    reasoning: "native",
    usage: "optional-acp-v1",
    images: "capability-negotiated",
    authentication: "kimi-cli",
    modelMetadata: "session-config-options",
  },
} as const satisfies KimiAcpHarnessCapabilities;

export interface KimiAcpHarnessOptions {
  /** Test seam for the owned ACP process-tree lifecycle. */
  terminateProcessTree?: ProcessTreeTerminator;
  /** Test seam for the bounded post-resume command advertisement wait. */
  commandAdvertisementTimeoutMs?: number;
  /** Test seam for bounded initialize/auth/session/configuration RPCs. */
  controlRpcTimeoutMs?: number;
  /** Test seam for proving host-tool cleanup authority. */
  createHostMcpSession?(
    runtime: ProviderHostToolRuntime,
  ): ProviderHostToolMcpSession;
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

interface ToolActivity {
  kind: "command" | "tool";
  label: string;
  command?: string;
  status?: ToolCallStatus | null;
}

export function kimiAcpProcessInvocation(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  return providerProcessInvocation(executable, ["acp"], environment, platform);
}

export function createKimiAcpHarness(
  options: KimiAcpHarnessOptions = {},
): AgentHarness {
  return {
    id: "kimi-acp",
    providerId: "kimi",
    capabilities: KIMI_ACP_CAPABILITIES,
    supports: (input) => input.providerId === "kimi",
    start: (startOptions) => startKimiRun(
      startOptions,
      options.terminateProcessTree,
      options.commandAdvertisementTimeoutMs,
      options.controlRpcTimeoutMs,
      options.createHostMcpSession,
    ),
  };
}

function startKimiRun(
  options: AgentHarnessStartOptions,
  terminateProcessTree?: ProcessTreeTerminator,
  commandAdvertisementTimeoutMs = COMMAND_ADVERTISEMENT_TIMEOUT_MS,
  controlRpcTimeoutMs = CONTROL_RPC_TIMEOUT_MS,
  createHostMcpSession = createProviderHostToolMcpSession,
): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter(
    "kimi",
    conversationId,
    options.callbacks,
    options.input.runId ?? conversationId,
    options.input.turnId ?? null,
    options.input.cwd,
  );
  const resultText = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const stderr = new CappedProviderBuffer(MAX_STDERR_CHARS);
  const approvals = new Map<string, PendingApproval>();
  const inputs = new Map<string, PendingInput>();
  const toolActivities = new Map<string, ToolActivity>();
  const contextUsage: KimiContextUsage = {
    usedTokens: null,
    maxTokens: null,
  };
  const turnEvidence: TurnEvidence = { seen: false };
  const compactions = new AcpCompactionProjection(
    "Kimi Code",
    "kimi",
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
  const redactHostMcpPayload = <T>(value: T): T => hostMcpConnection
    ? redactHostToolPayload(value, [
        hostMcpConnection.bearerToken,
        hostMcpConnection.url,
      ])
    : value;
  let sessionId = options.input.sessionId;
  let cancelRequested = false;
  let sessionReady = false;
  let promptInFlight = false;
  let supportsImages = false;
  let activeContext: acp.ClientContext | undefined;
  let availableCommandNames: Set<string> | null = null;
  let acceptsCommandAdvertisement = false;
  let suppressSessionProjection = false;
  let activeFailurePhase = "initialize";
  let activeTerminalEvent = "initialize";
  let processError: Error | undefined;
  let wireError: Error | undefined;
  let resolveCommandAdvertisement!: () => void;
  const commandAdvertisement = new Promise<void>((resolve) => {
    resolveCommandAdvertisement = resolve;
  });
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
        return kimiPermission(
          params,
          redactHostMcpPayload(params),
          signal,
          options,
          emitter.rich,
          approvals,
          inputs,
        );
      },
    )
    .onNotification(acp.methods.client.session.update, (value) => {
      try {
        return parseAcpSessionNotification(value) as SessionNotification;
      } catch (error) {
        wireError = error instanceof Error
          ? error
          : new Error("Kimi ACP sent an invalid session update.");
        requestProcessTermination(true);
        throw wireError;
      }
    }, ({ params: rawParams }) => {
      try {
        const params = redactHostMcpPayload(rawParams);
        if (
          cancelRequested
          || !sessionId
          || params.sessionId !== sessionId
        ) return;
        if (
          acceptsCommandAdvertisement
          && params.update.sessionUpdate === "available_commands_update"
        ) {
          availableCommandNames = new Set(
            params.update.availableCommands
              .slice(0, MAX_AVAILABLE_COMMANDS)
              .map(({ name }) => name.replace(/^\//u, "").toLowerCase()),
          );
          resolveCommandAdvertisement();
        }
        if (
          suppressSessionProjection
          || !sessionReady
          || !promptInFlight
        ) return;
        handleKimiUpdate(
          params,
          resultText,
          emitter,
          supportsImages,
          contextUsage,
          toolActivities,
          turnEvidence,
          compactions,
        );
      } catch (error) {
        wireError = error instanceof Error
          ? error
          : new Error("Kimi ACP sent an invalid session update.");
        requestProcessTermination(true);
      }
    });

  emitter.status("starting");
  try {
    const invocation = kimiAcpProcessInvocation(
      options.executable,
      options.environment,
    );
    child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
      cwd: options.input.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    const failure = kimiSpawnFailure(error, options.input.cwd);
    return failedKimiRun(
      conversationId,
      failure,
      emitter,
    );
  }
  child.once("error", (error) => {
    processError = error;
    stderr.append(kimiErrorDetail(error, "Kimi ACP process error."));
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
  child.stdin.on("error", () => { /* The ACP SDK surfaces connection failures. */ });

  const wireGuard = new BoundedKimiJsonLineTransform(
    MAX_WIRE_LINE_BYTES,
    new ProviderRunEventBudget(
      "Kimi ACP",
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
    "Kimi ACP process tree",
    terminateProcessTree,
  );
  requestProcessTermination = (force: boolean): void => {
    void terminateOwnedProcessTree(force).catch(() => undefined);
  };
  const requestControl = <T>(request: Promise<T>, method: string): Promise<T> =>
    withKimiRpcDeadline(
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
          clientCapabilities: { plan: {}, session: { compaction: {} } },
          clientInfo: { name: "Inertia", version: INERTIA_VERSION },
        }),
        "initialize",
      );
      validateKimiInitialize(initialized);
      supportsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
      const login = selectAcpAgentAuthMethod(
        "Kimi Code",
        initialized.authMethods,
        "login",
      );
      if (login) {
        activeFailurePhase = "auth";
        activeTerminalEvent = "authenticate";
        await requestControl(
          context.request(acp.methods.agent.authenticate, { methodId: login.id }),
          "authenticate",
        );
      }
      hostMcpConnection = await hostMcpSession?.start();
      const hostMcpServers = hostMcpConnection
        ? acpHostMcpServers(
            hostMcpConnection,
            initialized.agentCapabilities?.mcpCapabilities?.http === true,
          )
        : [];

      let modes: SessionModeState | null | undefined;
      let configOptions: SessionConfigOption[] | null | undefined;
      if (options.input.sessionId) {
        acceptsCommandAdvertisement = true;
        if (initialized.agentCapabilities?.sessionCapabilities?.resume) {
          activeFailurePhase = "session";
          activeTerminalEvent = "session/resume";
          const resumed = await requestControl(
            context.request(acp.methods.agent.session.resume, {
              sessionId: options.input.sessionId,
              cwd: options.input.cwd,
              mcpServers: hostMcpServers,
            }),
            "session/resume",
          );
          modes = resumed.modes;
          configOptions = resumed.configOptions;
        } else if (initialized.agentCapabilities?.loadSession === true) {
          activeFailurePhase = "session";
          activeTerminalEvent = "session/load";
          suppressSessionProjection = true;
          try {
            const loaded = await requestControl(
              context.request(acp.methods.agent.session.load, {
                sessionId: options.input.sessionId,
                cwd: options.input.cwd,
                mcpServers: hostMcpServers,
              }),
              "session/load",
            );
            modes = loaded.modes;
            configOptions = loaded.configOptions;
          } finally {
            suppressSessionProjection = false;
          }
        } else {
          throw new Error(
            "This Kimi ACP server does not advertise session resume support.",
          );
        }
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
        modes = created.modes;
        configOptions = created.configOptions;
      }
      if (!sessionId) throw new Error("Kimi ACP did not return a session ID.");

      activeFailurePhase = "configuration";
      activeTerminalEvent = "session/configuration";
      const configuredOptions = await configureKimiSession(
        context,
        sessionId,
        modes,
        configOptions ?? [],
        options.input.interactionMode,
        options.input.model,
        options.input.reasoningEffort,
        requestControl,
      );
      emitKimiMetadata(configuredOptions, supportsImages, emitter.rich);

      if (options.input.operation?.kind === "compact") {
        await waitForKimiCommandAdvertisement(
          commandAdvertisement,
          commandAdvertisementTimeoutMs,
        );
        if (availableCommandNames === null) {
          throw new Error(
            "This Kimi ACP session did not advertise its available commands.",
          );
        }
        if (!availableCommandNames.has("compact")) {
          throw new Error(
            "This Kimi ACP session does not advertise its compact command.",
          );
        }
      }

      const providerPrompt = options.input.operation?.kind === "compact"
        ? kimiCompactCommand(options.input.operation.instruction)
        : options.input.prompt;
      const prompt = await kimiPrompt(
        providerPrompt,
        options.input.imagePaths ?? [],
        initialized,
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
        emitKimiPromptUsage(response.usage, contextUsage, emitter.rich);
      }
      const compactionFailure = options.input.operation?.kind === "compact"
        && compactions.completionEvidence() !== "completed"
        ? unconfirmedAcpCompactionFailure("Kimi")
        : undefined;
      const outcome = cancelRequested || response.stopReason === "cancelled"
        ? finish("cancelled")
        : response.stopReason === "end_turn"
          // Current Kimi ACP collapses most internal failed turns into
          // end_turn. Empty turns can fail closed; partial-output failures are
          // wire-indistinguishable until the upstream adapter exposes them.
          ? options.input.operation?.kind === "compact"
            ? compactionFailure
              ? finish("failed", compactionFailure.message, compactionFailure)
              : finish("completed")
            : turnEvidence.seen
              ? finish("completed")
            : (() => {
                const failure: ProviderRunFailure = {
                  reason: "provider-error",
                  message:
                    "Kimi ACP ended without returning any turn output; the underlying Kimi turn may have failed.",
                  phase: "turn",
                  terminalEvent: "session/prompt:empty-end-turn",
                };
                return finish("failed", failure.message, failure);
              })()
          : (() => {
              const failure = kimiStopFailure(response.stopReason);
              return finish("failed", failure.message, failure);
            })();
      requestProcessTermination(true);
      return outcome;
    },
  ).catch(async (error: unknown) => {
    if (cancelRequested) {
      requestProcessTermination(true);
      return finish("cancelled");
    }
    await observeKimiProcessExit(child);
    const diagnostic = redactHostMcpPayload(stderr.toString().trim());
    const safeError = redactHostMcpPayload(kimiErrorDetail(
      error,
      "Kimi ACP stopped unexpectedly.",
    ));
    const safeWireError = wireError
      ? new Error(redactHostMcpPayload(kimiErrorDetail(
          wireError,
          "Kimi ACP wire error.",
        )))
      : undefined;
    const safeProcessError = processError
      ? new Error(redactHostMcpPayload(kimiErrorDetail(
          processError,
          "Kimi ACP process error.",
        )))
      : undefined;
    const failure = kimiRuntimeFailure(safeError, {
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
    try {
      await terminateOwnedProcessTree(true);
    } catch {
      const error = "Kimi ACP process tree could not be confirmed stopped.";
      emitter.status("failed", error);
      return {
        ...outcome,
        status: "failed",
        exitCode: child.exitCode,
        signal: child.signalCode,
        error,
        failure: {
          reason: "process-exit",
          message: error,
          phase: "cleanup",
          terminalEvent: "process/cleanup",
        },
        cleanupConfirmed: false,
      };
    }
    if (hostToolsCleanupFailed) {
      const error = "Kimi Inertia chat tools could not be cleaned up.";
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
    };
  });

  function finish(
    status: ProviderRunResult["status"],
    error?: string,
    failure?: ProviderRunFailure,
  ): ProviderRunResult {
    return {
      providerId: "kimi",
      conversationId,
      status,
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

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
    hostToolRuntime?.settle();
    void hostMcpSession?.close().catch(() => requestProcessTermination(true));
    emitter.status("cancelling");
    cancelPending();
    if (!force && sessionId && activeContext) {
      void activeContext.notify(acp.methods.agent.session.cancel, { sessionId })
        .catch(() => requestProcessTermination(true));
      return;
    }
    requestProcessTermination(force);
  };

  return {
    harnessId: "kimi-acp",
    providerId: "kimi",
    result,
    cancel,
    extension: {
      kind: "kimi-acp",
      respondToApproval: (requestId, decision) =>
        hostToolRuntime?.respondToApproval(requestId, decision)
        || settleApproval(requestId, decision),
      respondToInput: settleInput,
    },
  };
}

async function kimiPermission(
  params: RequestPermissionRequest,
  displayParams: RequestPermissionRequest,
  signal: AbortSignal,
  options: AgentHarnessStartOptions,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
  approvals: Map<string, PendingApproval>,
  inputs: Map<string, PendingInput>,
): Promise<RequestPermissionResponse> {
  const inputOptions = kimiInputOptions(displayParams);
  if (inputOptions) {
    return kimiInputPermission(
      params,
      displayParams,
      inputOptions,
      signal,
      emit,
      inputs,
    );
  }

  const allow = oneShotPermissionOption(params.options, true);
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
      throw new Error("Kimi Code exceeded the bounded approval budget.");
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
          displayParams.toolCall.title || "Kimi Code requested permission",
        ),
        detail: bounded(jsonSummary(displayParams.toolCall.rawInput)),
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

interface KimiInputOption {
  id: string;
  label: string;
}

interface KimiInputOptions {
  kind: "question" | "plan";
  options: KimiInputOption[];
}

export function kimiInputOptions(
  params: Pick<RequestPermissionRequest, "options" | "toolCall">,
): KimiInputOptions | null {
  const questionOptions = params.options.filter((option) =>
    /^q\d+_opt_\d+$/u.test(option.optionId),
  );
  if (questionOptions.length > 0) {
    return {
      kind: "question",
      options: boundedInputOptions(questionOptions),
    };
  }
  const planOptions = params.options.filter((option) =>
    /^plan_(?:opt_\d+|approve|revise|reject_and_exit)$/u.test(option.optionId),
  );
  if (planOptions.length > 0) {
    return {
      kind: "plan",
      options: boundedInputOptions(planOptions),
    };
  }
  return null;
}

function boundedInputOptions(options: PermissionOption[]): KimiInputOption[] {
  if (options.length > MAX_INPUT_OPTIONS) {
    throw new Error(
      `Kimi Code sent more than ${MAX_INPUT_OPTIONS} input options.`,
    );
  }
  const seen = new Set<string>();
  return options.map((option) => {
    if (
      !option.optionId
      || option.optionId.length > 160
      || seen.has(option.optionId)
    ) throw new Error("Kimi Code sent an invalid input option identity.");
    seen.add(option.optionId);
    return {
      id: option.optionId,
      label: bounded(option.name || option.optionId),
    };
  });
}

async function kimiInputPermission(
  params: RequestPermissionRequest,
  displayParams: RequestPermissionRequest,
  input: KimiInputOptions,
  signal: AbortSignal,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
  inputs: Map<string, PendingInput>,
): Promise<RequestPermissionResponse> {
  const requestId = randomUUID();
  const questionId = "selection";
  const request: AgentInputRequest = {
    requestId,
    autoResolutionMs: null,
    questions: [{
      id: questionId,
      header: input.kind === "plan" ? "Plan review" : "Question",
      question: permissionQuestionText(displayParams, input.kind),
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: input.options.map((option) => ({
        ...option,
        description: "",
      })),
    }],
  };
  const answers = await new Promise<Record<string, string[]>>((resolve) => {
    if (inputs.size >= MAX_PENDING_INTERACTIONS) {
      throw new Error("Kimi Code exceeded the bounded input budget.");
    }
    inputs.set(requestId, { resolve, settled: false });
    signal.addEventListener("abort", () => {
      const pending = inputs.get(requestId);
      if (!pending || pending.settled) return;
      pending.settled = true;
      inputs.delete(requestId);
      emit({ type: "input-resolved", requestId });
      resolve({});
    }, { once: true });
    emit({ type: "input", request });
  });
  if (signal.aborted) return { outcome: { outcome: "cancelled" } };
  const answer = answers[questionId]?.[0];
  const selectedIndex = input.options.findIndex((option) =>
    option.id === answer || option.label === answer,
  );
  const selected = selectedIndex >= 0
    ? kimiInputOptions(params)?.options[selectedIndex]
    : undefined;
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.id } }
    : { outcome: { outcome: "cancelled" } };
}

function permissionQuestionText(
  params: Pick<RequestPermissionRequest, "toolCall">,
  kind: KimiInputOptions["kind"],
): string {
  for (const content of params.toolCall.content ?? []) {
    const value = objectValue(content);
    if (value?.type === "content" && typeof value.content === "object") {
      const nested = objectValue(value.content);
      if (nested?.type === "text" && typeof nested.text === "string") {
        return bounded(nested.text);
      }
    }
    if (value?.type === "text" && typeof value.text === "string") {
      return bounded(value.text);
    }
  }
  return bounded(
    params.toolCall.title
      || (kind === "plan" ? "How should Kimi Code proceed with this plan?" : "Kimi Code needs your input."),
  );
}

export function permissionDisplayIsSafe(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  return isSafeApprovalDisplayText(
    params.toolCall.title || "Kimi Code requested permission",
  ) && isSafeApprovalDisplayText(jsonSummary(params.toolCall.rawInput), true);
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

function handleKimiUpdate(
  notification: SessionNotification,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  supportsImages: boolean,
  contextUsage: KimiContextUsage,
  toolActivities: Map<string, ToolActivity>,
  turnEvidence: TurnEvidence,
  compactions: AcpCompactionProjection,
): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return;
    case "agent_message_chunk":
      if (update.content.type === "text") {
        const value = bounded(update.content.text);
        if (value.trim()) turnEvidence.seen = true;
        resultText.append(value);
        emitter.text(value);
      }
      return;
    case "agent_thought_chunk":
      if (update.content.type === "text") {
        if (update.content.text.trim()) turnEvidence.seen = true;
        emitter.rich({
          type: "reasoning-summary",
          text: bounded(update.content.text),
        });
      }
      return;
    case "tool_call": {
      turnEvidence.seen = true;
      const activityId = boundedId(update.toolCallId, "tool call");
      if (
        !toolActivities.has(activityId)
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) throw new Error("Kimi Code exceeded the bounded tool activity budget.");
      const kind = update.kind === "execute" ? "command" : "tool";
      const label = boundedToolStateText(update.title || "Kimi Code tool");
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
      turnEvidence.seen = true;
      const activityId = boundedId(update.toolCallId, "tool call");
      const existing = toolActivities.get(activityId);
      if (
        !existing
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) throw new Error("Kimi Code exceeded the bounded tool activity budget.");
      const kind = update.kind === "execute"
        ? "command"
        : existing?.kind ?? "tool";
      const label = boundedToolStateText(
        update.title ?? update.name ?? existing?.label ?? "Kimi Code tool",
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
          explanation: `Kimi Code plan: ${bounded(update.plan.uri)}`,
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
        `Kimi Code switched to ${bounded(update.currentModeId)} mode`,
      );
      return;
    case "config_option_update":
      emitKimiMetadata(update.configOptions, supportsImages, emitter.rich);
      return;
    case "session_info_update":
      if (update.title) {
        emitter.activity(
          "system",
          "info",
          `Kimi Code session: ${bounded(update.title)}`,
        );
      }
      return;
    case "usage_update":
      contextUsage.usedTokens = tokenCount(update.used);
      contextUsage.maxTokens = tokenCount(update.size);
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
      compactions.observeUpdate(update);
      return;
    case "compaction_summary_chunk":
      // ACP compaction summaries replace retained context. They prove that the
      // provider handled this turn, but are not assistant response text or
      // ordinary-turn evidence.
      compactions.observeSummaryChunk(update);
      return;
  }
  const unsupportedUpdate: never = update;
  throw new Error(
    `Kimi ACP sent an unsupported session update: ${String(
      (unsupportedUpdate as { sessionUpdate?: unknown }).sessionUpdate,
    )}.`,
  );
}

function failedKimiRun(
  conversationId: string,
  failure: ProviderRunFailure,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): AgentHarnessRun {
  emitter.status("failed", failure.message);
  return {
    harnessId: "kimi-acp",
    providerId: "kimi",
    result: Promise.resolve({
      providerId: "kimi",
      conversationId,
      status: "failed",
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
      kind: "kimi-acp",
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
    throw new Error(`Kimi ACP sent an invalid ${label} identity.`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonSummary(value: unknown): string {
  try {
    return value === undefined
      ? "Kimi Code requested permission."
      : JSON.stringify(value);
  } catch {
    return "Kimi Code requested permission.";
  }
}
