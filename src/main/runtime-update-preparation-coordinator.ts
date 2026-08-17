import { randomUUID } from "node:crypto";

import type {
  RuntimeUpdatePreparationResult,
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import type {
  RuntimeProcessRecord,
  RuntimeSupervisorTimer,
} from "./runtime-supervisor-types.js";

type UpdatePreparationEvent = Extract<RuntimeWorkerEvent, {
  type: "runtime.prepare-update-result" | "runtime.release-update-preparation-result";
}>;

interface PendingPreparation {
  record: RuntimeProcessRecord;
  operationId: string;
  timer: RuntimeSupervisorTimer;
  promise: Promise<RuntimeUpdatePreparationResult>;
  resolve: (result: RuntimeUpdatePreparationResult) => void;
  reject: (error: Error) => void;
}

interface PendingRelease {
  record: RuntimeProcessRecord;
  operationId: string;
  timer: RuntimeSupervisorTimer;
  promise: Promise<boolean>;
  resolve: (released: boolean) => void;
  reject: (error: Error) => void;
}

interface RuntimeUpdatePreparationCoordinatorOptions {
  timeoutMs: number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  current: () => RuntimeProcessRecord | null;
  post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
  forceTerminate: (record: RuntimeProcessRecord) => void;
}

export class RuntimeUpdatePreparationCoordinator {
  private pendingPreparation: PendingPreparation | null = null;
  private pendingRelease: PendingRelease | null = null;
  private prepared: { record: RuntimeProcessRecord; operationId: string } | null = null;

  constructor(
    private readonly options: RuntimeUpdatePreparationCoordinatorOptions,
  ) {}

  prepare(record: RuntimeProcessRecord): Promise<RuntimeUpdatePreparationResult> {
    if (this.prepared?.record === record) return Promise.resolve({ ready: true });
    if (this.pendingPreparation?.record === record) {
      return this.pendingPreparation.promise;
    }
    if (this.pendingRelease) {
      return Promise.reject(new Error(
        "The local service is reopening after update preparation.",
      ));
    }
    const operationId = randomUUID();
    let resolveRequest!: (result: RuntimeUpdatePreparationResult) => void;
    let rejectRequest!: (error: Error) => void;
    const promise = new Promise<RuntimeUpdatePreparationResult>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const pending: PendingPreparation = {
      record,
      operationId,
      timer: undefined as unknown as RuntimeSupervisorTimer,
      promise,
      resolve: resolveRequest,
      reject: rejectRequest,
    };
    pending.timer = this.options.setTimer(() => {
      if (this.pendingPreparation !== pending) return;
      this.pendingPreparation = null;
      pending.reject(new Error(
        "The local service did not finish update preparation in time.",
      ));
      void this.releaseIdentity(record, operationId).catch(() => {
        this.options.forceTerminate(record);
      });
    }, this.options.timeoutMs);
    this.pendingPreparation = pending;
    if (!this.options.post(record, {
      type: "runtime.prepare-update",
      operationId,
      generation: record.generation,
    })) {
      this.pendingPreparation = null;
      this.options.clearTimer(pending.timer);
      pending.reject(new Error(
        "The local service did not accept update preparation.",
      ));
    }
    return promise;
  }

  release(): Promise<boolean> {
    const prepared = this.prepared;
    if (!prepared) return Promise.resolve(true);
    return this.releaseIdentity(prepared.record, prepared.operationId);
  }

  handle(record: RuntimeProcessRecord, event: UpdatePreparationEvent): void {
    if (event.type === "runtime.prepare-update-result") {
      const pending = this.pendingPreparation;
      if (
        !pending
        || pending.record !== record
        || pending.operationId !== event.operationId
        || event.generation !== record.generation
      ) return;
      this.pendingPreparation = null;
      this.options.clearTimer(pending.timer);
      if (event.ready) {
        this.prepared = { record, operationId: event.operationId };
      }
      pending.resolve(event.ready
        ? { ready: true }
        : { ready: false, blocker: event.blocker });
      return;
    }

    const pending = this.pendingRelease;
    if (
      !pending
      || pending.record !== record
      || pending.operationId !== event.operationId
      || event.generation !== record.generation
    ) return;
    this.pendingRelease = null;
    this.options.clearTimer(pending.timer);
    if (!event.released) {
      pending.reject(new Error(
        "The local service rejected reopening update admission.",
      ));
      this.options.forceTerminate(record);
      return;
    }
    if (
      this.prepared?.record === record
      && this.prepared.operationId === event.operationId
    ) this.prepared = null;
    pending.resolve(true);
  }

  clear(
    record: RuntimeProcessRecord | null,
    message: string,
    consumed: boolean,
  ): void {
    const preparing = this.pendingPreparation;
    if (preparing && (!record || preparing.record === record)) {
      this.pendingPreparation = null;
      this.options.clearTimer(preparing.timer);
      preparing.reject(new Error(message));
    }
    const releasing = this.pendingRelease;
    if (releasing && (!record || releasing.record === record)) {
      this.pendingRelease = null;
      this.options.clearTimer(releasing.timer);
      if (consumed) releasing.resolve(true);
      else releasing.reject(new Error(message));
    }
    if (this.prepared && (!record || this.prepared.record === record)) {
      this.prepared = null;
    }
  }

  private releaseIdentity(
    record: RuntimeProcessRecord,
    operationId: string,
  ): Promise<boolean> {
    const active = this.pendingRelease;
    if (active?.record === record && active.operationId === operationId) {
      return active.promise;
    }
    if (this.options.current() !== record) return Promise.resolve(true);
    let resolveRelease!: (released: boolean) => void;
    let rejectRelease!: (error: Error) => void;
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveRelease = resolve;
      rejectRelease = reject;
    });
    const pending: PendingRelease = {
      record,
      operationId,
      timer: undefined as unknown as RuntimeSupervisorTimer,
      promise,
      resolve: resolveRelease,
      reject: rejectRelease,
    };
    pending.timer = this.options.setTimer(() => {
      if (this.pendingRelease !== pending) return;
      this.pendingRelease = null;
      pending.reject(new Error(
        "The local service did not confirm reopening update admission.",
      ));
      this.options.forceTerminate(record);
    }, this.options.timeoutMs);
    this.pendingRelease = pending;
    if (!this.options.post(record, {
      type: "runtime.release-update-preparation",
      operationId,
      generation: record.generation,
    })) {
      this.pendingRelease = null;
      this.options.clearTimer(pending.timer);
      pending.reject(new Error(
        "The local service did not accept reopening update admission.",
      ));
      this.options.forceTerminate(record);
    }
    return promise;
  }
}
