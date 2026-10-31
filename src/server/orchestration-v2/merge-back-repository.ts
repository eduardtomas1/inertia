import type Database from "better-sqlite3";

import type { AgentTurn, Conversation } from "../../shared/contracts";
import { MAX_CONVERSATION_CONTEXT_MESSAGES, MAX_CONVERSATION_CONTEXT_SUPPLEMENT_BYTES,
  MAX_CONVERSATION_CONTEXT_SUPPLEMENT_COMMANDS, type ConversationContextSupplement } from "../../shared/conversation-context";
import { MAX_ROLLBACK_TURNS } from "../../shared/orchestration-history";
import { mergeBackSchema, type MergeBack, type MergeBackEvent, type MergeBackResult,
  type MergeBackSummary } from "../../shared/orchestration-merge-back";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { byteLength } from "../persistence/bounded-message-text";
import type { CreateConversationContextPacketInput } from "../persistence/conversation-context-packet-repository";
import { PairedLaunchRepository } from "../persistence/paired-launch-repository";
import { MAX_PROVIDER_HANDOFF_FILES } from "../persistence/provider-handoff-files";
import { scrubCommandSecrets } from "../provider/command-secrets";
import { boundedSubagentText } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";
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
type WorkEntry = { turn: number; kind: "commands" | "files"; line: string };

const PENDING_STATES = ["prepared", "attached", "dispatched"] as const;
const SUMMARY_COMMAND_ROWS = 512;
const SUMMARY_LINE_CHARS = 240;
const FILE_POSITION_STRIDE = 1_048_576;
const GENERIC_COMMAND_TITLES = new Set(["Bash", "Command"]);

function summaryLine(value: string | null, scrub: (text: string) => string = (text) => text): string | null {
  const bounded = boundedSubagentText(value, 4_096);
  if (!bounded) return null;
  const text = neutralizeUntrustedAgentText(scrub(bounded).replace(/\s+/gu, " ").trim());
  if (!text) return null;
  return text.length > SUMMARY_LINE_CHARS ? `${text.slice(0, SUMMARY_LINE_CHARS - 1)}…` : text;
}

function commandLine(title: string, detail: string | null): string | null {
  const section = /^Command:\n([^\n]+)/u.exec(detail ?? "")?.[1];
  return summaryLine(section ?? (GENERIC_COMMAND_TITLES.has(title) ? null : title), scrubCommandSecrets);
}

function workSupplement(entries: readonly WorkEntry[], commandCount: number, fileCount: number):
  ConversationContextSupplement | undefined {
  const lines = { commands: [] as string[], files: [] as string[] };
  const limits = { commands: MAX_CONVERSATION_CONTEXT_SUPPLEMENT_COMMANDS, files: MAX_PROVIDER_HANDOFF_FILES };
  const build = (omittedCommands: number, omittedFiles: number): ConversationContextSupplement => ({
    ...(lines.files.length ? { files: [...lines.files] } : {}), ...(omittedFiles > 0 ? { omittedFiles } : {}),
    ...(lines.commands.length ? { commands: [...lines.commands] } : {}), ...(omittedCommands > 0 ? { omittedCommands } : {}),
  });
  for (const { kind, line } of entries) {
    if (lines[kind].length >= limits[kind]) continue;
    lines[kind].push(line);
    if (byteLength(JSON.stringify(build(commandCount, fileCount))) <= MAX_CONVERSATION_CONTEXT_SUPPLEMENT_BYTES) continue;
    lines[kind].pop();
    break;
  }
  const supplement = build(commandCount - lines.commands.length, fileCount - lines.files.length);
  return Object.keys(supplement).length ? supplement : undefined;
}

export class MergeBackRepository {
  private readonly duos: PairedLaunchRepository;

  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore,
    private readonly forks: ForkRepository, private readonly history: HistoryRollbackRepository,
    private readonly access: MergeBackAccess) {
    this.duos = new PairedLaunchRepository(database);
  }

  get(id: string): MergeBack | null {
    const row = this.events.projection("merge-back", id);
    return row ? mergeBackSchema.parse(row.value) : null;
  }

  prepare(forkThreadId: string, source: CommandSource, requestedThroughTurnId: string | null = null): MergeBackResult {
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
      if ([fork.id, parent.id].some((conversationId) => this.duoUnsettled(conversationId))) {
        throw new MergeBackError("This fork or its source chat belongs to a Duo that is still running or needs attention. Let its chats finish or stop them, or resolve it from the Duo dialog, then merge back again.");
      }
      this.assertNoOtherFork(fork.id, parent.id);
      if (this.pairState(fork.id, parent.id, ["attached", "dispatched"])) {
        throw new MergeBackError("A merge-back from this fork is still being delivered. Wait for that turn to finish.");
      }
      const baseTurnId = this.lastDelivered(fork.id, parent.id)?.throughTurnId ?? null;
      const latest = this.forkTurns(fork.id, baseTurnId);
      const turnIds = requestedThroughTurnId === null ? latest
        : latest.slice(0, this.throughIndex(fork.id, latest, requestedThroughTurnId, baseTurnId) + 1);
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
      const work = this.workSummary(fork.id, turnIds);
      let packet: { id: string; messageCount: number };
      try {
        packet = this.access.contextPackets.create({ sourceConversationId: fork.id, targetConversationId: parent.id,
          sourceMessageIds: selected, note: `Merge-back from fork "${fork.title}".`,
          ...(work.supplement ? { supplement: work.supplement } : {}), acknowledgedWorkspaceDifference: false });
      } catch (error) {
        throw new MergeBackError(error instanceof Error ? error.message : "The fork's findings could not be attached.");
      }
      ensureOrchestrationThread(this.events, parent, this.access.conversationPath(parent.id));
      const timestamp = new Date().toISOString();
      const merge = mergeBackSchema.parse({ id: commandFingerprint({ namespace: "merge-back", ...identity }),
        forkThreadId: fork.id, parentThreadId: parent.id, projectId: parent.projectId, forkSourceTurnId: lineage.sourceTurnId,
        baseTurnId, throughTurnId: turnIds.at(-1), requestedThroughTurnId, turnIds, messageCount: packet.messageCount,
        omittedMessageCount: messages.length - selected.length, summary: work.summary, packetId: packet.id, state: "prepared",
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
      omittedMessageCount: merge.omittedMessageCount, turnCount: merge.turnIds.length, throughTurnId: merge.throughTurnId,
      requestedThroughTurnId: merge.requestedThroughTurnId, summary: { ...merge.summary } };
  }

  private draft(merge: MergeBack): boolean {
    try { return this.access.contextPackets.get(merge.packetId, merge.parentThreadId).consumedMessageId === null; }
    catch { return false; }
  }

  private duoUnsettled(conversationId: string): boolean {
    if (this.duos.deletionRecoveryLaunchIds({ conversationId }, 1).launchIds.length) return true;
    try { this.duos.assertConversationDeletionAllowed(conversationId); return false; }
    catch { return true; }
  }

  private assertNoOtherFork(forkThreadId: string, parentThreadId: string): void {
    const pending = this.rows(`thread_id = ? AND json_extract(payload_json, '$.forkThreadId') <> ?
      AND json_extract(payload_json, '$.state') IN (SELECT value FROM json_each(?))`,
    parentThreadId, forkThreadId, JSON.stringify(PENDING_STATES));
    for (const other of pending) {
      if (other.state !== "prepared") {
        throw new MergeBackError("Another fork's findings are still being delivered to the source chat. Wait for that turn to finish.");
      }
      if (this.draft(other)) {
        throw new MergeBackError("Another fork's findings are already waiting in the source chat. Send or remove that draft first.");
      }
      this.change(other, "withdrawn");
    }
  }

  private throughIndex(forkThreadId: string, turnIds: readonly string[], throughTurnId: string, baseTurnId: string | null): number {
    const index = turnIds.indexOf(throughTurnId);
    if (index !== -1) return index;
    const position = this.database.prepare(`SELECT status, requested_at, rowid AS position FROM agent_turns
      WHERE id = ? AND conversation_id = ?`);
    const turn = position.get(throughTurnId, forkThreadId) as
      { status: AgentTurn["status"]; requested_at: string; position: number } | undefined;
    if (!turn) throw new MergeBackError("That turn is not part of this fork.");
    if (this.history.rolledBack(throughTurnId)) {
      throw new MergeBackError("That turn was rolled back in the fork, so its findings can no longer be merged back.");
    }
    if (!isAgentTurnTerminalStatus(turn.status)) throw new MergeBackError("That turn has not finished yet.");
    const base = baseTurnId === null ? undefined
      : position.get(baseTurnId, forkThreadId) as { requested_at: string; position: number } | undefined;
    if (base && (turn.requested_at < base.requested_at
      || (turn.requested_at === base.requested_at && turn.position <= base.position))) {
      throw new MergeBackError("That turn's findings were already merged back into the source chat.");
    }
    throw new MergeBackError("Wait for the fork's earlier turns to finish before merging back through that turn.");
  }

  private workSummary(forkThreadId: string, turnIds: readonly string[]):
    { supplement: ConversationContextSupplement | undefined; summary: MergeBackSummary } {
    const delta = JSON.stringify(turnIds);
    const commandCount = (this.database.prepare(`SELECT COUNT(*) AS count FROM activities
      WHERE conversation_id = ? AND kind = 'command' AND turn_id IN (SELECT value FROM json_each(?))`)
      .get(forkThreadId, delta) as { count: number }).count;
    const commands = (this.database.prepare(`SELECT delta.key AS turn, activity.title,
      substr(activity.detail, 1, 4200) AS detail
      FROM activities AS activity JOIN json_each(?) AS delta ON delta.value = activity.turn_id
      WHERE activity.conversation_id = ? AND activity.kind = 'command'
      ORDER BY delta.key, activity.created_at, activity.rowid LIMIT ?`)
      .all(delta, forkThreadId, SUMMARY_COMMAND_ROWS) as { turn: number; title: string; detail: string | null }[])
      .flatMap(({ turn, title, detail }) => {
        const line = commandLine(title, detail);
        return line ? [{ turn, kind: "commands" as const, line }] : [];
      });
    const changed = `FROM turn_git_artifacts AS artifact JOIN json_each(?) AS delta ON delta.value = artifact.turn_id
      JOIN json_each(CASE WHEN json_valid(artifact.files_json) THEN artifact.files_json ELSE '[]' END) AS file
      WHERE artifact.conversation_id = ? AND artifact.status IN ('ready', 'partial')
        AND json_type(file.value, '$.path') = 'text'`;
    const fileCount = (this.database.prepare(`SELECT COUNT(DISTINCT json_extract(file.value, '$.path')) AS count ${changed}`)
      .get(delta, forkThreadId) as { count: number }).count;
    const files = (this.database.prepare(`SELECT json_extract(file.value, '$.path') AS changed_path,
      MIN(delta.key * ${FILE_POSITION_STRIDE} + file.key) AS position ${changed}
      GROUP BY changed_path ORDER BY position LIMIT ?`).all(delta, forkThreadId, MAX_PROVIDER_HANDOFF_FILES) as
      { changed_path: string; position: number }[]).flatMap(({ changed_path: path, position }) => {
      const line = summaryLine(path);
      return line ? [{ turn: Math.floor(position / FILE_POSITION_STRIDE), kind: "files" as const, line }] : [];
    });
    const entries = [...commands, ...files].sort((left, right) => left.turn - right.turn
      || Number(left.kind === "files") - Number(right.kind === "files"));
    const supplement = workSupplement(entries, commandCount, fileCount);
    return { supplement, summary: { commandCount, fileCount,
      truncated: (supplement?.omittedCommands ?? 0) + (supplement?.omittedFiles ?? 0) > 0 } };
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
