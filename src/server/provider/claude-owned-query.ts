import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import {
  createOwnedProcessTreeTermination,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";

export interface ClaudeOwnedQueryDependencies {
  /** Test seam for the SDK-owned child process creation. */
  spawnProcess?: typeof spawn;
  /** Test seam for the owned Claude process-tree lifecycle. */
  terminateProcessTree?: ProcessTreeTerminator;
}

export interface ClaudeOwnedQueryProcess {
  readonly spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  readonly child: () => ChildProcessWithoutNullStreams | undefined;
  readonly requestTermination: (force: boolean) => void;
  readonly terminate: (force: boolean) => Promise<void>;
}

/**
 * Owns the one Claude Code process an SDK Query may spawn.
 *
 * The SDK receives its final command, arguments, cwd, environment, and abort
 * signal unchanged. Inertia supplies only the shell-free detached-process
 * policy and one memoized whole-tree shutdown barrier shared by SDK close,
 * cancellation, and the public operation result.
 */
export function createClaudeOwnedQueryProcess(
  subject: string,
  dependencies: ClaudeOwnedQueryDependencies = {},
): ClaudeOwnedQueryProcess {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  let child: ChildProcessWithoutNullStreams | undefined;
  let shutdownRequested = false;
  let terminateOwnedProcessTree: ReturnType<
    typeof createOwnedProcessTreeTermination
  > | undefined;

  const requestTermination = (force: boolean): void => {
    shutdownRequested = true;
    void terminateOwnedProcessTree?.(force).catch(() => undefined);
  };

  const spawnClaudeCodeProcess = (
    spawnOptions: SpawnOptions,
  ): SpawnedProcess => {
    if (shutdownRequested) {
      throw new Error(
        "Claude Agent SDK attempted to spawn after query shutdown.",
      );
    }
    if (child) {
      throw new Error(
        "Claude Agent SDK attempted to spawn more than one process for a single query.",
      );
    }
    const ownedChild = spawnRuntimeOwnedProcess(() => spawnProcess(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    child = ownedChild;
    // A custom SDK spawner owns stderr consumption. Drain it so an untrusted
    // provider cannot block shutdown by filling an unread pipe.
    ownedChild.stderr.on("error", () => {
      // Provider exit is reported by the SDK through the process events.
    });
    ownedChild.stderr.resume();
    terminateOwnedProcessTree = createOwnedProcessTreeTermination(
      ownedChild,
      subject,
      dependencies.terminateProcessTree,
    );

    const forwardedAbort = (): void => requestTermination(true);
    const removeForwardedAbort = (): void => {
      spawnOptions.signal.removeEventListener("abort", forwardedAbort);
    };
    if (spawnOptions.signal.aborted) forwardedAbort();
    else {
      spawnOptions.signal.addEventListener("abort", forwardedAbort, {
        once: true,
      });
      ownedChild.once("exit", removeForwardedAbort);
      ownedChild.once("error", removeForwardedAbort);
    }

    return {
      stdin: ownedChild.stdin,
      stdout: ownedChild.stdout,
      get killed() { return ownedChild.killed; },
      get exitCode() { return ownedChild.exitCode; },
      get signalCode() { return ownedChild.signalCode; },
      kill(signal) {
        const running = ownedChild.exitCode === null
          && ownedChild.signalCode === null;
        requestTermination(signal === "SIGKILL");
        return running;
      },
      on(event, listener) { ownedChild.on(event, listener); },
      once(event, listener) { ownedChild.once(event, listener); },
      off(event, listener) { ownedChild.off(event, listener); },
    };
  };

  return {
    spawnClaudeCodeProcess,
    child: () => child,
    requestTermination,
    terminate: async (force) => {
      shutdownRequested = true;
      await terminateOwnedProcessTree?.(force);
    },
  };
}
