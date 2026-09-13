import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";
import {
  createOwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type AntigravityCliHarnessCapabilities,
  type ProviderInteractiveRunExtension,
} from "./agent-harness";
import {
  antigravityArguments,
  antigravityAuthRequired,
  antigravityDeclinedNotice,
  antigravityFailure,
  antigravityResultFailure,
  antigravitySessionId,
  antigravityUserLine,
  parseAntigravityLine,
  type AntigravityResult,
  type AntigravityStreamEvent,
} from "./antigravity-stream";
import {
  providerRunTerminal,
  type ProviderRunFailure,
  type ProviderRunInput,
  type ProviderRunResult,
} from "./contracts";
import { CappedProviderBuffer, ProviderNdjsonDecoder } from "./io";
import { providerProcessInvocation } from "./process";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_STDERR_TAIL_CHARS = 4 * 1024;
const MAX_STDERR_DETAIL_LINES = 20;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_TRACKED_TOOLS = 1_024;
const MAX_DECLINED_NOTICES = 32;
const RESULT_EXIT_GRACE_MS = 2_000;
const OUTPUT_DRAIN_GRACE_MS = 1_000;
const TERMINATION_CONFIRM_MS = 10_000;

export const ANTIGRAVITY_CLI_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "conversation" },
  cancellation: { graceful: "process-tree-signal", forceFallback: "process-tree-kill" },
  extension: {
    kind: "antigravity-cli",
    protocol: "headless-stream-json",
    approvals: "provider-policy",
    questions: "unavailable-in-headless",
    plans: "native-mode",
    reasoning: "unavailable-in-headless",
    usage: "result-usage",
    images: "unavailable-in-current-harness",
    authentication: "antigravity-cli",
    modelMetadata: "unavailable-in-current-harness",
  },
} as const satisfies AntigravityCliHarnessCapabilities;

export interface AntigravityCliHarnessOptions {
  terminateProcessTree?: ProcessTreeTerminator;
  resultExitGraceMs?: number;
  outputDrainGraceMs?: number;
  terminationConfirmMs?: number;
}

const RUN_EXTENSION: ProviderInteractiveRunExtension = {
  kind: "antigravity-cli",
  respondToApproval: () => false,
  respondToInput: () => false,
};

export function createAntigravityCliHarness(
  options: AntigravityCliHarnessOptions = {},
): AgentHarness {
  return {
    id: "antigravity-cli",
    providerId: "antigravity",
    capabilities: ANTIGRAVITY_CLI_CAPABILITIES,
    supports: (input) => input.providerId === "antigravity",
    start: (startOptions) => startAntigravityRun(startOptions, options),
  };
}

function settledRun(
  input: ProviderRunInput,
  failure: ProviderRunFailure,
): AgentHarnessRun {
  return {
    harnessId: "antigravity-cli",
    providerId: "antigravity",
    result: Promise.resolve({
      ...providerRunTerminal(input, "failed", failure),
      sessionId: input.sessionId,
      text: "",
      textTruncated: false,
      exitCode: null,
      signal: null,
      error: failure.message,
      failure,
      cleanupConfirmed: true,
    }),
    cancel: () => undefined,
    extension: RUN_EXTENSION,
  };
}

function boundedWait(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Process tree termination was not confirmed in time.")),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Process tree termination failed."));
      },
    );
  });
}

function startAntigravityRun(
  options: AgentHarnessStartOptions,
  harnessOptions: AntigravityCliHarnessOptions,
): AgentHarnessRun {
  const { input } = options;
  const emitter = createAgentHarnessEmitter(
    "antigravity",
    input.conversationId,
    options.callbacks,
    input.runId,
    input.turnId,
    input.cwd,
  );
  emitter.status("starting");
  const unsupported = input.operation
    ? "Antigravity does not expose explicit context compaction."
    : (input.imagePaths?.length ?? 0) > 0
      ? "Image input is unavailable for Antigravity in Inertia."
      : null;
  if (unsupported) {
    const failure = antigravityFailure("unsupported", "", input.cwd, unsupported);
    emitter.status("failed", failure.message);
    return settledRun(input, failure);
  }

  const stderr = new CappedProviderBuffer(MAX_STDERR_CHARS);
  const resultText = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const tools = new Set<string>();
  let sessionId = antigravitySessionId(input.sessionId);
  let result: AntigravityResult | undefined;
  let failure: ProviderRunFailure | undefined;
  let spawnError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let outputClosed = false;
  let sawText = false;
  let stderrTail = "";
  let declinedNotices = 0;
  let cancelRequested = false;
  let settled = false;
  let finalizing = false;
  let resultTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let closedOutputTimer: NodeJS.Timeout | undefined;
  let requestProcessTermination = (_force: boolean): void => {};
  let finish = (): void => {};

  const stderrDetail = (): string => stderr.toString()
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .slice(-MAX_STDERR_DETAIL_LINES)
    .join("\n");
  const fail = (next: ProviderRunFailure): void => {
    failure ??= next;
    requestProcessTermination(true);
  };
  const adoptSession = (conversationId: string | null): void => {
    if (!conversationId || conversationId === sessionId) return;
    sessionId = conversationId;
    emitter.session(conversationId);
  };
  const handle = (event: AntigravityStreamEvent): void => {
    if (event.kind === "session") {
      adoptSession(event.conversationId);
    } else if (event.kind === "text") {
      sawText = true;
      resultText.append(event.text);
      emitter.text(event.text);
    } else if (event.kind === "tool") {
      if (!tools.has(event.id) && tools.size >= MAX_TRACKED_TOOLS) return;
      tools.add(event.id);
      emitter.activity("tool", event.phase, event.label, {
        activityId: `antigravity:${input.runId}:${event.id}`,
      });
    } else {
      result = event.result;
      adoptSession(event.result.conversationId);
      if (event.result.status === "SUCCESS" && !sawText && event.result.response) {
        resultText.append(event.result.response);
        emitter.text(event.result.response);
      }
      if (event.result.usage) emitter.rich({ type: "usage", usage: event.result.usage });
      resultTimer = setTimeout(
        () => requestProcessTermination(true),
        harnessOptions.resultExitGraceMs ?? RESULT_EXIT_GRACE_MS,
      );
      resultTimer.unref?.();
    }
  };
  const decoder = new ProviderNdjsonDecoder(
    MAX_LINE_BYTES,
    (line) => {
      if (settled || finalizing || failure || result) return;
      const events = parseAntigravityLine(line);
      if (!events) {
        fail(antigravityFailure("malformed", line.slice(0, 2_000), input.cwd));
        return;
      }
      for (const event of events) {
        handle(event);
        if (result) return;
      }
    },
    () => emitter.activity("system", "info", "Antigravity sent an oversized line that Inertia skipped"),
  );
  const onStderr = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    stderr.append(text);
    const lines = `${stderrTail}${text}`.split(/\r?\n/u);
    stderrTail = (lines.pop() ?? "").slice(-MAX_STDERR_TAIL_CHARS);
    for (const line of [...lines, stderrTail]) {
      if (antigravityAuthRequired(line)) {
        fail(antigravityFailure("auth", line, input.cwd));
        return;
      }
    }
    for (const line of lines) {
      if (declinedNotices >= MAX_DECLINED_NOTICES || !antigravityDeclinedNotice(line)) continue;
      declinedNotices += 1;
      emitter.activity("system", "info", "Antigravity declined an action that needs approval");
    }
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    const invocation = providerProcessInvocation(
      options.executable,
      antigravityArguments(input),
      options.environment,
    );
    const owned = runtimeOwnedProcessInvocation(invocation.command, invocation.args);
    child = spawnRuntimeOwnedProcess(() => spawn(owned.command, owned.args, {
      cwd: input.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    const startFailure = antigravityFailure(
      "exit",
      error instanceof Error ? error.message : "",
      input.cwd,
      "Antigravity could not be started.",
    );
    emitter.status("failed", startFailure.message);
    return settledRun(input, startFailure);
  }

  let resolveResult!: (value: ProviderRunResult) => void;
  const runResult = new Promise<ProviderRunResult>((resolve) => {
    resolveResult = resolve;
  });
  const terminate = createOwnedProcessTreeTermination(
    child,
    "Antigravity CLI process tree",
    harnessOptions.terminateProcessTree,
  );
  const settle = (
    status: ProviderRunResult["status"],
    cleanupConfirmed: boolean,
    runFailure?: ProviderRunFailure,
  ): void => {
    if (settled) return;
    settled = true;
    if (resultTimer) clearTimeout(resultTimer);
    if (drainTimer) clearTimeout(drainTimer);
    if (closedOutputTimer) clearTimeout(closedOutputTimer);
    emitter.status(status, runFailure?.message);
    resolveResult({
      ...providerRunTerminal(input, status, runFailure),
      sessionId,
      text: resultText.toString(),
      textTruncated: resultText.truncated,
      exitCode: exit?.code ?? child.exitCode,
      signal: exit?.signal ?? child.signalCode,
      ...(runFailure ? { error: runFailure.message, failure: runFailure } : {}),
      cleanupConfirmed,
    });
  };
  const exitedWithoutResult = (): ProviderRunFailure => {
    const signal = exit?.signal ?? child.signalCode;
    const code = exit?.code ?? child.exitCode;
    return antigravityFailure(
      signal ? "signal" : "exit",
      stderrDetail(),
      input.cwd,
      `Antigravity exited without a result (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}).`,
    );
  };
  finish = (): void => {
    if (settled || finalizing) return;
    finalizing = true;
    if (drainTimer) clearTimeout(drainTimer);
    void (async () => {
      try {
        await boundedWait(
          terminate(false),
          harnessOptions.terminationConfirmMs ?? TERMINATION_CONFIRM_MS,
        );
      } catch {
        settle("failed", false, antigravityFailure(
          "exit",
          stderrDetail(),
          input.cwd,
          "Antigravity's process tree could not be confirmed stopped.",
        ));
        return;
      }
      if (cancelRequested) {
        settle("cancelled", true);
      } else if (failure) {
        settle("failed", true, failure);
      } else if (result) {
        const resultFailure = antigravityResultFailure(result, input.cwd);
        if (resultFailure) settle("failed", true, resultFailure);
        else settle("completed", true);
      } else if (spawnError && child.pid === undefined) {
        settle("failed", true, antigravityFailure(
          "exit",
          spawnError.message,
          input.cwd,
          "Antigravity could not be started.",
        ));
      } else {
        settle("failed", true, exitedWithoutResult());
      }
    })();
  };
  const finishWhenDrained = (): void => {
    if (exit && outputClosed) finish();
  };
  const onOutputClosed = (): void => {
    if (outputClosed) return;
    outputClosed = true;
    decoder.end();
    if (!result && !exit && !cancelRequested) {
      closedOutputTimer = setTimeout(() => {
        if (result || exit || cancelRequested) return;
        fail(antigravityFailure(
          "exit",
          stderrDetail(),
          input.cwd,
          "Antigravity closed its output without a result.",
        ));
      }, harnessOptions.outputDrainGraceMs ?? OUTPUT_DRAIN_GRACE_MS);
      closedOutputTimer.unref?.();
    }
    finishWhenDrained();
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exit ??= { code, signal };
    if (closedOutputTimer) clearTimeout(closedOutputTimer);
    requestProcessTermination(true);
    if (!outputClosed && !drainTimer) {
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        onOutputClosed();
      }, harnessOptions.outputDrainGraceMs ?? OUTPUT_DRAIN_GRACE_MS);
      drainTimer.unref?.();
    }
    finishWhenDrained();
  };
  requestProcessTermination = (force: boolean): void => {
    terminate(force).catch(() => {
      exit ??= { code: child.exitCode, signal: child.signalCode };
      outputClosed = true;
      finish();
    });
  };

  child.once("spawn", () => emitter.status("running"));
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  child.stdout.once("end", onOutputClosed);
  child.stdout.once("close", onOutputClosed);
  child.stdout.on("error", (error: Error) => {
    spawnError ??= error;
  });
  child.stderr.on("data", onStderr);
  child.stderr.on("error", () => undefined);
  child.stdin.on("error", (error: Error) => {
    if (!result) spawnError ??= error;
  });
  child.once("error", (error: Error) => {
    spawnError ??= error;
    if (child.pid === undefined) {
      exit ??= { code: null, signal: null };
      outputClosed = true;
      finish();
      return;
    }
    requestProcessTermination(true);
  });
  child.once("exit", onExit);
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    exit ??= { code, signal };
    onOutputClosed();
    finishWhenDrained();
  });

  try {
    child.stdin.end(antigravityUserLine(input.prompt));
  } catch (error) {
    spawnError ??= error instanceof Error ? error : new Error("Antigravity input failed.");
    requestProcessTermination(true);
  }

  return {
    harnessId: "antigravity-cli",
    providerId: "antigravity",
    result: runResult,
    cancel: (force) => {
      if (settled) return;
      if (!cancelRequested) {
        cancelRequested = true;
        emitter.status("cancelling");
      }
      requestProcessTermination(force || process.platform === "win32");
    },
    extension: RUN_EXTENSION,
  };
}
