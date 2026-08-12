import { startCodexAppServerRun } from "../codex-app-server";
import { staleProviderSessionDecision } from "../../shared/continuation-policy";
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

export function createCodexAppServerHarness(): AgentHarness {
  return {
    id: "codex-app-server",
    providerId: "codex",
    capabilities: CODEX_APP_SERVER_HARNESS_CAPABILITIES,
    supports: (input) => input.providerId === "codex",
    start: startCodexRun,
  };
}

function startCodexRun(options: AgentHarnessStartOptions): AgentHarnessRun {
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
    extension: {
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
    },
  };
}
