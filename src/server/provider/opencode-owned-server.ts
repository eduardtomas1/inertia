import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  createOwnedProcessTreeTermination,
  type OwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { CappedProviderBuffer } from "./io";
import { providerProcessInvocation } from "./process";

const START_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 1024 * 1024;

export class OpenCodeServerCleanupUnconfirmedError extends Error {
  readonly code = "process-tree-termination-unconfirmed";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "OpenCodeServerCleanupUnconfirmedError";
  }
}

export function openCodeServerProcessInvocation(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  return providerProcessInvocation(
    executable,
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    environment,
    platform,
  );
}

export async function startOwnedOpenCodeServer(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  output: CappedProviderBuffer,
  terminateOwnedProcessTree: ProcessTreeTerminator,
  terminationSubject: string,
  signal?: AbortSignal,
): Promise<{
  child: ChildProcessWithoutNullStreams;
  terminate: OwnedProcessTreeTermination;
  url: string;
}> {
  const invocation = openCodeServerProcessInvocation(executable, environment);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: environment,
    detached: process.platform !== "win32",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const terminate = createOwnedProcessTreeTermination(
    child,
    terminationSubject,
    terminateOwnedProcessTree,
  );
  // Arm ownership while Node still has a live process/stdio capability. A
  // later close-only cleanup must not signal a recycled POSIX PID or PGID.
  child.once("exit", () => {
    void terminate(true).catch(() => undefined);
  });
  child.stdin.end();
  let startupOutput = "";
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  let startupSettled = false;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const settleStartup = (action: () => void): void => {
    if (startupSettled) return;
    startupSettled = true;
    action();
  };
  const cancelStartup = (): void => {
    settleStartup(() => rejectReady(new Error("OpenCode startup was cancelled.")));
  };
  if (signal?.aborted) cancelStartup();
  else signal?.addEventListener("abort", cancelStartup, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    const value = chunk.toString("utf8");
    output.append(value);
    startupOutput = `${startupOutput}${value}`.slice(-4_096);
    const match =
      /opencode server listening on http:\/\/127\.0\.0\.1:(\d{1,5})/u.exec(startupOutput);
    const port = Number(match?.[1]);
    if (match && Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      settleStartup(() => resolveReady(`http://127.0.0.1:${port}`));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
  let startupTimer: NodeJS.Timeout | undefined;
  try {
    startupTimer = setTimeout(() => {
      settleStartup(() => rejectReady(
        new Error("Timed out waiting for the OpenCode server to start."),
      ));
    }, START_TIMEOUT_MS);
    startupTimer.unref();
    child.once("error", (error) => {
      settleStartup(() => rejectReady(error));
    });
    child.once("close", () => {
      settleStartup(() => rejectReady(
        new Error("OpenCode server exited during startup."),
      ));
    });
    const url = await ready;
    clearTimeout(startupTimer);
    signal?.removeEventListener("abort", cancelStartup);
    return { child, terminate, url };
  } catch (error) {
    if (startupTimer) clearTimeout(startupTimer);
    signal?.removeEventListener("abort", cancelStartup);
    try {
      await terminate(true);
    } catch (cleanupError) {
      throw new OpenCodeServerCleanupUnconfirmedError(
        `${safeError(error, "OpenCode server failed during startup.")} ${safeError(
          cleanupError,
          `${terminationSubject} could not be confirmed stopped.`,
        )}`,
        cleanupError,
      );
    }
    throw error;
  }
}

export async function waitForOpenCodeHealth(
  client: OpencodeClient,
  child: ChildProcessWithoutNullStreams,
  timeoutMs = START_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): Promise<void> {
  await withOpenCodeRequestDeadline(
    timeoutMs,
    "Timed out waiting for the OpenCode server health check.",
    async (signal) => {
      let lastError: unknown;
      while (!signal.aborted) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("OpenCode server exited during startup.");
        }
        try {
          await client.global.health({ signal, throwOnError: true });
          return;
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      throw new Error(safeError(
        lastError,
        "Timed out waiting for the OpenCode server health check.",
      ));
    },
    parentSignal,
  );
}

export async function withOpenCodeRequestDeadline<T>(
  timeoutMs: number,
  timeoutMessage: string,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let rejectCancelled!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const cancel = (): void => {
    controller.abort();
    rejectCancelled(new Error("OpenCode request was cancelled."));
  };
  if (parentSignal?.aborted) cancel();
  else parentSignal?.addEventListener("abort", cancel, { once: true });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      operation(controller.signal),
      deadline,
      cancelled,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
  }
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, MAX_ERROR_CHARS)
    : fallback;
}
