import type Database from "better-sqlite3";
import { z } from "zod";

import type { AgentTurn } from "../../shared/contracts";
import {
  MAX_ROLLBACK_TURNS, historyCursorSchema, type ConversationRollbackResult, type HistoryCursor, type HistoryEvent, type HistoryRollbackPlan,
  type RollbackFiles,
} from "../../shared/orchestration-history";
import { providerBackingSchema, type OrchestrationBackingEvent, type ProviderBacking } from "../../shared/orchestration-backings";
import { nativeControlSchema, type NativeControl } from "../../shared/orchestration-native-control";
import { orchestrationIdSchema } from "../../shared/orchestration-identities";
import { orchestrationNativeBoundarySchema } from "../../shared/orchestration-native-boundary";
import { orchestrationRunSchema } from "../../shared/orchestration-v2";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { OrchestrationEventStore } from "./event-store";
import { commandFingerprint } from "./json";
import { OrchestrationConflict, type CommandSource } from "./types";

export class HistoryRollbackError extends Error {}

const rollbackReceiptSchema = z.object({
  operationId: orchestrationIdSchema.nullable(), path: z.enum(["native", "portable", "unchanged"]),
  retainedTurnId: orchestrationIdSchema.nullable(), rolledBackTurns: z.number().int().nonnegative(),
  reason: orchestrationIdSchema.nullable(), restoreFiles: z.boolean().optional(),
}).strict();
export type RollbackReceipt = z.infer<typeof rollbackReceiptSchema>;

const rollbackFilesStateSchema = z.object({
  threadId: orchestrationIdSchema, state: z.enum(["restoring", "unchanged", "restored", "refused", "failed"]),
  message: z.string().nullable(), recoveryCheckpointId: z.string().nullable(), updatedAt: z.string(),
}).strict();
type RollbackFilesState = z.infer<typeof rollbackFilesStateSchema>["state"];
const terminalTurnStatuses = "('completed','failed','cancelled','interrupted')";

export interface RollbackCommand { threadId: string; projectId: string; source: CommandSource; restoreFiles?: boolean }

export class HistoryRollbackRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore) {}

  cursor(threadId: string): HistoryCursor | null {
    const row = this.events.projection("history-cursor", threadId);
    return row ? historyCursorSchema.parse(row.value) : null;
  }

  rolledBack(turnId: string): boolean {
    return this.events.projection("rolled-back-turn", turnId) !== null;
  }

  plan(threadId: string, retainedTurnId: string | null): HistoryRollbackPlan | null {
    const boundary = retainedTurnId === null ? null : this.database.prepare(`SELECT requested_at, rowid AS position, status
      FROM agent_turns WHERE id = ? AND conversation_id = ?`).get(retainedTurnId, threadId) as
      { requested_at: string; position: number; status: AgentTurn["status"] } | undefined;
    if (retainedTurnId !== null && !boundary) throw new HistoryRollbackError("The selected turn does not belong to this chat.");
    if (boundary && !isAgentTurnTerminalStatus(boundary.status)) throw new HistoryRollbackError("Choose a finished turn.");
    if (retainedTurnId !== null && this.rolledBack(retainedTurnId)) throw new HistoryRollbackError("This turn was already rolled back.");
    const rows = this.database.prepare(`SELECT id, status FROM agent_turns WHERE conversation_id = ?
      ${boundary ? "AND (requested_at, rowid) > (?, ?)" : ""}
      AND id NOT IN (SELECT id FROM orchestration_v2_entities WHERE kind = 'rolled-back-turn' AND thread_id = ?)
      ORDER BY requested_at, rowid LIMIT ?`).all(threadId, ...(boundary ? [boundary.requested_at, boundary.position] : []),
      threadId, MAX_ROLLBACK_TURNS + 1) as { id: string; status: AgentTurn["status"] }[];
    if (rows.length > MAX_ROLLBACK_TURNS) throw new HistoryRollbackError("Choose a more recent turn to roll back to.");
    if (rows.some(({ status }) => !isAgentTurnTerminalStatus(status))) throw new HistoryRollbackError("Stop active work before rolling back.");
    return rows.length ? { retainedTurnId, rolledBackTurnIds: rows.map(({ id }) => id) } : null;
  }

  physicalHead(input: { threadId: string; providerInstanceId: string; workspaceKey: string; nativeConversationId: string }): string | null {
    const boundary = this.database.prepare(`SELECT revision, payload_json FROM orchestration_v2_entities
      WHERE kind = 'native-boundary' AND thread_id = ? AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.workspaceKey') = ? AND json_extract(payload_json, '$.nativeConversationId') = ?
      ORDER BY revision DESC LIMIT 1`).get(input.threadId, input.providerInstanceId, input.workspaceKey,
      input.nativeConversationId) as { revision: number; payload_json: string } | undefined;
    const cursorRow = this.events.projection("history-cursor", input.threadId);
    const cursor = cursorRow ? historyCursorSchema.parse(cursorRow.value) : null;
    if (cursor?.transfer === "native" && cursor.providerInstanceId === input.providerInstanceId
      && cursor.workspaceKey === input.workspaceKey && cursor.nativeConversationId === input.nativeConversationId
      && cursorRow!.revision > (boundary?.revision ?? 0)) return cursor.physicalHeadId;
    if (!boundary) return null;
    const settled = orchestrationNativeBoundarySchema.parse(JSON.parse(boundary.payload_json));
    return settled.phase === "settled" ? settled.persistedHeadId : null;
  }

  continuationFor(input: { threadId: string; providerInstanceId: string; workspaceKey: string; nativeSessionId: string }) {
    const cursor = this.cursor(input.threadId);
    if (!cursor?.continuation || cursor.transfer !== "native" || cursor.continuationState !== "pending"
      || cursor.providerInstanceId !== input.providerInstanceId || cursor.workspaceKey !== input.workspaceKey
      || cursor.continuation.nativeConversationId !== input.nativeSessionId) return null;
    return { rollbackId: cursor.rollbackId, continuation: cursor.continuation };
  }

  attach(threadId: string, projectId: string, rollbackId: string, runId: string): void {
    this.commit(threadId, projectId, { type: "history.continuation-changed", payload: { rollbackId, runId, state: "attached" } });
  }

  dispatched(runId: string): void {
    this.advance(runId, ["attached"], "dispatched");
  }

  acknowledge(runId: string): void {
    this.advance(runId, ["attached", "dispatched"], "consumed");
  }

  settleRun(turn: AgentTurn, invalidate: (backing: ProviderBacking) => void): void {
    if (!isAgentTurnTerminalStatus(turn.status)) return;
    if (turn.status === "completed") this.acknowledge(turn.runId);
    const cursor = this.advance(turn.runId, ["attached"], "pending")
      ?? this.advance(turn.runId, ["dispatched"], "uncertain");
    if (cursor?.continuationState !== "uncertain") return;
    for (const backing of this.backings(cursor.threadId)) {
      if (backing.providerInstanceId === cursor.providerInstanceId && backing.workspaceKey === cursor.workspaceKey
        && backing.nativeSessionId === cursor.nativeConversationId) invalidate(backing);
    }
  }

  recordFiles(threadId: string, projectId: string, rollbackId: string, state: RollbackFilesState, message: string | null,
    recoveryCheckpointId: string | null = null): void {
    this.commit(threadId, projectId, { type: "history.files-changed", payload: { rollbackId, state, message,
      ...(recoveryCheckpointId ? { recoveryCheckpointId } : {}) } });
  }

  workspaceActivity(threadId: string, worktreeIdentity: string, since: string): { changed: boolean; unknown: string[]; more: boolean } {
    const changed = this.database.prepare(`SELECT 1 FROM agent_turns AS turn JOIN turn_git_artifacts AS artifact
      ON artifact.turn_id = turn.id WHERE turn.conversation_id <> ? AND artifact.worktree_identity = ?
        AND (turn.completed_at IS NULL OR turn.completed_at >= ?)
        AND (artifact.files_json <> '[]' OR artifact.status <> 'ready' OR turn.status NOT IN ${terminalTurnStatuses}) LIMIT 1`)
      .get(threadId, worktreeIdentity, since) !== undefined;
    const unknown = (this.database.prepare(`SELECT DISTINCT turn.conversation_id AS id FROM agent_turns AS turn
      LEFT JOIN turn_git_artifacts AS artifact ON artifact.turn_id = turn.id
      WHERE turn.conversation_id <> ? AND (turn.completed_at IS NULL OR turn.completed_at >= ?)
        AND (turn.status NOT IN ${terminalTurnStatuses} OR (artifact.id IS NULL AND turn.started_at IS NOT NULL)
          OR (artifact.id IS NOT NULL AND artifact.worktree_identity IS NULL AND artifact.absence_reason IS NULL))
      ORDER BY turn.conversation_id LIMIT 65`).all(threadId, since) as { id: string }[]).map(({ id }) => id);
    return { changed, unknown: unknown.slice(0, 64), more: unknown.length > 64 };
  }

  replay(command: RollbackCommand): ConversationRollbackResult | null {
    const receipt = this.events.receipt(this.identity(command), command.source.command);
    if (!receipt) return null;
    const recorded = rollbackReceiptSchema.parse(receipt.result);
    if (recorded.path !== "native") return this.result(command.threadId, recorded, recorded.path, recorded.reason);
    const row = this.events.projection("native-control", recorded.operationId!);
    if (!row) throw new OrchestrationConflict("scope-conflict");
    const control = nativeControlSchema.parse(row.value);
    if (control.state === "running") throw new HistoryRollbackError("This rollback is still running.");
    if (control.state === "uncertain") throw new HistoryRollbackError("Native rollback cleanup must be confirmed before this chat can continue.");
    return this.result(command.threadId, recorded, control.state === "completed" ? "native" : "portable", control.reason);
  }

  recordUnchanged(command: RollbackCommand, retainedTurnId: string | null): ConversationRollbackResult {
    const recorded: RollbackReceipt = { operationId: null, path: "unchanged", retainedTurnId, rolledBackTurns: 0, reason: null,
      ...(command.restoreFiles ? { restoreFiles: true } : {}) };
    this.events.commit({ ...this.identity(command), command: command.source.command,
      expectedRevision: this.events.revision(command.threadId), events: [], result: recorded });
    return this.result(command.threadId, recorded, "unchanged", null);
  }

  applyPortable(command: RollbackCommand, id: string, plan: HistoryRollbackPlan, reason: string): ConversationRollbackResult {
    const recorded: RollbackReceipt = { operationId: id, path: "portable", retainedTurnId: plan.retainedTurnId,
      rolledBackTurns: plan.rolledBackTurnIds.length, reason, ...(command.restoreFiles ? { restoreFiles: true } : {}) };
    this.database.transaction(() => {
      const event: HistoryEvent = { type: "history.rolled-back", payload: { id, plan, reason } };
      this.events.commit({ ...this.identity(command), command: command.source.command,
        expectedRevision: this.events.revision(command.threadId), events: [event], result: recorded });
      this.settleBackings(command.threadId, command.projectId, plan, null);
    }).immediate();
    return this.result(command.threadId, recorded, "portable", reason);
  }

  nativeReceipt(id: string, plan: HistoryRollbackPlan, restoreFiles = false): RollbackReceipt {
    return { operationId: id, path: "native", retainedTurnId: plan.retainedTurnId, rolledBackTurns: plan.rolledBackTurnIds.length, reason: null,
      ...(restoreFiles ? { restoreFiles: true } : {}) };
  }

  identity(command: RollbackCommand) {
    return { actorId: command.source.actorId, commandId: command.source.commandId, projectId: command.projectId, threadId: command.threadId };
  }

  private result(threadId: string, recorded: RollbackReceipt, transfer: ConversationRollbackResult["transfer"],
    reason: string | null): ConversationRollbackResult {
    return { kind: "conversation.rollback", conversationId: threadId, rollbackId: recorded.operationId,
      retainedTurnId: recorded.retainedTurnId, rolledBackTurns: recorded.rolledBackTurns, transfer, reason, files: this.files(recorded) };
  }

  private files(recorded: RollbackReceipt): RollbackFiles {
    if (!recorded.restoreFiles) return { outcome: "unchanged", message: null };
    if (recorded.operationId === null) return { outcome: "unchanged", message: "No turns were rolled back, so files were left unchanged." };
    const row = this.events.projection("rollback-files", recorded.operationId);
    if (!row) return { outcome: "unchanged", message: "Files were not restored. The chat history was rolled back without them." };
    const { state, message } = rollbackFilesStateSchema.parse(row.value);
    if (state === "restoring") {
      return { outcome: "failed", message: "The file restore was interrupted before Inertia confirmed it. Review the workspace and its recovery checkpoint." };
    }
    return { outcome: state, message };
  }

  applySettled(control: NativeControl, state: "completed" | "portable"): void {
    if (control.request.kind !== "rollback" || !control.rollback) throw new OrchestrationConflict("scope-conflict");
    const settled = this.events.projection("native-control", control.id)?.value as NativeControl | undefined;
    this.settleBackings(control.threadId, control.projectId, control.rollback,
      state === "completed" ? { control, backing: settled!.backing! } : null);
  }

  private settleBackings(threadId: string, projectId: string, plan: HistoryRollbackPlan,
    native: { control: NativeControl; backing: NonNullable<NativeControl["backing"]> } | null): void {
    const removed = new Set((this.database.prepare(`SELECT id FROM messages WHERE conversation_id = ?
      AND turn_id IN (SELECT value FROM json_each(?))`).all(threadId, JSON.stringify(plan.rolledBackTurnIds)) as { id: string }[])
      .map(({ id }) => id));
    const turns = new Set(plan.rolledBackTurnIds);
    const source = native?.control.request.source;
    let active: ProviderBacking | undefined;
    for (const backing of this.backings(threadId)) {
      if (source && backing.status === "ready" && backing.providerInstanceId === source.identity.providerInstanceId
        && backing.workspaceKey === native!.control.sourceWorkspaceKey && backing.nativeSessionId === source.nativeConversationId) {
        active = backing;
        continue;
      }
      if (!backing.coverageComplete || turns.has(backing.lastTurnId)
        || backing.coveredItemIds.some((item) => removed.has(item))) {
        this.commit(threadId, projectId, { type: "provider.backing-invalidated", payload: { backingId: backing.id, reason: "rolled-back" } });
      }
    }
    if (native) {
      if (!active) throw new OrchestrationConflict("revision-conflict");
      const replaced = native.backing.continuation?.kind === "new-session";
      this.commit(threadId, projectId, { type: "provider.backing-rewound", payload: { rollbackId: native.control.id,
        backingId: active.id, nativeSessionId: native.backing.nativeConversationId,
        coveredItemIds: replaced ? [] : active.coveredItemIds.filter((item) => !removed.has(item)),
        coverageComplete: active.coverageComplete } });
    }
    this.database.prepare("UPDATE conversations SET provider_session_id = ? WHERE id = ? AND project_id = ?")
      .run(native?.backing.nativeConversationId ?? null, threadId, projectId);
  }

  private *backings(threadId: string): Generator<ProviderBacking> {
    let afterId = "";
    const page = this.database.prepare(`SELECT id, payload_json FROM orchestration_v2_entities WHERE kind = 'provider-backing'
      AND thread_id = ? AND id > ? AND json_extract(payload_json, '$.status') <> 'retired' ORDER BY id LIMIT 256`);
    while (true) {
      const rows = page.all(threadId, afterId) as { id: string; payload_json: string }[];
      if (!rows.length) return;
      for (const row of rows) yield providerBackingSchema.parse(JSON.parse(row.payload_json));
      afterId = rows.at(-1)!.id;
    }
  }

  private advance(runId: string, from: readonly HistoryCursor["continuationState"][], state: "pending" | "dispatched" | "consumed" | "uncertain") {
    const row = this.events.projection("run", runId);
    if (!row) return null;
    const run = orchestrationRunSchema.parse(row.value);
    const cursor = this.cursor(run.threadId);
    if (!cursor || cursor.runId !== runId || !from.includes(cursor.continuationState)) return null;
    this.commit(run.threadId, run.projectId, { type: "history.continuation-changed",
      payload: { rollbackId: cursor.rollbackId, runId, state } });
    return this.cursor(run.threadId);
  }

  private commit(threadId: string, projectId: string, event: HistoryEvent | OrchestrationBackingEvent): void {
    const revision = this.events.revision(threadId);
    this.events.commit({ actorId: "runtime", commandId: `history:${commandFingerprint({ threadId, projectId, event, revision })}`,
      threadId, projectId, command: event, expectedRevision: revision, events: [event], result: null });
  }
}
