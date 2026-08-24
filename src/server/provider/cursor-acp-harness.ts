import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  ToolCallStatus,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";

import type { ProviderModel } from "../../shared/contracts";
import { INERTIA_VERSION } from "../../shared/version";
import { spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";
import {
  createOwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type CursorAcpHarnessCapabilities,
} from "./agent-harness";
import type { ProviderRunFailure, ProviderRunResult } from "./contracts";
import type {
  AgentApprovalDecision,
  AgentPlanStep,
} from "./interactions";
import { providerActivityDetailSections } from "./activity-detail";
import { isSafeApprovalDisplayText } from "./approval-display";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import { providerProcessInvocation } from "./process";
import { cursorAgentCommandArgs } from "./cursor-command";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import {
  createProviderHostToolMcpSession,
  type ProviderHostToolMcpConnection,
} from "./host-tool-mcp-http";
import { acpHostMcpServers } from "./host-tool-mcp-config";
import { redactHostToolPayload } from "./host-tool-redaction";
import {
  cursorPriorFailureDetail,
  cursorRuntimeFailure,
} from "./cursor-acp-failures";
import {
  BoundedJsonLineTransform,
  validateCursorVendorFrame,
} from "./cursor-acp-framing";
import { selectAcpAgentAuthMethod } from "./acp-auth";
import { AcpCompactionProjection, unconfirmedAcpCompactionFailure } from "./acp-compaction-projection";
import { parseAcpSessionNotification } from "./acp-json-rpc";
import {
  cursorQuestions,
  cursorTodoSteps,
  parseCursorGenerateImageNotification,
  parseCursorPlanRequest,
  parseCursorQuestionRequest,
  parseCursorTaskNotification,
  parseCursorTodosRequest,
} from "./cursor-acp-extensions";

export {
  parseCursorGenerateImageNotification,
  parseCursorQuestionRequest,
  parseCursorTaskNotification,
};

const MAX_WIRE_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PENDING_INTERACTIONS = 64;
const MAX_TRACKED_TOOL_ACTIVITIES = 1_024;
const MAX_TOOL_ACTIVITY_ID_CHARS = 1_000;
const MAX_TOOL_STATE_TEXT_CHARS = 4_000;
const MAX_AVAILABLE_COMMANDS = 256;
const MAX_RUN_EVENTS = 8_192;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const COMMAND_ADVERTISEMENT_TIMEOUT_MS = 2_000;
const CONTROL_RPC_TIMEOUT_MS = 30_000;

export function cursorAcpProcessInvocation(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  return providerProcessInvocation(
    executable,
    cursorAgentCommandArgs(executable, ["acp"]),
    environment,
    platform,
  );
}

export const CURSOR_ACP_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "cursor-acp",
    protocol: "acp-v1-json-rpc",
    approvals: "native",
    questions: "cursor-extension",
    plans: "native",
    reasoning: "native",
    usage: "optional-acp-v1",
    images: "capability-negotiated",
    authentication: "cursor-cli",
    modelMetadata: "session-config-options",
  },
} as const satisfies CursorAcpHarnessCapabilities;

interface PendingApproval { resolve: (decision: AgentApprovalDecision) => void; settled: boolean }
interface PendingInput { resolve: (answers: Record<string, string[]>) => void; settled: boolean }
interface CursorContextUsage { usedTokens: number | null; maxTokens: number | null }

export interface CursorAcpHarnessOptions {
  /** Test seam for the owned ACP process-tree lifecycle. */
  terminateProcessTree?: ProcessTreeTerminator;
  /** Test seam for the bounded post-load command advertisement wait. */
  commandAdvertisementTimeoutMs?: number;
  /** Test seam for initialize, auth, session, and configuration RPC deadlines. */
  controlRpcTimeoutMs?: number;
}

export function createCursorAcpHarness(
  options: CursorAcpHarnessOptions = {},
): AgentHarness {
  return {
    id: "cursor-acp",
    providerId: "cursor",
    capabilities: CURSOR_ACP_CAPABILITIES,
    supports: (input) => input.providerId === "cursor",
    start: (startOptions) =>
      startCursorRun(
        startOptions,
        options.terminateProcessTree,
        options.commandAdvertisementTimeoutMs,
        options.controlRpcTimeoutMs,
      ),
  };
}

function startCursorRun(
  options: AgentHarnessStartOptions,
  terminateProcessTree?: ProcessTreeTerminator,
  commandAdvertisementTimeoutMs = COMMAND_ADVERTISEMENT_TIMEOUT_MS,
  controlRpcTimeoutMs = CONTROL_RPC_TIMEOUT_MS,
): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter(
    "cursor",
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
  let sessionId = options.input.sessionId;
  let cancelRequested = false;
  let sessionReady = false;
  let promptInFlight = false;
  let supportsImages = false;
  let availableCommandNames: Set<string> | null = null;
  let acceptsCommandAdvertisement = false;
  let resolveCommandAdvertisement!: () => void;
  const commandAdvertisement = new Promise<void>((resolve) => {
    resolveCommandAdvertisement = resolve;
  });
  const contextUsage: CursorContextUsage = { usedTokens: null, maxTokens: null };
  const compactions = new AcpCompactionProjection("Cursor", "cursor", emitter);
  let subagentSequence = 0;
  const toolActivities = new Map<
    string,
    {
      kind: "command" | "tool";
      label: string;
      command?: string;
      status?: ToolCallStatus | null;
    }
  >();
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
    ? createProviderHostToolMcpSession(hostToolRuntime)
    : undefined;
  let hostMcpConnection: ProviderHostToolMcpConnection | undefined;
  const redactHostMcpPayload = <T>(value: T): T => hostMcpConnection
    ? redactHostToolPayload(value, [
        hostMcpConnection.bearerToken,
        hostMcpConnection.url,
      ])
    : value;
  let activeContext: acp.ClientContext | undefined;
  let child: ChildProcessWithoutNullStreams;
  let activeFailurePhase = "initialize";
  let activeTerminalEvent = "initialize";
  let providerEventError: Error | undefined;
  let requestProcessTermination = (_force: boolean): void => undefined;

  const handleCursorProviderEvent = <T>(
    action: () => T,
    fallback: string,
  ): T => {
    try {
      return action();
    } catch (error) {
      const detail = safeError(error, fallback);
      providerEventError = new Error(detail === fallback ? fallback : `${fallback} ${detail}`);
      requestProcessTermination(true);
      throw providerEventError;
    }
  };

  const ownsActivePrompt = (): boolean =>
    Boolean(sessionId) && sessionReady && promptInFlight && !cancelRequested;

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

  const client = acp.client({ name: "Inertia" })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
      if (!ownsActivePrompt() || params.sessionId !== sessionId) {
        return { outcome: { outcome: "cancelled" } };
      }
      return await cursorPermission(
        params,
        redactHostMcpPayload(params),
        signal,
        options,
        emitter.rich,
        approvals,
      );
    })
    .onNotification(acp.methods.client.session.update, (value) =>
      handleCursorProviderEvent(
        () => parseAcpSessionNotification(value) as SessionNotification,
        "Cursor ACP sent an invalid session update.",
      ), ({ params }) => {
      const safeParams = redactHostMcpPayload(params);
      if (!sessionId || safeParams.sessionId !== sessionId || cancelRequested) return;
      if (
        acceptsCommandAdvertisement
        && safeParams.update.sessionUpdate === "available_commands_update"
      ) {
        availableCommandNames = new Set(
          safeParams.update.availableCommands.slice(0, MAX_AVAILABLE_COMMANDS).map(({ name }) =>
            name.replace(/^\//u, "").toLowerCase()),
        );
        resolveCommandAdvertisement();
      }
      if (
        !sessionReady
        && safeParams.update.sessionUpdate === "config_option_update"
      ) {
        emitCursorMetadata(
          safeParams.update.configOptions,
          supportsImages,
          emitter.rich,
        );
        return;
      }
      if (!ownsActivePrompt()) return;
      handleCursorProviderEvent(() => {
        handleCursorUpdate(safeParams, resultText, emitter, supportsImages, contextUsage, toolActivities, compactions);
      }, "Cursor ACP sent an invalid update.");
    })
    .onRequest("cursor/ask_question", (value) => value, async ({ params: rawParams, signal }) => {
      if (!ownsActivePrompt()) return { outcome: "cancelled" };
      const providerParams = parseCursorQuestionRequest(rawParams);
      const params = parseCursorQuestionRequest(
        redactHostMcpPayload(rawParams),
      );
      const requestId = randomUUID();
      const request = cursorQuestions(requestId, params);
      const answers = await new Promise<Record<string, string[]>>((resolve) => {
        if (inputs.size >= MAX_PENDING_INTERACTIONS) {
          throw new Error("Cursor exceeded the bounded question budget.");
        }
        inputs.set(requestId, { resolve, settled: false });
        signal.addEventListener("abort", () => settleInput(requestId, {}), { once: true });
        emitter.rich({ type: "input", request });
      });
      if (signal.aborted || !ownsActivePrompt()) return { outcome: "cancelled" };
      return {
        outcome: "answered",
        answers: params.questions.map((question, questionIndex) => ({
          questionId: providerParams.questions[questionIndex]?.id
            ?? question.id,
          selectedOptionIds: (answers[question.id] ?? []).flatMap((answer) => {
            const optionIndex = question.options.findIndex((candidate) =>
              candidate.id === answer || candidate.label === answer);
            // Cursor's extension only names this field for option IDs. Current
            // agents also accept a raw value here for the native "Other"
            // answer; dropping it would falsely report that the user answered.
            return [providerParams.questions[questionIndex]?.options[optionIndex]
              ?.id ?? answer];
          }),
        })),
      };
    })
    .onRequest("cursor/create_plan", (value) => value, ({ params: rawParams }) => {
      if (!ownsActivePrompt()) {
        return { outcome: { outcome: "cancelled" } };
      }
      const params = parseCursorPlanRequest(redactHostMcpPayload(rawParams));
      emitter.rich({ type: "plan", explanation: params.plan, steps: cursorTodoSteps(params.todos, params.plan) });
      return { outcome: { outcome: "accepted" } };
    })
    .onNotification("cursor/update_todos", (value) => value, ({ params: rawParams }) => {
      if (!ownsActivePrompt()) return;
      handleCursorProviderEvent(() => {
        const params = parseCursorTodosRequest(redactHostMcpPayload(rawParams));
        emitter.rich({ type: "plan", explanation: null, steps: cursorTodoSteps(params.todos) });
      }, "Cursor ACP sent an invalid todo update.");
    })
    .onNotification("cursor/task", (value) => value, ({ params: rawParams }) => {
      if (!ownsActivePrompt()) return;
      handleCursorProviderEvent(() => {
        const params = parseCursorTaskNotification(
          redactHostMcpPayload(rawParams),
        );
        subagentSequence += 1;
        emitter.subagent({
          sequence: subagentSequence,
          providerTaskId: params.toolCallId,
          providerAgentId: params.agentId ?? null,
          parentProviderAgentId: null,
          parentProviderToolUseId: null,
          providerToolUseId: params.toolCallId,
          providerRole: params.subagentType,
          providerName: params.model ?? null,
          providerStatus: "completed",
          status: "completed",
          isLive: false,
          description: params.description,
          progress: params.durationMs === undefined
            ? null
            : `Completed in ${params.durationMs} ms`,
          result: null,
        });
      }, "Cursor ACP sent an invalid task notification.");
    })
    .onNotification(
      "cursor/generate_image",
      (value) => value,
      ({ params: rawParams }) => {
        if (!ownsActivePrompt()) return;
        handleCursorProviderEvent(() => {
          const params = parseCursorGenerateImageNotification(
            redactHostMcpPayload(rawParams),
          );
          const detail = [
            params.filePath ? `Output: ${params.filePath}` : null,
            params.referenceImagePaths.length > 0
              ? `References: ${params.referenceImagePaths.join(", ")}`
              : null,
          ].filter((value): value is string => value !== null).join("\n");
          emitter.activity(
            "tool",
            "completed",
            `Generated image: ${params.description}`,
            {
              activityId: params.toolCallId,
              ...(detail ? { detail } : {}),
            },
          );
        }, "Cursor ACP sent an invalid generated-image notification.");
      },
    );

  emitter.status("starting");
  try {
    const invocation = cursorAcpProcessInvocation(
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
    return failedCursorRun(conversationId, safeError(error, "Cursor ACP could not be started."), emitter);
  }
  child.once("error", (error) => stderr.append(safeError(error, "Cursor ACP could not be started.")));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
  child.stdin.on("error", () => { /* Connection failure is surfaced by the ACP SDK. */ });
  const wireGuard = new BoundedJsonLineTransform(
    MAX_WIRE_LINE_BYTES,
    new ProviderRunEventBudget(
      "Cursor ACP",
      MAX_WIRE_LINE_BYTES,
      MAX_RUN_EVENTS,
      MAX_RUN_EVENT_BYTES,
    ),
    (frame) => validateCursorVendorFrame(frame, ownsActivePrompt()),
  );
  child.stdout.pipe(wireGuard);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(wireGuard) as ReadableStream<Uint8Array>,
  );
  const terminateOwnedProcessTree = createOwnedProcessTreeTermination(
    child,
    "Cursor ACP process tree",
    terminateProcessTree,
  );
  requestProcessTermination = (force: boolean): void => {
    // The public result below always awaits this same memoized promise.
    void terminateOwnedProcessTree(force).catch(() => undefined);
  };
  const requestControl = <T>(request: Promise<T>, method: string): Promise<T> =>
    withCursorRpcDeadline(request, controlRpcTimeoutMs, method, () => requestProcessTermination(true))
      .then(redactHostMcpPayload);

  const providerResult = client.connectWith(stream, async (context): Promise<ProviderRunResult> => {
    activeContext = context;
    const initialized = await requestControl(context.request(acp.methods.agent.initialize, {
      protocolVersion: 1, clientCapabilities: { plan: {}, session: { compaction: {} } },
      clientInfo: { name: "Inertia", version: INERTIA_VERSION },
    }), "initialize");
    validateCursorInitialize(initialized);
    supportsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
    hostMcpConnection = await hostMcpSession?.start();
    const hostMcpServers = hostMcpConnection
      ? acpHostMcpServers(
          hostMcpConnection,
          initialized.agentCapabilities?.mcpCapabilities?.http === true,
        )
      : [];
    const cursorLogin = selectAcpAgentAuthMethod("Cursor", initialized.authMethods, "cursor_login");
    if (cursorLogin) {
      activeFailurePhase = "auth"; activeTerminalEvent = "authenticate";
      await requestControl(
        context.request(acp.methods.agent.authenticate, { methodId: cursorLogin.id }), "authenticate",
      );
    }

    let modes: SessionModeState | null | undefined;
    let configOptions: SessionConfigOption[] | null | undefined;
    if (options.input.sessionId) {
      activeFailurePhase = "session"; activeTerminalEvent = "session/load";
      if (initialized.agentCapabilities?.loadSession !== true) throw new Error("This Cursor ACP server does not advertise session resume support.");
      const loadRequest = requestControl(context.request(acp.methods.agent.session.load, {
        sessionId: options.input.sessionId,
        cwd: options.input.cwd,
        mcpServers: hostMcpServers,
      }), "session/load");
      // The requested session ID is known before the connection starts, so a
      // same-session notification received before this request could be stale.
      // Only advertisements delivered after the resume request is on the wire
      // can prove the capabilities of the resumed session.
      acceptsCommandAdvertisement = true;
      const loaded = redactHostMcpPayload(await loadRequest);
      modes = loaded?.modes;
      configOptions = loaded?.configOptions;
    } else {
      activeFailurePhase = "session"; activeTerminalEvent = "session/new";
      const created = await requestControl(context.request(acp.methods.agent.session.new, {
        cwd: options.input.cwd,
        mcpServers: hostMcpServers,
      }), "session/new");
      sessionId = created.sessionId;
      emitter.session(sessionId);
      modes = created.modes;
      configOptions = created.configOptions;
    }
    if (!sessionId) throw new Error("Cursor ACP did not return a session ID.");
    activeFailurePhase = "configuration"; activeTerminalEvent = "session/configuration";
    const configuredOptions = await configureCursorSession(
      context,
      sessionId,
      modes,
      configOptions ?? [],
      options.input.interactionMode,
      options.input.model,
      options.input.reasoningEffort,
      redactHostMcpPayload,
      requestControl,
    );
    emitCursorMetadata(configuredOptions, supportsImages, emitter.rich);
    if (options.input.operation?.kind === "compact") {
      await waitForCursorCommandAdvertisement(
        commandAdvertisement,
        commandAdvertisementTimeoutMs,
      );
      if (availableCommandNames === null) {
        throw new Error(
          "This Cursor ACP session did not advertise its available commands.",
        );
      }
    }
    if (options.input.operation?.kind === "compact"
      && !availableCommandNames?.has("summarize")) {
      throw new Error(
        "This Cursor ACP session does not advertise its summarize command.",
      );
    }
    const providerPrompt = options.input.operation?.kind === "compact"
      ? "/summarize"
      : options.input.prompt;
    const prompt = await cursorPrompt(providerPrompt, options.input.imagePaths ?? [], initialized);
    if (cancelRequested) return finish("cancelled");
    sessionReady = true;
    emitter.status("running");
    // ACP 1.4 compaction evidence, not a bare `/summarize` end_turn, authorizes success.
    promptInFlight = true;
    activeFailurePhase = "turn"; activeTerminalEvent = "session/prompt";
    const response = redactHostMcpPayload(await context.request(
      acp.methods.agent.session.prompt,
      { sessionId, prompt },
    ).finally(() => {
      promptInFlight = false;
    }));
    if (providerEventError) throw providerEventError;
    if (response.usage) emitCursorPromptUsage(response.usage, contextUsage, emitter.rich);
    const compactionFailure = options.input.operation?.kind === "compact"
      && compactions.completionEvidence() !== "completed"
      ? unconfirmedAcpCompactionFailure("Cursor")
      : undefined;
    const outcome = cancelRequested || response.stopReason === "cancelled"
      ? finish("cancelled")
      : response.stopReason !== "end_turn"
        ? (() => {
            const message = `Cursor stopped with reason: ${response.stopReason}.`;
            return finish("failed", message, {
              reason: "provider-error",
              message,
              phase: "turn",
              terminalEvent: `session/prompt:${response.stopReason}`,
            });
          })()
        : compactionFailure
          ? finish("failed", compactionFailure.message, compactionFailure)
          : finish("completed");
    // Arm owned termination before returning control to connectWith, which may
    // close/reap the ACP transport before the public-result continuation runs.
    requestProcessTermination(true);
    return outcome;
  }).catch((error: unknown) => {
    requestProcessTermination(true);
    if (cancelRequested) return finish("cancelled");
    const redactHostMcp = (value: string): string => redactHostMcpPayload(value);
    const diagnostic = redactHostMcp(stderr.toString().trim());
    const message = redactHostMcp(safeError(
      providerEventError ?? error,
      diagnostic ? `Cursor ACP stopped: ${diagnostic}` : "Cursor ACP stopped unexpectedly.",
    ));
    return finish(
      "failed",
      message,
      cursorRuntimeFailure(message, child, activeFailurePhase, activeTerminalEvent),
    );
  });
  const result = providerResult.then(async (outcome): Promise<ProviderRunResult> => {
    cancelPending();
    hostToolRuntime?.settle();
    try {
      await hostMcpSession?.close();
    } catch {
      const error = "Cursor Inertia chat tools could not be cleaned up.";
      emitter.status("failed", error);
      return { ...outcome, status: "failed", error, cleanupConfirmed: false };
    }
    try {
      // ACP has already produced its terminal response, so no graceful wait
      // window remains useful. Reuse any earlier cancellation request.
      await terminateOwnedProcessTree(true);
    } catch {
      const error = "Cursor ACP process tree could not be confirmed stopped.";
      const priorFailure = outcome.failure
        ? cursorPriorFailureDetail(outcome.failure, options.input.cwd)
        : undefined;
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
          terminalEvent: "process-tree/cleanup",
          ...(priorFailure ? { technicalDetail: priorFailure } : {}),
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
      providerId: "cursor",
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
      void activeContext.notify(
        acp.methods.agent.session.cancel,
        { sessionId },
      ).catch(() => requestProcessTermination(true));
      return;
    }
    requestProcessTermination(force);
  };

  return {
    harnessId: "cursor-acp",
    providerId: "cursor",
    result,
    cancel,
    extension: {
      kind: "cursor-acp",
      respondToApproval: (requestId, decision) =>
        hostToolRuntime?.respondToApproval(requestId, decision)
        || settleApproval(requestId, decision),
      respondToInput: settleInput,
    },
  };
}

async function waitForCursorCommandAdvertisement(
  advertisement: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      advertisement,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cursorPermission(
  params: RequestPermissionRequest,
  displayParams: RequestPermissionRequest,
  signal: AbortSignal,
  options: AgentHarnessStartOptions,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
  approvals: Map<string, PendingApproval>,
): Promise<RequestPermissionResponse> {
  const allow = cursorOneShotPermissionOption(params.options, true);
  const fileMutation = isCursorFileMutationKind(params.toolCall.kind);
  if (
    options.input.access === "full"
    || (options.input.access === "auto-edit" && fileMutation)
  ) {
    return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
  }
  if (!cursorPermissionDisplayIsSafe(displayParams)) {
    return { outcome: { outcome: "cancelled" } };
  }
  const requestId = randomUUID();
  const decision = await new Promise<AgentApprovalDecision>((resolve) => {
    if (approvals.size >= MAX_PENDING_INTERACTIONS) {
      throw new Error("Cursor exceeded the bounded approval budget.");
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
          displayParams.toolCall.title || "Cursor requested permission",
        ),
        detail: bounded(jsonSummary(displayParams.toolCall.rawInput)),
        cwd: options.input.cwd,
        permissionRoots: [],
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
  });
  if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
  const selected = cursorOneShotPermissionOption(
    params.options,
    decision === "approve",
  );
  return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
}

export function cursorPermissionDisplayIsSafe(
  params: Pick<RequestPermissionRequest, "toolCall">,
): boolean {
  return isSafeApprovalDisplayText(
    params.toolCall.title || "Cursor requested permission",
  ) && isSafeApprovalDisplayText(jsonSummary(params.toolCall.rawInput), true);
}

export function isCursorFileMutationKind(
  kind: ToolKind | null | undefined,
): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

export function cursorOneShotPermissionOption(
  options: PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  // Inertia's provider-neutral approval only represents this request. Never
  // turn it into a provider-persisted grant or denial without an explicit UI
  // choice for that stronger scope.
  const kind = allow ? "allow_once" : "reject_once";
  return options.find((option) => option.kind === kind);
}

function handleCursorUpdate(
  notification: SessionNotification,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  supportsImages: boolean,
  contextUsage: CursorContextUsage,
  toolActivities: Map<
    string,
    {
      kind: "command" | "tool";
      label: string;
      command?: string;
      status?: ToolCallStatus | null;
    }
  >,
  compactions: AcpCompactionProjection,
): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      // This is an echo of client-authored input, not assistant output.
      return;
    case "agent_message_chunk":
      if (update.content.type === "text") {
        const value = bounded(update.content.text);
        resultText.append(value);
        emitter.text(value);
      }
      return;
    case "agent_thought_chunk":
      if (update.content.type === "text") {
        emitter.rich({
          type: "reasoning-summary",
          text: bounded(update.content.text),
        });
      }
      return;
    case "tool_call": {
      const activityId = boundedToolActivityId(update.toolCallId);
      if (
        !toolActivities.has(activityId)
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) {
        throw new Error("Cursor exceeded the bounded tool activity budget.");
      }
      const kind = update.kind === "execute" ? "command" : "tool";
      const label = boundedToolStateText(update.title || "Cursor tool");
      const phase = cursorToolActivityPhase(update.status);
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
      const activityId = boundedToolActivityId(update.toolCallId);
      const existing = toolActivities.get(activityId);
      if (
        !existing
        && toolActivities.size >= MAX_TRACKED_TOOL_ACTIVITIES
      ) {
        throw new Error("Cursor exceeded the bounded tool activity budget.");
      }
      const kind = update.kind === "execute"
        ? "command"
        : existing?.kind ?? "tool";
      const label = boundedToolStateText(
        update.title ?? update.name ?? existing?.label ?? "Cursor tool",
      );
      const status = update.status ?? existing?.status;
      const phase = cursorToolActivityPhase(status);
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
        steps: cursorPlanSteps(update.entries),
      });
      return;
    case "plan_update":
      if (update.plan.type === "items") {
        emitter.rich({
          type: "plan",
          explanation: null,
          steps: cursorPlanSteps(update.plan.entries),
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
          explanation: `Cursor plan: ${bounded(update.plan.uri)}`,
          steps: [],
        });
      }
      return;
    case "plan_removed":
      emitter.rich({ type: "plan", explanation: null, steps: [] });
      return;
    case "available_commands_update":
      // The enclosing notification handler retains the bounded command set.
      return;
    case "current_mode_update":
      emitter.activity(
        "system",
        "info",
        `Cursor switched to ${bounded(update.currentModeId)} mode`,
      );
      return;
    case "config_option_update":
      emitCursorMetadata(update.configOptions, supportsImages, emitter.rich);
      return;
    case "session_info_update":
      if (update.title) {
        emitter.activity(
          "system",
          "info",
          `Cursor session: ${bounded(update.title)}`,
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
      // ACP defines this as retained context, not new assistant output. The
      // lifecycle update above is projected; replaying the summary here would
      // falsely append historical context to the current answer.
      compactions.observeSummaryChunk(update);
      return;
  }
  const unsupportedUpdate: never = update;
  throw new Error(
    `Cursor ACP sent an unsupported session update: ${String(
      (unsupportedUpdate as { sessionUpdate?: unknown }).sessionUpdate,
    )}.`,
  );
}

function cursorToolActivityPhase(
  status: ToolCallStatus | null | undefined,
): "started" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "started";
}

function cursorPlanSteps(
  entries: ReadonlyArray<{ content: string; status: string }>,
): AgentPlanStep[] {
  return entries.slice(0, 100).map((entry) => ({
    step: bounded(entry.content),
    status: entry.status === "in_progress"
      ? "inProgress"
      : entry.status === "completed"
        ? "completed"
        : "pending",
  }));
}

function cursorSelectChoices(option: SessionConfigOption | undefined): Array<{ value: string; name: string; description?: string | null }> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]).slice(0, 64);
}

function emitCursorMetadata(
  configOptions: SessionConfigOption[],
  supportsImages: boolean,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  const modelOption = configOptions.find((option) => option.type === "select" && option.category === "model");
  const models = cursorSelectChoices(modelOption);
  if (!modelOption || modelOption.type !== "select" || models.length === 0) return;
  const effortOption = configOptions.find((option) => option.type === "select" && option.category === "thought_level");
  const efforts = cursorSelectChoices(effortOption).slice(0, 12);
  const defaultEffort = effortOption?.type === "select" && typeof effortOption.currentValue === "string"
    ? effortOption.currentValue
    : "";
  const metadata: ProviderModel[] = models.map((model) => ({
    id: bounded(model.value),
    label: bounded(model.name || model.value),
    description: bounded(model.description || "Cursor session model"),
    isDefault: modelOption.currentValue === model.value,
    inputModalities: supportsImages ? ["text", "image"] : ["text"],
    reasoningOptions: efforts.map((effort) => ({
      value: bounded(effort.value),
      label: bounded(effort.name || effort.value),
      description: bounded(effort.description || `${effort.name || effort.value} reasoning`),
    })),
    defaultReasoningEffort: defaultEffort,
  }));
  emit({ type: "metadata", metadata: { models: metadata }, source: "session", complete: true });
}

async function configureCursorSession(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  interactionMode: "build" | "plan",
  model?: string,
  effort?: string,
  redactResponse: <T>(value: T) => T = (value) => value,
  requestControl: <T>(request: Promise<T>, method: string) => Promise<T> = (request) => request,
): Promise<SessionConfigOption[]> {
  let authoritativeConfigOptions = configOptions;
  const wantedMode = interactionMode === "plan" ? /plan|architect/iu : /build|agent|code/iu;
  const nativeMode = modes?.availableModes.find((mode) => wantedMode.test(`${mode.id} ${mode.name}`));
  const configMode = findCursorAdvertisedConfigValue(authoritativeConfigOptions, "mode", interactionMode === "plan" ? "plan" : "build", wantedMode);
  if (nativeMode && modes?.currentModeId !== nativeMode.id) {
    await requestControl(
      context.request(acp.methods.agent.session.setMode, { sessionId, modeId: nativeMode.id }),
      "session/set_mode",
    );
  } else if (!nativeMode && configMode) {
    const response = redactResponse(await requestControl(context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: configMode.id, value: configMode.value }), "session/set_config_option"));
    authoritativeConfigOptions = response.configOptions;
  } else if (interactionMode === "plan" && !nativeMode) {
    throw new Error("This Cursor ACP server does not advertise a plan mode.");
  }
  if (model) {
    const selected = findCursorAdvertisedConfigValue(authoritativeConfigOptions, "model", model);
    if (!selected) throw new Error(`Cursor ACP does not advertise the selected model '${model}'.`);
    const response = redactResponse(await requestControl(context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: selected.id, value: selected.value }), "session/set_config_option"));
    authoritativeConfigOptions = response.configOptions;
  }
  if (effort) {
    const selected = findCursorAdvertisedConfigValue(authoritativeConfigOptions, "thought_level", effort);
    if (!selected) throw new Error(`Cursor ACP does not advertise the selected reasoning effort '${effort}'.`);
    const response = redactResponse(await requestControl(context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: selected.id, value: selected.value }), "session/set_config_option"));
    authoritativeConfigOptions = response.configOptions;
  }
  return authoritativeConfigOptions;
}

export async function withCursorRpcDeadline<T>(
  request: Promise<T>, timeoutMs: number, method: string, onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Cursor ACP ${method} RPC deadline exceeded after ${Math.max(0, timeoutMs)} ms.`));
        }, Math.max(0, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function findCursorAdvertisedConfigValue(
  configOptions: SessionConfigOption[],
  category: string,
  wanted: string,
  fallbackPattern?: RegExp,
): { id: string; value: string } | undefined {
  const option = configOptions.find((candidate) => candidate.type === "select" && candidate.category === category);
  if (!option || option.type !== "select") return undefined;
  const choices = option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
  const wantedLower = wanted.toLowerCase();
  const selected = choices.find((choice) => choice.value.toLowerCase() === wantedLower || choice.name.toLowerCase() === wantedLower)
    ?? (fallbackPattern ? choices.find((choice) => fallbackPattern.test(`${choice.value} ${choice.name}`)) : undefined);
  return selected ? { id: option.id, value: selected.value } : undefined;
}

async function cursorPrompt(prompt: string, paths: readonly string[], initialized: InitializeResponse): Promise<ContentBlock[]> {
  if (paths.length > 0 && initialized.agentCapabilities?.promptCapabilities?.image !== true) {
    throw new Error("This Cursor ACP server did not advertise image prompt support.");
  }
  const blocks: ContentBlock[] = [];
  let total = 0;
  for (const path of paths) {
    const mimeType = imageMediaType(path);
    if (!mimeType) throw new Error(`Cursor does not support the attached image type: ${extname(path) || "unknown"}.`);
    const data = await readFile(path);
    total += data.byteLength;
    if (total > MAX_IMAGE_BYTES) throw new Error("Cursor image attachments exceed the 20 MB safety limit.");
    blocks.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

function validateCursorInitialize(initialized: InitializeResponse): void {
  if (initialized.protocolVersion !== 1) throw new Error(`Unsupported Cursor ACP protocol version: ${initialized.protocolVersion}.`);
  const name = initialized.agentInfo?.name?.toLowerCase() ?? "";
  if (name && !name.includes("cursor")) throw new Error(`The selected executable exposed ACP as '${initialized.agentInfo?.name}', not Cursor.`);
}

function emitCursorPromptUsage(
  usage: Usage,
  contextUsage: CursorContextUsage,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  emit({
    type: "usage",
    usage: {
      usedTokens: contextUsage.usedTokens,
      totalProcessedTokens: tokenCount(usage.totalTokens),
      totalProcessedScope: "session",
      maxTokens: contextUsage.maxTokens,
      inputTokens: tokenCount(usage.inputTokens),
      cachedInputTokens: tokenCount(usage.cachedReadTokens),
      cacheWriteInputTokens: tokenCount(usage.cachedWriteTokens),
      outputTokens: tokenCount(usage.outputTokens),
      reasoningOutputTokens: tokenCount(usage.thoughtTokens),
      compactsAutomatically: null,
    },
  });
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function failedCursorRun(conversationId: string, message: string, emitter: ReturnType<typeof createAgentHarnessEmitter>): AgentHarnessRun {
  emitter.status("failed", message);
  return {
    harnessId: "cursor-acp",
    providerId: "cursor",
    result: Promise.resolve({
      providerId: "cursor",
      conversationId,
      status: "failed",
      text: "",
      textTruncated: false,
      exitCode: null,
      signal: null,
      error: message,
      failure: {
        reason: "provider-error",
        message,
        phase: "startup",
        terminalEvent: "process/spawn",
      },
      cleanupConfirmed: true,
    }),
    cancel: () => {},
    extension: { kind: "cursor-acp", respondToApproval: () => false, respondToInput: () => false },
  };
}

function imageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return undefined;
  }
}
function bounded(value: string): string { return value.slice(0, MAX_EVENT_TEXT_CHARS); }
function boundedToolStateText(value: string): string { return value.slice(0, MAX_TOOL_STATE_TEXT_CHARS); }
function boundedToolActivityId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOOL_ACTIVITY_ID_CHARS) {
    throw new Error("Cursor ACP sent an invalid tool call identity.");
  }
  return value;
}
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function safeError(error: unknown, fallback: string): string { return error instanceof Error && error.message ? bounded(error.message) : fallback; }
function jsonSummary(value: unknown): string { try { return value === undefined ? "Cursor requested permission." : JSON.stringify(value); } catch { return "Cursor requested permission."; } }
