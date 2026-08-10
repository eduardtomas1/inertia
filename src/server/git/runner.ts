import { spawn } from "node:child_process";

import {
  DEFAULT_OUTPUT_BYTES,
  LOCAL_TIMEOUT_MS,
  STDERR_BYTES,
} from "./constants";
import {
  requireProcessTreeTermination,
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { gitProcessEnvironment } from "./environment";
import { GitError } from "./types";

const TRUNCATED_OUTPUT_DRAIN_MS = 250;

export interface GitProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
}

export interface RunGitOptions {
  timeoutMs?: number;
  deadlineAt?: number;
  maxOutputBytes?: number;
  truncateOutput?: boolean;
  input?: Buffer;
  environment?: NodeJS.ProcessEnv;
  failureMessage: string;
}

export type RunGitInspectionOptions = Omit<RunGitOptions, "input">;

export interface GitRunnerDependencies {
  terminateProcessTree?: ProcessTreeTerminator;
}

export interface PreparedGitRefUpdateContext {
  readonly signal: AbortSignal;
  assertActive(): void;
  /**
   * Runs the only mutation permitted from a prepared-ref callback. The
   * operation must be synchronous: once the context is revoked, a delayed
   * read-only callback can no longer enqueue filesystem work.
   */
  mutate(operation: () => undefined): void;
}

function inspectionArguments(args: readonly string[]): string[] {
  const [command, ...rest] = args;
  if (!command || command.startsWith("-")) {
    throw new GitError(
      "invalid-input",
      "The Git inspection command is invalid.",
    );
  }
  const commandArguments = command === "diff"
    ? [
        command,
        ...(!rest.includes("--no-ext-diff") ? ["--no-ext-diff"] : []),
        ...(!rest.includes("--no-textconv") ? ["--no-textconv"] : []),
        ...rest,
      ]
    : [command, ...rest];
  return [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    ...commandArguments,
  ];
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitError("invalid-input", "The requested limit is invalid.");
  }
  return Math.min(value, maximum);
}

export function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function classifyFailure(stderr: string, fallback: string): GitError {
  const detail = stderr.toLowerCase();
  if (
    detail.includes("not a git repository")
    || detail.includes("not a git directory")
  ) {
    return new GitError(
      "not-repository",
      "The selected folder is not a Git repository.",
    );
  }
  if (
    detail.includes("nothing to commit")
    || detail.includes("no changes added to commit")
  ) {
    return new GitError(
      "nothing-to-commit",
      "There are no changes to commit.",
    );
  }
  if (
    detail.includes("authentication failed")
    || detail.includes("could not read username")
    || detail.includes("permission denied (publickey)")
  ) {
    return new GitError(
      "authentication",
      "Git authentication failed. Check the repository credentials and try again.",
    );
  }
  if (
    detail.includes("would be overwritten")
    || detail.includes("merge conflict")
    || detail.includes("resolve your current index first")
    || detail.includes("not possible to fast-forward")
  ) {
    return new GitError(
      "conflict",
      "Git could not complete the operation because the repository has conflicting changes.",
    );
  }
  return new GitError("operation-failed", fallback);
}

export function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions,
  dependencies: GitRunnerDependencies = {},
): Promise<GitProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const configuredTimeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS;
  const deadlineTimeoutMs = options.deadlineAt === undefined
    ? configuredTimeoutMs
    : Math.floor(options.deadlineAt - Date.now());
  if (deadlineTimeoutMs <= 0) {
    return Promise.reject(new GitError(
      "timeout",
      "Git took too long to complete the operation.",
    ));
  }
  const timeoutMs = Math.min(configuredTimeoutMs, deadlineTimeoutMs);
  const terminateProcessTree = dependencies.terminateProcessTree
    ?? terminateProcessTreeAndWait;

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      env: gitProcessEnvironment(process.env, options.environment),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    let truncatedOutputDrainTimer: NodeJS.Timeout | undefined;

    const finish = (
      error?: GitError,
      result?: GitProcessResult,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncatedOutputDrainTimer) {
        clearTimeout(truncatedOutputDrainTimer);
      }
      if (error) rejectProcess(error);
      else if (result) resolveProcess(result);
    };

    const bufferedResult = (): GitProcessResult => ({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      truncated,
    });

    const terminateAndFinish = (error?: GitError): void => {
      if (settled || termination) return;
      termination = requireProcessTreeTermination(
        terminateProcessTree,
        child,
        true,
        "Git process tree",
      );
      void termination.then(
        () => {
          if (error) finish(error);
          else finish(undefined, bufferedResult());
        },
        () => {
          finish(new GitError(
            "operation-failed",
            "Git stopped responding, and its process tree could not be confirmed stopped.",
          ));
        },
      );
    };

    const timer = setTimeout(() => {
      terminateAndFinish(new GitError(
        "timeout",
        "Git took too long to complete the operation.",
      ));
    }, timeoutMs);
    timer.unref();
    if (options.input && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
      if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
      stdoutBytes = maxOutputBytes;
      truncated = true;
      if (options.truncateOutput) {
        // A real Git process commonly exits immediately after crossing a
        // bounded diff limit. Give that already-finishing child one short
        // window to close normally before process-tree termination. This
        // avoids racing Windows taskkill after the root PID has disappeared,
        // while still bounding a producer that continues or stalls.
        truncatedOutputDrainTimer = setTimeout(
          () => terminateAndFinish(),
          TRUNCATED_OUTPUT_DRAIN_MS,
        );
        truncatedOutputDrainTimer.unref();
        return;
      }
      terminateAndFinish(new GitError(
        "output-limit",
        "Git returned more data than this application can safely process.",
      ));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_BYTES) return;
      const part = chunk.subarray(0, STDERR_BYTES - stderrBytes);
      stderr.push(part);
      stderrBytes += part.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (termination) return;
      if (error.code === "ENOENT") {
        finish(
          new GitError(
            "git-unavailable",
            "Git is not installed or could not be started.",
          ),
        );
      } else {
        finish(new GitError("operation-failed", options.failureMessage));
      }
    });
    child.on("close", (code) => {
      if (termination) return;
      const result = bufferedResult();
      if (truncated && !options.truncateOutput) {
        finish(
          new GitError(
            "output-limit",
            "Git returned more data than this application can safely process.",
          ),
        );
      } else if (code === 0 || (truncated && options.truncateOutput)) {
        finish(undefined, result);
      } else {
        finish(
          classifyFailure(
            result.stderr.toString("utf8"),
            options.failureMessage,
          ),
        );
      }
    });
  });
}

/**
 * Runs a read-only Git inspection without honoring repository-configured
 * filesystem monitors or diff executables. Mutating and authenticated
 * workflows deliberately continue to use runGit so their intended hooks and
 * credential helpers are not changed by this boundary.
 */
export function runGitInspection(
  cwd: string,
  args: readonly string[],
  options: RunGitInspectionOptions,
): Promise<GitProcessResult> {
  return runGit(cwd, inspectionArguments(args), options);
}

/**
 * Uses Git's own reference transaction so the target branch remains locked
 * while a caller prepares related filesystem state. Callers must verify the
 * symbolic HEAD separately because Git does not lock it with the branch ref.
 */
export function withPreparedGitRefUpdate(
  cwd: string,
  ref: string,
  newOid: string,
  expectedOid: string,
  options: Pick<RunGitOptions, "deadlineAt" | "failureMessage"> & {
    testHooks?: { afterCommitAcknowledged?: () => void | Promise<void> };
  },
  onPrepared: (context: PreparedGitRefUpdateContext) => void | Promise<void>,
): Promise<void> {
  const deadlineTimeoutMs = options.deadlineAt === undefined
    ? LOCAL_TIMEOUT_MS
    : Math.floor(options.deadlineAt - Date.now());
  if (deadlineTimeoutMs <= 0) {
    return Promise.reject(new GitError(
      "timeout",
      "Git took too long to complete the operation.",
    ));
  }
  const timeoutMs = Math.min(LOCAL_TIMEOUT_MS, deadlineTimeoutMs);
  const expiresAt = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["update-ref", "--stdin"], {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: gitProcessEnvironment(process.env),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let prepared = false;
    let committed = false;
    let callbackError: unknown;
    let termination: Promise<void> | null = null;
    let finishing = false;
    const callbackAbort = new AbortController();
    const preparedContext: PreparedGitRefUpdateContext = {
      signal: callbackAbort.signal,
      assertActive: () => {
        if (callbackAbort.signal.aborted || Date.now() >= expiresAt) {
          throw new GitError(
            "timeout",
            "Git took too long to complete the operation.",
          );
        }
      },
      mutate: (operation) => {
        preparedContext.assertActive();
        const result = operation();
        if (result !== undefined) {
          throw new GitError(
            "operation-failed",
            "The prepared Git mutation must complete synchronously.",
          );
        }
        preparedContext.assertActive();
      },
    };

    const finish = (error?: unknown): void => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      callbackAbort.abort();
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: GitError): void => {
      if (settled || finishing || termination) return;
      callbackAbort.abort();
      termination = requireProcessTreeTermination(
        terminateProcessTreeAndWait,
        child,
        true,
        "Git reference transaction",
      );
      void termination.then(
        () => finish(error),
        () => finish(new GitError(
          "operation-failed",
          "Git stopped responding, and its process tree could not be confirmed stopped.",
        )),
      );
    };
    const timer = setTimeout(() => terminate(new GitError(
      "timeout",
      "Git took too long to complete the operation.",
    )), timeoutMs);
    timer.unref();
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputBytes + chunk.length > 4_096) {
        terminate(new GitError(
          "output-limit",
          "Git returned more data than this application can safely process.",
        ));
        return;
      }
      outputBytes += chunk.length;
      stdout.push(chunk);
      const text = Buffer.concat(stdout).toString("utf8");
      if (!prepared && /(?:^|\r?\n)prepare: ok\r?\n/u.test(text)) {
        prepared = true;
        void Promise.resolve()
          .then(() => onPrepared(preparedContext))
          .then(
            () => {
              child.stdin.end("commit\n");
            },
            (error: unknown) => {
              callbackError = error;
              child.stdin.end("abort\n");
            },
          );
      }
      if (/(?:^|\r?\n)commit: ok\r?\n/u.test(text)) committed = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = STDERR_BYTES - Buffer.concat(stderr).length;
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (termination) return;
      finish(error.code === "ENOENT"
        ? new GitError(
            "git-unavailable",
            "Git is not installed or could not be started.",
          )
        : new GitError("operation-failed", options.failureMessage));
    });
    child.on("close", (code) => {
      if (termination) return;
      if (callbackError) {
        finish(callbackError);
      } else if (code === 0 && committed) {
        void Promise.resolve()
          .then(options.testHooks?.afterCommitAcknowledged)
          .then(() => finish(), (error: unknown) => finish(error));
      } else {
        finish(classifyFailure(
          Buffer.concat(stderr).toString("utf8"),
          options.failureMessage,
        ));
      }
    });
    child.stdin.write([
      "start",
      `update ${ref} ${newOid} ${expectedOid}`,
      "prepare",
      "",
    ].join("\n"));
  });
}
