import type Database from "better-sqlite3";

import type { Conversation } from "../../shared/contracts";
import {
  delegatedTaskCreatedSchema,
  isTerminalDelegatedDeliveryState,
  MAX_DELEGATED_EVENT_TASKS,
  type ConversationDelegation,
  type DelegatedAttachVia,
  type DelegatedCompletionWake,
  type DelegatedTask,
  type DelegatedTaskCreated,
  type DelegatedTaskResultView,
  type DelegatedTaskStatus,
  type DelegatedWakePolicyReason,
  type DelegatedWorkState,
  type DelegationDisarmReason,
  type DelegationDisarmScope,
  type DelegationEvent,
  type DelegationMailbox,
} from "../../shared/orchestration-delegation";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { QueuedMessageRepository } from "../persistence/queued-message-repository";
import {
  deliveryContent,
  deliveryEvent,
  effectiveMailbox,
  planDelegatedDelivery,
  removeFromQueuedDelivery,
  type DelegationPlanContext,
  type DelegationPlanMode,
  type DelegationPlanResult,
} from "./delegation-delivery-planner";
import { DELEGATED_TASK_PROJECTION, DELEGATION_MAILBOX_PROJECTION } from "./delegation-projector";
import { DelegationReads, defaultLiveNativeChildren, type LiveNativeChildren } from "./delegation-reads";
import { recoverDelegation, type DelegationRecoveryReport } from "./delegation-recovery";
import type { OrchestrationEventStore } from "./event-store";
import { ensureOrchestrationThread } from "./thread-registration";

export interface DelegationAccess {
  conversation(id: string): Conversation;
  conversationPath(id: string): string;
}

export type DelegationErrorCode = "not-found" | "not-owned" | "invalid-request" | "conflict";

export class DelegationError extends Error {
  constructor(readonly code: DelegationErrorCode, message: string) {
    super(message);
    this.name = "DelegationError";
  }
}

export type CreateDelegatedTaskInput = Omit<DelegatedTaskCreated, "taskId" | "createdAt"> & { createdAt?: string };

export interface DelegatedTaskRead {
  task: DelegatedTask;
  status: DelegatedTaskStatus;
  workState: DelegatedWorkState;
  hasPendingChildTurns: boolean;
  result: DelegatedTaskResultView | null;
  latest: { turnId: string; status: string } | null;
  cleanup: "not-started" | "pending" | "confirmed" | "unconfirmed";
}

export interface DelegationIndexRebuild {
  tasks: number;
  turns: number;
  skipped: string[];
  repairedDeliveries: string[];
}

export interface DelegationChange {
  finalized: string[];
  upstream: string[];
}

export interface FollowUpTarget {
  kind: "attach" | "follow-up";
  taskId: string;
}

function eventTaskIds(events: readonly DelegationEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "delegation.mailbox-changed") continue;
    if ("taskIds" in event.payload) for (const taskId of event.payload.taskIds) ids.add(taskId);
    else ids.add(event.payload.taskId);
  }
  return [...ids];
}

export class DelegationRepository {
  readonly reads: DelegationReads;
  private readonly queue: QueuedMessageRepository;
  private readonly planContext: DelegationPlanContext;

  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore,
    private readonly access: DelegationAccess, liveNativeChildren?: LiveNativeChildren) {
    this.reads = new DelegationReads(database, liveNativeChildren ?? defaultLiveNativeChildren(database));
    this.queue = new QueuedMessageRepository(database);
    this.planContext = { database, reads: this.reads, queue: this.queue,
      conversation: (id) => this.access.conversation(id),
      commit: (parent, commandId, command, events, compatibility) => this.commit(parent, commandId, command, events, compatibility) };
  }

  useLiveNativeChildren(source: LiveNativeChildren): void {
    this.reads.useLiveNativeChildren(source);
  }

  get(taskId: string): DelegatedTask | null {
    return this.reads.task(taskId);
  }

  mailbox(parentConversationId: string): DelegationMailbox | null {
    return this.reads.mailbox(parentConversationId);
  }

  detail(conversationId: string): ConversationDelegation | null {
    return this.reads.detail(conversationId);
  }

  read(taskId: string): DelegatedTaskRead | null {
    const task = this.reads.task(taskId);
    if (!task) return null;
    const evaluation = this.reads.evaluate(task);
    const { status, workState, outcome } = this.reads.derived(task, evaluation);
    const latest = evaluation.latestTerminalTurn;
    return {
      task,
      status,
      workState,
      hasPendingChildTurns: evaluation.hasPendingChildTurns,
      result: outcome ? this.reads.outcomeView(outcome) : null,
      latest: latest && latest.id !== outcome?.turnId ? { turnId: latest.id, status: latest.status } : null,
      cleanup: this.reads.cleanup((evaluation.latestTurn ?? evaluation.resultTurn)?.run_id ?? task.firstChildRunId),
    };
  }

  ownedTask(callerConversationId: string, taskId: string): DelegatedTask {
    const task = this.reads.task(taskId);
    const managed = task ? this.database.prepare(`SELECT 1 FROM agent_managed_conversations
      WHERE child_conversation_id = ? AND source_conversation_id = ?`).get(task.childConversationId, callerConversationId) : undefined;
    const indexed = task ? this.database.prepare("SELECT 1 FROM delegated_tasks WHERE task_id = ? AND parent_conversation_id = ?")
      .get(taskId, callerConversationId) : undefined;
    if (!task || task.parentConversationId !== callerConversationId || !managed || !indexed) {
      throw new DelegationError("not-owned", "That delegated task does not belong to this chat.");
    }
    return task;
  }

  tasksForParent(parentConversationId: string): DelegatedTask[] {
    return this.reads.tasks("parent_conversation_id = ?", parentConversationId);
  }

  taskForChildTurn(childTurnId: string): DelegatedTask | null {
    const taskId = this.reads.taskForChildTurn(childTurnId);
    return taskId ? this.reads.task(taskId) : null;
  }

  followUpTarget(parentConversationId: string, childConversationId: string): FollowUpTarget | null {
    const tasks = this.reads.tasks("parent_conversation_id = ? AND child_conversation_id = ?", parentConversationId,
      childConversationId);
    const unresolved = tasks.filter(({ result }) => result === null).at(-1);
    if (unresolved) return { kind: "attach", taskId: unresolved.taskId };
    const original = tasks.filter(({ kind, result }) => kind === "original" && result !== null).at(-1);
    return original ? { kind: "follow-up", taskId: original.taskId } : null;
  }

  upstreamParents(childConversationId: string): string[] {
    return [...new Set(this.reads.tasks("child_conversation_id = ? AND status = 'running'", childConversationId)
      .map(({ parentConversationId }) => parentConversationId))];
  }

  deliveryText(parentConversationId: string, generation: number): string | null {
    const { mailbox } = effectiveMailbox(this.planContext, parentConversationId);
    return mailbox.generation === generation && mailbox.taskIds.length ? deliveryContent(this.planContext, mailbox.taskIds) : null;
  }

  create(input: CreateDelegatedTaskInput): DelegatedTask {
    const created = delegatedTaskCreatedSchema.parse({ ...input, taskId: input.operationId,
      createdAt: input.createdAt ?? new Date().toISOString() });
    return this.transaction(() => {
      const commandId = `delegation:create:${created.operationId}`;
      const command = { type: "delegation.create", ...created, route: { ...created.route }, createdAt: "" };
      if (this.replayed(created.parentConversationId, commandId, command)) return this.reads.task(created.taskId)!;
      this.validateCreate(created);
      this.commit(created.parentConversationId, commandId, command, [{ type: "delegation.task-created", payload: created }],
        () => this.indexTurn(created.taskId, created.firstChildTurnId));
      return this.reads.task(created.taskId)!;
    });
  }

  attach(taskId: string, childTurnId: string, via: DelegatedAttachVia): DelegatedTask {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      if (this.reads.taskForChildTurn(childTurnId) === taskId) return task;
      const commandId = `delegation:attach:${taskId}:${childTurnId}`;
      const command = { type: "delegation.attach", taskId, childTurnId, via };
      if (this.replayed(task.parentConversationId, commandId, command)) return this.reads.task(taskId)!;
      const turn = this.reads.turn(childTurnId);
      if (!turn || turn.conversation_id !== task.childConversationId) {
        throw new DelegationError("invalid-request", "That turn does not belong to the delegated chat.");
      }
      if (task.result !== null) throw new DelegationError("conflict", "That delegated task already has a result.");
      const owner = this.reads.taskForChildTurn(childTurnId);
      if (owner && owner !== taskId) throw new DelegationError("conflict", "That turn already belongs to another delegated task.");
      this.commit(task.parentConversationId, commandId, command, [{ type: "delegation.task-turn-attached",
        payload: { taskId, childTurnId, childRunId: turn.run_id, via } }], () => this.indexTurn(taskId, childTurnId));
      return this.reads.task(taskId)!;
    });
  }

  finalizeIfReady(taskId: string): DelegationChange {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.result !== null) return { finalized: [], upstream: [] };
      const outcome = this.reads.outcome(task);
      if (!outcome) return { finalized: [], upstream: [] };
      const commandId = `delegation:finalize:${taskId}:${outcome.turnId}`;
      const command = { type: "delegation.finalize", taskId, resultTurnId: outcome.turnId };
      if (!this.replayed(task.parentConversationId, commandId, command)) {
        this.commit(task.parentConversationId, commandId, command, [{ type: "delegation.task-finalized", payload: {
          taskId, resultTurnId: outcome.turnId, resultRunId: outcome.runId, status: outcome.status,
          resultMessageId: outcome.messageId, failureSummary: outcome.failureSummary,
          finalizedAt: new Date().toISOString() } }]);
      }
      this.plan(task.parentConversationId);
      return { finalized: [taskId], upstream: [task.parentConversationId] };
    });
  }

  onChildChanged(childConversationId: string): DelegationChange {
    const change: DelegationChange = { finalized: [], upstream: [] };
    for (const taskId of this.reads.taskIds("child_conversation_id = ? AND status = 'running'", childConversationId)) {
      const next = this.finalizeIfReady(taskId);
      change.finalized.push(...next.finalized);
      for (const parent of next.upstream) if (!change.upstream.includes(parent)) change.upstream.push(parent);
    }
    return change;
  }

  planDelivery(parentConversationId: string, mode: DelegationPlanMode = "automatic"): DelegationPlanResult {
    return this.transaction(() => this.plan(parentConversationId, mode));
  }

  markDispatched(parentConversationId: string, generation: number, wakeTurnId: string): boolean {
    return this.transaction(() => {
      const { mailbox } = effectiveMailbox(this.planContext, parentConversationId);
      if (mailbox.generation !== generation || mailbox.phase !== "queued") return false;
      return this.commit(parentConversationId, `delegation:dispatched:${parentConversationId}:${generation}:${wakeTurnId}`,
        { type: "delegation.dispatched", parentConversationId, generation, wakeTurnId },
        [{ type: "delegation.mailbox-changed", payload: { generation, deliveryId: mailbox.deliveryId, taskIds: [...mailbox.taskIds],
          phase: "dispatched", wakeTurnId, nextGeneration: mailbox.nextGeneration } }]);
    });
  }

  settleDelivery(parentConversationId: string, wakeTurnId: string): DelegationChange {
    return this.transaction(() => {
      const turn = this.reads.turn(wakeTurnId);
      if (!turn || turn.conversation_id !== parentConversationId || !isAgentTurnTerminalStatus(turn.status)) {
        return { finalized: [], upstream: [] };
      }
      const generation = this.reads.wakeGeneration(parentConversationId, turn);
      const { mailbox } = effectiveMailbox(this.planContext, parentConversationId);
      if (generation === null || mailbox.generation !== generation || (mailbox.phase !== "queued" && mailbox.phase !== "dispatched")) {
        return { finalized: [], upstream: [] };
      }
      const delivered = turn.status !== "cancelled" && this.reads.startCrossed(turn)
        && (turn.status !== "interrupted" || turn.terminal_reason === "app-update");
      this.settle(parentConversationId, mailbox, wakeTurnId, delivered ? "delivered" : "requeued");
      return { finalized: [], upstream: [parentConversationId] };
    });
  }

  deliverySteered(parentConversationId: string, generation: number, turnId: string): boolean {
    return this.transaction(() => {
      const effective = effectiveMailbox(this.planContext, parentConversationId);
      if (effective.mailbox.generation !== generation || (effective.mailbox.phase !== "queued" && effective.mailbox.phase !== "dispatched")) {
        return false;
      }
      if (effective.phase === "queued") this.queue.withdrawDelegatedDelivery(parentConversationId, effective.mailbox.deliveryId!);
      this.settle(parentConversationId, effective.mailbox, turnId, "steered");
      return true;
    });
  }

  acknowledge(taskId: string, observerTurnId: string): boolean {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      const observer = this.reads.turn(observerTurnId);
      if (!task.result || isTerminalDelegatedDeliveryState(task.delivery.state) || !observer
        || observer.conversation_id !== task.parentConversationId || isAgentTurnTerminalStatus(observer.status)) return false;
      const removal = removeFromQueuedDelivery(this.planContext, task.parentConversationId, [taskId]);
      return this.commit(task.parentConversationId, `delegation:ack:${taskId}:${observerTurnId}`,
        { type: "delegation.ack", taskId, observerTurnId },
        [...deliveryEvent([taskId], "acknowledged", "acknowledged", task.delivery.generation, observerTurnId), ...removal.events],
        removal.compatibility);
    });
  }

  dispose(taskId: string, reason: "cancelled" | "user-dismiss", actor: string): boolean {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      if (isTerminalDelegatedDeliveryState(task.delivery.state)) return false;
      const removal = removeFromQueuedDelivery(this.planContext, task.parentConversationId, [taskId]);
      const disarm: DelegationEvent[] = task.wakeArmed ? [{ type: "delegation.wake-policy-changed",
        payload: { taskId, completionWake: task.completionWake, armed: false, reason: "disposed" } }] : [];
      return this.commit(task.parentConversationId, `delegation:dispose:${taskId}:${reason}:${actor}`,
        { type: "delegation.dispose", taskId, reason, actor },
        [...deliveryEvent([taskId], "disposed", reason), ...disarm, ...removal.events], removal.compatibility);
    });
  }

  disarm(input: { parentConversationId: string; scope: DelegationDisarmScope; sourceTurnId: string | null;
    reason: DelegationDisarmReason; trigger: string }): string[] {
    if ((input.scope === "source-turn") !== (input.sourceTurnId !== null)) {
      throw new DelegationError("invalid-request", "A source-turn disarm needs exactly one source turn.");
    }
    return this.transaction(() => {
      const scoped = input.scope === "source-turn" ? "AND source_turn_id = ?" : "";
      const matching = this.reads.tasks(`parent_conversation_id = ? ${scoped}`, input.parentConversationId,
        ...(input.sourceTurnId ? [input.sourceTurnId] : [])).filter((task) => !isTerminalDelegatedDeliveryState(task.delivery.state)
        && (task.wakeArmed || input.reason !== "setting-off"));
      const taskIds = matching.map(({ taskId }) => taskId);
      if (!taskIds.length) return [];
      const effective = effectiveMailbox(this.planContext, input.parentConversationId);
      const queued = effective.phase === "queued" ? taskIds.filter((taskId) => effective.mailbox.taskIds.includes(taskId)) : [];
      const keeping = input.reason === "setting-off";
      const removal = removeFromQueuedDelivery(this.planContext, input.parentConversationId, keeping ? queued : taskIds);
      const events: DelegationEvent[] = [];
      for (let index = 0; index < taskIds.length; index += MAX_DELEGATED_EVENT_TASKS) {
        events.push({ type: "delegation.wakes-disarmed", payload: { scope: input.scope, sourceTurnId: input.sourceTurnId,
          reason: input.reason, taskIds: taskIds.slice(index, index + MAX_DELEGATED_EVENT_TASKS) } });
      }
      const commandId = `delegation:disarm:${input.parentConversationId}:${input.sourceTurnId ?? "conversation"}:${input.reason}:${input.trigger}`;
      this.commit(input.parentConversationId, commandId, { type: "delegation.disarm", ...input, sourceTurnId: input.sourceTurnId ?? "" },
        [...events, ...(keeping ? deliveryEvent(queued, "pending", "deferred") : []), ...removal.events], removal.compatibility);
      return taskIds;
    });
  }

  setWakePolicy(taskId: string, completionWake: DelegatedCompletionWake, reason: Exclude<DelegatedWakePolicyReason, "user" | "disposed">,
    observerTurnId: string): boolean {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.completionWake === completionWake || task.completionWake === "never" || completionWake === "never"
        || !task.wakeArmed || isTerminalDelegatedDeliveryState(task.delivery.state)) return false;
      const changed = this.commit(task.parentConversationId,
        `delegation:wake-policy:${taskId}:${completionWake}:${reason}:${observerTurnId}`,
        { type: "delegation.wake-policy", taskId, completionWake, reason, observerTurnId },
        [{ type: "delegation.wake-policy-changed", payload: { taskId, completionWake, armed: true, reason } }]);
      if (changed) this.plan(task.parentConversationId);
      return changed;
    });
  }

  setWakeArmed(taskId: string, armed: boolean, actor: string): boolean {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.wakeArmed === armed || (armed && (task.completionWake === "never"
        || isTerminalDelegatedDeliveryState(task.delivery.state)))) return false;
      const removal = armed ? { events: [], compatibility: () => undefined }
        : removeFromQueuedDelivery(this.planContext, task.parentConversationId, [taskId]);
      const events: DelegationEvent[] = [{ type: "delegation.wake-policy-changed",
        payload: { taskId, completionWake: task.completionWake, armed, reason: "user" } }];
      if (removal.events.length) events.push(...deliveryEvent([taskId], "pending", "user-dismiss"));
      const changed = this.commit(task.parentConversationId, `delegation:wake-policy:${taskId}:${armed ? "armed" : "disarmed"}:user:${actor}`,
        { type: "delegation.wake-arm", taskId, armed: armed ? "armed" : "disarmed", actor }, [...events, ...removal.events],
        removal.compatibility);
      if (changed && armed) this.plan(task.parentConversationId);
      return changed;
    });
  }

  rebuildProjections(): DelegationIndexRebuild {
    let report: DelegationIndexRebuild = { tasks: 0, turns: 0, skipped: [], repairedDeliveries: [] };
    this.events.rebuildProjections(() => { report = this.rebuildIndex(); });
    return report;
  }

  rebuildIndex(): DelegationIndexRebuild {
    return this.transaction(() => {
      const report: DelegationIndexRebuild = { tasks: 0, turns: 0, skipped: [], repairedDeliveries: [] };
      this.database.prepare("DELETE FROM delegated_task_turns").run();
      this.database.prepare("DELETE FROM delegated_tasks").run();
      const conversationExists = this.database.prepare("SELECT 1 FROM conversations WHERE id = ?");
      const projections = this.database.prepare(`SELECT id FROM orchestration_v2_entities WHERE kind = ? AND id > ?
        ORDER BY id LIMIT 256`);
      let after = "";
      while (true) {
        const rows = projections.all(DELEGATED_TASK_PROJECTION, after) as { id: string }[];
        if (!rows.length) break;
        for (const { id } of rows) {
          const task = this.reads.task(id)!;
          if (!conversationExists.get(task.parentConversationId) || !conversationExists.get(task.childConversationId)) {
            report.skipped.push(id);
            continue;
          }
          this.indexTask(id);
          report.tasks += 1;
        }
        after = rows.at(-1)!.id;
      }
      const ownership = this.database.prepare(`SELECT json_extract(event.payload_json, '$.taskId') AS task_id,
          COALESCE(json_extract(event.payload_json, '$.childTurnId'), json_extract(event.payload_json, '$.firstChildTurnId')) AS turn_id,
          event.sequence
        FROM orchestration_v2_events AS event
        WHERE event.type IN ('delegation.task-created', 'delegation.task-turn-attached') AND event.sequence > ?
        ORDER BY event.sequence LIMIT 256`);
      const insertTurn = this.database.prepare(`INSERT INTO delegated_task_turns (child_turn_id, task_id)
        SELECT turn.id, task.task_id FROM agent_turns AS turn JOIN delegated_tasks AS task ON task.task_id = ?
        WHERE turn.id = ? AND turn.conversation_id = task.child_conversation_id
        ON CONFLICT(child_turn_id) DO NOTHING`);
      let sequence = 0;
      while (true) {
        const rows = ownership.all(sequence) as { task_id: string; turn_id: string; sequence: number }[];
        if (!rows.length) break;
        for (const row of rows) report.turns += insertTurn.run(row.task_id, row.turn_id).changes;
        sequence = rows.at(-1)!.sequence;
      }
      const mailboxes = this.database.prepare(`SELECT id FROM orchestration_v2_entities WHERE kind = ?
        AND json_extract(payload_json, '$.phase') = 'queued' ORDER BY id LIMIT 4096`).all(DELEGATION_MAILBOX_PROJECTION) as { id: string }[];
      for (const { id: parentConversationId } of mailboxes) {
        const effective = effectiveMailbox(this.planContext, parentConversationId);
        const { mailbox, row } = effective;
        if (effective.phase !== "queued" || !row) continue;
        const attribution = { parentConversationId, generation: mailbox.generation, taskIds: [...mailbox.taskIds] };
        if (JSON.stringify(row.delegatedCompletion) === JSON.stringify(attribution)) continue;
        if (this.queue.updateDelegatedDelivery(parentConversationId, row.id, deliveryContent(this.planContext, mailbox.taskIds),
          attribution)) {
          report.repairedDeliveries.push(row.id);
        }
      }
      return report;
    });
  }

  recover(): DelegationRecoveryReport {
    return recoverDelegation(this.database, this);
  }

  private settle(parentConversationId: string, mailbox: DelegationMailbox, wakeTurnId: string,
    outcome: "delivered" | "requeued" | "steered"): void {
    const claimed = mailbox.taskIds.filter((taskId) => {
      const task = this.reads.task(taskId);
      return task?.delivery.state === "claimed" && task.delivery.generation === mailbox.generation;
    });
    const events: DelegationEvent[] = outcome === "requeued" ? deliveryEvent(claimed, "pending", "requeued")
      : deliveryEvent(claimed, "delivered", outcome === "steered" ? "steered" : "delivered", mailbox.generation);
    events.push({ type: "delegation.mailbox-changed", payload: { generation: mailbox.generation, deliveryId: mailbox.deliveryId,
      taskIds: [...mailbox.taskIds], phase: "settled", wakeTurnId, nextGeneration: Math.max(mailbox.nextGeneration, mailbox.generation + 1) } });
    this.commit(parentConversationId, `delegation:delivery-settled:${parentConversationId}:${mailbox.generation}:${wakeTurnId}`,
      { type: "delegation.delivery-settled", parentConversationId, generation: mailbox.generation, wakeTurnId, outcome }, events);
    this.plan(parentConversationId);
  }

  private plan(parentConversationId: string, mode: DelegationPlanMode = "automatic"): DelegationPlanResult {
    return planDelegatedDelivery(this.planContext, parentConversationId, mode);
  }

  private validateCreate(created: DelegatedTaskCreated): void {
    const operation = this.database.prepare(`SELECT source_conversation_id, source_turn_id, source_run_id, child_conversation_id,
      tool_name, status, target_turn_id, target_run_id FROM agent_thread_operations WHERE id = ?`).get(created.operationId) as {
      source_conversation_id: string | null; source_turn_id: string | null; source_run_id: string; child_conversation_id: string | null;
      tool_name: string; status: string; target_turn_id: string | null; target_run_id: string | null } | undefined;
    const tool = created.kind === "original" ? "inertia_delegate_task" : "inertia_send_message";
    if (!operation || operation.tool_name !== tool || !["dispatching", "completed"].includes(operation.status)
      || operation.source_conversation_id !== created.parentConversationId || operation.source_turn_id !== created.sourceTurnId
      || operation.source_run_id !== created.sourceRunId || operation.child_conversation_id !== created.childConversationId
      || (operation.target_turn_id !== null && operation.target_turn_id !== created.firstChildTurnId)
      || (operation.target_run_id !== null && operation.target_run_id !== created.firstChildRunId)) {
      throw new DelegationError("conflict", "The delegated task does not match its approved managed-chat operation.");
    }
    if (!this.database.prepare(`SELECT 1 FROM agent_managed_conversations WHERE child_conversation_id = ?
      AND source_conversation_id = ?`).get(created.childConversationId, created.parentConversationId)) {
      throw new DelegationError("not-owned", "Only a chat this chat created can carry its delegated task.");
    }
    const turn = this.reads.turn(created.firstChildTurnId);
    if (!turn || turn.conversation_id !== created.childConversationId || turn.run_id !== created.firstChildRunId) {
      throw new DelegationError("invalid-request", "The delegated task's first turn does not belong to its chat.");
    }
    const existing = this.reads.tasks("child_conversation_id = ?", created.childConversationId);
    if (created.kind === "original" && existing.length) {
      throw new DelegationError("conflict", "That chat already carries a delegated task.");
    }
    if (created.kind === "follow-up") {
      const original = existing.find(({ taskId }) => taskId === created.originalTaskId);
      if (!original || original.kind !== "original" || original.result === null
        || original.parentConversationId !== created.parentConversationId || existing.some(({ result }) => result === null)) {
        throw new DelegationError("conflict", "A follow-up task needs a finished original task and no unresolved task.");
      }
    }
  }

  private requireTask(taskId: string): DelegatedTask {
    const task = this.reads.task(taskId);
    if (!task) throw new DelegationError("not-found", "That delegated task does not exist.");
    return task;
  }

  private replayed(parentConversationId: string, commandId: string, command: Record<string, unknown>): boolean {
    const parent = this.access.conversation(parentConversationId);
    return this.events.receipt({ actorId: "runtime", commandId, projectId: parent.projectId, threadId: parent.id },
      command as never) !== null;
  }

  private commit(parentConversationId: string, commandId: string, command: Record<string, unknown>,
    events: readonly DelegationEvent[], compatibility?: () => void): boolean {
    const parent = this.access.conversation(parentConversationId);
    ensureOrchestrationThread(this.events, parent, this.access.conversationPath(parent.id));
    const identity = { actorId: "runtime", commandId, projectId: parent.projectId, threadId: parent.id };
    if (!events.length || this.events.receipt(identity, command as never)) return false;
    const touched = eventTaskIds(events);
    return !this.events.commit({ ...identity, command: command as never, expectedRevision: this.events.revision(parent.id),
      events: events as never, result: null }, () => {
      compatibility?.();
      for (const taskId of touched) this.indexTask(taskId);
    }).replayed;
  }

  private indexTask(taskId: string): void {
    const task = this.reads.task(taskId);
    if (!task) throw new Error("The delegated task projection is missing.");
    this.database.prepare(`INSERT INTO delegated_tasks (task_id, parent_conversation_id, source_turn_id, source_run_id,
        child_conversation_id, operation_id, kind, original_task_id, status, completion_wake, wake_armed, delivery_state,
        delivery_generation, result_turn_id, created_at, updated_at)
      VALUES (?, ?, (SELECT id FROM agent_turns WHERE id = ?), ?, ?, (SELECT id FROM agent_thread_operations WHERE id = ?),
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, completion_wake = excluded.completion_wake,
        wake_armed = excluded.wake_armed, delivery_state = excluded.delivery_state,
        delivery_generation = excluded.delivery_generation, result_turn_id = excluded.result_turn_id,
        updated_at = excluded.updated_at`).run(task.taskId, task.parentConversationId, task.sourceTurnId, task.sourceRunId,
      task.childConversationId, task.operationId, task.kind, task.originalTaskId, task.status, task.completionWake,
      task.wakeArmed ? 1 : 0, task.delivery.state, task.delivery.generation, task.result?.turnId ?? null, task.createdAt, task.updatedAt);
  }

  private indexTurn(taskId: string, childTurnId: string): void {
    this.indexTask(taskId);
    this.database.prepare("INSERT INTO delegated_task_turns (child_turn_id, task_id) VALUES (?, ?) ON CONFLICT(child_turn_id) DO NOTHING")
      .run(childTurnId, taskId);
    if (this.reads.taskForChildTurn(childTurnId) !== taskId) {
      throw new DelegationError("conflict", "That turn already belongs to another delegated task.");
    }
  }

  private transaction<T>(body: () => T): T {
    return this.database.transaction(body).immediate();
  }
}
