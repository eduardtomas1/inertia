import { spawn } from "node:child_process";

import {
  DEFAULT_OUTPUT_BYTES,
  LOCAL_TIMEOUT_MS,
  STDERR_BYTES,
} from "./constants";
import { gitProcessEnvironment } from "./environment";
import { GitError } from "./types";

export interface GitProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
}

export interface RunGitOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  truncateOutput?: boolean;
  input?: Buffer;
  failureMessage: string;
}

export type RunGitInspectionOptions = Omit<RunGitOptions, "input">;

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
): Promise<GitProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS;

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      env: gitProcessEnvironment(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (
      error?: GitError,
      result?: GitProcessResult,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectProcess(error);
      else if (result) resolveProcess(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new GitError("timeout", "Git took too long to complete the operation."));
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
      child.kill("SIGKILL");
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_BYTES) return;
      const part = chunk.subarray(0, STDERR_BYTES - stderrBytes);
      stderr.push(part);
      stderrBytes += part.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
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
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        truncated,
      };
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
