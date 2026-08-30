import type { ElectronApplication, Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";

import { privilegedShutdownEnvelopeMs } from
  "../../../src/main/privileged-shutdown-deadline";
import { runtimeSupervisorShutdownEnvelopeMs } from "../../../src/node/runtime-shutdown-deadline";

const FIXTURE_SERVER_TEARDOWN_TIMEOUT_MS = 2_000;
export function fixtureElectronGracefulTimeoutMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return privilegedShutdownEnvelopeMs(platform) + 500;
}
export function fixtureRuntimeExitTimeoutMs(
  platform: NodeJS.Platform = process.platform,
): number {
  return runtimeSupervisorShutdownEnvelopeMs(platform) + 500;
}
const FIXTURE_ELECTRON_GRACEFUL_TIMEOUT_MS =
  fixtureElectronGracefulTimeoutMs();
export const FIXTURE_RUNTIME_EXIT_TIMEOUT_MS = fixtureRuntimeExitTimeoutMs();

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForRuntimeProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + FIXTURE_RUNTIME_EXIT_TIMEOUT_MS;
  while (processExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error("The Electron fixture runtime did not exit in time.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export type BoundedOperationResult<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timed-out" };

export async function settleOperationBounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<BoundedOperationResult<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race<BoundedOperationResult<T>>([
    operation.then(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    ),
    new Promise<BoundedOperationResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function closePreviewServerBounded(server: Server): Promise<void> {
  server.closeAllConnections();
  const result = await settleOperationBounded(
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    FIXTURE_SERVER_TEARDOWN_TIMEOUT_MS,
  );
  // A connection accepted immediately before close() took effect must not
  // survive a timed-out test fixture.
  server.closeAllConnections();
  if (result.status === "rejected") throw result.reason;
  if (result.status === "timed-out") {
    throw new Error("The Electron fixture preview server did not close in time.");
  }
}

export async function removeFixtureDirectory(testDirectory: string): Promise<void> {
  // Closed SQLite handles on Windows and recently-settled Git checkpoint
  // writes on macOS can remain visible briefly after process exit.
  await rm(testDirectory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}

export function observeElectronProcess(
  current: ElectronApplication,
  appendDiagnostic: (source: "stdout" | "stderr", chunk: Buffer) => void,
): void {
  current.process().stdout?.on("data", (chunk: Buffer) => {
    appendDiagnostic("stdout", chunk);
  });
  current.process().stderr?.on("data", (chunk: Buffer) => {
    appendDiagnostic("stderr", chunk);
  });
}

export function observeElectronPage(
  currentPage: Page,
  rendererErrors: string[],
): void {
  currentPage.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  currentPage.on("pageerror", (error) => rendererErrors.push(error.message));
}

async function waitForChildExitBounded(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, Math.max(0, Math.trunc(timeoutMs)));
    timer.unref();
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timer);
      resolve(true);
    }
  });
}

interface ElectronAppCloseOptions {
  readonly childProcess?: ChildProcess;
  readonly gracefulTimeoutMs?: number;
  readonly forcedExitTimeoutMs?: number;
  readonly protocolSettleTimeoutMs?: number;
}

export interface ElectronAppQuitOptions extends ElectronAppCloseOptions {
  readonly quitRequestTimeoutMs?: number;
}

export interface ElectronAppQuitResult<T> {
  readonly outcome: "graceful" | "abnormal" | "forced";
  readonly requestResult: BoundedOperationResult<T>;
  readonly transportSettled: boolean;
}

export async function quitElectronAppBounded<T>(
  current: ElectronApplication,
  requestQuit: () => Promise<T>,
  options: ElectronAppQuitOptions = {},
): Promise<ElectronAppQuitResult<T>> {
  const child = options.childProcess ?? current.process();
  const requestResultPromise = settleOperationBounded(
    Promise.resolve().then(requestQuit),
    options.quitRequestTimeoutMs ?? 1_000,
  );
  const exitedNaturally = await waitForChildExitBounded(
    child,
    options.gracefulTimeoutMs ?? FIXTURE_ELECTRON_GRACEFUL_TIMEOUT_MS,
  );
  let outcome: ElectronAppQuitResult<T>["outcome"];
  if (exitedNaturally) {
    outcome = child.exitCode === 0 && child.signalCode === null
      ? "graceful"
      : "abnormal";
  } else {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    const exitedAfterForce = await waitForChildExitBounded(
      child,
      options.forcedExitTimeoutMs ?? 5_000,
    );
    if (!exitedAfterForce) {
      throw new Error(
        "The Electron fixture process did not exit after forced quit.",
      );
    }
    outcome = "forced";
  }

  // app.quit disconnects Playwright as the native process exits. Settle that
  // transport only after OS process authority proves the profile is no longer
  // owned; starting BrowserContext.close earlier races Electron's before-quit
  // cleanup and can leave the next launch contending for the same profile.
  const transportResult = await settleOperationBounded(
    Promise.resolve().then(() => current.close()),
    options.protocolSettleTimeoutMs ?? 1_000,
  );
  return {
    outcome,
    requestResult: await requestResultPromise,
    transportSettled: transportResult.status !== "timed-out",
  };
}

async function closeElectronAppWithOutcome(
  current: ElectronApplication,
  options: ElectronAppCloseOptions = {},
): Promise<"graceful" | "abnormal" | "forced"> {
  const child = options.childProcess ?? current.process();
  const gracefulTimeoutMs = options.gracefulTimeoutMs
    ?? FIXTURE_ELECTRON_GRACEFUL_TIMEOUT_MS;
  const gracefulDeadlineAt = Date.now() + gracefulTimeoutMs;
  const closeResult = Promise.resolve().then(() => current.close());
  const graceful = await settleOperationBounded(
    closeResult,
    gracefulTimeoutMs,
  );
  if (
    (graceful.status === "fulfilled" || graceful.status === "rejected")
    && await waitForChildExitBounded(
      child,
      gracefulDeadlineAt - Date.now(),
    )
  ) {
    return child.exitCode === 0 && child.signalCode === null
      ? "graceful"
      : "abnormal";
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  const exited = await waitForChildExitBounded(
    child,
    options.forcedExitTimeoutMs ?? 5_000,
  );
  if (!exited) {
    throw new Error("The Electron fixture process did not exit after forced close.");
  }
  // Killing Electron settles Playwright's in-flight BrowserContext close and
  // its Node/CDP transports asynchronously. Give that cleanup a short bounded
  // turn so the worker does not inherit an unresolved application close.
  await settleOperationBounded(
    closeResult,
    options.protocolSettleTimeoutMs ?? 1_000,
  );
  return "forced";
}

export async function closeElectronAppBounded(
  current: ElectronApplication,
  options: ElectronAppCloseOptions = {},
): Promise<void> {
  await closeElectronAppWithOutcome(current, options);
}

export async function closeElectronFixtureBounded(options: {
  readonly current: ElectronApplication | null;
  readonly priorRuntimePid?: number | null;
  readonly requestRuntimeQuit: () => Promise<number | null>;
  readonly waitForRuntimeExit: (pid: number) => Promise<void>;
  readonly closeServer: () => Promise<void>;
  readonly removeDirectory: () => Promise<void>;
  readonly rpcTimeoutMs?: number;
  readonly serverTimeoutMs?: number;
  readonly removeTimeoutMs?: number;
}): Promise<void> {
  const cleanupErrors: unknown[] = [];
  let runtimePid: number | null = options.priorRuntimePid ?? null;
  try {
    if (options.current) {
      // The quit RPC can close Playwright's Electron dispatcher before the
      // next JavaScript turn. Retain the OS child authority while connected.
      let childProcess: ChildProcess | null = null;
      try {
        childProcess = options.current.process();
      } catch (error) {
        cleanupErrors.push(error);
      }
      let quitFailure: unknown;
      let quitResult: BoundedOperationResult<number | null>;
      let appCloseConfirmed = false;
      if (childProcess) {
        try {
          const appQuit = await quitElectronAppBounded(
            options.current,
            options.requestRuntimeQuit,
            {
              childProcess,
              quitRequestTimeoutMs: options.rpcTimeoutMs ?? 1_000,
            },
          );
          quitResult = appQuit.requestResult;
          appCloseConfirmed = appQuit.outcome === "graceful";
          if (!appQuit.transportSettled && appCloseConfirmed) {
            cleanupErrors.push(new Error(
              "The Electron fixture transport did not settle after process exit.",
            ));
          }
          if (appQuit.outcome === "abnormal") {
            cleanupErrors.push(new Error(
              `The Electron fixture process exited abnormally during close (exitCode=${String(childProcess.exitCode)}, signal=${String(childProcess.signalCode)}).`,
            ));
          } else if (appQuit.outcome === "forced") {
            cleanupErrors.push(new Error(
              "The Electron fixture process required forced termination during close.",
            ));
          }
        } catch (error) {
          cleanupErrors.push(error);
          quitResult = { status: "fulfilled", value: null };
        }
      } else {
        quitResult = await settleOperationBounded(
          Promise.resolve().then(options.requestRuntimeQuit),
          options.rpcTimeoutMs ?? 1_000,
        );
      }
      if (quitResult.status === "fulfilled") {
        if (quitResult.value !== null) runtimePid = quitResult.value;
      } else if (quitResult.status === "rejected") {
        quitFailure = quitResult.reason;
      } else {
        quitFailure = new Error(
          "The Electron fixture runtime quit request did not settle in time.",
        );
      }
      // app.quit intentionally disconnects Playwright while its evaluate call
      // is returning. A captured Electron child that then completes the
      // privileged before-quit cleanup is the stronger lifecycle authority;
      // only surface the advisory RPC failure when that bounded close proof is
      // unavailable.
      if (quitFailure !== undefined && !appCloseConfirmed) {
        cleanupErrors.push(quitFailure);
      }
      if (runtimePid) {
        try {
          await options.waitForRuntimeExit(runtimePid);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
  } finally {
    const serverResult = await settleOperationBounded(
      Promise.resolve().then(options.closeServer),
      options.serverTimeoutMs ?? 2_000,
    );
    if (serverResult.status === "rejected") {
      cleanupErrors.push(serverResult.reason);
    } else if (serverResult.status === "timed-out") {
      cleanupErrors.push(new Error(
        "The Electron fixture preview server did not close in time.",
      ));
    }
    const removeResult = await settleOperationBounded(
      Promise.resolve().then(options.removeDirectory),
      options.removeTimeoutMs ?? 5_000,
    );
    if (removeResult.status === "rejected") {
      cleanupErrors.push(removeResult.reason);
    } else if (removeResult.status === "timed-out") {
      cleanupErrors.push(new Error(
        "The Electron fixture directory was not removed in time.",
      ));
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "The Electron fixture did not close cleanly.");
  }
}
