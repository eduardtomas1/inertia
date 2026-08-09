import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import { environmentValue } from "./environment";
import {
  createOwnedProcessTreeTermination,
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "./process-lifecycle";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;

const SAFE_ENVIRONMENT_KEYS = [
  "APPDATA", "GH_CONFIG_DIR", "HOME", "LANG", "LOCALAPPDATA", "NO_COLOR", "PATH",
  "PATHEXT", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR",
  "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
] as const;

export class RestrictedCliError extends Error {
  constructor(
    readonly code: "unavailable" | "failed" | "timeout" | "output-limit" | "cleanup",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RestrictedCliError";
  }
}

export interface RestrictedCliResult {
  stdout: string;
  stderr: string;
}

export interface RestrictedCliOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  failureMessage: string;
}

export interface RestrictedCliDependencies {
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  terminateProcessTree?: ProcessTreeTerminator;
}

/** OS/config paths only. Provider, GitHub, cloud, and agent tokens are excluded. */
export function restrictedCliEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environmentValue(source, key, platform);
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key.toUpperCase().startsWith("LC_")) {
      environment[key] = value;
    }
  }
  return environment;
}

export async function runRestrictedCli(
  executable: string,
  args: readonly string[],
  options: RestrictedCliOptions,
  dependencies: RestrictedCliDependencies = {},
): Promise<RestrictedCliResult> {
  const platform = dependencies.platform ?? process.platform;
  const timeoutMs = Math.max(
    1_000,
    Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10 * 60_000),
  );
  const maxOutputBytes = Math.max(
    1_024,
    Math.min(options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, 1024 * 1024),
  );
  const spawnProcess = dependencies.spawn ?? (
    (command, commandArgs, spawnOptions) => spawn(
      command,
      [...commandArgs],
      { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] },
    )
  );

  return await new Promise<RestrictedCliResult>((resolveRun, rejectRun) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(executable, args, {
        cwd: options.cwd,
        env: restrictedCliEnvironment(
          options.environment ?? process.env,
          platform,
        ),
        shell: false,
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      rejectRun(new RestrictedCliError(
        "unavailable",
        `${executable} is not installed or could not be started.`,
        { cause: error },
      ));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let termination: Promise<void> | null = null;
    const terminateOwnedTree = createOwnedProcessTreeTermination(
      child,
      `${executable} process tree`,
      dependencies.terminateProcessTree ?? terminateProcessTreeAndWait,
    );
    let timer: NodeJS.Timeout;
    const finish = (
      error?: RestrictedCliError,
      result?: RestrictedCliResult,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error);
      else if (result) resolveRun(result);
    };
    const terminateAndReject = async (
      error: RestrictedCliError,
    ): Promise<void> => {
      if (settled || termination) return;
      termination = terminateOwnedTree(true);
      try {
        await termination;
        finish(error);
      } catch (cause) {
        finish(new RestrictedCliError(
          "cleanup",
          `${executable} stopped responding and its process tree could not be confirmed stopped.`,
          { cause },
        ));
      }
    };
    const append = (target: Buffer[], chunk: Buffer): void => {
      if (settled || termination) return;
      const remaining = maxOutputBytes - outputBytes;
      if (chunk.length <= remaining) {
        target.push(chunk);
        outputBytes += chunk.length;
        return;
      }
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes = maxOutputBytes;
      void terminateAndReject(new RestrictedCliError(
        "output-limit",
        `${executable} returned more output than Inertia can safely process.`,
      ));
    };

    timer = setTimeout(() => {
      void terminateAndReject(new RestrictedCliError(
        "timeout",
        `${executable} took too long to complete.`,
      ));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (termination) return;
      finish(new RestrictedCliError(
        error.code === "ENOENT" ? "unavailable" : "failed",
        error.code === "ENOENT"
          ? `${executable} is not installed or could not be started.`
          : options.failureMessage,
        { cause: error },
      ));
    });
    child.once("close", (code) => {
      if (termination || settled) return;
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) finish(undefined, result);
      else finish(new RestrictedCliError("failed", options.failureMessage));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
