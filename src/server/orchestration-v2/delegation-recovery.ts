import type Database from "better-sqlite3";

import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { DelegationReads } from "./delegation-reads";
import { DELEGATION_MAILBOX_PROJECTION } from "./delegation-projector";

export interface DelegationRecoveryTarget {
  readonly reads: DelegationReads;
  finalizeIfReady(taskId: string): { finalized: string[] };
  settleDelivery(parentConversationId: string, wakeTurnId: string): unknown;
  setWakePolicy(taskId: string, completionWake: "always", reason: "restart", observerTurnId: string): boolean;
  planDelivery(parentConversationId: string): unknown;
}

export interface DelegationRecoveryReport {
  finalized: string[];
  settled: string[];
  upgraded: string[];
  planned: string[];
}

export const MAX_DELEGATION_FINALIZE_PASSES = 4;

export function delegationRecoveryParents(reads: DelegationReads): string[] {
  return [...new Set(reads.tasks(`task_id IN (SELECT MIN(task_id) FROM delegated_tasks
    WHERE status = 'running' OR delivery_state IS NULL OR delivery_state IN ('pending','claimed')
      OR parent_conversation_id IN (SELECT id FROM orchestration_v2_entities WHERE kind = ?
        AND json_extract(payload_json, '$.phase') IN ('queued','dispatched'))
    GROUP BY parent_conversation_id)`, DELEGATION_MAILBOX_PROJECTION).map(({ parentConversationId }) => parentConversationId))];
}

export function upgradeInterruptedWaits(target: DelegationRecoveryTarget, parentConversationId: string): string[] {
  const upgraded: string[] = [];
  for (const task of target.reads.tasks(`parent_conversation_id = ? AND completion_wake = 'settled_only' AND wake_armed = 1
    AND (delivery_state IS NULL OR delivery_state = 'pending')`, parentConversationId)) {
    const source = target.reads.turn(task.sourceTurnId);
    if (source?.status !== "interrupted" || source.terminal_reason === "app-update") continue;
    if (target.setWakePolicy(task.taskId, "always", "restart", task.sourceTurnId)) upgraded.push(task.taskId);
  }
  return upgraded;
}

export function finalizeRecoveredTasks(target: DelegationRecoveryTarget, parentConversationId: string): string[] {
  return target.reads.taskIds("parent_conversation_id = ? AND status = 'running'", parentConversationId)
    .flatMap((taskId) => target.finalizeIfReady(taskId).finalized);
}

export function settleRecoveredDelivery(target: DelegationRecoveryTarget, parentConversationId: string): boolean {
  const mailbox = target.reads.mailbox(parentConversationId);
  if (!mailbox || (mailbox.phase !== "queued" && mailbox.phase !== "dispatched")) return false;
  const wakeTurnId = target.reads.wakeTurnId(parentConversationId, mailbox.generation);
  const wake = wakeTurnId ? target.reads.turn(wakeTurnId) : null;
  if (!wake || !isAgentTurnTerminalStatus(wake.status)) return false;
  target.settleDelivery(parentConversationId, wake.id);
  return true;
}

export function recoverDelegation(_database: Database.Database, target: DelegationRecoveryTarget): DelegationRecoveryReport {
  const report: DelegationRecoveryReport = { finalized: [], settled: [], upgraded: [], planned: [] };
  const parents = delegationRecoveryParents(target.reads);
  for (const parent of parents) report.upgraded.push(...upgradeInterruptedWaits(target, parent));
  for (let pass = 0; pass < MAX_DELEGATION_FINALIZE_PASSES; pass += 1) {
    const before = report.finalized.length;
    for (const parent of parents) report.finalized.push(...finalizeRecoveredTasks(target, parent));
    if (report.finalized.length === before) break;
  }
  for (const parent of parents) {
    if (settleRecoveredDelivery(target, parent)) report.settled.push(parent);
    target.planDelivery(parent);
    report.planned.push(parent);
  }
  return report;
}
