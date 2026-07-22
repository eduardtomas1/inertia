import { startCodexAppServerRun } from "../codex-app-server";
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
  const emitter = createAgentHarnessEmitter(providerId, conversationId, options.callbacks);
  emitter.status("starting");
  let runningEmitted = false;
  const emitRunning = (): void => {
    if (runningEmitted) return;
    runningEmitted = true;
    emitter.status("running");
  };

  let codexRun: ReturnType<typeof startCodexAppServerRun>;
  try {
    codexRun = startCodexAppServerRun({
      executable: options.executable,
      environment: options.environment,
      cwd: options.input.cwd,
      prompt: options.input.prompt,
      ...(options.input.model ? { model: options.input.model } : {}),
      ...(options.input.reasoningEffort ? { reasoningEffort: options.input.reasoningEffort } : {}),
      ...(options.input.sessionId ? { sessionId: options.input.sessionId } : {}),
      ...(options.input.imagePaths ? { imagePaths: options.input.imagePaths } : {}),
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
      onReasoning: (text) => emitter.codex({ type: "reasoning-summary", text }),
      onUsage: (usage) => emitter.codex({ type: "usage", usage }),
    });
  } catch (error) {
    const spawnError = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
    const message = providerFailureMessage(providerId, spawnError, "");
    emitter.status("failed", message);
    return failedCodexRun(conversationId, options.input.sessionId, message);
  }

  let settled = false;
  let cancelRequested = false;
  const result = codexRun.result.then((runtimeResult): ProviderRunResult => {
    settled = true;
    const { diagnostic: runtimeDiagnostic, compatibilityError, ...publicRuntimeResult } = runtimeResult;
    if (runtimeResult.status === "cancelled" || cancelRequested) {
      emitter.status("cancelled");
      return { providerId, conversationId, ...publicRuntimeResult, status: "cancelled" };
    }
    if (runtimeResult.status === "failed") {
      const message = compatibilityError === "full-access-unsupported"
        ? "This Codex App Server version does not support Full Access. Update Codex CLI and try again."
        : providerFailureMessage(providerId, undefined, runtimeDiagnostic ?? "");
      emitter.status("failed", message);
      return { providerId, conversationId, ...publicRuntimeResult, status: "failed", error: message };
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
    }),
    cancel: () => undefined,
    extension: {
      kind: "codex-app-server",
      respondToApproval: () => false,
      respondToInput: () => false,
    },
  };
}
