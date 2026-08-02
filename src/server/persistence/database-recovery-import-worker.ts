import { writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { RuntimeStore } from "../database";
import { readDatabaseRecoveryExportFile } from "./database-export-file";
import type { RecoveryImportWorkerFault } from "./database-recovery-import-worker-client";

interface RecoveryImportWorkerData {
  databasePath: string;
  defaultWorkspacePath: string;
  recoveryPath: string;
  targetDirectory: string;
  operationId: string;
  fault?: RecoveryImportWorkerFault;
}

const input = workerData as RecoveryImportWorkerData;

let faultStarted = false;
function applyFault(phase: RecoveryImportWorkerFault["phase"]): void {
  if (faultStarted || input.fault?.phase !== phase) return;
  faultStarted = true;
  try {
    writeFileSync(
      input.fault.markerPath,
      phase === "after-staging-publish"
        ? "staging-published\n"
        : "message-import-started\n",
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EEXIST"
    ) return;
    throw error;
  }
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    input.fault.stallMs,
  );
}

async function run(): Promise<void> {
  if (!parentPort) throw new Error("The recovery import worker has no owner.");
  let store: RuntimeStore | null = null;
  try {
    store = new RuntimeStore(
      input.databasePath,
      input.defaultWorkspacePath,
      { recoverInterruptedRuns: false },
    );
    const result = await store.importRecoveryData(
      await readDatabaseRecoveryExportFile(input.recoveryPath),
      input.targetDirectory,
      {
        operationId: input.operationId,
        operations: {
          ...(input.fault?.phase === "after-staging-publish"
            ? { afterStagingPublish: () => applyFault("after-staging-publish") }
            : {}),
          ...(input.fault?.phase === "during-message-import"
            ? { afterMessageCreate: () => applyFault("during-message-import") }
            : {}),
        },
      },
    );
    store.close();
    store = null;
    parentPort.postMessage({ type: "result", ok: true, result });
  } catch (error) {
    store?.close();
    parentPort.postMessage({
      type: "result",
      ok: false,
      message: error instanceof Error ? error.message : "Recovery import failed.",
    });
  }
}

void run();
