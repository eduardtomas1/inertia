import { writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { RuntimeStore } from "../database";
import { readDatabaseRecoveryExportFile } from "./database-export-file";
import {
  parseRecoveryImportWorkerRequest,
  type RecoveryImportWorkerEvent,
  type RecoveryImportWorkerFault,
} from "./database-recovery-import-worker-protocol";

const parsedInput = parseRecoveryImportWorkerRequest(workerData);
if (!parsedInput) throw new Error("The recovery import worker request is invalid.");
const input = parsedInput;

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
    parentPort.postMessage({
      type: "recovery-import.result", version: 1, operationId: input.operationId, ok: true, result,
    } satisfies RecoveryImportWorkerEvent);
  } catch {
    store?.close();
    parentPort.postMessage({
      type: "recovery-import.result",
      version: 1,
      operationId: input.operationId,
      ok: false,
      code: "import-failed",
    } satisfies RecoveryImportWorkerEvent);
  }
}

void run();
