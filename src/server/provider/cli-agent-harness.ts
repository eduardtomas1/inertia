import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  createOwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import {
  buildProviderInvocation,
  normalizeProviderLine,
  providerFailureMessage,
  type ProviderInvocation,
  type ProviderParserState,
} from "./adapters";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessCapabilities,
  type AgentHarnessId,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
} from "./agent-harness";
import {
  providerRunTerminal,
  type ProviderId,
  type ProviderRunInput,
  type ProviderRunResult,
} from "./contracts";
import { CappedProviderBuffer, ProviderNdjsonDecoder } from "./io";
import { providerProcessInvocation } from "./process";
import {
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";

const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;

const CORE_CAPABILITIES = {
  lifecycle: {
    events: "push",
    terminalStatuses: ["completed", "failed", "cancelled"],
  },
  session: {
    resume: "native",
    identity: "session",
  },
  cancellation: {
    graceful: "process-tree-signal",
    forceFallback: "process-tree-kill",
  },
} as const;

export const LEGACY_CLI_AGENT_HARNESS_CAPABILITIES_FOR_TESTS = {
  codex: {
    ...CORE_CAPABILITIES,
    session: { resume: "native", identity: "thread" },
    extension: {
      kind: "codex-cli",
      protocol: "exec-jsonl",
      routing: "full-access-compatibility",
      approvals: "unavailable",
      questions: "unavailable",
      plans: "unavailable",
      reasoning: "unavailable",
      usage: "unavailable",
      images: "native-cli-path",
      authentication: "codex-cli",
      modelMetadata: "unavailable",
    },
  },
  claude: {
    ...CORE_CAPABILITIES,
    extension: {
      kind: "claude-cli",
      protocol: "stream-json",
      partialMessages: "enabled",
      permissionModes: "native-cli",
      planMode: "native-cli",
      approvals: "unavailable-in-current-harness",
      questions: "unavailable-in-current-harness",
      reasoning: "unavailable-in-current-harness",
      usage: "unavailable-in-current-harness",
      images: "prompt-path-reference",
      authentication: "claude-cli",
      modelMetadata: "unavailable-in-current-harness",
    },
  },
  cursor: {
    ...CORE_CAPABILITIES,
    extension: {
      kind: "cursor-cli",
      protocol: "stream-json",
      approvals: "unavailable-in-current-harness",
      questions: "unavailable-in-current-harness",
      plans: "prompt-emulated",
      reasoning: "suppressed-by-print-mode",
      usage: "unavailable-in-current-harness",
      images: "prompt-path-reference",
      authentication: "cursor-cli",
      modelMetadata: "unavailable-in-current-harness",
    },
  },
  opencode: {
    ...CORE_CAPABILITIES,
    extension: {
      kind: "opencode-cli",
      protocol: "json-events",
      planMode: "native-agent-selection",
      approvals: "unavailable-in-current-harness",
      questions: "unavailable-in-current-harness",
      reasoning: "unavailable-in-current-harness",
      usage: "unavailable-in-current-harness",
      images: "native-cli-file",
      authentication: "opencode-cli",
      modelMetadata: "unavailable-in-current-harness",
    },
  },
} as const satisfies Readonly<Record<Exclude<ProviderId, "gemini" | "kimi">, AgentHarnessCapabilities>>;

const HARNESS_IDS: Readonly<Record<Exclude<ProviderId, "gemini" | "kimi">, AgentHarnessId>> = {
  codex: "codex-cli",
  claude: "claude-cli",
  cursor: "cursor-cli",
  opencode: "opencode-cli",
};

export interface LegacyCliAgentHarnessForTestsOptions {
  supports?: (input: AgentHarnessStartOptions["input"]) => boolean;
  /** Arguments inserted before the provider CLI arguments (for native test launchers). */
  prefixArgs?: readonly string[];
  /** Test seam for the owned CLI process-tree lifecycle. */
  terminateProcessTree?: ProcessTreeTerminator;
}

/**
 * Sunset compatibility fixture for lifecycle tests and benchmarks. Production
 * routes use the native harness registry and must never register this adapter.
 */
export function createLegacyCliAgentHarnessForTests(
  providerId: ProviderId,
  options: LegacyCliAgentHarnessForTestsOptions = {},
): AgentHarness {
  if (providerId === "gemini" || providerId === "kimi") {
    throw new Error(`${providerId === "gemini" ? "Gemini" : "Kimi Code"} is available only through its native ACP harness.`);
  }
  const harnessId = HARNESS_IDS[providerId];
  return {
    id: harnessId,
    providerId,
    capabilities: LEGACY_CLI_AGENT_HARNESS_CAPABILITIES_FOR_TESTS[providerId],
    supports: options.supports ?? ((input) => input.providerId === providerId),
    start: (startOptions) => startCliRun(
      harnessId,
      providerId,
      startOptions,
      options.prefixArgs ?? [],
      options.terminateProcessTree,
    ),
  };
}

function startCliRun(
  harnessId: AgentHarnessId,
  providerId: ProviderId,
  options: AgentHarnessStartOptions,
  prefixArgs: readonly string[],
  terminateProcessTree?: ProcessTreeTerminator,
): AgentHarnessRun {
  const conversationId = options.input.conversationId;
  const emitter = createAgentHarnessEmitter(
    providerId,
    conversationId,
    options.callbacks,
    options.input.runId,
    options.input.turnId,
    options.input.cwd,
  );
  const parserState: ProviderParserState = {
    sessionId: options.input.sessionId,
    sawText: false,
    sawStreamingDelta: false,
    hadErrorEvent: false,
    failureText: undefined,
  };
  const stderr = new CappedProviderBuffer(MAX_STDERR_CHARS);
  const resultText = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  let overflowReported = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  let terminationRequested = false;
  let requestProcessTermination!: (force: boolean) => void;

  const emitText = (text: string): void => {
    resultText.append(text);
    emitter.text(text);
  };
  const decoder = new ProviderNdjsonDecoder(
    MAX_NDJSON_LINE_BYTES,
    (line) => {
      normalizeProviderLine(
        providerId,
        line,
        parserState,
        emitText,
        emitter.activity,
        emitter.session,
      );
      if (parserState.sawTerminalEvent && !terminationRequested) {
        requestProcessTermination(true);
      }
    },
    () => {
      if (overflowReported) return;
      overflowReported = true;
      emitter.activity("system", "info", "Some oversized provider output was skipped");
    },
  );

  let invocation: ProviderInvocation;
  try {
    invocation = buildProviderInvocation(options.input, options.executable);
    invocation.args.unshift(...prefixArgs);
  } catch {
    const message = "The provider could not be started.";
    emitter.status("starting");
    emitter.status("failed", message);
    return settledCliRun(harnessId, providerId, options.input, message);
  }

  emitter.status("starting");
  let child: ChildProcessWithoutNullStreams;
  try {
    const processInvocation = providerProcessInvocation(invocation.command, invocation.args, options.environment);
    const ownedInvocation = runtimeOwnedProcessInvocation(
      processInvocation.command,
      processInvocation.args,
    );
    child = spawnRuntimeOwnedProcess(() => spawn(ownedInvocation.command, ownedInvocation.args, {
      cwd: options.input.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: processInvocation.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
    const message = providerFailureMessage(
      providerId,
      spawnError,
      "",
      "",
      options.input.backendProfile,
    );
    emitter.status("failed", message);
    return settledCliRun(harnessId, providerId, options.input, message);
  }

  let cancelRequested = false;
  let settled = false;
  let finalizing = false;
  let resolveResult!: (result: ProviderRunResult) => void;
  const result = new Promise<ProviderRunResult>((resolve) => {
    resolveResult = resolve;
  });
  const providerLabel = `${providerId.slice(0, 1).toUpperCase()}${providerId.slice(1)}`;
  const terminateOwnedProcessTree = createOwnedProcessTreeTermination(
    child,
    `${providerLabel} CLI process tree`,
    terminateProcessTree,
  );

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled || finalizing) return;
    finalizing = true;
    void (async () => {
      if (terminationRequested) {
        try {
          await terminateOwnedProcessTree(false);
        } catch {
          const message =
            `${providerLabel} CLI process tree could not be confirmed stopped.`;
          settled = true;
          emitter.status("failed", message);
          resolveResult({
            ...providerRunTerminal(options.input, "failed"),
            sessionId: parserState.sessionId,
            text: resultText.toString(),
            textTruncated: resultText.truncated,
            exitCode: child.exitCode ?? exitCode,
            signal: child.signalCode ?? signal,
            error: message,
            cleanupConfirmed: false,
          });
          return;
        }
      } else {
        const message = providerFailureMessage(
          providerId,
          spawnError,
          stderr.toString(),
          parserState.failureText,
          options.input.backendProfile,
        );
        settled = true;
        emitter.status("failed", message);
        resolveResult({
          ...providerRunTerminal(options.input, "failed"),
          sessionId: parserState.sessionId,
          text: resultText.toString(),
          textTruncated: resultText.truncated,
          exitCode,
          signal,
          error: message,
          cleanupConfirmed: false,
        });
        return;
      }
      settled = true;

      if (cancelRequested) {
        emitter.status("cancelled");
        resolveResult({
          ...providerRunTerminal(options.input, "cancelled"),
          sessionId: parserState.sessionId,
          text: resultText.toString(),
          textTruncated: resultText.truncated,
          exitCode: child.exitCode ?? exitCode,
          signal: child.signalCode ?? signal,
          cleanupConfirmed: true,
        });
        return;
      }

      if (
        spawnError
        || !parserState.sawTerminalEvent
        || parserState.hadErrorEvent
      ) {
        const message = providerFailureMessage(
          providerId,
          spawnError,
          stderr.toString(),
          parserState.failureText,
          options.input.backendProfile,
        );
        emitter.status("failed", message);
        resolveResult({
          ...providerRunTerminal(options.input, "failed"),
          sessionId: parserState.sessionId,
          text: resultText.toString(),
          textTruncated: resultText.truncated,
          exitCode,
          signal,
          error: message,
          cleanupConfirmed: true,
        });
        return;
      }

      emitter.status("completed");
      resolveResult({
        ...providerRunTerminal(options.input, "completed"),
        sessionId: parserState.sessionId,
        text: resultText.toString(),
        textTruncated: resultText.truncated,
        exitCode,
        signal,
        cleanupConfirmed: true,
      });
    })();
  };
  requestProcessTermination = (force: boolean): void => {
    terminationRequested = true;
    void terminateOwnedProcessTree(force).then(
      () => finish(child.exitCode, child.signalCode),
      () => finish(child.exitCode, child.signalCode),
    );
  };

  child.once("spawn", () => emitter.status("running"));
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  child.stdout.once("end", () => decoder.end());
  child.stdout.on("error", (error: NodeJS.ErrnoException) => {
    spawnError ??= error;
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
  child.stderr.on("error", () => {
    // Stderr is diagnostic-only and is never exposed directly.
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (invocation.stdin !== undefined) spawnError ??= error;
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    spawnError = error;
    requestProcessTermination(true);
    finish(null, null);
  });
  // Arm cleanup while the process identity is still owned. A spontaneous CLI
  // exit may leave descendants in its detached process group; waiting until
  // `close` would lose the safe opportunity to terminate that tree.
  child.once("exit", () => requestProcessTermination(true));
  child.once("close", finish);

  try {
    child.stdin.end(invocation.stdin);
  } catch (error) {
    spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
    requestProcessTermination(true);
  }

  const cancel = (force: boolean): void => {
    if (settled) return;
    if (!cancelRequested) {
      cancelRequested = true;
      emitter.status("cancelling");
    }
    requestProcessTermination(force);
  };

  return {
    harnessId,
    providerId,
    result,
    cancel,
    extension: { kind: "cli", providerId },
  };
}

function settledCliRun(
  harnessId: AgentHarnessId,
  providerId: ProviderId,
  input: ProviderRunInput,
  error: string,
): AgentHarnessRun {
  return {
    harnessId,
    providerId,
    result: Promise.resolve({
      ...providerRunTerminal(input, "failed"),
      sessionId: input.sessionId,
      text: "",
      textTruncated: false,
      exitCode: null,
      signal: null,
      error,
      cleanupConfirmed: true,
    }),
    cancel: () => undefined,
    extension: { kind: "cli", providerId },
  };
}
