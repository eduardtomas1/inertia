import { startCodexAppServerRun } from "../codex-app-server";
import { withCodexControlClient } from "../codex/control-client";
import {
  codexAccessPolicy,
  codexServiceTierMatches,
  validateCodexModelProvider,
} from "../codex/app-server-config";
import {
  boundedText,
  objectValue,
  type JsonObject,
} from "../codex/protocol";
import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { staleProviderSessionDecision } from "../../shared/continuation-policy";
import { PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS } from "../../shared/runtime-command-timeouts";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type CodexAppServerHarnessCapabilities,
} from "./agent-harness";
import { providerFailureMessage } from "./adapters";
import type { ProviderRunResult } from "./contracts";

export const CODEX_APP_SERVER_HARNESS_CAPABILITIES = {
  lifecycle: {
    events: "push",
    terminalStatuses: ["completed", "failed", "cancelled"],
  },
  session: {
    resume: "native",
    identity: "thread",
  },
  cancellation: {
    graceful: "protocol-interrupt",
    forceFallback: "process-tree-kill",
  },
  extension: {
    kind: "codex-app-server",
    protocol: "json-rpc-jsonl",
    schema: "version-specific",
    approvals: "native",
    questions: "native",
    plans: "native",
    reasoning: "summary",
    usage: "token-usage",
    images: "local-image-input",
    authentication: "codex-cli",
    modelMetadata: "app-server",
  },
} as const satisfies CodexAppServerHarnessCapabilities;

function codexServiceTier(
  input: AgentHarnessStartOptions["input"],
): "priority" | null | undefined {
  const fastMode = input.modelSelection.providerOptions.fastMode;
  if (fastMode !== undefined && fastMode !== "priority") {
    throw new Error("Codex received an invalid Fast mode service tier.");
  }
  return input.supportedFastMode === "priority"
    ? fastMode === "priority" ? fastMode : null
    : undefined;
}

export interface CodexAppServerHarnessDependencies {
  withControlClient?: typeof withCodexControlClient;
}

export function createCodexAppServerHarness(
  dependencies: CodexAppServerHarnessDependencies = {},
): AgentHarness {
  return {
    id: "codex-app-server",
    providerId: "codex",
    capabilities: CODEX_APP_SERVER_HARNESS_CAPABILITIES,
    supports: (input) => input.providerId === "codex",
    start: (options) => startCodexRun(options, dependencies),
  };
}

function startCodexRun(
  options: AgentHarnessStartOptions,
  dependencies: CodexAppServerHarnessDependencies,
): AgentHarnessRun {
  if (options.input.operation?.kind === "compact") {
    return startCodexCompaction(options, dependencies);
  }
  const providerId = "codex" as const;
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter(
    providerId,
    conversationId,
    options.callbacks,
    options.input.runId ?? conversationId,
    options.input.turnId ?? null,
    options.input.cwd,
  );
  emitter.status("starting");
  let runningEmitted = false;
  const emitRunning = (): void => {
    if (runningEmitted) return;
    runningEmitted = true;
    emitter.status("running");
  };

  let codexRun: ReturnType<typeof startCodexAppServerRun>;
  try {
    const serviceTier = codexServiceTier(options.input);
    if (
      options.harnessConfiguration
      && options.harnessConfiguration.kind !== "codex-responses"
    ) {
      throw new Error("Codex received an incompatible harness configuration.");
    }
    codexRun = startCodexAppServerRun({
      executable: options.executable,
      environment: options.environment,
      cwd: options.input.cwd,
      prompt: options.input.prompt,
      ...(options.input.model ? { model: options.input.model } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(options.harnessConfiguration
        ? { modelProvider: options.harnessConfiguration }
        : {}),
      ...(options.input.reasoningEffort ? { reasoningEffort: options.input.reasoningEffort } : {}),
      ...(options.input.sessionId ? { sessionId: options.input.sessionId } : {}),
      ...(options.input.imagePaths ? { imagePaths: options.input.imagePaths } : {}),
      ...(options.input.skills
        ? {
            skills: options.input.skills.filter(
              (skill) => skill.source === "codex-native",
            ),
          }
        : {}),
      ...(options.input.goalStart
        ? { goalStart: options.input.goalStart }
        : {}),
      goalContinuationExpected:
        options.input.goalContinuationExpected === true,
      planMode: options.input.interactionMode === "plan",
      access: options.input.access,
      onText: emitter.text,
      onActivity: emitter.activity,
      onSession: emitter.session,
      onStatus: emitRunning,
      onApproval: (request) => emitter.codex({ type: "approval", request }),
      onApprovalResolved: (requestId, decision) => emitter.codex({ type: "approval-resolved", requestId, decision }),
      onInputRequest: (request) => emitter.codex({ type: "input", request }),
      onInputResolved: (requestId) => emitter.codex({ type: "input-resolved", requestId }),
      onPlan: (explanation, steps) => emitter.codex({ type: "plan", explanation, steps }),
      onGoalUpdated: emitter.goalUpdated,
      onGoalCleared: emitter.goalCleared,
      onReasoning: (text) => emitter.codex({ type: "reasoning-summary", text }),
      onUsage: (usage) => emitter.codex({ type: "usage", usage }),
      onRateLimits: (rateLimits, complete) => emitter.codex({ type: "metadata", metadata: { rateLimits }, source: "provider", complete }),
      onSubagent: emitter.subagent,
    });
  } catch (error) {
    const spawnError = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
    const message = providerFailureMessage(
      providerId,
      spawnError,
      "",
      "",
      options.input.backendProfile,
    );
    emitter.status("failed", message);
    return failedCodexRun(conversationId, options.input.sessionId, message);
  }

  let settled = false;
  let cancelRequested = false;
  const result = codexRun.result.then((runtimeResult): ProviderRunResult => {
    settled = true;
    const {
      diagnostic: runtimeDiagnostic,
      failure: runtimeFailure,
      compatibilityError,
      continuationError,
      ...publicRuntimeResult
    } = runtimeResult;
    if (runtimeResult.status === "cancelled" || cancelRequested) {
      emitter.status("cancelled");
      return { providerId, conversationId, ...publicRuntimeResult, status: "cancelled" };
    }
    if (runtimeResult.status === "failed") {
      const providerMessage = providerFailureMessage(
        providerId,
        undefined,
        runtimeDiagnostic ?? "",
        "",
        options.input.backendProfile,
      );
      const message = continuationError === "stale-provider-session"
        ? staleProviderSessionDecision().reason
        : compatibilityError === "full-access-unsupported"
          ? "This Codex App Server version does not support Full Access. Update Codex CLI and try again."
          : compatibilityError === "fast-mode-unsupported"
            ? "This Codex App Server version or selected model did not apply the requested response speed. Choose Standard, refresh models, or update Codex CLI."
          : runtimeFailure?.reason === "protocol-overflow"
              ? "Codex produced a protocol message that was too large to process safely."
              : runtimeFailure?.reason === "malformed-protocol"
                ? "Codex returned a malformed App Server message."
                : runtimeFailure?.reason === "goal-continuation-timeout"
                  ? "Codex kept the goal active but did not start another turn. Resume the goal to continue."
                  : runtimeFailure?.reason === "rpc-timeout"
                    ? "Codex App Server stopped responding."
                    : runtimeFailure?.reason === "transport-closed"
                      ? "The Codex App Server connection closed before the turn completed."
                      : providerMessage;
      const failure = runtimeFailure
        ? { ...runtimeFailure, message }
        : { reason: "codex-error" as const, message };
      emitter.status("failed", message);
      return {
        providerId,
        conversationId,
        ...publicRuntimeResult,
        status: "failed",
        error: message,
        failure,
      };
    }
    emitter.status("completed");
    return { providerId, conversationId, ...publicRuntimeResult, status: "completed" };
  });

  const cancel = (force: boolean): void => {
    if (settled) return;
    if (!cancelRequested) {
      cancelRequested = true;
      emitter.status("cancelling");
    }
    codexRun.cancel(force);
  };

  return {
    harnessId: "codex-app-server",
    providerId,
    result,
    cancel,
    extension: {
      kind: "codex-app-server",
      respondToApproval: (requestId, decision) => !settled && !cancelRequested && codexRun.respondToApproval(requestId, decision),
      respondToInput: (requestId, answers) => !settled && !cancelRequested && codexRun.respondToInput(requestId, answers),
      steer: async (content) =>
        !settled
        && !cancelRequested
        && Boolean(await codexRun.steer?.(content)),
      setGoal: async (input) => {
        if (settled || cancelRequested) {
          throw new Error("The Codex goal connection is not active.");
        }
        return await codexRun.setGoal(input);
      },
      clearGoal: async () => {
        if (settled || cancelRequested) {
          throw new Error("The Codex goal connection is not active.");
        }
        return await codexRun.clearGoal();
      },
    },
  };
}

function startCodexCompaction(
  options: AgentHarnessStartOptions,
  dependencies: CodexAppServerHarnessDependencies,
): AgentHarnessRun {
  const conversationId = options.input.conversationId
    ?? options.input.threadId
    ?? "";
  const sessionId = options.input.sessionId!;
  const emitter = createAgentHarnessEmitter(
    "codex",
    conversationId,
    options.callbacks,
    options.input.runId ?? conversationId,
    null,
    options.input.cwd,
  );
  const abortController = new AbortController();
  let settled = false;
  let cancelRequested = false;
  emitter.status("starting");

  const result = (async (): Promise<ProviderRunResult> => {
    let completionTimer: NodeJS.Timeout | undefined;
    try {
      if (
        options.harnessConfiguration
        && options.harnessConfiguration.kind !== "codex-responses"
      ) {
        throw new Error("Codex received an incompatible harness configuration.");
      }
      const modelProvider = validateCodexModelProvider({
        environment: options.environment,
        modelProvider: options.harnessConfiguration,
      });
      const serviceTier = codexServiceTier(options.input);
      let resolveCompaction!: () => void;
      let compactionInitiated = false;
      let compactionInitiatedAtMs: number | null = null;
      let compactionItemId: string | null = null;
      let compactionTurnId: string | null = null;
      let compactionStartedAtMs: number | null = null;
      const compacted = new Promise<void>((resolve, reject) => {
        resolveCompaction = resolve;
        completionTimer = setTimeout(
          () => reject(new Error("Codex context compaction timed out.")),
          PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS,
        );
        completionTimer.unref();
      });
      await (dependencies.withControlClient ?? withCodexControlClient)({
        executable: options.executable,
        environment: options.environment,
        cwd: options.input.cwd,
        timeoutMs: 30_000,
        processLabel: "Codex compaction process tree",
        signal: abortController.signal,
        onNotification: (method, params) => {
          // App Server does not expose a request/item correlation ID for
          // thread/compact/start. Its bounded authority is therefore a
          // matching terminal event on this one-shot control connection,
          // after local request initiation and before the operation timeout.
          // A buffered completion observed while resuming proves nothing.
          if (!compactionInitiated) return;
          if (method !== "item/started" && method !== "item/completed") return;
          if (params.threadId !== sessionId) return;
          const item = objectValue(params.item);
          if (item?.type !== "contextCompaction") return;
          const itemId = exactCodexLifecycleId(item.id);
          const turnId = exactCodexLifecycleId(params.turnId);
          if (!itemId || !turnId || compactionInitiatedAtMs === null) return;
          if (method === "item/started") {
            const startedAtMs = params.startedAtMs;
            if (
              typeof startedAtMs !== "number"
              || !Number.isSafeInteger(startedAtMs)
              || startedAtMs < compactionInitiatedAtMs
            ) return;
            compactionItemId ??= itemId;
            compactionTurnId ??= turnId;
            compactionStartedAtMs ??= startedAtMs;
            return;
          }
          const completedAtMs = params.completedAtMs;
          if (
            itemId === compactionItemId
            && turnId === compactionTurnId
            && compactionStartedAtMs !== null
            && typeof completedAtMs === "number"
            && Number.isSafeInteger(completedAtMs)
            && completedAtMs >= compactionStartedAtMs
          ) resolveCompaction();
        },
      }, async (client) => {
        const accessPolicy = codexAccessPolicy({
          access: options.input.access,
          planMode: options.input.interactionMode === "plan",
        });
        const threadConfig: JsonObject = {
          cwd: options.input.cwd,
          approvalPolicy: accessPolicy.approvalPolicy,
          approvalsReviewer: "user",
          sandbox: accessPolicy.threadSandbox,
          ...(options.input.model ? { model: options.input.model } : {}),
          ...(options.input.reasoningEffort
            ? { effort: options.input.reasoningEffort }
            : {}),
          ...(serviceTier !== undefined ? { serviceTier } : {}),
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
        const resumed = await client.request("thread/resume", {
          threadId: sessionId,
          excludeTurns: true,
          ...threadConfig,
        });
        const resumedThreadId = boundedText(
          objectValue(resumed.thread)?.id,
          512,
        );
        if (resumedThreadId !== sessionId) {
          throw new Error(
            "Codex did not resume the exact thread selected for compaction.",
          );
        }
        if (
          serviceTier !== undefined
          && !codexServiceTierMatches(serviceTier, resumed.serviceTier)
        ) {
          throw new Error(
            "Codex did not confirm the requested response service tier for compaction.",
          );
        }
        emitter.status("running");
        compactionInitiatedAtMs = Date.now();
        const compactRequest = client.request(
          "thread/compact/start",
          { threadId: sessionId },
        );
        compactionInitiated = true;
        await compactRequest;
        await compacted;
      });
      emitter.status("completed");
      return {
        providerId: "codex",
        conversationId,
        status: "completed",
        sessionId,
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        cleanupConfirmed: true,
      };
    } catch (error) {
      const cleanupConfirmed = !isProcessTreeTerminationUnconfirmed(error);
      const status = cancelRequested || abortController.signal.aborted
        ? "cancelled" as const
        : "failed" as const;
      const message = error instanceof Error
        ? error.message
        : "Codex could not compact the context.";
      emitter.status(status, status === "failed" ? message : undefined);
      return {
        providerId: "codex",
        conversationId,
        status,
        sessionId,
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        ...(status === "failed" ? { error: message } : {}),
        cleanupConfirmed,
      };
    } finally {
      settled = true;
      if (completionTimer) clearTimeout(completionTimer);
    }
  })();

  return {
    harnessId: "codex-app-server",
    providerId: "codex",
    result,
    cancel: () => {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      emitter.status("cancelling");
      abortController.abort();
    },
    extension: inactiveCodexExtension(),
  };
}

function exactCodexLifecycleId(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > 512
    || value.includes("\0")
  ) return null;
  return value;
}

function inactiveCodexExtension(): AgentHarnessRun["extension"] {
  return {
    kind: "codex-app-server",
    respondToApproval: () => false,
    respondToInput: () => false,
    steer: async () => false,
    setGoal: async () => {
      throw new Error("The Codex goal connection is not active.");
    },
    clearGoal: async () => {
      throw new Error("The Codex goal connection is not active.");
    },
  };
}

function failedCodexRun(
  conversationId: string,
  sessionId: string | undefined,
  error: string,
): AgentHarnessRun {
  return {
    harnessId: "codex-app-server",
    providerId: "codex",
    result: Promise.resolve({
      providerId: "codex",
      conversationId,
      status: "failed",
      sessionId,
      text: "",
      textTruncated: false,
      exitCode: null,
      signal: null,
      error,
      failure: {
        reason: "codex-error",
        message: error,
      },
      cleanupConfirmed: true,
    }),
    cancel: () => undefined,
    extension: inactiveCodexExtension(),
  };
}
