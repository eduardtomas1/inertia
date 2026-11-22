import type Database from "better-sqlite3";

import {
  delegatedTaskSchema,
  delegationMailboxSchema,
  MAX_DELEGATED_FAILURE_SUMMARY_CHARS,
  MAX_DELEGATED_TASK_SUMMARIES,
  type ConversationDelegation,
  type DelegatedTask,
  type DelegatedTaskResultStatus,
  type DelegatedTaskResultView,
  type DelegatedTaskStatus,
  type DelegatedTaskSummary,
  type DelegatedWorkState,
  type DelegationMailbox,
} from "../../shared/orchestration-delegation";
import { isAgentTurnTerminalStatus, type AgentTurnStatus } from "../../shared/turn-lifecycle";
import { orchestrationProviderStopReasonSchema } from "../../shared/orchestration-v2";
import { liveNativeChildCount } from "../persistence/observed-child-repository";
import { MESSAGE_PROJECTION_COLUMNS } from "../persistence/stream-text-storage";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";
import { DELEGATED_TASK_PROJECTION, DELEGATION_MAILBOX_PROJECTION } from "./delegation-projector";
import { delegatedResultPreview, delegatedResultText } from "./delegation-text";
import { commandFingerprint } from "./json";

/** Live provider-managed agents in any of the given turns of a conversation. */
export type LiveNativeChildren = (conversationId: string, turnIds: readonly string[]) => number;

export interface DelegationTurnRow {
  id: string;
  run_id: string;
  conversation_id: string;
  status: AgentTurnStatus;
  terminal_reason: string | null;
  terminal_assistant_message_id: string | null;
  started_at: string | null;
}

export interface DelegatedWorkEvaluation {
  workState: DelegatedWorkState;
  hasPendingChildTurns: boolean;
  resultTurn: DelegationTurnRow | null;
  latestTurn: DelegationTurnRow | null;
  latestTerminalTurn: DelegationTurnRow | null;
}

export interface DelegatedTaskOutcome {
  turnId: string;
  runId: string;
  status: DelegatedTaskResultStatus;
  messageId: string | null;
  failureSummary: string | null;
}

const FAILURE_LABELS: Record<string, string> = {
  "provider-error": "the provider reported an error",
  "provider-process-exit": "the provider process exited",
  "provider-process-crash": "the provider process crashed",
  "turn-timeout": "the turn timed out",
  "turn-start-failed": "the turn could not start",
};

const TERMINAL = "('completed','failed','cancelled','interrupted')";
const RESULT_CANDIDATES = 64;
const NOT_ROLLED_BACK = `NOT EXISTS (SELECT 1 FROM orchestration_v2_entities AS rollback
  WHERE rollback.kind = 'rolled-back-turn' AND rollback.id = turn.id)`;
const NOT_WATCHER_WAKE = "NOT EXISTS (SELECT 1 FROM watcher_wakes AS wake WHERE wake.watcher_turn_id = turn.id)";
const BY_END = "ORDER BY turn.completed_at DESC, turn.requested_at DESC, turn.id DESC";
const TURN_COLUMNS = "turn.id, turn.run_id, turn.conversation_id, turn.status, turn.terminal_reason, turn.terminal_assistant_message_id, turn.started_at";
const NATIVE_CHILD_TURNS = 64;
const UNATTACHED = "NOT EXISTS (SELECT 1 FROM delegated_task_turns AS attached WHERE attached.child_turn_id = turn.id)";
/**
 * A delegated-completion wake whose delivered tasks all started from turns attached to a task matching `owner`
 * (`= ?` or `<> ?`). Wakes admitted while a follow-up is open are attached to it; this places wakes an older
 * version left unattached, one level deep, as T3's `delegatedTaskRuns` places untagged wake runs.
 */
const wakeOfTasks = (owner: "= ?" | "<> ?") => `EXISTS (SELECT 1 FROM messages AS wake
    WHERE wake.id = turn.user_message_id AND wake.delegated_completion_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(wake.delegated_completion_json, '$.taskIds') AS item
        WHERE NOT EXISTS (SELECT 1 FROM delegated_tasks AS delivered
          JOIN delegated_task_turns AS source ON source.child_turn_id = delivered.source_turn_id
          WHERE delivered.task_id = item.value AND source.task_id ${owner})))`;
export const UNRESOLVED_TASK_SQL = `(status = 'running' OR delivery_state IN ('pending','claimed')
  OR (delivery_state IS NULL AND wake_armed = 1 AND completion_wake <> 'never'))`;

export function defaultLiveNativeChildren(database: Database.Database): LiveNativeChildren {
  return (conversationId, turnIds) => liveNativeChildCount(database, conversationId, turnIds);
}

export class DelegationReads {
  constructor(private readonly database: Database.Database, private liveNativeChildren: LiveNativeChildren) {}

  useLiveNativeChildren(source: LiveNativeChildren): void {
    this.liveNativeChildren = source;
  }

  task(taskId: string): DelegatedTask | null {
    const row = this.database.prepare("SELECT payload_json FROM orchestration_v2_entities WHERE kind = ? AND id = ?")
      .get(DELEGATED_TASK_PROJECTION, taskId) as { payload_json: string } | undefined;
    return row ? delegatedTaskSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  mailbox(parentConversationId: string): DelegationMailbox | null {
    const row = this.database.prepare("SELECT payload_json FROM orchestration_v2_entities WHERE kind = ? AND id = ?")
      .get(DELEGATION_MAILBOX_PROJECTION, parentConversationId) as { payload_json: string } | undefined;
    return row ? delegationMailboxSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  taskIds(where: string, ...parameters: (string | number)[]): string[] {
    return (this.database.prepare(`SELECT task_id FROM delegated_tasks WHERE ${where} ORDER BY created_at, task_id LIMIT 1024`)
      .all(...parameters) as { task_id: string }[]).map(({ task_id }) => task_id);
  }

  tasks(where: string, ...parameters: (string | number)[]): DelegatedTask[] {
    return this.taskIds(where, ...parameters).flatMap((taskId) => {
      const task = this.task(taskId);
      return task ? [task] : [];
    });
  }

  taskForChildTurn(childTurnId: string): string | null {
    return (this.database.prepare("SELECT task_id FROM delegated_task_turns WHERE child_turn_id = ?")
      .get(childTurnId) as { task_id: string } | undefined)?.task_id ?? null;
  }

  unresolvedTaskForChild(childConversationId: string): DelegatedTask | null {
    return this.tasks("child_conversation_id = ? AND status = 'running'", childConversationId).at(-1) ?? null;
  }

  turn(turnId: string): DelegationTurnRow | null {
    return this.database.prepare(`SELECT ${TURN_COLUMNS} FROM agent_turns AS turn WHERE turn.id = ?`)
      .get(turnId) as DelegationTurnRow | undefined ?? null;
  }

  latestTurn(conversationId: string): DelegationTurnRow | null {
    return this.database.prepare(`SELECT ${TURN_COLUMNS} FROM agent_turns AS turn WHERE turn.conversation_id = ?
      ORDER BY turn.requested_at DESC, turn.id DESC LIMIT 1`).get(conversationId) as DelegationTurnRow | undefined ?? null;
  }

  activeTurnId(conversationId: string): string | null {
    const latest = this.latestTurn(conversationId);
    return latest && !isAgentTurnTerminalStatus(latest.status) ? latest.id : null;
  }

  archived(conversationId: string): boolean | null {
    const row = this.database.prepare("SELECT archived_at FROM conversations WHERE id = ?")
      .get(conversationId) as { archived_at: string | null } | undefined;
    return row ? row.archived_at !== null : null;
  }

  /**
   * Whether `turn` is one of the task's own turns, as SQL over the alias `turn`. A follow-up owns the turns attached
   * to it (its sends and steers, and the wakes admitted while it is open) and an unattached wake of its own tasks. An
   * original task owns every other turn of its chat: not attached to another task, and not an unattached wake of
   * another task's tasks. So no turn has two owners.
   */
  private ownTurn(task: DelegatedTask): { sql: string; parameters: string[] } {
    return task.kind === "original"
      ? { sql: `(NOT EXISTS (SELECT 1 FROM delegated_task_turns AS other WHERE other.child_turn_id = turn.id
          AND other.task_id <> ?) AND NOT (${UNATTACHED} AND ${wakeOfTasks("<> ?")}))`,
        parameters: [task.taskId, task.taskId] }
      : { sql: `(EXISTS (SELECT 1 FROM delegated_task_turns AS attached WHERE attached.child_turn_id = turn.id
          AND attached.task_id = ?) OR (${UNATTACHED} AND ${wakeOfTasks("= ?")}))`,
        parameters: [task.taskId, task.taskId] };
  }

  /** Whether the turn is one of the task's own turns (`ownTurn`). */
  ownsTurn(task: DelegatedTask, turnId: string): boolean {
    const own = this.ownTurn(task);
    return this.database.prepare(`SELECT 1 FROM agent_turns AS turn WHERE turn.id = ? AND turn.conversation_id = ?
      AND ${own.sql}`).get(turnId, task.childConversationId, ...own.parameters) !== undefined;
  }

  evaluate(task: DelegatedTask): DelegatedWorkEvaluation {
    const child = task.childConversationId;
    const own = this.ownTurn(task);
    const taskTurns = `FROM agent_turns AS turn WHERE turn.conversation_id = ? AND ${own.sql}`;
    const parameters = [child, ...own.parameters];
    const latestTurn = this.database.prepare(`SELECT ${TURN_COLUMNS} ${taskTurns}
      ORDER BY turn.requested_at DESC, turn.id DESC LIMIT 1`).get(...parameters) as DelegationTurnRow | undefined ?? null;
    const latestTerminalTurn = this.database.prepare(`SELECT ${TURN_COLUMNS} ${taskTurns} AND turn.status IN ${TERMINAL}
      AND ${NOT_ROLLED_BACK} ${BY_END} LIMIT 1`).get(...parameters) as DelegationTurnRow | undefined ?? null;
    const pending = this.database.prepare(`SELECT 1 ${taskTurns} AND turn.status NOT IN ${TERMINAL} AND ${NOT_WATCHER_WAKE}
      LIMIT 1`).get(...parameters) !== undefined;
    const resultTurn = (this.database.prepare(`SELECT ${TURN_COLUMNS} ${taskTurns} AND turn.status IN ${TERMINAL}
      AND ${NOT_ROLLED_BACK} AND ${NOT_WATCHER_WAKE} ${BY_END} LIMIT ${RESULT_CANDIDATES}`).all(...parameters) as DelegationTurnRow[])
      .find((turn) => turn.id === task.firstChildTurnId || this.startCrossed(turn)) ?? null;
    const evaluation = (workState: DelegatedWorkState): DelegatedWorkEvaluation =>
      ({ workState, hasPendingChildTurns: pending, resultTurn, latestTurn, latestTerminalTurn });
    const continuation = this.database.prepare(`SELECT 1 FROM restart_continuation_plans AS plan
      JOIN agent_turns AS turn ON turn.id = plan.interrupted_turn_id
      WHERE plan.conversation_id = ? AND plan.state IN ('waiting','dispatching') AND turn.conversation_id = ? AND ${own.sql}
      LIMIT 1`).get(child, child, ...own.parameters) !== undefined;
    if (pending || !resultTurn || continuation || this.limitResetHeld(child, latestTurn)) {
      return evaluation("working");
    }
    // Only work the task's own turns started holds it (T3 b79d277cd): native children of its turns (the newest 64)
    // and tasks delegated from its turns. A follow-up does not wait on what the original or the user started.
    const ownTurnIds = (this.database.prepare(`SELECT turn.id ${taskTurns} ORDER BY turn.requested_at DESC, turn.id DESC
      LIMIT ${NATIVE_CHILD_TURNS}`).all(...parameters) as { id: string }[]).map(({ id }) => id);
    if (this.liveNativeChildren(child, ownTurnIds) > 0
      || this.database.prepare(`SELECT 1 FROM delegated_tasks WHERE parent_conversation_id = ? AND ${UNRESOLVED_TASK_SQL}
        AND source_turn_id IN (SELECT turn.id ${taskTurns}) LIMIT 1`).get(child, ...parameters) !== undefined) {
      return evaluation("waiting_for_children");
    }
    return evaluation("result_available");
  }

  workState(task: DelegatedTask): DelegatedWorkState {
    return task.result ? "result_available" : this.evaluate(task).workState;
  }

  outcomeFromTurn(turn: DelegationTurnRow): DelegatedTaskOutcome | null {
    if (!isAgentTurnTerminalStatus(turn.status)) return null;
    const failureKind = turn.status === "failed" ? (this.database.prepare("SELECT failure_kind FROM turn_failure_kinds WHERE turn_id = ?")
      .get(turn.id) as { failure_kind: string } | undefined)?.failure_kind ?? null : null;
    return { turnId: turn.id, runId: turn.run_id, status: turn.status as DelegatedTaskResultStatus,
      messageId: turn.terminal_assistant_message_id, failureSummary: failureSummary(turn, failureKind) };
  }

  outcome(task: DelegatedTask, evaluation?: DelegatedWorkEvaluation): DelegatedTaskOutcome | null {
    if (task.result) {
      const { turnId, runId, status, messageId, failureSummary: summary } = task.result;
      return { turnId, runId, status, messageId, failureSummary: summary };
    }
    const evaluated = evaluation ?? this.evaluate(task);
    if (evaluated.workState !== "result_available" || !evaluated.resultTurn) return null;
    const outcome = this.outcomeFromTurn(evaluated.resultTurn);
    // T3 looks back only when no provider stop reason explains the silent turn (`c440fd19d`).
    if (outcome?.status !== "completed" || outcome.messageId !== null || this.providerStopReason(outcome.runId) !== null) {
      return outcome;
    }
    return { ...outcome, messageId: this.earlierReport(task, evaluated.resultTurn) };
  }

  /**
   * Why the provider itself stopped the run (T3 `subagentStopNotice`): a Codex hook stop recorded on a completed,
   * cancelled or interrupted V2 run. Null for any other run, and for runs settled before reasons were recorded.
   */
  providerStopReason(runId: string): string | null {
    const row = this.database.prepare(`SELECT json_extract(payload_json, '$.providerStopReason') AS reason
      FROM orchestration_v2_entities WHERE kind = 'run' AND id = ? AND json_extract(payload_json, '$.status') <> 'failed'`)
      .get(runId) as { reason: unknown } | undefined;
    const reason = orchestrationProviderStopReasonSchema.safeParse(row?.reason);
    return reason.success ? reason.data : null;
  }

  /**
   * The report of a result turn that completed without assistant text (T3 `delegatedTaskReportRuns`): the newest
   * assistant message among the task's earlier completed turns, by end time. Watcher wakes and rolled-back turns are
   * left out of the 64 candidates, and turns that never started are skipped. The search ends at a turn that did not
   * complete or is not the task's own (`ownTurn`); for a follow-up, a user's own message in the chat is not.
   */
  private earlierReport(task: DelegatedTask, result: DelegationTurnRow): string | null {
    const own = this.ownTurn(task);
    const rows = this.database.prepare(`SELECT ${TURN_COLUMNS}, ${own.sql} AS own_turn
      FROM agent_turns AS turn
      WHERE turn.conversation_id = ? AND ${NOT_WATCHER_WAKE} AND ${NOT_ROLLED_BACK}
        AND (turn.completed_at, turn.requested_at, turn.id) < (SELECT completed_at, requested_at, id FROM agent_turns WHERE id = ?)
      ${BY_END} LIMIT ${RESULT_CANDIDATES}`).all(...own.parameters, result.conversation_id, result.id) as
      (DelegationTurnRow & { own_turn: number })[];
    for (const turn of rows) {
      if (!this.startCrossed(turn)) continue;
      if (!turn.own_turn || turn.status !== "completed") return null;
      if (turn.terminal_assistant_message_id !== null) return turn.terminal_assistant_message_id;
    }
    return null;
  }

  resultView(task: DelegatedTask): DelegatedTaskResultView | null {
    return task.result ? this.outcomeView(task.result) : null;
  }

  outcomeView(outcome: Pick<DelegatedTaskOutcome, "turnId" | "runId" | "status" | "messageId" | "failureSummary">):
    DelegatedTaskResultView {
    const message = outcome.messageId ? this.messageContent(outcome.messageId) : null;
    const text = [outcome.status === "failed" ? outcome.failureSummary : null, message]
      .filter((part): part is string => Boolean(part?.trim())).join("\n\n");
    // Every result of a run its provider stopped ends with the reason, with or without report text (T3 `c440fd19d`).
    const bounded = delegatedResultText(text || null, outcome.status === "failed" ? null : this.providerStopReason(outcome.runId));
    return { turnId: outcome.turnId, status: outcome.status, ...bounded };
  }

  cleanup(runId: string): "not-started" | "pending" | "confirmed" | "unconfirmed" {
    const row = this.database.prepare(`SELECT json_extract(attempt.payload_json, '$.cleanup') AS cleanup
      FROM orchestration_v2_entities AS run JOIN orchestration_v2_entities AS attempt
        ON attempt.kind = 'attempt' AND attempt.id = json_extract(run.payload_json, '$.attemptId')
      WHERE run.kind = 'run' AND run.id = ?`).get(runId) as { cleanup: string } | undefined;
    return (["pending", "confirmed", "unconfirmed"] as const).find((state) => state === row?.cleanup) ?? "not-started";
  }

  startCrossed(turn: DelegationTurnRow): boolean {
    const row = this.database.prepare("SELECT attempts FROM orchestration_v2_effects WHERE id = ?")
      .get(`start:${commandFingerprint(turn.run_id)}`) as { attempts: number } | undefined;
    return row ? row.attempts > 0 : turn.started_at !== null;
  }

  wakeTurnId(parentConversationId: string, generation: number): string | null {
    const message = this.database.prepare(`SELECT turn_id FROM messages WHERE conversation_id = ? AND turn_id IS NOT NULL
      AND delegated_completion_json IS NOT NULL AND json_extract(delegated_completion_json, '$.generation') = ?
      ORDER BY created_at DESC LIMIT 1`).get(parentConversationId, generation) as { turn_id: string } | undefined;
    if (message) return message.turn_id;
    return (this.database.prepare(`SELECT turn_id FROM queued_messages WHERE conversation_id = ? AND turn_id IS NOT NULL
      AND delegated_completion_json IS NOT NULL AND json_extract(delegated_completion_json, '$.generation') = ?`)
      .get(parentConversationId, generation) as { turn_id: string } | undefined)?.turn_id ?? null;
  }

  wakeGeneration(parentConversationId: string, turn: DelegationTurnRow): number | null {
    const row = this.database.prepare(`SELECT json_extract(message.delegated_completion_json, '$.generation') AS generation
      FROM agent_turns AS turn JOIN messages AS message ON message.id = turn.user_message_id
      WHERE turn.id = ? AND turn.conversation_id = ? AND message.delegated_completion_json IS NOT NULL`)
      .get(turn.id, parentConversationId) as { generation: number } | undefined;
    if (row) return row.generation;
    return (this.database.prepare(`SELECT json_extract(delegated_completion_json, '$.generation') AS generation
      FROM queued_messages WHERE conversation_id = ? AND turn_id = ? AND delegated_completion_json IS NOT NULL`)
      .get(parentConversationId, turn.id) as { generation: number } | undefined)?.generation ?? null;
  }

  cohort(sourceTurnIds: readonly string[]): { total: number } {
    const row = this.database.prepare(`SELECT COUNT(*) AS total FROM delegated_tasks
      WHERE source_turn_id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(sourceTurnIds)) as { total: number };
    return { total: row.total };
  }

  detail(conversationId: string): ConversationDelegation | null {
    const total = (this.database.prepare("SELECT COUNT(*) AS count FROM delegated_tasks WHERE parent_conversation_id = ?")
      .get(conversationId) as { count: number }).count;
    const newest = (this.database.prepare(`SELECT task_id FROM delegated_tasks WHERE parent_conversation_id = ?
      ORDER BY created_at DESC, task_id DESC LIMIT ?`).all(conversationId, MAX_DELEGATED_TASK_SUMMARIES) as { task_id: string }[])
      .flatMap(({ task_id }) => {
        const task = this.task(task_id);
        return task ? [this.summary(task)] : [];
      });
    const mailbox = this.mailbox(conversationId);
    const asChild = this.tasks("child_conversation_id = ?", conversationId).sort((left, right) =>
      Number(left.status === "running") - Number(right.status === "running") || left.createdAt.localeCompare(right.createdAt, "en")).at(-1);
    if (!total && !asChild) return null;
    const child = asChild ? this.derived(asChild) : null;
    return {
      asParent: total ? { tasks: newest, totalTasks: total, mailbox: mailbox
        ? { generation: mailbox.generation, phase: mailbox.phase, taskIds: [...mailbox.taskIds] } : null } : null,
      asChild: asChild && child ? { taskId: asChild.taskId, parentConversationId: asChild.parentConversationId,
        parentTitle: this.title(asChild.parentConversationId), status: child.status, workState: child.workState } : null,
    };
  }

  derived(task: DelegatedTask, evaluation?: DelegatedWorkEvaluation): { status: DelegatedTaskStatus; workState: DelegatedWorkState;
    outcome: DelegatedTaskOutcome | null } {
    if (task.result) return { status: task.status, workState: "result_available", outcome: this.outcome(task) };
    const evaluated = evaluation ?? this.evaluate(task);
    const outcome = this.outcome(task, evaluated);
    return { status: outcome?.status ?? task.status, workState: evaluated.workState, outcome };
  }

  private summary(task: DelegatedTask): DelegatedTaskSummary {
    const { status, workState, outcome } = this.derived(task);
    return { taskId: task.taskId, kind: task.kind, childConversationId: task.childConversationId,
      childTitle: this.title(task.childConversationId), title: task.title, role: task.role, route: task.route,
      sourceTurnId: task.sourceTurnId, status, workState,
      completionWake: task.completionWake, wakeArmed: task.wakeArmed,
      delivery: { state: task.delivery.state, generation: task.delivery.generation },
      resultTurnId: outcome?.turnId ?? null,
      resultPreview: delegatedResultPreview(outcome ? this.outcomeView(outcome).text : null),
      createdAt: task.createdAt, updatedAt: task.updatedAt };
  }

  private title(conversationId: string): string | null {
    return (this.database.prepare("SELECT title FROM conversations WHERE id = ?").get(conversationId) as
      { title: string } | undefined)?.title.slice(0, 1_000) ?? null;
  }

  private messageContent(messageId: string): string | null {
    return (this.database.prepare(`SELECT ${MESSAGE_PROJECTION_COLUMNS} FROM messages WHERE messages.id = ?`)
      .get(messageId) as { content: string } | undefined)?.content ?? null;
  }

  private limitResetHeld(conversationId: string, latest: DelegationTurnRow | null): boolean {
    if (!latest || latest.status !== "failed") return false;
    return this.database.prepare(`SELECT 1 FROM usage_limit_resume_plans AS plan
      JOIN usage_limited_turns AS limited ON limited.turn_id = plan.failed_turn_id
      WHERE plan.conversation_id = ? AND plan.failed_turn_id = ? AND plan.state IN ('waiting','dispatching')`)
      .get(conversationId, latest.id) !== undefined;
  }
}

function failureSummary(turn: DelegationTurnRow, failureKind: string | null): string | null {
  if (turn.status !== "failed") return null;
  const reason = turn.terminal_reason ? FAILURE_LABELS[turn.terminal_reason] ?? turn.terminal_reason : "it failed";
  const summary = neutralizeUntrustedAgentText(`The delegated turn failed: ${reason}${failureKind ? ` (${failureKind})` : ""}.`);
  return summary.slice(0, MAX_DELEGATED_FAILURE_SUMMARY_CHARS);
}
