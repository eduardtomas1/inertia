import { randomUUID } from "node:crypto";

import type { SecretRequestStorage } from "../shared/agent-secrets.js";
import {
  AGENT_SECRET_RECONCILE_MAX_REQUESTS,
  type RuntimeAgentSecretEvent,
  type RuntimeAgentSecretRejectionReason,
} from "../node/runtime-agent-secret-protocol.js";
import type { RuntimeWorkerCommand, RuntimeWorkerEvent } from "../node/runtime-process-protocol.js";
import { drainRuntimeRecordRequests } from "./runtime-supervisor-process-record.js";
import type {
  RuntimeAgentSecretVault,
  RuntimeProcessRecord,
  RuntimeSupervisorTimer,
} from "./runtime-supervisor-types.js";

export const AGENT_SECRET_DELIVERY_TIMEOUT_MS = 30_000;

export interface RuntimeAgentSecretDelivery {
  conversationId: string;
  requestId: string;
  secret: string;
  vaulted: boolean;
}

export type RuntimeAgentSecretDeliveryOutcome =
  | { status: "delivered"; expiresAt: string; storage: SecretRequestStorage }
  | { status: "rejected"; reason: RuntimeAgentSecretRejectionReason | "unavailable" };

interface PendingAgentSecretDelivery {
  record: RuntimeProcessRecord;
  requestId: string;
  timer: RuntimeSupervisorTimer;
  settle: (outcome: RuntimeAgentSecretDeliveryOutcome) => void;
}

interface PendingAgentSecretReconcile {
  record: RuntimeProcessRecord;
  requestIds: ReadonlySet<string>;
  timer: RuntimeSupervisorTimer;
  settle: (orphaned: readonly string[]) => void;
}

interface RuntimeAgentSecretCoordinatorOptions {
  timeoutMs: number;
  vault?: RuntimeAgentSecretVault | undefined;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  readyRecord: () => RuntimeProcessRecord | Error;
  post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
}

const UNAVAILABLE: RuntimeAgentSecretDeliveryOutcome = Object.freeze({ status: "rejected", reason: "unavailable" });

function isAgentSecretEvent(event: RuntimeWorkerEvent): event is RuntimeAgentSecretEvent {
  return event.type === "runtime.agent-secret-delivered"
    || event.type === "runtime.agent-secret-rejected"
    || event.type === "runtime.agent-secret-reconciled";
}

export class RuntimeAgentSecretCoordinator {
  private readonly pending = new Map<string, PendingAgentSecretDelivery>();
  private readonly reconciles = new Map<string, PendingAgentSecretReconcile>();
  private reconciling: RuntimeProcessRecord | null = null;

  constructor(private readonly options: RuntimeAgentSecretCoordinatorOptions) {}

  deliver(delivery: RuntimeAgentSecretDelivery): Promise<RuntimeAgentSecretDeliveryOutcome> {
    const record = this.options.readyRecord();
    if (record instanceof Error) return Promise.resolve(UNAVAILABLE);
    for (const pending of this.pending.values()) {
      if (pending.requestId === delivery.requestId) {
        return Promise.resolve({ status: "rejected", reason: "not-pending" });
      }
    }
    const transportId = randomUUID();
    return new Promise<RuntimeAgentSecretDeliveryOutcome>((resolve) => {
      const timer = this.options.setTimer(() => {
        if (this.pending.get(transportId)?.timer !== timer) return;
        this.pending.delete(transportId);
        resolve(UNAVAILABLE);
      }, this.options.timeoutMs);
      this.pending.set(transportId, { record, requestId: delivery.requestId, timer, settle: resolve });
      const posted = this.options.post(record, {
        type: "runtime.agent-secret-deliver",
        transportId,
        conversationId: delivery.conversationId,
        requestId: delivery.requestId,
        secret: delivery.secret,
        vaulted: delivery.vaulted,
      });
      if (!posted) this.settle(transportId, UNAVAILABLE);
    });
  }

  ready(record: RuntimeProcessRecord): void {
    const vault = this.options.vault;
    if (!vault || this.reconciling === record) return;
    this.reconciling = record;
    void this.reconcile(record, vault).finally(() => {
      if (this.reconciling === record) this.reconciling = null;
    });
  }

  handle(record: RuntimeProcessRecord, event: RuntimeWorkerEvent): event is RuntimeAgentSecretEvent {
    if (!isAgentSecretEvent(event)) return false;
    if (event.type === "runtime.agent-secret-reconciled") {
      const pending = this.reconciles.get(event.transportId);
      if (pending?.record !== record) return true;
      this.reconciles.delete(event.transportId);
      this.options.clearTimer(pending.timer);
      pending.settle(event.orphaned.filter((requestId) => pending.requestIds.has(requestId)));
      return true;
    }
    if (this.pending.get(event.transportId)?.record !== record) return true;
    this.settle(event.transportId, event.type === "runtime.agent-secret-delivered"
      ? { status: "delivered", expiresAt: event.expiresAt, storage: event.storage }
      : { status: "rejected", reason: event.reason });
    return true;
  }

  reject(record: RuntimeProcessRecord | null): void {
    drainRuntimeRecordRequests(this.pending, record, (pending) => {
      this.options.clearTimer(pending.timer);
      pending.settle(UNAVAILABLE);
    });
    drainRuntimeRecordRequests(this.reconciles, record, (pending) => {
      this.options.clearTimer(pending.timer);
      pending.settle([]);
    });
  }

  private async reconcile(record: RuntimeProcessRecord, vault: RuntimeAgentSecretVault): Promise<void> {
    let requestIds: string[];
    try {
      requestIds = [...new Set(await vault.requestIds())].slice(0, AGENT_SECRET_RECONCILE_MAX_REQUESTS);
    } catch {
      return;
    }
    if (requestIds.length === 0) return;
    for (const requestId of await this.orphaned(record, requestIds)) {
      try {
        await vault.forget(requestId);
      } catch {
      }
    }
  }

  private orphaned(record: RuntimeProcessRecord, requestIds: string[]): Promise<readonly string[]> {
    if (this.options.readyRecord() !== record) return Promise.resolve([]);
    const transportId = randomUUID();
    return new Promise<readonly string[]>((resolve) => {
      const timer = this.options.setTimer(() => {
        if (this.reconciles.get(transportId)?.timer !== timer) return;
        this.reconciles.delete(transportId);
        resolve([]);
      }, this.options.timeoutMs);
      this.reconciles.set(transportId, { record, requestIds: new Set(requestIds), timer, settle: resolve });
      if (this.options.post(record, { type: "runtime.agent-secret-reconcile", transportId, requestIds })) return;
      this.reconciles.delete(transportId);
      this.options.clearTimer(timer);
      resolve([]);
    });
  }

  private settle(transportId: string, outcome: RuntimeAgentSecretDeliveryOutcome): void {
    const pending = this.pending.get(transportId);
    if (!pending) return;
    this.pending.delete(transportId);
    this.options.clearTimer(pending.timer);
    pending.settle(outcome);
  }
}
