import type { AgentTurn } from "../../../shared/contracts";
import {
  isTerminalDelegatedDeliveryState,
  MAX_DELEGATED_TASK_TITLE_CHARS,
  type ConversationDelegation,
  type DelegatedTask,
  type DelegatedTaskView,
} from "../../../shared/orchestration-delegation";
import { randomUUID } from "node:crypto";

import type { RuntimeStore } from "../../database";
import {
  DelegationError,
  type CreateDelegatedTaskInput,
  type DelegationRepository,
} from "../../orchestration-v2/delegation-repository";
import {
  delegationRecoveryParents,
  finalizeRecoveredTasks,
  MAX_DELEGATION_FINALIZE_PASSES,
  settleRecoveredDelivery,
  upgradeInterruptedWaits,
} from "../../orchestration-v2/delegation-recovery";
import type { StoredLimitResetPlan } from "../../persistence/limit-reset-repository";
import type { RestartContinuationPlan } from "../../persistence/restart-continuation-repository";
import { stopOwnedManagedTurn } from "../managed-turn-ownership";
import {
  limitResetCancel,
  onScheduledPlanSettled,
  scheduledPlanSettled,
  type ScheduledPlanSettlement,
} from "../scheduled-plan-settlements";
import type { TurnController } from "../turns/turn-controller";
import { sameTurnOwner } from "../turns/turn-ownership";
import { activeTaskTurn, decorateDelegationNeedsAction, delegatedTaskView, type DelegationInteractions } from "./task-view";
import { clampDelegatedWaitTimeout, DelegatedTaskSignals, waitForDelegatedTask } from "./task-wait";

export type DelegationTaskErrorCode = "task_not_cancellable" | "nothing_to_send";

export class DelegationTaskError extends Error {
  constructor(readonly code: DelegationTaskErrorCode, message: string) {
    super(message);
    this.name = "DelegationTaskError";
  }
}

export interface DelegationQueue {
  offerDelegated(conversationId: string): Promise<void>;
  sendDelegated(conversationId: string): Promise<void>;
}

export interface DelegationTaskServiceDependencies {
  store: RuntimeStore;
  turns: TurnController;
  interactions: DelegationInteractions;
  queue(): DelegationQueue | undefined;
  changed?(conversationIds: readonly string[]): void;
  automaticWakes?(): boolean;
  pollMs?: number;
}

export interface DelegationCaller {
  conversationId: string;
  turnId: string;
}

export interface DelegationCancelTarget {
  task: DelegatedTask;
  identity: { turnId: string; runId: string } | null;
}

export interface DelegationFollowUpInput {
  parentConversationId: string;
  childConversationId: string;
  operationId: string;
  sourceTurnId: string;
  sourceRunId: string;
  childTurn: { id: string; runId: string };
  via: "send" | "steer";
}

const MAX_CANCEL_DEPTH = 3;
const MAX_PROPAGATION_DEPTH = 4;
const CONTINUATION_DISMISSED = "The delegated task was cancelled.";

function followUpTitle(title: string): string {
  return Array.from(`Follow-up: ${title}`).slice(0, MAX_DELEGATED_TASK_TITLE_CHARS).join("").trim();
}

export class DelegationTaskService {
  readonly signals = new DelegatedTaskSignals();

  constructor(private readonly dependencies: DelegationTaskServiceDependencies) {
    onScheduledPlanSettled(dependencies.store, (settlement) => {
      void this.onPlanSettled(settlement).catch(() => undefined);
    });
  }

  automaticWakes(): boolean {
    return this.dependencies.automaticWakes?.() ?? true;
  }

  private get delegation(): DelegationRepository {
    return this.dependencies.store.orchestration.delegation;
  }

  private lane<T>(parentConversationId: string, command: () => T): Promise<T> {
    return this.dependencies.store.orchestration.lanes.run(parentConversationId, command);
  }

  private changed(conversationIds: readonly string[]): void {
    this.dependencies.changed?.([...new Set(conversationIds)]);
  }

  view(taskId: string, extra: { waitTimedOut?: boolean } = {}): DelegatedTaskView {
    return delegatedTaskView(this.delegation, this.dependencies.interactions, taskId, extra);
  }

  decorateDetail(detail: ConversationDelegation | undefined): ConversationDelegation | undefined {
    return decorateDelegationNeedsAction(this.delegation, this.dependencies.interactions, detail);
  }

  owned(callerConversationId: string, taskId: string): DelegatedTask {
    return this.delegation.ownedTask(callerConversationId, taskId);
  }

  latestTaskFor(parentConversationId: string, childConversationId: string): DelegatedTaskView | null {
    const task = this.delegation.reads.tasks("parent_conversation_id = ? AND child_conversation_id = ?",
      parentConversationId, childConversationId).at(-1);
    return task ? this.view(task.taskId) : null;
  }

  async create(input: CreateDelegatedTaskInput): Promise<DelegatedTask> {
    const task = await this.lane(input.parentConversationId, () => {
      const created = this.delegation.create(input);
      this.holdWakesWhileOff(created.parentConversationId, created.taskId);
      return created;
    });
    this.changed([task.parentConversationId, task.childConversationId]);
    return task;
  }

  async followUp(input: DelegationFollowUpInput): Promise<string | null> {
    const taskId = await this.lane(input.parentConversationId, () => {
      const target = this.delegation.followUpTarget(input.parentConversationId, input.childConversationId);
      if (!target) return null;
      if (target.kind === "attach") {
        this.delegation.attach(target.taskId, input.childTurn.id, input.via);
        return target.taskId;
      }
      const original = this.delegation.get(target.taskId);
      if (input.via === "steer" || !original) return null;
      const created = this.delegation.create({
        operationId: input.operationId, kind: "follow-up", originalTaskId: original.taskId,
        parentConversationId: input.parentConversationId, sourceTurnId: input.sourceTurnId, sourceRunId: input.sourceRunId,
        childConversationId: input.childConversationId, firstChildTurnId: input.childTurn.id, firstChildRunId: input.childTurn.runId,
        title: followUpTitle(original.title), role: original.role, route: original.route, accessMode: original.accessMode,
        interactionMode: original.interactionMode, workspace: original.workspace, completionWake: "always",
      });
      this.holdWakesWhileOff(created.parentConversationId, created.taskId);
      return created.taskId;
    });
    if (taskId) this.changed([input.parentConversationId, input.childConversationId]);
    return taskId;
  }

  async status(caller: DelegationCaller, taskId: string): Promise<DelegatedTaskView> {
    const task = this.owned(caller.conversationId, taskId);
    return await this.lane(task.parentConversationId, () => {
      this.acknowledgeIfTerminal(taskId, caller.turnId);
      return this.view(taskId);
    });
  }

  async wait(caller: DelegationCaller, taskId: string, timeoutMs: number | undefined, signal: AbortSignal):
    Promise<DelegatedTaskView> {
    const task = this.owned(caller.conversationId, taskId);
    const { outcome } = await waitForDelegatedTask({
      read: () => this.view(taskId),
      subscribe: (listener) => this.signals.subscribe(listener),
      timeoutMs: clampDelegatedWaitTimeout(timeoutMs),
      signal,
      ...(this.dependencies.pollMs === undefined ? {} : { pollMs: this.dependencies.pollMs }),
    });
    const view = await this.lane(task.parentConversationId, () => {
      if (outcome === "terminal") {
        this.acknowledgeIfTerminal(taskId, caller.turnId);
      } else {
        const current = this.delegation.get(taskId);
        if (current?.completionWake === "settled_only" && current.wakeArmed) {
          this.delegation.setWakePolicy(taskId, "always", outcome === "timeout" ? "wait-timeout" : "wait-needs-action",
            caller.turnId);
        }
      }
      return this.view(taskId, { waitTimedOut: outcome === "timeout" });
    });
    await this.offer([task.parentConversationId]);
    this.changed([task.parentConversationId]);
    return view;
  }

  prepareCancel(callerConversationId: string | null, taskId: string): DelegationCancelTarget {
    const task = callerConversationId === null ? this.requireTask(taskId) : this.owned(callerConversationId, taskId);
    const target = this.cancelTarget(task);
    if (task.status === "running" && !target.identity && !this.nestedUnresolved(task).length && !this.armedLimitPlan(task)
      && !this.pendingContinuation(task) && this.delegation.reads.workState(task) !== "waiting_for_children") {
      throw new DelegationTaskError("task_not_cancellable",
        "The delegated task has no running turn, agents of its own or armed resume to cancel.");
    }
    return target;
  }

  async cancel(target: DelegationCancelTarget, actor: string, depth = 0): Promise<{ taskId: string;
    status: "cancel_requested" | Exclude<DelegatedTask["status"], "running"> }> {
    const { task } = target;
    const child = task.childConversationId;
    if (target.identity && sameTurnOwner(this.dependencies.turns.activeIdentity(child), target.identity)) {
      await stopOwnedManagedTurn(this.dependencies.store, this.dependencies.turns, child, target.identity);
    }
    const plan = this.armedLimitPlan(task);
    if (plan) this.cancelLimitPlan(plan);
    const continuation = this.pendingContinuation(task);
    if (continuation) this.dependencies.store.restartContinuations.cancel(continuation, CONTINUATION_DISMISSED);
    if (depth < MAX_CANCEL_DEPTH) {
      for (const nested of this.nestedUnresolved(task)) await this.cancel(this.cancelTarget(nested), actor, depth + 1);
    }
    await this.lane(task.parentConversationId, () => this.delegation.dispose(task.taskId, "cancelled", actor));
    const affected = await this.propagate(child);
    await this.offer(affected);
    this.changed([task.parentConversationId, child, ...affected]);
    this.signals.notify();
    return { taskId: task.taskId, status: task.status === "running" ? "cancel_requested" : task.status };
  }

  async dismiss(parentConversationId: string, taskIds: readonly string[] | undefined, actor: string): Promise<string[]> {
    const disposed = await this.lane(parentConversationId, () => {
      const tasks = taskIds === undefined
        ? this.delegation.tasksForParent(parentConversationId).filter(({ result }) => result !== null)
        : taskIds.map((taskId) => {
          const task = this.delegation.get(taskId);
          if (!task || task.parentConversationId !== parentConversationId) {
            throw new DelegationError("not-owned", "That delegated task does not belong to this chat.");
          }
          return task;
        });
      return tasks.filter(({ taskId }) => this.delegation.dispose(taskId, "user-dismiss", actor)).map(({ taskId }) => taskId);
    });
    this.changed([parentConversationId]);
    this.signals.notify();
    return disposed;
  }

  async send(parentConversationId: string): Promise<{ taskIds: string[]; generation: number }> {
    const parent = this.dependencies.store.conversation(parentConversationId);
    if (parent.archivedAt !== null) throw new DelegationError("invalid-request", "Unarchive this chat before sending results.");
    await this.lane(parentConversationId, () => this.delegation.planDelivery(parentConversationId, "user"));
    const entry = this.dependencies.store.queuedMessages.activeDelegatedDelivery(parentConversationId);
    const attribution = entry?.delegatedCompletion;
    if (!attribution) throw new DelegationTaskError("nothing_to_send", "No delegated results are waiting to be sent.");
    this.changed([parentConversationId]);
    await this.dependencies.queue()?.sendDelegated(parentConversationId);
    return { taskIds: [...attribution.taskIds], generation: attribution.generation };
  }

  async setWake(taskId: string, armed: boolean, actor: string): Promise<DelegatedTaskView> {
    const task = this.requireTask(taskId);
    if (armed && task.completionWake === "never") {
      throw new DelegationError("invalid-request", "This task was delegated without an automatic continue.");
    }
    await this.lane(task.parentConversationId, () => this.delegation.setWakeArmed(taskId, armed, actor));
    await this.offer([task.parentConversationId]);
    this.changed([task.parentConversationId]);
    return this.view(taskId);
  }

  async onTurnSettled(turn: AgentTurn): Promise<void> {
    const conversationId = turn.conversationId;
    const affected = new Set<string>();
    if (this.isParent(conversationId)) {
      await this.lane(conversationId, () => {
        if (turn.status === "cancelled") {
          this.delegation.disarm({ parentConversationId: conversationId, scope: "conversation", sourceTurnId: null,
            reason: "stop", trigger: turn.id });
        } else if (turn.status === "failed" && !this.limitHeld(turn)) {
          this.delegation.disarm({ parentConversationId: conversationId, scope: "source-turn", sourceTurnId: turn.id,
            reason: "source-failed", trigger: turn.id });
        }
        this.delegation.settleDelivery(conversationId, turn.id);
        this.delegation.planDelivery(conversationId);
      });
      affected.add(conversationId);
    }
    for (const parent of await this.propagate(conversationId)) affected.add(parent);
    await this.offer([...affected]);
    this.changed([...affected, conversationId]);
    this.signals.notify();
  }

  async onPlanSettled(settlement: ScheduledPlanSettlement): Promise<void> {
    const { conversationId } = settlement;
    const affected = new Set<string>();
    if (settlement.kind === "limit-reset" && this.isParent(conversationId)) {
      const released = await this.lane(conversationId, () => {
        const latest = this.delegation.reads.latestTurn(conversationId);
        if (latest?.id !== settlement.turnId || latest.status !== "failed") return false;
        this.delegation.disarm({ parentConversationId: conversationId, scope: "source-turn", sourceTurnId: settlement.turnId,
          reason: "source-failed", trigger: `limit-reset:${settlement.planId}:${settlement.state}` });
        this.delegation.planDelivery(conversationId);
        return true;
      });
      if (released) affected.add(conversationId);
    }
    for (const parent of await this.propagate(conversationId)) affected.add(parent);
    await this.offer([...affected]);
    this.changed([...affected, conversationId]);
    this.signals.notify();
  }

  async automaticWakesTurnedOff(trigger: string): Promise<void> {
    if (this.automaticWakes()) return;
    const parents = [...new Set(this.delegation.reads.tasks(`wake_armed = 1
      AND (delivery_state IS NULL OR delivery_state IN ('pending','claimed'))`).map(({ parentConversationId }) => parentConversationId))];
    for (const parent of parents) {
      await this.lane(parent, () => this.delegation.disarm({ parentConversationId: parent, scope: "conversation",
        sourceTurnId: null, reason: "setting-off", trigger })).catch(() => undefined);
    }
    this.changed(parents);
    this.signals.notify();
  }

  async recover(): Promise<void> {
    const parents = delegationRecoveryParents(this.delegation.reads);
    const step = async (parent: string, command: () => void): Promise<void> => {
      await this.lane(parent, command).catch((error: unknown) => {
        console.warn("Delegated task recovery did not finish for a chat.", error instanceof Error ? error.message : "unknown error");
      });
    };
    const automatic = this.automaticWakes();
    const trigger = `recovery:${randomUUID()}`;
    for (const parent of parents) {
      await step(parent, () => {
        if (!automatic) {
          this.delegation.disarm({ parentConversationId: parent, scope: "conversation", sourceTurnId: null,
            reason: "setting-off", trigger });
        }
        upgradeInterruptedWaits(this.delegation, parent);
      });
    }
    for (let pass = 0; pass < MAX_DELEGATION_FINALIZE_PASSES; pass += 1) {
      let finalized = 0;
      for (const parent of parents) {
        await step(parent, () => { finalized += finalizeRecoveredTasks(this.delegation, parent).length; });
      }
      if (!finalized) break;
    }
    for (const parent of parents) {
      await step(parent, () => {
        settleRecoveredDelivery(this.delegation, parent);
        this.delegation.planDelivery(parent);
      });
    }
    this.changed(parents);
    this.signals.notify();
  }

  async onChildEvidence(childConversationId: string): Promise<void> {
    const affected = await this.propagate(childConversationId);
    await this.offer(affected);
    this.changed(affected);
    this.signals.notify();
  }

  async onArchived(conversationId: string): Promise<void> {
    if (!this.isParent(conversationId)) return;
    await this.lane(conversationId, () => this.delegation.disarm({ parentConversationId: conversationId,
      scope: "conversation", sourceTurnId: null, reason: "archive", trigger: `archive:${Date.now()}` }));
    this.changed([conversationId]);
  }

  isParent(conversationId: string): boolean {
    return this.delegation.reads.taskIds("parent_conversation_id = ?", conversationId).length > 0
      || this.delegation.mailbox(conversationId) !== null;
  }

  isDelegatedChild(conversationId: string): boolean {
    return this.delegation.upstreamParents(conversationId).length > 0;
  }

  private async propagate(childConversationId: string, depth = 0): Promise<string[]> {
    const affected: string[] = [];
    for (const parent of this.delegation.upstreamParents(childConversationId)) {
      const change = await this.lane(parent, () => this.delegation.onChildChanged(childConversationId));
      for (const upstream of change.upstream) {
        affected.push(upstream);
        if (depth < MAX_PROPAGATION_DEPTH) affected.push(...await this.propagate(upstream, depth + 1));
      }
    }
    return affected;
  }

  private async offer(conversationIds: readonly string[]): Promise<void> {
    const queue = this.dependencies.queue();
    if (!queue) return;
    for (const conversationId of new Set(conversationIds)) {
      if (!this.dependencies.store.queuedMessages.activeDelegatedDelivery(conversationId)) continue;
      await queue.offerDelegated(conversationId).catch(() => undefined);
    }
  }

  private acknowledgeIfTerminal(taskId: string, observerTurnId: string): void {
    if (this.delegation.get(taskId)?.status === "running") this.delegation.finalizeIfReady(taskId);
    const task = this.delegation.get(taskId);
    if (task?.result && !isTerminalDelegatedDeliveryState(task.delivery.state)) this.delegation.acknowledge(taskId, observerTurnId);
  }

  private requireTask(taskId: string): DelegatedTask {
    const task = this.delegation.get(taskId);
    if (!task) throw new DelegationError("not-found", "That delegated task does not exist.");
    return task;
  }

  private cancelTarget(task: DelegatedTask): DelegationCancelTarget {
    const turn = activeTaskTurn(this.delegation, task);
    const active = this.dependencies.turns.activeIdentity(task.childConversationId);
    return { task, identity: turn && active?.turnId === turn.id && active.runId === turn.runId
      ? { turnId: active.turnId, runId: active.runId } : null };
  }

  private nestedUnresolved(task: DelegatedTask): DelegatedTask[] {
    return this.delegation.tasksForParent(task.childConversationId).filter((nested) => nested.status === "running"
      || (nested.result !== null && !isTerminalDelegatedDeliveryState(nested.delivery.state)));
  }

  private holdWakesWhileOff(parentConversationId: string, taskId: string): void {
    if (this.automaticWakes()) return;
    this.delegation.disarm({ parentConversationId, scope: "conversation", sourceTurnId: null, reason: "setting-off",
      trigger: `task:${taskId}` });
  }

  private limitHeld(turn: AgentTurn): boolean {
    if (!this.dependencies.store.limitResets.usageLimited(turn.id)) return false;
    const plan = this.dependencies.store.limitResets.get(turn.conversationId);
    return plan?.failedTurnId !== turn.id || !["cancelled", "blocked", "missed"].includes(plan.state);
  }

  private cancelLimitPlan(plan: StoredLimitResetPlan): void {
    const cancel = limitResetCancel(this.dependencies.store);
    if (cancel) {
      cancel(plan.conversationId, plan.id);
      return;
    }
    this.dependencies.store.limitResets.settle(plan, "cancelled", null);
    scheduledPlanSettled(this.dependencies.store, { kind: "limit-reset", conversationId: plan.conversationId, planId: plan.id,
      turnId: plan.failedTurnId, state: "cancelled" });
  }

  private pendingContinuation(task: DelegatedTask): RestartContinuationPlan | null {
    const plan = this.dependencies.store.restartContinuations.forConversation(task.childConversationId);
    if (!plan || (plan.state !== "waiting" && plan.state !== "dispatching")) return null;
    return this.ownsChildTurn(task, plan.interruptedTurnId) ? plan : null;
  }

  private ownsChildTurn(task: DelegatedTask, childTurnId: string): boolean {
    const owner = this.delegation.reads.taskForChildTurn(childTurnId);
    return owner === task.taskId || (task.kind === "original" && owner === null);
  }

  private armedLimitPlan(task: DelegatedTask): StoredLimitResetPlan | null {
    const plan = this.dependencies.store.limitResets.get(task.childConversationId);
    if (!plan || (plan.state !== "waiting" && plan.state !== "dispatching") || plan.turnId !== null) return null;
    return this.ownsChildTurn(task, plan.failedTurnId) ? plan : null;
  }
}
