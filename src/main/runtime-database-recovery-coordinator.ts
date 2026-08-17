import { randomUUID } from "node:crypto";

import type {
  RuntimeDatabaseRecoveryOperation,
  RuntimeDatabaseRecoverySummary,
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import type {
  PendingDatabaseRecoveryRequest,
  RuntimeProcessRecord,
  RuntimeSupervisorTimer,
} from "./runtime-supervisor-types.js";

type RecoveryResultEvent = Extract<RuntimeWorkerEvent, {
  type: "runtime.database-recovery-result";
}>;

interface RuntimeDatabaseRecoveryCoordinatorOptions {
  requestTimeoutMs: number;
  cancelTimeoutMs: number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
  cancellationUnconfirmed: (record: RuntimeProcessRecord) => void;
}

export class RuntimeDatabaseRecoveryCoordinator {
  private readonly pending = new Map<string, PendingDatabaseRecoveryRequest>();

  constructor(
    private readonly options: RuntimeDatabaseRecoveryCoordinatorOptions,
  ) {}

  request(
    record: RuntimeProcessRecord,
    operation: RuntimeDatabaseRecoveryOperation,
    path: string,
    targetDirectory?: string,
  ): Promise<RuntimeDatabaseRecoverySummary | null> {
    if (operation === "import" && !targetDirectory) {
      return Promise.reject(new Error(
        "The recovery import needs an explicitly authorized destination folder.",
      ));
    }
    if (this.pending.size > 0) {
      return Promise.reject(new Error(
        "A database recovery operation is already in progress.",
      ));
    }
    const operationId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending: PendingDatabaseRecoveryRequest = {
        record,
        operation,
        timer: undefined as unknown as RuntimeSupervisorTimer,
        timedOut: false,
        resolve,
        reject,
      };
      pending.timer = this.options.setTimer(() => {
        if (this.pending.get(operationId) !== pending) return;
        pending.timedOut = true;
        this.options.post(record, {
          type: "runtime.database-recovery-cancel",
          operationId,
          generation: record.generation,
          operation,
        });
        pending.timer = this.options.setTimer(() => {
          if (this.pending.get(operationId) !== pending) return;
          this.options.cancellationUnconfirmed(record);
        }, this.options.cancelTimeoutMs);
      }, this.options.requestTimeoutMs);
      this.pending.set(operationId, pending);
      this.options.post(record, {
        type: "runtime.database-recovery",
        operationId,
        generation: record.generation,
        operation,
        path,
        ...(operation === "import" && targetDirectory
          ? { targetDirectory }
          : {}),
      });
    });
  }

  handle(record: RuntimeProcessRecord, event: RecoveryResultEvent): void {
    const pending = this.pending.get(event.operationId);
    if (
      !pending
      || pending.record !== record
      || event.generation !== record.generation
      || pending.operation !== event.operation
    ) return;
    this.pending.delete(event.operationId);
    this.options.clearTimer(pending.timer);
    if (event.ok) pending.resolve(event.summary);
    else if (pending.timedOut && event.cancelled) {
      pending.reject(new Error(
        "The database recovery request timed out and was cancelled.",
      ));
    } else pending.reject(new Error(event.message));
  }

  reject(record: RuntimeProcessRecord | null, message: string): void {
    if (!record) return;
    for (const [requestId, pending] of this.pending) {
      if (pending.record !== record) continue;
      this.pending.delete(requestId);
      this.options.clearTimer(pending.timer);
      pending.reject(new Error(
        pending.timedOut
          ? "The database recovery request timed out and the runtime stopped before cancellation was confirmed."
          : message,
      ));
    }
  }
}
