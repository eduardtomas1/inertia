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
import {
  awaitRuntimeOwnedProcessStopped,
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";
import { BoundedClaudeTransport, type ClaudeTransportLimits } from "./claude-transport";

export interface ClaudeOwnedQueryDependencies {
  /** Test seam for the SDK-owned child process creation. */
  spawnProcess?: typeof spawn;
  /** Test seam for the owned Claude process-tree lifecycle. */
  terminateProcessTree?: ProcessTreeTerminator;
  /** Small deterministic wire budgets for synthetic transport tests. */
  transportLimits?: ClaudeTransportLimits;
}

export interface ClaudeOwnedQueryProcess {
  readonly spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  readonly child: () => ChildProcessWithoutNullStreams | undefined;
  readonly transportError: () => Error | undefined;
  readonly waitForNaturalClose: (waitMs: number, signal?: AbortSignal) => Promise<boolean>;
  readonly requestTermination: (force: boolean) => void;
  readonly terminate: (force: boolean) => Promise<void>;
}

/**
 * Owns the one Claude Code process an SDK Query may spawn.
 *
 * The SDK receives its final command, arguments, cwd, environment, and abort
 * signal unchanged. Inertia supplies only the shell-free detached-process
 * policy and one memoized whole-tree shutdown barrier shared by SDK close,
 * cancellation, and the public operation result. Raw stdout passes through
 * a bounded streaming boundary before the SDK can assemble complete lines.
 */
export function createClaudeOwnedQueryProcess(
  subject: string,
  dependencies: ClaudeOwnedQueryDependencies = {},
): ClaudeOwnedQueryProcess {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  let child: ChildProcessWithoutNullStreams | undefined;
  let shutdownRequested = false;
  let transportError: Error | undefined;
  let childClosed: Promise<void> | undefined;
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
    const invocation = runtimeOwnedProcessInvocation(
      spawnOptions.command,
      spawnOptions.args,
    );
    const ownedChild = spawnRuntimeOwnedProcess(() => spawnProcess(invocation.command, invocation.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    child = ownedChild;
    childClosed = new Promise<void>((resolve) => { ownedChild.once("close", resolve); });
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
    const stdout = new BoundedClaudeTransport(dependencies.transportLimits);
    stdout.on("error", (error) => {
      transportError ??= error;
      ownedChild.stdout.unpipe(stdout);
      // Retain no further output while the same owned shutdown barrier settles.
      ownedChild.stdout.resume();
      requestTermination(true);
    });
    ownedChild.stdout.on("error", (error) => stdout.destroy(error));
    ownedChild.stdout.pipe(stdout);

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
      stdout,
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
    transportError: () => transportError,
    waitForNaturalClose: async (waitMs, signal) => {
      const ownedChild = child;
      if (!ownedChild) return true;
      if (shutdownRequested || signal?.aborted || !childClosed) return false;
      let timer: NodeJS.Timeout | undefined;
      let cancel!: () => void;
      const interrupted = new Promise<boolean>((resolve) => {
        cancel = () => resolve(false);
        timer = setTimeout(cancel, waitMs);
        timer.unref();
        signal?.addEventListener("abort", cancel, { once: true });
      });
      try {
        // EOF is not a cleanup receipt. Join the exact guardian's ordinary
        // close and durable retirement before permitting successful teardown.
        return await Promise.race([
          childClosed.then(() => awaitRuntimeOwnedProcessStopped(ownedChild)),
          interrupted,
        ]);
      } catch { return false; }
      finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },
    requestTermination,
    terminate: async (force) => {
      shutdownRequested = true;
      await terminateOwnedProcessTree?.(force);
    },
  };
}
