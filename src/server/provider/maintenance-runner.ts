import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { homedir } from "node:os";

import { environmentValue } from "../environment";
import {
  terminateProcessTree,
  type ProcessLifecycleDependencies,
} from "../process-lifecycle";
import { sanitizeProviderActivityDetail } from "./activity-detail";
import { providerProcessInvocation } from "./process";
import type { ProviderMaintenanceUpdateAction } from "./maintenance-capabilities";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_RAW_OUTPUT_BYTES = 64 * 1024;
const MAX_PUBLIC_OUTPUT_CHARS = 16 * 1024;

export interface ProviderMaintenanceRunProgress {
  output: string | null;
  outputTruncated: boolean;
}

export interface ProviderMaintenanceRunResult
  extends ProviderMaintenanceRunProgress {
  status: "succeeded" | "failed" | "cancelled" | "timed-out";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  message: string;
}

export interface ProviderMaintenanceRunnerOptions {
  cwd?: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  processLifecycle?: Partial<ProcessLifecycleDependencies>;
  onProgress?: (progress: ProviderMaintenanceRunProgress) => void;
}

const PASSTHROUGH_ENVIRONMENT_KEYS = [
  "APPDATA",
  "ComSpec",
  "HOME",
  "HOMEBREW_CACHE",
  "HOMEBREW_PREFIX",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

/**
 * Updaters need package-manager paths and ordinary OS directories, not agent
 * credentials. Explicit allowlisting prevents provider/API secrets inherited by
 * the runtime from reaching a maintenance child.
 */
export function providerMaintenanceEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    NO_COLOR: "1",
  };
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = environmentValue(source, key, platform);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function publicOutput(raw: string): string | null {
  return sanitizeProviderActivityDetail(raw, {
    maxChars: MAX_PUBLIC_OUTPUT_CHARS,
  });
}

function appendOutput(
  current: string,
  chunk: Buffer | string,
): { output: string; truncated: boolean } {
  if (Buffer.byteLength(current, "utf8") >= MAX_RAW_OUTPUT_BYTES) {
    return { output: current, truncated: true };
  }
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_RAW_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
  return {
    output: current + incoming.subarray(0, remaining).toString("utf8"),
    truncated: incoming.length > remaining,
  };
}

export async function runProviderMaintenanceAction(
  action: ProviderMaintenanceUpdateAction,
  options: ProviderMaintenanceRunnerOptions,
): Promise<ProviderMaintenanceRunResult> {
  const platform = options.platform ?? process.platform;
  const environment = providerMaintenanceEnvironment(
    options.environment,
    platform,
  );
  const invocation = providerProcessInvocation(
    action.executable,
    action.args,
    environment,
    platform,
  );
  const spawnProcess = options.spawn ?? (
    (command, args, spawnOptions) => spawn(
      command,
      [...args],
      {
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
  );
  const timeoutMs = Math.max(
    1_000,
    Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15 * 60_000),
  );
  const killGraceMs = Math.max(
    100,
    Math.min(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 30_000),
  );
  const processLifecycle = {
    windowsSystemRoot: environmentValue(
      environment,
      "SystemRoot",
      platform,
    ) ?? null,
    ...options.processLifecycle,
  };

  return await new Promise<ProviderMaintenanceRunResult>((resolveRun) => {
    let child: ChildProcessWithoutNullStreams;
    let output = "";
    let outputTruncated = false;
    let settled = false;
    let cancelled = options.signal.aborted;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;

    const progress = (): void => {
      options.onProgress?.({
        output: publicOutput(output),
        outputTruncated,
      });
    };
    const finish = (
      status: ProviderMaintenanceRunResult["status"],
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      message: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      options.signal.removeEventListener("abort", cancel);
      resolveRun({
        status,
        exitCode,
        signal,
        message,
        output: publicOutput(output),
        outputTruncated,
      });
    };
    const terminate = (): void => {
      if (!child || child.killed) return;
      try {
        terminateProcessTree(child, false, processLifecycle);
      } catch {
        // The process may already have exited between the state check and kill.
      }
      hardKill = setTimeout(() => {
        try {
          terminateProcessTree(child, true, processLifecycle);
        } catch {
          // The process may already have exited.
        }
        finish(
          cancelled ? "cancelled" : timedOut ? "timed-out" : "failed",
          null,
          "SIGKILL",
          cancelled
            ? "Provider update cancelled."
            : timedOut
              ? "Provider update timed out."
              : "Provider update process did not stop cleanly.",
        );
      }, killGraceMs);
      hardKill.unref();
    };
    const cancel = (): void => {
      cancelled = true;
      terminate();
    };

    try {
      child = spawnProcess(invocation.command, invocation.args, {
        cwd: options.cwd ?? homedir(),
        env: environment,
        shell: false,
        detached: platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch {
      finish(
        cancelled ? "cancelled" : "failed",
        null,
        null,
        cancelled
          ? "Provider update cancelled."
          : "The provider update command could not be started.",
      );
      return;
    }

    const append = (chunk: Buffer): void => {
      const next = appendOutput(output, chunk);
      output = next.output;
      outputTruncated ||= next.truncated;
      progress();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => {
      finish(
        cancelled ? "cancelled" : "failed",
        null,
        null,
        cancelled
          ? "Provider update cancelled."
          : "The provider update command failed to run.",
      );
    });
    child.once("close", (exitCode, signal) => {
      if (cancelled) {
        finish("cancelled", exitCode, signal, "Provider update cancelled.");
        return;
      }
      if (timedOut) {
        finish("timed-out", exitCode, signal, "Provider update timed out.");
        return;
      }
      finish(
        exitCode === 0 ? "succeeded" : "failed",
        exitCode,
        signal,
        exitCode === 0
          ? "Provider update command completed."
          : `Provider update command exited with code ${exitCode ?? "unknown"}.`,
      );
    });
    child.stdin.end();
    options.signal.addEventListener("abort", cancel, { once: true });
    if (cancelled) terminate();

    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
  });
}
