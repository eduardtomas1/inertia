import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type Agent,
  type Event,
  type Model,
  type OpencodeClient,
  type PermissionRuleset,
  type Provider,
  type QuestionInfo,
} from "@opencode-ai/sdk/v2";

import type { ProviderModel } from "../../shared/contracts";
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
import type { ProviderRunResult } from "./contracts";
import type {
  AgentApprovalDecision,
  AgentPlanStep,
} from "./interactions";
import { isSafeApprovalDisplayText } from "./approval-display";
import { CappedProviderBuffer, ProviderRunEventBudget } from "./io";
import {
  createOwnedOpenCodeClient,
  ownedOpenCodeCredentials,
  ownedOpenCodeEnvironment,
  openCodeInteractionId,
  openCodeOptionId,
  openCodeQuestionPayload,
  openCodeQuestionId,
  openCodeQuestions,
} from "./opencode-boundary";
import {
  OpenCodeServerCleanupUnconfirmedError,
  startOwnedOpenCodeServer,
  waitForOpenCodeHealth,
  withOpenCodeRequestDeadline,
} from "./opencode-owned-server";
import {
  createOpenCodeEventState,
  emitOpenCodeNextActivity,
  emitOpenCodeUsage,
  emitOpenCodeUsageSnapshot,
  handleOpenCodeNextTextEvent,
  handleOpenCodePart,
  handleOpenCodePartDelta,
  rememberOpenCodeMessageRole,
  removeOpenCodeMessage,
  removeOpenCodePart,
  replayOpenCodeParts,
  type OpenCodeEventState,
  type OpenCodeUsageState,
} from "./opencode-event-projection";
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_RUN_EVENTS = 8_192;
const MAX_PENDING_INTERACTIONS = 64;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_SERVER_OUTPUT_CHARS = 32 * 1024;
const START_TIMEOUT_MS = 10_000;
const INITIALIZATION_TIMEOUT_MS = 30_000;
const METADATA_PROVIDER_TIMEOUT_MS = 10_000;
const CANCEL_FORCE_MS = 2_000;
const RUN_DEADLINE_MS = 4 * 60 * 60 * 1_000;
const EVENT_INACTIVITY_DEADLINE_MS = 30 * 60 * 1_000;
const MIN_DEADLINE_MS = 25;
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

interface PendingApproval { nativeId: string; settled: boolean }
interface PendingInput { nativeId: string; questions: QuestionInfo[]; settled: boolean }
interface OpenCodePromptLifecycle {
  messageId: string;
  observed: boolean;
  activityObserved: boolean;
}
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
   * window. Events for other sessions do not reset this deadline.
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

export interface OpenCodeSdkMetadataOptions {
  /**
   * May shorten, but never extend, the production health-check deadline.
   * Primarily useful for deterministic lifecycle verification.
   */
  healthTimeoutMs?: number;
  /**
   * May shorten, but never extend, the production provider-catalog deadline.
   * Primarily useful for deterministic lifecycle verification.
   */
  providerTimeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
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

function openCodeModels(
  providers: Provider[],
  defaults: Record<string, string>,
  connectedProviderIds: readonly string[],
): ProviderModel[] {
  const connected = new Set(connectedProviderIds);
  return providers.filter((provider) => connected.has(provider.id)).flatMap((provider) => Object.values(provider.models).map((model) => {
    const variants = Object.keys(model.variants ?? {});
    return {
      id: `${provider.id}/${model.id}`,
      label: model.name || model.id,
      description: [provider.name, model.family, model.status !== "active" ? model.status : undefined].filter(Boolean).join(" · ") || "OpenCode model",
      isDefault: defaults[provider.id] === model.id,
      inputModalities: model.capabilities.input.image ? ["text", "image"] : ["text"],
      reasoningOptions: variants.map((variant) => ({ value: variant, label: variant, description: `${variant} model variant` })),
      // Catalog variants are explicit overlays; their record order does not
      // identify the base model's effective default.
      defaultReasoningEffort: "",
    } satisfies ProviderModel;
  })).slice(0, 128);
}

export async function readOpenCodeSdkModels(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  options: OpenCodeSdkMetadataOptions = {},
): Promise<ProviderModel[]> {
  const healthTimeoutMs = shortenedTimeout(
    options.healthTimeoutMs,
    START_TIMEOUT_MS,
    "metadata healthTimeoutMs",
  );
  const providerTimeoutMs = shortenedTimeout(
    options.providerTimeoutMs,
    METADATA_PROVIDER_TIMEOUT_MS,
    "metadata providerTimeoutMs",
  );
  const terminateOwnedProcessTree = options.terminateProcessTree ?? terminateProcessTreeAndWait;
  const output = new CappedProviderBuffer(MAX_SERVER_OUTPUT_CHARS);
  const credentials = ownedOpenCodeCredentials(environment);
  const started = await startOwnedOpenCodeServer(
    executable,
    cwd,
    ownedOpenCodeEnvironment(environment, credentials),
    output,
    terminateOwnedProcessTree,
    "OpenCode metadata server process tree",
  );
  const client = createOwnedOpenCodeClient(started.url, cwd, credentials);
  try {
    await waitForOpenCodeHealth(client, started.child, healthTimeoutMs);
    const response = await withOpenCodeRequestDeadline(
      providerTimeoutMs,
      "Timed out waiting for the OpenCode provider catalog.",
      async (signal) => await client.provider.list(
        { directory: cwd },
        { signal, throwOnError: true },
      ),
    );
    return openCodeModels(response.data.all, response.data.default, response.data.connected);
  } finally {
    await started.terminate(true);
  }
}

function startOpenCodeRun(
  options: AgentHarnessStartOptions,
  deadlines: OpenCodeRunDeadlines,
  terminateOwnedProcessTree: ProcessTreeTerminator,
  compactionTimestampNow: () => number,
): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter(
    "opencode",
    conversationId,
    options.callbacks,
    options.input.runId ?? conversationId,
    options.input.turnId ?? null,
    options.input.cwd,
  );
  const text = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const serverOutput = new CappedProviderBuffer(MAX_SERVER_OUTPUT_CHARS);
  const approvals = new Map<string, PendingApproval>();
  const inputs = new Map<string, PendingInput>();
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
  const promptLifecycle: OpenCodePromptLifecycle = {
    messageId: `msg_${randomUUID().replaceAll("-", "")}`,
    observed: false,
    activityObserved: false,
  };
  const pendingFollowUps = new Set<Promise<boolean>>();
  let sessionId = options.input.sessionId;
  let client: OpencodeClient | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let terminateOwnedRun: OwnedProcessTreeTermination | undefined;
  let cancelRequested = false;
  let acceptingFollowUps = false;
  let terminalError: string | undefined;
  let cancelOwnedRun: (force: boolean) => void = () => {};
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
  const failDeadline = (message: string): void => {
    if (cancelRequested || terminalError) return;
    terminalError = message;
    eventAbort.abort();
    interruptRun(new Error(message));
  };
  const armEventInactivityDeadline = (): void => {
    if (cancelRequested || terminalError) return;
    if (eventInactivityTimer) clearTimeout(eventInactivityTimer);
    eventInactivityTimer = setTimeout(() => {
      failDeadline("OpenCode's event stream became inactive before the session completed.");
    }, deadlines.eventInactivityDeadlineMs);
    eventInactivityTimer.unref();
  };
  const failInteraction = (error: unknown): void => {
    terminalError = safeError(error, "OpenCode could not deliver an interactive response.");
    eventAbort.abort();
    interruptRun(new Error(terminalError));
  };
  const settleApproval = (requestId: string, decision: AgentApprovalDecision): boolean => {
    const pending = approvals.get(requestId);
    if (!pending || pending.settled || !client) return false;
    pending.settled = true;
    approvals.delete(requestId);
    if (decision === "cancel") {
      emitter.rich({ type: "approval-resolved", requestId, decision });
      cancelOwnedRun(false);
      return true;
    }
    const reply = decision === "approve" ? "once" : "reject";
    void client.permission.reply({ requestID: pending.nativeId, reply }, { throwOnError: true }).then(() => {
      emitter.rich({ type: "approval-resolved", requestId, decision });
    }).catch(failInteraction);
    return true;
  };
  const settleInput = (requestId: string, answers: Record<string, string[]>): boolean => {
    const pending = inputs.get(requestId);
    if (!pending || pending.settled || !client) return false;
    pending.settled = true;
    inputs.delete(requestId);
    const ordered = pending.questions.map((question, index) => {
      const labelsById = new Map(question.options.map((option, optionIndex) => [
        openCodeOptionId(optionIndex),
        option.label,
      ]));
      return (answers[openCodeQuestionId(index)] ?? []).map((value) => labelsById.get(value) ?? value);
    });
    void client.question.reply({ requestID: pending.nativeId, answers: ordered }, { throwOnError: true }).then(() => {
      emitter.rich({ type: "input-resolved", requestId });
    }).catch(failInteraction);
    return true;
  };
  const rejectPending = (): void => {
    if (!client) return;
    for (const [requestId, pending] of approvals) {
      pending.settled = true;
      approvals.delete(requestId);
      void client.permission.reply({ requestID: pending.nativeId, reply: "reject" }, { throwOnError: true }).catch(() => {});
      emitter.rich({ type: "approval-resolved", requestId, decision: "cancelled" });
    }
    for (const [requestId, pending] of inputs) {
      pending.settled = true;
      inputs.delete(requestId);
      void client.question.reject({ requestID: pending.nativeId }, { throwOnError: true }).catch(() => {});
      emitter.rich({ type: "input-resolved", requestId });
    }
  };

  emitter.status("starting");
  runDeadlineTimer = setTimeout(() => {
    failDeadline("OpenCode exceeded the maximum run duration.");
  }, deadlines.runDeadlineMs);
  runDeadlineTimer.unref();
  const result = (async (): Promise<ProviderRunResult> => {
    let outcome: { status: ProviderRunResult["status"]; error?: string };
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

      const [providerData, agents] = await initialize(
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
      const manualCompaction: OpenCodeManualCompactionProof = {
        initiatedAt: null,
        messageId: null,
        startedAt: null,
      };
      let sessionIdleObserved = false;
      const pump = pumpOpenCodeEvents(subscribed.stream, sessionId, {
        onActivity: armEventInactivityDeadline,
        onEvent: (event) => handleOpenCodeEvent(
          event,
          options,
          client!,
          text,
          emitter,
          approvals,
          inputs,
          emittedParts,
          usageState,
          eventState,
          promptLifecycle,
          failInteraction,
        ),
        isDone: async (event) => {
          if (compacting) {
            return event.type === "session.error"
              || completesRequestedOpenCodeCompaction(event, manualCompaction);
          }
          if (event.type === "session.error") return true;
          if (!isOpenCodeIdleEvent(event)) return false;
          if (!promptLifecycle.observed || !promptLifecycle.activityObserved) return false;
          sessionIdleObserved = true;
          acceptingFollowUps = false;
          const admissions = [...pendingFollowUps];
          if (admissions.length === 0) return true;
          const receipts = await Promise.allSettled(admissions);
          const admitted = receipts.some((receipt) =>
            receipt.status === "fulfilled" && receipt.value);
          if (!admitted || cancelRequested || terminalError) return true;
          acceptingFollowUps = true;
          return false;
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
            return response;
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
          ? { status: "failed", error: terminalError }
          : { status: "completed" };
    } catch (error) {
      if (error instanceof OpenCodeServerCleanupUnconfirmedError) {
        cleanupConfirmed = false;
      }
      outcome = cancelRequested
        ? { status: "cancelled" }
        : {
            status: "failed",
            error: terminalError ?? safeError(error, serverDiagnostic(serverOutput)),
          };
    }
    acceptingFollowUps = false;
    await Promise.allSettled(pendingFollowUps);
    clearDeadlineTimers();
    if (cancelForceTimer) clearTimeout(cancelForceTimer);
    eventAbort.abort();
    rejectPending();
    if (child) {
      try {
        await terminateOwnedRun?.(true);
      } catch (error) {
        cleanupConfirmed = false;
        outcome = {
          status: "failed",
          error: safeError(
            error,
            "OpenCode server process tree could not be confirmed stopped.",
          ),
        };
      }
    }
    return finish(outcome.status, outcome.error, cleanupConfirmed);
  })();

  function finish(
    status: ProviderRunResult["status"],
    error?: string,
    cleanupConfirmed = true,
  ): ProviderRunResult {
    emitter.status(status, error);
    return {
      providerId: "opencode",
      conversationId,
      status,
      ...(sessionId ? { sessionId } : {}),
      text: text.toString(),
      textTruncated: text.truncated,
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
      ...(error ? { error } : {}),
      cleanupConfirmed,
    };
  }

  cancelOwnedRun = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
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
      void client.session.abort(
        { sessionID: sessionId, directory: options.input.cwd },
        { throwOnError: true },
      ).then((response) => {
        if (response.data === true) interruptRun(new Error("OpenCode acknowledged session cancellation."));
      }).catch(() => {
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
      respondToApproval: settleApproval,
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
        const files = input.imagePaths.map((path) => ({
          uri: pathToFileURL(path).href,
          name: path.split(/[\\/]/u).at(-1),
        }));
        const followUp = (async (): Promise<boolean> => {
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
            return exactOpenCodeSteerReceipt(
              response.data,
              id,
              activeSessionId,
              text,
              files.map(({ uri }) => uri),
            );
          } catch {
            return false;
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
    onActivity: () => void;
    onEvent: (event: Event) => void;
    isDone: (event: Event) => boolean | Promise<boolean>;
  },
): Promise<void> {
  const eventBudget = new ProviderRunEventBudget(
    "OpenCode",
    MAX_EVENT_BYTES,
    MAX_RUN_EVENTS,
    MAX_RUN_EVENT_BYTES,
  );
  for await (const event of stream) {
    eventBudget.observe(event);
    if (openCodeEventSessionId(event) !== sessionId) continue;
    handlers.onActivity();
    handlers.onEvent(event);
    if (await handlers.isDone(event)) return;
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

function handleOpenCodeEvent(
  event: Event,
  options: AgentHarnessStartOptions,
  client: OpencodeClient,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  approvals: Map<string, PendingApproval>,
  inputs: Map<string, PendingInput>,
  emittedParts: Map<string, string>,
  usageState: OpenCodeUsageState,
  eventState: OpenCodeEventState,
  promptLifecycle: OpenCodePromptLifecycle,
  onFailure: (error: unknown) => void,
): void {
  const properties = event.properties as Record<string, unknown>;
  if (
    event.type === "session.next.prompt.admitted"
    && stringValue(properties.messageID) === promptLifecycle.messageId
  ) {
    promptLifecycle.observed = true;
  }
  if (promptLifecycle.observed && isOpenCodeRunActivityEvent(event, properties)) {
    promptLifecycle.activityObserved = true;
  }
  if (event.type === "message.updated") {
    const info = objectValue(properties.info);
    const messageId = stringValue(info?.id);
    if (messageId) {
      rememberOpenCodeMessageRole(
        messageId,
        info?.role === "assistant" ? "assistant" : "other",
        eventState,
      );
      if (messageId === promptLifecycle.messageId) promptLifecycle.observed = true;
      if (
        info?.role === "assistant"
        && stringValue(info.parentID) === promptLifecycle.messageId
      ) {
        promptLifecycle.observed = true;
        promptLifecycle.activityObserved = true;
      }
    }
    if (info?.role === "assistant" && messageId) {
      const tokens = objectValue(info.tokens);
      if (tokens) emitOpenCodeUsage(messageId, tokens, usageState, emitter.rich);
      const error = objectValue(info.error);
      if (error) emitter.activity("system", "failed", bounded(errorMessage(error)));
      replayOpenCodeParts(
        messageId,
        emittedParts,
        resultText,
        emitter,
        eventState,
      );
    }
  } else if (event.type === "message.removed") {
    const messageId = stringValue(properties.messageID);
    if (messageId) removeOpenCodeMessage(messageId, emittedParts, eventState);
  } else if (event.type === "message.part.updated") {
    const part = objectValue(properties.part);
    if (part) {
      handleOpenCodePart(
        part,
        emittedParts,
        resultText,
        emitter,
        usageState,
        eventState,
      );
    }
  } else if (event.type === "message.part.removed") {
    const partId = stringValue(properties.partID);
    if (partId) removeOpenCodePart(partId, emittedParts, eventState);
  } else if (event.type === "message.part.delta") {
    const partId = stringValue(properties.partID);
    const messageId = stringValue(properties.messageID);
    const delta = stringValue(properties.delta);
    if (partId && messageId && delta) handleOpenCodePartDelta(
      partId,
      messageId,
      delta,
      emittedParts,
      resultText,
      emitter,
      eventState,
    );
  } else if (
    event.type === "session.next.text.started"
    || event.type === "session.next.text.delta"
    || event.type === "session.next.text.ended"
  ) {
    handleOpenCodeNextTextEvent(
      event.type,
      properties,
      "text",
      emittedParts,
      resultText,
      emitter,
      eventState,
    );
  } else if (
    event.type === "session.next.reasoning.started"
    || event.type === "session.next.reasoning.delta"
    || event.type === "session.next.reasoning.ended"
  ) {
    handleOpenCodeNextTextEvent(
      event.type,
      properties,
      "reasoning",
      emittedParts,
      resultText,
      emitter,
      eventState,
    );
  } else if (event.type === "session.next.step.ended") {
    const messageId = stringValue(properties.assistantMessageID);
    const tokens = objectValue(properties.tokens);
    if (messageId && tokens) emitOpenCodeUsage(messageId, tokens, usageState, emitter.rich);
  } else if (event.type === "session.next.step.failed") {
    const error = objectValue(properties.error);
    emitter.activity(
      "system",
      "failed",
      bounded(error ? errorMessage(error) : "OpenCode step failed."),
    );
  } else if (event.type === "session.next.retried") {
    const error = objectValue(properties.error);
    const attempt = finite(properties.attempt);
    emitter.activity(
      "system",
      "info",
      bounded(`OpenCode retried the model${attempt === null ? "" : ` (attempt ${attempt})`}`),
      error ? { detail: bounded(errorMessage(error)) } : {},
    );
  } else if (
    event.type === "session.next.shell.started"
    || event.type === "session.next.shell.ended"
    || event.type === "session.next.tool.called"
    || event.type === "session.next.tool.progress"
    || event.type === "session.next.tool.success"
    || event.type === "session.next.tool.failed"
  ) {
    emitOpenCodeNextActivity(event.type, properties, emitter);
  } else if (event.type === "todo.updated") {
    const todos = Array.isArray(properties.todos) ? properties.todos : [];
    emitter.rich({ type: "plan", explanation: null, steps: todos.flatMap(todoStep) });
  } else if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
    const nativeId = openCodeInteractionId(properties.id, "permission");
    const permission = stringValue(properties.permission) ?? stringValue(properties.action) ?? "tool";
    if (options.input.access === "full" || (options.input.access === "auto-edit" && permission === "edit")) {
      void client.permission.reply({ requestID: nativeId, reply: "once" }, { throwOnError: true }).catch(onFailure);
      return;
    }
    const display = openCodeApprovalDisplay(properties, permission);
    if (!display) {
      void client.permission.reply(
        { requestID: nativeId, reply: "reject" },
        { throwOnError: true },
      ).catch(onFailure);
      return;
    }
    const { detail, resources, title } = display;
    const requestId = randomUUID();
    if (approvals.size >= MAX_PENDING_INTERACTIONS) {
      throw new Error("OpenCode exceeded the bounded approval budget.");
    }
    approvals.set(requestId, { nativeId, settled: false });
    emitter.rich({
      type: "approval",
      request: {
        requestId,
        kind: permission === "bash" ? "command" : permission === "edit" ? "file-change" : "permissions",
        title: bounded(title),
        detail: bounded(detail),
        cwd: options.input.cwd,
        permissionRoots: resources.map((path) => ({ path: bounded(path), access: "write" as const })).slice(0, 20),
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
  } else if (event.type === "permission.replied" || event.type === "permission.v2.replied") {
    const nativeId = stringValue(properties.requestID);
    if (nativeId) resolveOpenCodeApproval(nativeId, properties.reply, approvals, emitter);
  } else if (event.type === "question.asked" || event.type === "question.v2.asked") {
    const nativeId = openCodeInteractionId(properties.id, "question");
    const questions = openCodeQuestionPayload(properties.questions);
    const requestId = randomUUID();
    if (inputs.size >= MAX_PENDING_INTERACTIONS) {
      throw new Error("OpenCode exceeded the bounded question budget.");
    }
    inputs.set(requestId, { nativeId, questions, settled: false });
    emitter.rich({ type: "input", request: openCodeQuestions(requestId, questions) });
  } else if (
    event.type === "question.replied"
    || event.type === "question.v2.replied"
    || event.type === "question.rejected"
    || event.type === "question.v2.rejected"
  ) {
    const nativeId = stringValue(properties.requestID);
    if (nativeId) resolveOpenCodeInput(nativeId, inputs, emitter);
  } else if (event.type === "session.deleted") {
    throw new Error("OpenCode deleted the active session before the run completed.");
  } else if (event.type === "session.status") {
    const status = objectValue(properties.status);
    if (status?.type === "retry") {
      emitter.activity(
        "system",
        "info",
        bounded(stringValue(status.message) ?? "OpenCode is retrying the model"),
      );
    }
  } else if (event.type === "session.error") {
    const error = objectValue(properties.error);
    const message = error ? errorMessage(error) : "OpenCode reported a session error.";
    emitter.activity("system", "failed", bounded(message));
    throw new Error(message);
  } else if (
    event.type === "session.compacted"
    || event.type === "session.next.compaction.ended"
  ) {
    usageState.currentContextTokens = null;
    emitOpenCodeUsageSnapshot(usageState, emitter.rich);
    emitter.activity("system", "info", "OpenCode compacted the session context");
  }
}

function resolveOpenCodeApproval(
  nativeId: string,
  reply: unknown,
  approvals: Map<string, PendingApproval>,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): void {
  for (const [requestId, pending] of approvals) {
    if (pending.nativeId !== nativeId) continue;
    pending.settled = true;
    approvals.delete(requestId);
    emitter.rich({
      type: "approval-resolved",
      requestId,
      decision: reply === "reject" ? "deny" : "approve",
    });
    return;
  }
}

function resolveOpenCodeInput(
  nativeId: string,
  inputs: Map<string, PendingInput>,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): void {
  for (const [requestId, pending] of inputs) {
    if (pending.nativeId !== nativeId) continue;
    pending.settled = true;
    inputs.delete(requestId);
    emitter.rich({ type: "input-resolved", requestId });
    return;
  }
}

export function openCodeApprovalDisplay(
  properties: Record<string, unknown>,
  permission = stringValue(properties.permission)
    ?? stringValue(properties.action)
    ?? "tool",
): { detail: string; resources: string[]; title: string } | null {
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((value): value is string =>
        typeof value === "string")
    : [];
  const resources = Array.isArray(properties.resources)
    ? properties.resources.filter((value): value is string =>
        typeof value === "string")
    : [];
  const title = `OpenCode wants to use ${permission}`;
  const detail = [...patterns, ...resources].join("\n")
    || jsonSummary(properties.metadata);
  return isSafeApprovalDisplayText(title)
      && isSafeApprovalDisplayText(detail, true)
      && resources.every((path) => isSafeApprovalDisplayText(path))
    ? { detail, resources, title }
    : null;
}

export function resolveOpenCodeModel(
  selection: string | undefined,
  providers: Provider[],
  connectedProviderIds: readonly string[],
): Model | undefined {
  if (!selection) return undefined;
  const slash = selection.indexOf("/");
  if (slash <= 0 || slash === selection.length - 1) {
    throw new Error(`OpenCode model '${selection}' must come from its native provider/model catalog.`);
  }
  const providerId = selection.slice(0, slash);
  const modelId = selection.slice(slash + 1);
  if (!connectedProviderIds.includes(providerId)) {
    throw new Error(`OpenCode does not advertise the selected model '${selection}' from a connected provider.`);
  }
  const model = findOpenCodeModel(providerId, modelId, providers);
  if (!model) throw new Error(`OpenCode does not advertise the selected model '${selection}'.`);
  return model;
}

function findOpenCodeModel(providerId: string, modelId: string, providers: Provider[]): Model | undefined {
  return providers.find((provider) => provider.id === providerId)?.models[modelId];
}

function resolveOpenCodeAgent(mode: "build" | "plan", agents: Agent[]): Agent | undefined {
  if (mode === "build") return undefined;
  const agent = agents.find((candidate) => candidate.name === "plan" && candidate.mode !== "subagent");
  if (!agent) throw new Error("OpenCode does not advertise its native plan agent.");
  return agent;
}

function openCodePermissions(access: "full" | "supervised" | "auto-edit"): PermissionRuleset {
  if (access === "full") return [{ permission: "*", pattern: "*", action: "allow" }];
  return [
    { permission: "*", pattern: "*", action: "ask" },
    ...(access === "auto-edit" ? [{ permission: "edit", pattern: "*", action: "allow" } as const] : []),
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

function todoStep(value: unknown): AgentPlanStep[] {
  const todo = objectValue(value);
  const content = stringValue(todo?.content);
  if (!content) return [];
  const status = todo?.status === "completed" ? "completed" : todo?.status === "in_progress" ? "inProgress" : "pending";
  return [{ step: bounded(content), status }];
}

function openCodeEventSessionId(event: Event): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  const info = objectValue(properties.info);
  return stringValue(properties.sessionID)
    ?? stringValue(info?.sessionID)
    ?? (event.type === "session.created"
      || event.type === "session.updated"
      || event.type === "session.deleted"
      ? stringValue(info?.id)
      : undefined);
}

function isOpenCodeIdleEvent(event: Event): boolean {
  if (event.type === "session.idle") return true;
  if (event.type !== "session.status") return false;
  return objectValue((event.properties as Record<string, unknown>).status)?.type === "idle";
}

function isOpenCodeRunActivityEvent(
  event: Event,
  properties: Record<string, unknown>,
): boolean {
  if (event.type === "message.updated") {
    return objectValue(properties.info)?.role === "assistant";
  }
  return event.type === "message.part.updated"
    || event.type === "message.part.delta"
    || event.type === "permission.asked"
    || event.type === "permission.v2.asked"
    || event.type === "question.asked"
    || event.type === "question.v2.asked"
    || event.type === "todo.updated"
    || event.type === "session.next.text.started"
    || event.type === "session.next.text.delta"
    || event.type === "session.next.text.ended"
    || event.type === "session.next.reasoning.started"
    || event.type === "session.next.reasoning.delta"
    || event.type === "session.next.reasoning.ended"
    || event.type === "session.next.shell.started"
    || event.type === "session.next.shell.ended"
    || event.type === "session.next.step.started"
    || event.type === "session.next.step.ended"
    || event.type === "session.next.step.failed"
    || event.type === "session.next.tool.called"
    || event.type === "session.next.tool.progress"
    || event.type === "session.next.tool.success"
    || event.type === "session.next.tool.failed";
}

function imageMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: throw new Error(`OpenCode does not support the attached image type: ${extname(path) || "unknown"}.`);
  }
}
function bounded(value: string): string { return value.slice(0, MAX_EVENT_TEXT_CHARS); }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function jsonSummary(value: unknown): string { try { return value === undefined ? "" : JSON.stringify(value); } catch { return ""; } }
function errorMessage(error: Record<string, unknown>): string { return stringValue(objectValue(error.data)?.message) ?? stringValue(error.message) ?? stringValue(error.name) ?? "OpenCode reported an error."; }
function safeError(error: unknown, fallback: string): string { return error instanceof Error && error.message ? bounded(error.message) : fallback; }
function serverDiagnostic(output: CappedProviderBuffer): string { const value = output.toString().trim(); return value ? bounded(`OpenCode server stopped: ${value}`) : "OpenCode server stopped unexpectedly."; }
