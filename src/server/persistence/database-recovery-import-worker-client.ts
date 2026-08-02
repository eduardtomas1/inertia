import { Worker } from "node:worker_threads";

import type { DatabaseRecoveryImportResult } from "./database-export";
import {
  DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS,
  DATABASE_RECOVERY_EXPORT_MAX_MESSAGES,
  DATABASE_RECOVERY_EXPORT_MAX_PROJECTS,
} from "./database-export";

export interface RecoveryImportWorkerFault {
  phase: "during-message-import";
  markerPath: string;
  stallMs: number;
}

export interface RunRecoveryImportWorkerOptions {
  databasePath: string;
  defaultWorkspacePath: string;
  recoveryPath: string;
  targetDirectory: string;
  operationId: string;
  signal?: AbortSignal;
  afterStagingPublish?: () => void;
  fault?: RecoveryImportWorkerFault;
}

type RecoveryImportWorkerEvent =
  | { type: "staging-published" }
  | { type: "result"; ok: true; result: DatabaseRecoveryImportResult }
  | { type: "result"; ok: false; message: string };

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The database recovery import was cancelled.");
}

function validReceipt(value: unknown): value is DatabaseRecoveryImportResult {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 4
    && Number.isSafeInteger(receipt.projects)
    && Number(receipt.projects) >= 0
    && Number(receipt.projects) <= DATABASE_RECOVERY_EXPORT_MAX_PROJECTS
    && Number.isSafeInteger(receipt.conversations)
    && Number(receipt.conversations) >= 0
    && Number(receipt.conversations) <= DATABASE_RECOVERY_EXPORT_MAX_CONVERSATIONS
    && Number.isSafeInteger(receipt.messages)
    && Number(receipt.messages) >= 0
    && Number(receipt.messages) <= DATABASE_RECOVERY_EXPORT_MAX_MESSAGES
    && typeof receipt.alreadyImported === "boolean";
}

export function runRecoveryImportWorker(
  options: RunRecoveryImportWorkerOptions,
): Promise<DatabaseRecoveryImportResult> {
  if (options.signal?.aborted) {
    return Promise.reject(cancellationError(options.signal));
  }
  const stagingBarrier = options.afterStagingPublish
    ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    : undefined;
  const worker = new Worker(
    new URL("./database-recovery-import-worker.js", import.meta.url),
    {
      workerData: {
        databasePath: options.databasePath,
        defaultWorkspacePath: options.defaultWorkspacePath,
        recoveryPath: options.recoveryPath,
        targetDirectory: options.targetDirectory,
        operationId: options.operationId,
        stagingBarrier,
        fault: options.fault,
      },
    },
  );

  return new Promise<DatabaseRecoveryImportResult>((resolve, reject) => {
    let result: Extract<RecoveryImportWorkerEvent, { type: "result" }> | null = null;
    let workerError: Error | null = null;
    let stopping = false;

    const releaseStagingBarrier = (state: 1 | 2): void => {
      if (!stagingBarrier) return;
      const barrier = new Int32Array(stagingBarrier);
      Atomics.store(barrier, 0, state);
      Atomics.notify(barrier, 0);
    };
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const onAbort = (): void => {
      if (stopping) return;
      stopping = true;
      releaseStagingBarrier(2);
      const error = options.signal
        ? cancellationError(options.signal)
        : new Error("The database recovery import was cancelled.");
      // Resolve cancellation only after the owned SQLite connection has
      // exited, so rollback and native-handle release are authoritative.
      void worker.terminate().then(
        () => {
          cleanup();
          reject(error);
        },
        (terminationError: unknown) => {
          cleanup();
          reject(terminationError);
        },
      );
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    worker.on("message", (event: RecoveryImportWorkerEvent) => {
      if (stopping) return;
      if (event.type === "staging-published") {
        try {
          options.afterStagingPublish?.();
          releaseStagingBarrier(1);
        } catch (error) {
          workerError = error instanceof Error ? error : new Error(String(error));
          releaseStagingBarrier(2);
        }
        return;
      }
      result = event.ok && !validReceipt(event.result)
        ? { type: "result", ok: false, message: "The recovery import worker returned an invalid receipt." }
        : event;
    });
    worker.once("error", (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
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
        reject(new Error(result.message));
      }
    });
  });
}
