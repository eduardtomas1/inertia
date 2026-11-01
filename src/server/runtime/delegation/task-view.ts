import type { AgentApprovalRequest, AgentInputRequest } from "../../../shared/contracts";
import {
  delegatedTaskViewSchema,
  isTerminalDelegatedDeliveryState,
  type ConversationDelegation,
  type DelegatedTask,
  type DelegatedTaskNeedsAction,
  type DelegatedTaskView,
} from "../../../shared/orchestration-delegation";
import { isAgentTurnTerminalStatus } from "../../../shared/turn-lifecycle";
import { DelegationError, type DelegationRepository } from "../../orchestration-v2/delegation-repository";

export interface DelegationInteractions {
  approvals: ReadonlyMap<string, AgentApprovalRequest>;
  inputs: ReadonlyMap<string, AgentInputRequest>;
}

export const TASK_RUNNING_WAKE_NEXT =
  "Still running. End your turn and its result will continue this chat automatically, or call inertia_wait_for_task.";
export const TASK_NEEDS_USER_NEXT =
  "The delegated chat is waiting for the user. Ask the user to answer in that chat; you cannot answer it.";

export function activeTaskTurn(delegation: DelegationRepository, task: DelegatedTask): { id: string; runId: string } | null {
  if (task.result) return null;
  const latest = delegation.reads.latestTurn(task.childConversationId);
  if (!latest || isAgentTurnTerminalStatus(latest.status)) return null;
  const owner = delegation.reads.taskForChildTurn(latest.id);
  return owner === task.taskId || (task.kind === "original" && owner === null) ? { id: latest.id, runId: latest.run_id } : null;
}

export function taskNeedsAction(delegation: DelegationRepository, interactions: DelegationInteractions,
  task: DelegatedTask): DelegatedTaskNeedsAction | null {
  const turn = activeTaskTurn(delegation, task);
  if (!turn) return null;
  const child = task.childConversationId;
  for (const input of interactions.inputs.values()) {
    if (input.conversationId === child && input.turnId === turn.id && input.questions.length > 0
      && !input.conversationContextRequest) return { kind: "question", turnId: turn.id };
  }
  for (const approval of interactions.approvals.values()) {
    if (approval.conversationId === child && approval.turnId === turn.id) return { kind: "approval", turnId: turn.id };
  }
  return null;
}

export function decorateDelegationNeedsAction(delegation: DelegationRepository, interactions: DelegationInteractions,
  detail: ConversationDelegation | undefined): ConversationDelegation | undefined {
  if (!detail?.asParent) return detail;
  return { ...detail, asParent: { ...detail.asParent, tasks: detail.asParent.tasks.map((summary) => {
    const task = summary.status === "running" ? delegation.get(summary.taskId) : null;
    return { ...summary, needsAction: task ? taskNeedsAction(delegation, interactions, task) : null };
  }) } };
}

export function delegatedTaskView(delegation: DelegationRepository, interactions: DelegationInteractions, taskId: string,
  extra: { waitTimedOut?: boolean } = {}): DelegatedTaskView {
  const read = delegation.read(taskId);
  if (!read) throw new DelegationError("not-found", "That delegated task does not exist.");
  const { task } = read;
  const needsAction = taskNeedsAction(delegation, interactions, task);
  const settled = read.status !== "running" || isTerminalDelegatedDeliveryState(task.delivery.state);
  const next = settled ? undefined
    : needsAction ? TASK_NEEDS_USER_NEXT
      : task.wakeArmed && task.completionWake !== "never" ? TASK_RUNNING_WAKE_NEXT : undefined;
  return delegatedTaskViewSchema.parse({
    taskId: task.taskId,
    kind: task.kind,
    originalTaskId: task.originalTaskId,
    conversationId: task.childConversationId,
    firstTurnId: task.firstChildTurnId,
    title: task.title,
    status: read.status,
    workState: read.workState,
    needsAction,
    hasPendingChildTurns: read.hasPendingChildTurns,
    result: read.result,
    latest: read.latest,
    route: task.route,
    accessMode: task.accessMode,
    interactionMode: task.interactionMode,
    completionWake: task.completionWake,
    wakeArmed: task.wakeArmed,
    delivery: { state: task.delivery.state, generation: task.delivery.generation },
    cleanup: read.cleanup,
    ...(extra.waitTimedOut === undefined ? {} : { waitTimedOut: extra.waitTimedOut }),
    ...(next ? { next } : {}),
  });
}
