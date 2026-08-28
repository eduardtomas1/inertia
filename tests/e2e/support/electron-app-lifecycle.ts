import type { ElectronApplication, Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";

const FIXTURE_SERVER_TEARDOWN_TIMEOUT_MS = 2_000;

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

export async function closeElectronAppBounded(
  current: ElectronApplication,
  options: {
    readonly gracefulTimeoutMs?: number;
    readonly forcedExitTimeoutMs?: number;
    readonly protocolSettleTimeoutMs?: number;
  } = {},
): Promise<void> {
  const child = current.process();
  const closeResult = current.close();
  const graceful = await settleOperationBounded(
    closeResult,
    options.gracefulTimeoutMs ?? 5_000,
  );
  if (graceful.status === "fulfilled") return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  const exited = child.exitCode !== null || child.signalCode !== null
    ? true
    : await new Promise<boolean>((resolve) => {
        const onExit = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.off("exit", onExit);
          resolve(false);
        }, options.forcedExitTimeoutMs ?? 5_000);
        timer.unref();
        child.once("exit", onExit);
        if (child.exitCode !== null || child.signalCode !== null) {
          child.off("exit", onExit);
          clearTimeout(timer);
          resolve(true);
        }
      });
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
}

export async function closeElectronFixtureBounded(options: {
  readonly current: ElectronApplication | null;
  readonly requestRuntimeQuit: () => Promise<number | null>;
  readonly waitForRuntimeExit: (pid: number) => Promise<void>;
  readonly closeServer: () => Promise<void>;
  readonly removeDirectory: () => Promise<void>;
  readonly rpcTimeoutMs?: number;
  readonly serverTimeoutMs?: number;
  readonly removeTimeoutMs?: number;
}): Promise<void> {
  const cleanupErrors: unknown[] = [];
  let runtimePid: number | null = null;
  try {
    if (options.current) {
      const quitResult = await settleOperationBounded(
        Promise.resolve().then(options.requestRuntimeQuit),
        options.rpcTimeoutMs ?? 1_000,
      );
      if (quitResult.status === "fulfilled") {
        runtimePid = quitResult.value;
      } else if (quitResult.status === "rejected") {
        cleanupErrors.push(quitResult.reason);
      } else {
        cleanupErrors.push(new Error(
          "The Electron fixture runtime quit request did not settle in time.",
        ));
      }
      try {
        await closeElectronAppBounded(options.current);
      } catch (error) {
        cleanupErrors.push(error);
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
