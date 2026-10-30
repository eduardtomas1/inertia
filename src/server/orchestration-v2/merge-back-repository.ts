import type Database from "better-sqlite3";

import type { AgentTurn, Conversation } from "../../shared/contracts";
import { MAX_CONVERSATION_CONTEXT_MESSAGES } from "../../shared/conversation-context";
import { MAX_ROLLBACK_TURNS } from "../../shared/orchestration-history";
import { mergeBackSchema, type MergeBack, type MergeBackEvent, type MergeBackResult } from "../../shared/orchestration-merge-back";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { CreateConversationContextPacketInput } from "../persistence/conversation-context-packet-repository";
import type { OrchestrationEventStore } from "./event-store";
import type { ForkRepository } from "./fork-repository";
import type { HistoryRollbackRepository } from "./history-rollback-repository";
import { commandFingerprint } from "./json";
import { ensureOrchestrationThread } from "./thread-registration";
import type { CommandSource } from "./types";

export class MergeBackError extends Error {}

export interface MergeBackAccess {
  conversation(id: string): Conversation;
  conversationPath(id: string): string;
  contextPackets: {
    create(input: CreateConversationContextPacketInput): { id: string; messageCount: number };
    get(packetId: string, targetConversationId: string): { consumedMessageId: string | null };
    deleteDraft(packetId: string, targetConversationId: string): void;
  };
}

type Lifecycle = "attached" | "dispatched";

export class MergeBackRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore,
    private readonly forks: ForkRepository, private readonly history: HistoryRollbackRepository,
    private readonly access: MergeBackAccess) {}

  get(id: string): MergeBack | null {
    const row = this.events.projection("merge-back", id);
    return row ? mergeBackSchema.parse(row.value) : null;
  }

  prepare(forkThreadId: string, source: CommandSource): MergeBackResult {
    return this.database.transaction(() => {
      const lineage = this.forks.get(forkThreadId);
      if (!lineage) throw new MergeBackError("Only a fork can merge its findings back into its source chat.");
      const fork = this.access.conversation(forkThreadId);
      let parent: Conversation;
      try { parent = this.access.conversation(lineage.parentThreadId); }
      catch { throw new MergeBackError("The fork's source chat no longer exists."); }
      if (fork.projectId !== lineage.projectId || parent.projectId !== lineage.projectId) {
        throw new MergeBackError("The fork and its source chat no longer belong to the same project.");
      }
      const identity = { actorId: source.actorId, commandId: source.commandId, projectId: parent.projectId, threadId: parent.id };
      const receipt = this.events.receipt(identity, source.command);
      if (receipt) return receipt.result as unknown as MergeBackResult;
      if (this.history.rolledBack(lineage.sourceTurnId)) {
        throw new MergeBackError("The fork's starting point was rolled back in its source chat, so its findings no longer apply there.");
      }
      if (this.pairState(fork.id, parent.id, ["attached", "dispatched"])) {
        throw new MergeBackError("A merge-back from this fork is still being delivered. Wait for that turn to finish.");
      }
      const baseTurnId = this.lastDelivered(fork.id, parent.id)?.throughTurnId ?? null;
      const turnIds = this.forkTurns(fork.id, baseTurnId);
      if (!turnIds.length) throw new MergeBackError("The fork has no finished work since its last merge-back.");
      const prepared = this.pairState(fork.id, parent.id, ["prepared"]);
      if (prepared) {
        const draft = this.draft(prepared);
        if (draft && prepared.baseTurnId === baseTurnId && prepared.throughTurnId === turnIds.at(-1)) {
          const result = this.result(prepared);
          this.events.commit({ ...identity, command: source.command, expectedRevision: this.events.revision(parent.id),
            events: [], result: { ...result } });
          return result;
        }
        if (draft) this.access.contextPackets.deleteDraft(prepared.packetId, parent.id);
        this.change(prepared, draft ? "superseded" : "withdrawn");
      }
      const messages = (this.database.prepare(`SELECT id FROM messages WHERE conversation_id = ?
        AND turn_id IN (SELECT value FROM json_each(?)) AND role IN ('user','assistant') ORDER BY created_at, rowid`)
        .all(fork.id, JSON.stringify(turnIds)) as { id: string }[]).map(({ id }) => id);
      const selected = messages.slice(-MAX_CONVERSATION_CONTEXT_MESSAGES);
      if (!selected.length) throw new MergeBackError("The fork has no shareable messages since its last merge-back.");
      let packet: { id: string; messageCount: number };
      try {
        packet = this.access.contextPackets.create({ sourceConversationId: fork.id, targetConversationId: parent.id,
          sourceMessageIds: selected, note: `Merge-back from fork "${fork.title}".`, acknowledgedWorkspaceDifference: false });
      } catch (error) {
        throw new MergeBackError(error instanceof Error ? error.message : "The fork's findings could not be attached.");
      }
      ensureOrchestrationThread(this.events, parent, this.access.conversationPath(parent.id));
      const timestamp = new Date().toISOString();
      const merge = mergeBackSchema.parse({ id: commandFingerprint({ namespace: "merge-back", ...identity }),
        forkThreadId: fork.id, parentThreadId: parent.id, projectId: parent.projectId, forkSourceTurnId: lineage.sourceTurnId,
        baseTurnId, throughTurnId: turnIds.at(-1), turnIds, messageCount: packet.messageCount,
        omittedMessageCount: messages.length - selected.length, packetId: packet.id, state: "prepared",
        runId: null, messageId: null, createdBy: "human", createdAt: timestamp, updatedAt: timestamp });
      const result = this.result(merge);
      this.events.commit({ ...identity, command: source.command, expectedRevision: this.events.revision(parent.id),
        events: [{ type: "merge-back.prepared", payload: merge }], result: { ...result } });
      return result;
    }).immediate();
  }

  assertDeliverable(threadId: string, packetIds: readonly string[]): void {
    for (const merge of this.preparedFor(threadId, packetIds)) {
      if (merge.turnIds.some((turnId) => this.history.rolledBack(turnId)) || this.history.rolledBack(merge.forkSourceTurnId)) {
        throw new MergeBackError("This merge-back includes fork work that was rolled back. Remove it and merge back again.");
      }
    }
  }

  attach(threadId: string, packetIds: readonly string[], runId: string, messageId: string): void {
    this.assertDeliverable(threadId, packetIds);
    for (const merge of this.preparedFor(threadId, packetIds)) {
      this.commit(merge, { id: merge.id, state: "attached", runId, messageId });
    }
  }

  dispatched(runId: string): void {
    for (const merge of this.forRun(runId, ["attached"])) this.change(merge, "dispatched");
  }

  acknowledge(runId: string): void {
    for (const merge of this.forRun(runId, ["attached", "dispatched"])) this.change(merge, "delivered");
  }

  settleRun(turn: AgentTurn): void {
    if (!isAgentTurnTerminalStatus(turn.status)) return;
    if (turn.status === "completed") this.acknowledge(turn.runId);
    for (const merge of this.forRun(turn.runId, ["attached", "dispatched"])) {
      this.change(merge, merge.state === "attached" ? "undelivered" : "uncertain");
    }
  }

  private result(merge: MergeBack): MergeBackResult {
    return { kind: "conversation.merge-back", forkConversationId: merge.forkThreadId, parentConversationId: merge.parentThreadId,
      mergeBackId: merge.id, packetId: merge.packetId, messageCount: merge.messageCount,
      omittedMessageCount: merge.omittedMessageCount, turnCount: merge.turnIds.length };
  }

  private draft(merge: MergeBack): boolean {
    try { return this.access.contextPackets.get(merge.packetId, merge.parentThreadId).consumedMessageId === null; }
    catch { return false; }
  }

  private lastDelivered(forkThreadId: string, parentThreadId: string): MergeBack | null {
    const row = this.database.prepare(`SELECT merge.payload_json FROM orchestration_v2_entities AS merge
      JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.id = json_extract(merge.payload_json, '$.runId')
      WHERE merge.kind = 'merge-back' AND merge.thread_id = ?
        AND json_extract(merge.payload_json, '$.forkThreadId') = ?
        AND json_extract(merge.payload_json, '$.state') = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_entities AS rollback
          WHERE rollback.kind = 'rolled-back-turn' AND rollback.id = json_extract(run.payload_json, '$.turnId'))
      ORDER BY merge.revision DESC, merge.id DESC LIMIT 1`).get(parentThreadId, forkThreadId) as { payload_json: string } | undefined;
    return row ? mergeBackSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  private forkTurns(forkThreadId: string, baseTurnId: string | null): string[] {
    const base = baseTurnId === null ? null : this.database.prepare(`SELECT requested_at, rowid AS position FROM agent_turns
      WHERE id = ? AND conversation_id = ?`).get(baseTurnId, forkThreadId) as { requested_at: string; position: number } | undefined;
    if (baseTurnId !== null && !base) throw new MergeBackError("The previous merge-back point is no longer available.");
    const rows = this.database.prepare(`SELECT id, status FROM agent_turns WHERE conversation_id = ?
      ${base ? "AND (requested_at, rowid) > (?, ?)" : ""}
      AND id NOT IN (SELECT id FROM orchestration_v2_entities WHERE kind = 'rolled-back-turn' AND thread_id = ?)
      ORDER BY requested_at, rowid LIMIT ?`).all(forkThreadId, ...(base ? [base.requested_at, base.position] : []),
      forkThreadId, MAX_ROLLBACK_TURNS) as { id: string; status: AgentTurn["status"] }[];
    const stable = rows.findIndex(({ status }) => !isAgentTurnTerminalStatus(status));
    return (stable === -1 ? rows : rows.slice(0, stable)).map(({ id }) => id);
  }

  private pairState(forkThreadId: string, parentThreadId: string, states: readonly MergeBack["state"][]): MergeBack | null {
    return this.rows(`thread_id = ? AND json_extract(payload_json, '$.forkThreadId') = ?
      AND json_extract(payload_json, '$.state') IN (SELECT value FROM json_each(?))`,
    parentThreadId, forkThreadId, JSON.stringify(states))[0] ?? null;
  }

  private preparedFor(threadId: string, packetIds: readonly string[]): MergeBack[] {
    if (!packetIds.length) return [];
    return this.rows(`thread_id = ? AND json_extract(payload_json, '$.state') = 'prepared'
      AND json_extract(payload_json, '$.packetId') IN (SELECT value FROM json_each(?))`, threadId, JSON.stringify(packetIds));
  }

  private forRun(runId: string, states: readonly Lifecycle[]): MergeBack[] {
    return this.rows(`json_extract(payload_json, '$.runId') = ? AND json_extract(payload_json, '$.state') IN (SELECT value FROM json_each(?))`,
      runId, JSON.stringify(states));
  }

  private rows(where: string, ...parameters: string[]): MergeBack[] {
    return (this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities WHERE kind = 'merge-back' AND ${where}
      ORDER BY revision DESC LIMIT 256`).all(...parameters) as { payload_json: string }[])
      .map(({ payload_json }) => mergeBackSchema.parse(JSON.parse(payload_json)));
  }

  private change(merge: MergeBack, state: MergeBack["state"]): void {
    this.commit(merge, { id: merge.id, state, runId: merge.runId, messageId: merge.messageId });
  }

  private commit(merge: MergeBack, payload: Extract<MergeBackEvent, { type: "merge-back.changed" }>["payload"]): void {
    const event = { type: "merge-back.changed", payload } as const;
    const revision = this.events.revision(merge.parentThreadId);
    this.events.commit({ actorId: "runtime", commandId: `merge-back:${commandFingerprint({ event, revision })}`,
      projectId: merge.projectId, threadId: merge.parentThreadId, command: event, expectedRevision: revision,
      events: [event], result: null });
  }
}
