import type Database from "better-sqlite3";

import type { Conversation } from "../../shared/contracts";
import {
  MAX_DELEGATED_DELIVERY_TASKS,
  type DelegatedDeliveryReason,
  type DelegatedTask,
  type DelegationEvent,
  type DelegationMailbox,
} from "../../shared/orchestration-delegation";
import type { QueuedMessage } from "../../shared/queued-messages";
import { delegatedDeliveryId, type QueuedMessageRepository } from "../persistence/queued-message-repository";
import type { DelegationReads } from "./delegation-reads";
import { delegatedWakeText } from "./delegation-text";
import { commandFingerprint } from "./json";

export type DelegationPlanMode = "automatic" | "user";
export type EffectiveMailboxPhase = "idle" | "queued" | "dispatched" | "removed";

export interface DelegationPlanContext {
  database: Database.Database;
  reads: DelegationReads;
  queue: QueuedMessageRepository;
  conversation(id: string): Conversation;
  commit(parentConversationId: string, commandId: string, command: { type: string; [key: string]: string | number | string[] },
    events: DelegationEvent[], compatibility?: () => void): boolean;
}

export interface EffectiveMailbox {
  mailbox: DelegationMailbox;
  phase: EffectiveMailboxPhase;
  row: QueuedMessage | null;
}

export interface DelegationPlanResult {
  claimed: string[];
  pending: string[];
  disposed: string[];
  generation: number | null;
  deliveryId: string | null;
}

export interface QueuedRemoval {
  events: DelegationEvent[];
  compatibility: () => void;
}

const IDLE = (parentConversationId: string): DelegationMailbox => ({ parentConversationId, generation: 0, deliveryId: null,
  taskIds: [], phase: "settled", wakeTurnId: null, nextGeneration: 1, updatedAt: new Date(0).toISOString() });

export function effectiveMailbox(context: DelegationPlanContext, parentConversationId: string): EffectiveMailbox {
  const mailbox = context.reads.mailbox(parentConversationId) ?? IDLE(parentConversationId);
  if (mailbox.phase === "dispatched") return { mailbox, phase: "dispatched", row: null };
  if (mailbox.phase !== "queued" || mailbox.deliveryId === null) return { mailbox, phase: "idle", row: null };
  const row = context.queue.get(parentConversationId, mailbox.deliveryId);
  if (row && (row.state === "waiting" || row.state === "blocked")) return { mailbox, phase: "queued", row };
  if (row && (row.state === "dispatching" || row.turnId !== null)) return { mailbox, phase: "dispatched", row };
  if (context.reads.wakeTurnId(parentConversationId, mailbox.generation)) return { mailbox, phase: "dispatched", row };
  return { mailbox, phase: "removed", row };
}

export function deliveryContent(context: DelegationPlanContext, taskIds: readonly string[]): string {
  const tasks = taskIds.flatMap((taskId) => {
    const task = context.reads.task(taskId);
    return task ? [task] : [];
  });
  const cohort = context.reads.cohort([...new Set(tasks.map(({ sourceTurnId }) => sourceTurnId))]);
  return delegatedWakeText(tasks.map((task) => ({ taskId: task.taskId, title: task.title, status: task.status,
    text: context.reads.resultView(task)?.text ?? null })), cohort);
}

function mailboxEvent(mailbox: Omit<DelegationMailbox, "parentConversationId" | "updatedAt">): DelegationEvent {
  return { type: "delegation.mailbox-changed", payload: { generation: mailbox.generation, deliveryId: mailbox.deliveryId,
    taskIds: [...mailbox.taskIds], phase: mailbox.phase, wakeTurnId: mailbox.wakeTurnId, nextGeneration: mailbox.nextGeneration } };
}

export function deliveryEvent(taskIds: readonly string[], state: "pending" | "claimed" | "delivered" | "acknowledged" | "disposed",
  reason: DelegatedDeliveryReason, generation: number | null = null, observedByTurnId: string | null = null): DelegationEvent[] {
  const events: DelegationEvent[] = [];
  for (let index = 0; index < taskIds.length; index += 256) {
    events.push({ type: "delegation.delivery-changed", payload: { taskIds: taskIds.slice(index, index + 256), state,
      generation, observedByTurnId, reason } });
  }
  return events;
}

export function removeFromQueuedDelivery(context: DelegationPlanContext, parentConversationId: string,
  removed: readonly string[]): QueuedRemoval {
  const effective = effectiveMailbox(context, parentConversationId);
  const { mailbox } = effective;
  if (effective.phase !== "queued" || !removed.some((taskId) => mailbox.taskIds.includes(taskId))) {
    return { events: [], compatibility: () => undefined };
  }
  const remaining = mailbox.taskIds.filter((taskId) => !removed.includes(taskId));
  const deliveryId = mailbox.deliveryId!;
  if (!remaining.length) {
    return { events: [mailboxEvent({ ...mailbox, phase: "withdrawn" })],
      compatibility: () => { context.queue.withdrawDelegatedDelivery(parentConversationId, deliveryId); } };
  }
  return { events: [mailboxEvent({ ...mailbox, taskIds: remaining })], compatibility: () => {
    context.queue.updateDelegatedDelivery(parentConversationId, deliveryId, deliveryContent(context, remaining),
      { parentConversationId, generation: mailbox.generation, taskIds: remaining });
  } };
}

function candidates(context: DelegationPlanContext, parentConversationId: string, mode: DelegationPlanMode): DelegatedTask[] {
  const states = mode === "user" ? "(delivery_state IS NULL OR delivery_state IN ('pending','disposed'))"
    : "(delivery_state IS NULL OR delivery_state = 'pending')";
  return context.reads.tasks(`parent_conversation_id = ? AND status <> 'running' AND ${states}`, parentConversationId)
    .filter((task) => task.result !== null && (task.delivery.state === null || task.delivery.state === "pending"
      || (mode === "user" && task.delivery.state === "disposed")));
}

export function planDelegatedDelivery(context: DelegationPlanContext, parentConversationId: string,
  mode: DelegationPlanMode = "automatic"): DelegationPlanResult {
  const result: DelegationPlanResult = { claimed: [], pending: [], disposed: [], generation: null, deliveryId: null };
  const archived = context.reads.archived(parentConversationId);
  if (archived === null || (archived && mode === "user")) return result;
  const effective = effectiveMailbox(context, parentConversationId);
  if (mode === "user" && effective.phase === "dispatched") return result;
  const events: DelegationEvent[] = [];
  const compat: (() => void)[] = [];
  if (effective.phase === "removed") {
    const claimed = effective.mailbox.taskIds.filter((taskId) => context.reads.task(taskId)?.delivery.state === "claimed");
    events.push(...deliveryEvent(claimed, "disposed", "user-dismiss"), mailboxEvent({ ...effective.mailbox, phase: "withdrawn" }));
    result.disposed.push(...claimed);
    effective.phase = "idle";
    effective.mailbox = { ...effective.mailbox, phase: "withdrawn" };
  }
  const activeTurnId = context.reads.activeTurnId(parentConversationId);
  const deliverable: DelegatedTask[] = [];
  for (const task of candidates(context, parentConversationId, mode)) {
    if (archived) {
      if (task.delivery.state !== "disposed") result.disposed.push(task.taskId);
      continue;
    }
    if (mode === "automatic" && (task.completionWake === "never" || !task.wakeArmed)) continue;
    if (mode === "automatic" && task.completionWake === "settled_only" && task.sourceTurnId === activeTurnId) continue;
    deliverable.push(task);
  }
  events.push(...deliveryEvent(result.disposed, "disposed", "parent-gone"));
  const { mailbox } = effective;
  const deferred = (tasks: readonly DelegatedTask[]) => tasks.filter(({ delivery }) => delivery.state !== "pending")
    .map(({ taskId }) => taskId);
  if (effective.phase === "dispatched") {
    result.pending.push(...deferred(deliverable));
  } else if (deliverable.length) {
    const queued = effective.phase === "queued";
    const room = queued ? MAX_DELEGATED_DELIVERY_TASKS - mailbox.taskIds.length : MAX_DELEGATED_DELIVERY_TASKS;
    const claimed = deliverable.slice(0, Math.max(0, room));
    result.pending.push(...deferred(deliverable.slice(claimed.length)));
    if (claimed.length) {
      const generation = queued ? mailbox.generation : mailbox.nextGeneration;
      const deliveryId = queued ? mailbox.deliveryId! : delegatedDeliveryId(parentConversationId, generation);
      const taskIds = [...(queued ? mailbox.taskIds : []), ...claimed.map(({ taskId }) => taskId)];
      result.claimed.push(...claimed.map(({ taskId }) => taskId));
      result.generation = generation;
      result.deliveryId = deliveryId;
      events.push(...deliveryEvent(result.claimed, "claimed", mode === "user" ? "user-send" : queued ? "merged" : "planned", generation),
        mailboxEvent({ generation, deliveryId, taskIds, phase: "queued", wakeTurnId: null,
          nextGeneration: Math.max(mailbox.nextGeneration, generation + 1) }));
      compat.push(() => {
        const content = deliveryContent(context, taskIds);
        const attribution = { parentConversationId, generation, taskIds };
        if (queued) {
          if (!context.queue.updateDelegatedDelivery(parentConversationId, deliveryId, content, attribution)) {
            throw new Error("The queued delegated result delivery changed while it was being merged.");
          }
        } else {
          context.queue.insertDelegatedDelivery({ id: deliveryId, conversation: context.conversation(parentConversationId),
            content, attribution });
        }
      });
    }
  }
  events.push(...deliveryEvent(result.pending, "pending", "deferred"));
  if (!events.length) return result;
  const command = { type: "delegation.deliver", parentConversationId, mode, plan: commandFingerprint(events as never) };
  context.commit(parentConversationId,
    `delegation:deliver:${parentConversationId}:${result.generation ?? mailbox.generation}:${command.plan}`, command, events,
    () => { for (const write of compat) write(); });
  return result;
}
