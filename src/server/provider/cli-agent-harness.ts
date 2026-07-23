import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { terminateProcessTree } from "../process-lifecycle";
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
import type { ProviderId, ProviderRunResult } from "./contracts";
import { CappedProviderBuffer, ProviderNdjsonDecoder } from "./io";
import { providerProcessInvocation } from "./process";

const MAX_NDJSON_LINE_CHARS = 1024 * 1024;
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

export const CLI_AGENT_HARNESS_CAPABILITIES = {
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
} as const satisfies Readonly<Record<ProviderId, AgentHarnessCapabilities>>;

const HARNESS_IDS: Readonly<Record<ProviderId, AgentHarnessId>> = {
  codex: "codex-cli",
  claude: "claude-cli",
  cursor: "cursor-cli",
  opencode: "opencode-cli",
};

export interface CliAgentHarnessOptions {
  supports?: (input: AgentHarnessStartOptions["input"]) => boolean;
  /** Arguments inserted before the provider CLI arguments (for native test launchers). */
  prefixArgs?: readonly string[];
}

export function createCliAgentHarness(
  providerId: ProviderId,
  options: CliAgentHarnessOptions = {},
): AgentHarness {
  const harnessId = HARNESS_IDS[providerId];
  return {
    id: harnessId,
    providerId,
    capabilities: CLI_AGENT_HARNESS_CAPABILITIES[providerId],
    supports: options.supports ?? ((input) => input.providerId === providerId),
    start: (startOptions) => startCliRun(harnessId, providerId, startOptions, options.prefixArgs ?? []),
  };
}

function startCliRun(
  harnessId: AgentHarnessId,
  providerId: ProviderId,
  options: AgentHarnessStartOptions,
  prefixArgs: readonly string[],
): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter(providerId, conversationId, options.callbacks);
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

  const emitText = (text: string): void => {
    resultText.append(text);
    emitter.text(text);
  };
  const decoder = new ProviderNdjsonDecoder(
    MAX_NDJSON_LINE_CHARS,
    (line) => normalizeProviderLine(providerId, line, parserState, emitText, emitter.activity, emitter.session),
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
    return settledCliRun(harnessId, providerId, conversationId, parserState.sessionId, message);
  }

  emitter.status("starting");
  let child: ChildProcessWithoutNullStreams;
  try {
    const processInvocation = providerProcessInvocation(invocation.command, invocation.args, options.environment);
    child = spawn(processInvocation.command, processInvocation.args, {
      cwd: options.input.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: processInvocation.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
    const message = providerFailureMessage(providerId, spawnError, "");
    emitter.status("failed", message);
    return settledCliRun(harnessId, providerId, conversationId, parserState.sessionId, message);
  }

  let cancelRequested = false;
  let settled = false;
  let resolveResult!: (result: ProviderRunResult) => void;
  const result = new Promise<ProviderRunResult>((resolve) => {
    resolveResult = resolve;
  });

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;

    if (cancelRequested) {
      emitter.status("cancelled");
      resolveResult({
        providerId,
        conversationId,
        status: "cancelled",
        sessionId: parserState.sessionId,
        text: resultText.toString(),
        textTruncated: resultText.truncated,
        exitCode,
        signal,
      });
      return;
    }

    if (spawnError || exitCode !== 0 || parserState.hadErrorEvent) {
      const message = providerFailureMessage(providerId, spawnError, stderr.toString(), parserState.failureText);
      emitter.status("failed", message);
      resolveResult({
        providerId,
        conversationId,
        status: "failed",
        sessionId: parserState.sessionId,
        text: resultText.toString(),
        textTruncated: resultText.truncated,
        exitCode,
        signal,
        error: message,
      });
      return;
    }

    emitter.status("completed");
    resolveResult({
      providerId,
      conversationId,
      status: "completed",
      sessionId: parserState.sessionId,
      text: resultText.toString(),
      textTruncated: resultText.truncated,
      exitCode,
      signal,
    });
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
    finish(null, null);
  });
  child.once("close", finish);

  try {
    child.stdin.end(invocation.stdin);
  } catch (error) {
    spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
    try {
      child.kill();
    } catch {
      // The close/error event will settle the public result.
    }
  }

  const cancel = (force: boolean): void => {
    if (settled) return;
    if (!cancelRequested) {
      cancelRequested = true;
      emitter.status("cancelling");
    }
    terminateProcessTree(child, force);
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
  conversationId: string,
  sessionId: string | undefined,
  error: string,
): AgentHarnessRun {
  return {
    harnessId,
    providerId,
    result: Promise.resolve({
      providerId,
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
    extension: { kind: "cli", providerId },
  };
}
