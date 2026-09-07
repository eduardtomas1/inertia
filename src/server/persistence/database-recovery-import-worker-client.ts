import { Worker } from "node:worker_threads";

import type { DatabaseRecoveryImportResult } from "./database-export";
import {
  parseRecoveryImportWorkerEvent,
  parseRecoveryImportWorkerRequest,
  type RecoveryImportWorkerEvent,
  type RecoveryImportWorkerFault,
} from "./database-recovery-import-worker-protocol";

export type { RecoveryImportWorkerFault } from "./database-recovery-import-worker-protocol";

export interface RunRecoveryImportWorkerOptions {
  databasePath: string;
  defaultWorkspacePath: string;
  recoveryPath: string;
  targetDirectory: string;
  operationId: string;
  signal?: AbortSignal;
  fault?: RecoveryImportWorkerFault;
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The database recovery import was cancelled.");
}

export function runRecoveryImportWorker(
  options: RunRecoveryImportWorkerOptions,
): Promise<DatabaseRecoveryImportResult> {
  if (options.signal?.aborted) {
    return Promise.reject(cancellationError(options.signal));
  }
  const request = parseRecoveryImportWorkerRequest({
    type: "recovery-import.start",
    version: 1,
    databasePath: options.databasePath,
    defaultWorkspacePath: options.defaultWorkspacePath,
    recoveryPath: options.recoveryPath,
    targetDirectory: options.targetDirectory,
    operationId: options.operationId,
    fault: options.fault,
  });
  if (!request) return Promise.reject(new Error("The recovery import worker request is invalid."));
  const worker = new Worker(
    new URL("./database-recovery-import-worker.js", import.meta.url),
    { workerData: request },
  );

  return new Promise<DatabaseRecoveryImportResult>((resolve, reject) => {
    let result: RecoveryImportWorkerEvent | null = null;
    let workerError: Error | null = null;
    let stopping = false;

    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const stop = (error: Error, cancellation: boolean): void => {
      if (stopping) return;
      stopping = true;
      // Rejection authorizes journal reconciliation in the caller, so it must
      // never precede termination of the worker's independent SQLite writer.
      const confirmedExit = (): void => {
        cleanup();
        if (cancellation && options.fault?.phase === "after-staging-publish") {
          setTimeout(() => reject(error), options.fault.stallMs);
        } else {
          reject(error);
        }
      };
      void worker.terminate().then(
        confirmedExit,
        () => {
          // A failed termination request is not proof that SQLite stopped.
          // Keep reconciliation fenced until this exact worker exits. The
          // supervisor owns the outer deadline if it never does.
          if (worker.threadId === -1) confirmedExit();
          else worker.once("exit", confirmedExit);
        },
      );
    };
    const onAbort = (): void => {
      if (stopping) return;
      // The worker closes its SQLite connection before publishing success.
      // Once that validated receipt is visible, the transaction is already
      // authoritative; let the exit event settle it instead of reporting a
      // cancellation that could not roll the import back.
      if (result?.ok) return;
      const error = options.signal
        ? cancellationError(options.signal)
        : new Error("The database recovery import was cancelled.");
      // Resolve cancellation only after the owned SQLite connection has
      // exited, so rollback and native-handle release are authoritative.
      stop(error, true);
    };

    worker.on("message", (value: unknown) => {
      if (stopping) return;
      const event = parseRecoveryImportWorkerEvent(value);
      if (!event || event.operationId !== request.operationId || result) {
        stop(new Error("The recovery import worker returned an invalid receipt."), false);
        return;
      }
      result = event;
    });
    worker.once("error", () => {
      workerError = new Error("The recovery import worker failed.");
    });
    worker.once("exit", (code) => {
      if (stopping) return;
      cleanup();
      if (workerError) {
        reject(workerError);
      } else if (!result) {
        reject(new Error(
          `The database recovery import worker exited before receipt (${code}).`,
        ));
      } else if (result.ok) {
        resolve(result.result);
      } else {
        reject(new Error("The database recovery import failed."));
      }
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
