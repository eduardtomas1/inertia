import {
  delegatedTaskSchema,
  delegationMailboxSchema,
  isTerminalDelegatedDeliveryState,
  MAX_DELEGATED_TASK_TURN_IDS,
  type DelegatedDeliveryState,
  type DelegatedTask,
  type DelegationEvent,
} from "../../shared/orchestration-delegation";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

export const DELEGATED_TASK_PROJECTION = "delegated-task";
export const DELEGATION_MAILBOX_PROJECTION = "delegation-mailbox";

const DELIVERY_TRANSITIONS: Record<"none" | DelegatedDeliveryState, readonly DelegatedDeliveryState[]> = {
  none: ["pending", "claimed", "acknowledged", "disposed"],
  pending: ["pending", "claimed", "acknowledged", "disposed"],
  claimed: ["claimed", "pending", "delivered", "acknowledged", "disposed"],
  delivered: [],
  acknowledged: [],
  disposed: [],
};

function readTask(read: ProjectionReader, envelope: OrchestrationEvent, taskId: string): DelegatedTask {
  const row = read(DELEGATED_TASK_PROJECTION, taskId);
  if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
  return delegatedTaskSchema.parse(row.value);
}

function write(task: DelegatedTask, envelope: OrchestrationEvent): ProjectionWrite {
  return { kind: DELEGATED_TASK_PROJECTION, id: task.taskId,
    value: delegatedTaskSchema.parse({ ...task, updatedAt: envelope.createdAt }) };
}

function deliveryChange(task: DelegatedTask, payload: Extract<DelegationEvent, { type: "delegation.delivery-changed" }>["payload"]):
  DelegatedTask {
  const current = task.delivery.state;
  if (current === payload.state && isTerminalDelegatedDeliveryState(current)) return task;
  const userResend = current === "disposed" && payload.state === "claimed" && payload.reason === "user-send";
  if (!userResend && !DELIVERY_TRANSITIONS[current ?? "none"].includes(payload.state)) {
    throw new OrchestrationConflict("revision-conflict");
  }
  if ((payload.state === "claimed" || payload.state === "delivered") && (task.result === null || payload.generation === null)) {
    throw new OrchestrationConflict("revision-conflict");
  }
  if (payload.state === "pending" && task.result === null) throw new OrchestrationConflict("revision-conflict");
  if (payload.state === "delivered" && task.delivery.generation !== payload.generation) {
    throw new OrchestrationConflict("revision-conflict");
  }
  if (payload.state === "acknowledged" && (task.result === null || payload.observedByTurnId === null)) {
    throw new OrchestrationConflict("revision-conflict");
  }
  return { ...task, delivery: {
    state: payload.state,
    generation: payload.state === "pending" ? null : payload.generation ?? task.delivery.generation,
    observedByTurnId: payload.state === "acknowledged" ? payload.observedByTurnId : task.delivery.observedByTurnId,
  } };
}

export function isDelegationEvent<T extends { type: string }>(event: T): event is Extract<T, DelegationEvent> {
  return event.type.startsWith("delegation.");
}

export function projectDelegationEvent(event: DelegationEvent, envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  switch (event.type) {
    case "delegation.task-created": {
      const created = event.payload;
      if (read(DELEGATED_TASK_PROJECTION, created.taskId) || created.parentConversationId !== envelope.threadId) {
        throw new OrchestrationConflict("scope-conflict");
      }
      if (created.kind === "follow-up") {
        const original = readTask(read, envelope, created.originalTaskId!);
        if (original.result === null || original.childConversationId !== created.childConversationId
          || original.kind !== "original") throw new OrchestrationConflict("scope-conflict");
      }
      return [write({ ...created, wakeArmed: created.completionWake !== "never", status: "running",
        turnIds: [created.firstChildTurnId], result: null,
        delivery: { state: null, generation: null, observedByTurnId: null }, updatedAt: envelope.createdAt }, envelope)];
    }
    case "delegation.task-turn-attached": {
      const task = readTask(read, envelope, event.payload.taskId);
      if (task.result !== null) throw new OrchestrationConflict("revision-conflict");
      if (task.turnIds.includes(event.payload.childTurnId)) return [];
      return [write({ ...task, turnIds: [...task.turnIds, event.payload.childTurnId].slice(-MAX_DELEGATED_TASK_TURN_IDS) }, envelope)];
    }
    case "delegation.task-finalized": {
      const task = readTask(read, envelope, event.payload.taskId);
      if (task.result !== null) throw new OrchestrationConflict("revision-conflict");
      const { taskId: _taskId, resultTurnId, resultRunId, resultMessageId, ...result } = event.payload;
      return [write({ ...task, status: result.status, result: { turnId: resultTurnId, runId: resultRunId,
        messageId: resultMessageId, ...result } }, envelope)];
    }
    case "delegation.wake-policy-changed": {
      const task = readTask(read, envelope, event.payload.taskId);
      const { completionWake, armed, reason } = event.payload;
      if (armed && (completionWake === "never" || isTerminalDelegatedDeliveryState(task.delivery.state)
        || (!task.wakeArmed && reason !== "user"))) throw new OrchestrationConflict("revision-conflict");
      return [write({ ...task, completionWake, wakeArmed: armed }, envelope)];
    }
    case "delegation.delivery-changed":
      return event.payload.taskIds.map((taskId) => write(deliveryChange(readTask(read, envelope, taskId), event.payload), envelope));
    case "delegation.wakes-disarmed":
      return event.payload.taskIds.map((taskId) => {
        const task = readTask(read, envelope, taskId);
        if (event.payload.scope === "source-turn" && task.sourceTurnId !== event.payload.sourceTurnId) {
          throw new OrchestrationConflict("scope-conflict");
        }
        const dispose = event.payload.reason !== "setting-off" && !isTerminalDelegatedDeliveryState(task.delivery.state);
        return write({ ...task, wakeArmed: false,
          delivery: dispose ? { ...task.delivery, state: "disposed" } : task.delivery }, envelope);
      });
    case "delegation.mailbox-changed": {
      const previousRow = read(DELEGATION_MAILBOX_PROJECTION, envelope.threadId);
      const previous = previousRow ? delegationMailboxSchema.parse(previousRow.value) : null;
      const next = delegationMailboxSchema.parse({ ...event.payload, parentConversationId: envelope.threadId,
        updatedAt: envelope.createdAt });
      if (previous && (next.generation < previous.generation || next.nextGeneration < previous.nextGeneration
        || (next.generation === previous.generation && previous.deliveryId !== null && next.deliveryId !== previous.deliveryId))) {
        throw new OrchestrationConflict("revision-conflict");
      }
      for (const taskId of next.taskIds) readTask(read, envelope, taskId);
      return [{ kind: DELEGATION_MAILBOX_PROJECTION, id: envelope.threadId, value: next }];
    }
  }
}
