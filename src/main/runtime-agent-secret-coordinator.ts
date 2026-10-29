import { randomUUID } from "node:crypto";

import type { SecretRequestStorage } from "../shared/agent-secrets.js";
import type {
  RuntimeAgentSecretEvent,
  RuntimeAgentSecretRejectionReason,
} from "../node/runtime-agent-secret-protocol.js";
import type { RuntimeWorkerCommand, RuntimeWorkerEvent } from "../node/runtime-process-protocol.js";
import { drainRuntimeRecordRequests } from "./runtime-supervisor-process-record.js";
import type {
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

interface RuntimeAgentSecretCoordinatorOptions {
  timeoutMs: number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  readyRecord: () => RuntimeProcessRecord | Error;
  post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
}

const UNAVAILABLE: RuntimeAgentSecretDeliveryOutcome = Object.freeze({ status: "rejected", reason: "unavailable" });

function isAgentSecretEvent(event: RuntimeWorkerEvent): event is RuntimeAgentSecretEvent {
  return event.type === "runtime.agent-secret-delivered" || event.type === "runtime.agent-secret-rejected";
}

export class RuntimeAgentSecretCoordinator {
  private readonly pending = new Map<string, PendingAgentSecretDelivery>();

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

  handle(record: RuntimeProcessRecord, event: RuntimeWorkerEvent): event is RuntimeAgentSecretEvent {
    if (!isAgentSecretEvent(event)) return false;
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
  }

  private settle(transportId: string, outcome: RuntimeAgentSecretDeliveryOutcome): void {
    const pending = this.pending.get(transportId);
    if (!pending) return;
    this.pending.delete(transportId);
    this.options.clearTimer(pending.timer);
    pending.settle(outcome);
  }
}
