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
  stagingBarrier?: SharedArrayBuffer;
  fault?: RecoveryImportWorkerFault;
}

const input = workerData as RecoveryImportWorkerData;

function waitForParentAfterStagingPublish(): void {
  if (!input.stagingBarrier) return;
  parentPort?.postMessage({ type: "staging-published" });
  const barrier = new Int32Array(input.stagingBarrier);
  Atomics.wait(barrier, 0, 0);
  if (Atomics.load(barrier, 0) !== 1) {
    throw new Error("The recovery import staging fault was cancelled.");
  }
}

let messageFaultStarted = false;
function applyMessageFault(): void {
  if (messageFaultStarted || input.fault?.phase !== "during-message-import") return;
  messageFaultStarted = true;
  try {
    writeFileSync(input.fault.markerPath, "message-import-started\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
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
          ...(input.stagingBarrier
            ? { afterStagingPublish: waitForParentAfterStagingPublish }
            : {}),
          ...(input.fault?.phase === "during-message-import"
            ? { afterMessageCreate: applyMessageFault }
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
