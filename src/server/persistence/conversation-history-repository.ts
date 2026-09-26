import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConversationContentResult, ConversationDeferredContent, ConversationDetail, ConversationHistoryRequest } from "../../shared/contracts/conversation-detail";
import { activityFromRow, agentGoalFromRow, agentTurnFromRow, checkpointFromRow, conversationFromRow, messageFromRow, planFromRow, reasoningFromRow, subagentTraceFromRow, usageFromRow } from "./codecs";
import { turnGitArtifactFromRow } from "./git-artifact-codecs";
import { reviewNoteFromRow, reviewStateFromRow, reviewSummaryFromRow } from "./review-codecs";
import type { DiffReviewNoteRow, DiffReviewStateRow, DiffReviewSummaryRow } from "./rows";
import type { ActivityRow, AgentGoalRow, AgentPlanRow, AgentReasoningRow, AgentTurnRow, CheckpointRow, ConversationRow, MessageRow, SubagentTraceRow, ThreadUsageRow, TurnGitArtifactRow } from "./rows";

export const HISTORY_PAGE_RECORDS = 24;
export const HISTORY_PREVIEW_BYTES = 16 * 1024;
export const HISTORY_CONTENT_BYTES = 64 * 1024;
export const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const SOURCES = {
  message: "messages", activity: "activities", reasoning: "agent_reasonings",
  subagent: "subagent_traces", checkpoint: "checkpoints", turn: "agent_turns",
  plan: "agent_plans",
} as const;
type RecordKind = keyof typeof SOURCES;
type TextKind = ConversationDeferredContent["kind"];
type Key = [string, RecordKind, string];
type Watermarks = Record<RecordKind, number>;
interface HistoryCursor { type: "history"; conversationId: string; marks: Watermarks; boundary: Key; direction: "older" | "newer" }
interface ContentCursor { type: "content"; conversationId: string; kind: TextKind; id: string; offset: number; total: number; revision: number; sequence: number }
interface HistoryRecord { id: string; turn_id: string | null; created_at: string; kind: RecordKind }
interface ContentState { total: number; base: number; revision: number; sequence: number }
const keyOf = (row: HistoryRecord): Key => [row.created_at, row.kind, row.id];
const compare = (a: HistoryRecord, b: HistoryRecord): number => {
  const aa = keyOf(a); const bb = keyOf(b);
  for (let i = 0; i < aa.length; i++) { if (aa[i] < bb[i]) return -1; if (aa[i] > bb[i]) return 1; }
  return 0;
};
const placeholders = (values: readonly unknown[]): string => values.map(() => "?").join(",");
const textSource = (kind: TextKind) => kind === "activity"
  ? { table: "activities", column: "detail", chunks: null, owner: "" }
  : { table: kind === "message" ? "messages" : "agent_reasonings", column: "content", chunks: kind === "message" ? "message_content_chunks" : "reasoning_content_chunks", owner: kind === "message" ? "message_id" : "reasoning_id" };

/** SQL limits apply before materializing transcript text. Cursors live for one runtime generation. */
export class ConversationHistoryRepository {
  private readonly secret = randomBytes(32);
  private readonly metadataColumns = new Map<string, string[]>();
  constructor(private readonly database: Database.Database) {}

  private encode(value: HistoryCursor | ContentCursor): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.secret).update(payload).digest("base64url")}`;
  }

  private decode(cursor: string, conversationId: string): HistoryCursor | ContentCursor {
    if (cursor.length > 2048) throw new Error("The history cursor is invalid. Load the latest history again.");
    const [payload, signature, extra] = cursor.split(".");
    const expected = createHmac("sha256", this.secret).update(payload ?? "").digest();
    const supplied = Buffer.from(signature ?? "", "base64url");
    if (extra !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("This history cursor has expired. Load the latest history again.");
    }
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HistoryCursor | ContentCursor;
    if (value.conversationId !== conversationId) throw new Error("This history cursor belongs to another chat.");
    return value;
  }

  private marks(conversationId: string): Watermarks {
    return Object.fromEntries(Object.entries(SOURCES).map(([kind, table]) => [kind,
      (this.database.prepare(`SELECT COALESCE(MAX(rowid), 0) AS id FROM ${table} WHERE conversation_id = ?`).get(conversationId) as { id: number }).id,
    ])) as Watermarks;
  }

  private records(conversationId: string, marks: Watermarks, boundary: Key | undefined, direction: "older" | "newer", inclusive = false, limit = HISTORY_PAGE_RECORDS): HistoryRecord[] {
    const order = direction === "older" ? "DESC" : "ASC";
    const operator = direction === "older" ? (inclusive ? "<=" : "<") : ">";
    const rows = Object.entries(SOURCES).flatMap(([kind, table]) => {
      const identity = kind === "plan" ? "run_id" : "id";
      const timestamp = kind === "plan" ? "updated_at" : "created_at";
      return this.database.prepare(`
      SELECT ${identity} AS id, ${kind === "turn" ? "id" : "turn_id"} AS turn_id, ${timestamp} AS created_at, '${kind}' AS kind FROM ${table}
      WHERE conversation_id = ? AND rowid <= ?
      ${kind === "plan" ? "AND turn_id IS NULL" : ""}
      ${boundary ? `AND (${timestamp}, '${kind}', ${identity}) ${operator} (?, ?, ?)` : ""}
      ORDER BY ${timestamp} ${order}, ${identity} ${order} LIMIT ?
    `).all(conversationId, marks[kind as RecordKind], ...(boundary ?? []), limit) as HistoryRecord[];
    });
    rows.sort(compare);
    return direction === "older" ? rows.slice(-limit) : rows.slice(0, limit);
  }

  private contentState(conversationId: string, kind: TextKind, id: string): ContentState {
    const source = textSource(kind);
    const row = this.database.prepare(`SELECT COALESCE(length(CAST(${source.column} AS BLOB)), 0) AS base,
      COALESCE((SELECT revision FROM conversation_content_revisions WHERE kind = ? AND record_id = ?), 0) AS revision
      FROM ${source.table} WHERE id = ? AND conversation_id = ?`).get(kind, id, id, conversationId) as { base: number; revision: number } | undefined;
    if (!row) throw new Error("The requested text no longer exists in this chat.");
    const chunks = source.chunks ? this.database.prepare(`SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes, COALESCE(MAX(sequence), 0) AS sequence FROM ${source.chunks} WHERE ${source.owner} = ?`).get(id) as { bytes: number; sequence: number } : { bytes: 0, sequence: 0 };
    return { ...row, total: row.base + chunks.bytes, sequence: chunks.sequence };
  }

  private text(conversationId: string, kind: TextKind, id: string, state: ContentState, offset: number, length: number): string {
    const source = textSource(kind);
    const pieces: Buffer[] = [];
    let remaining = Math.min(length, state.total - offset);
    let position = 0;
    const append = (bytes: number, table: string, column: string, predicate: string, identity: string | number): void => {
      const start = Math.max(0, offset - position);
      if (remaining > 0 && start < bytes) {
        const count = Math.min(remaining, bytes - start);
        const row = this.database.prepare(`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS text FROM ${table} WHERE ${predicate} = ?`).get(start + 1, count, identity) as { text: Buffer | null };
        if (row.text) pieces.push(row.text);
        remaining -= count;
      }
      position += bytes;
    };
    append(state.base, source.table, source.column, "id", id);
    if (source.chunks && remaining > 0) {
      // Iterate lengths only; never concatenate an entire persisted transcript in SQLite or JS.
      for (const chunk of this.database.prepare(`SELECT sequence, length(CAST(content AS BLOB)) AS bytes FROM ${source.chunks} WHERE ${source.owner} = ? ORDER BY sequence`).iterate(id) as Iterable<{ sequence: number; bytes: number }>) {
        append(chunk.bytes, source.chunks, "content", "sequence", chunk.sequence);
        if (remaining === 0) break;
      }
    }
    const bytes = Buffer.concat(pieces);
    // A segment can stop inside a UTF-8 code point; keep its complete prefix.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (let trim = 0; trim <= Math.min(3, bytes.length); trim++) {
      try { return decoder.decode(bytes.subarray(0, bytes.length - trim)); } catch { /* try the previous character boundary */ }
    }
    throw new Error("The stored text could not be decoded.");
  }

  readContent(conversationId: string, cursor: string): ConversationContentResult {
    const value = this.decode(cursor, conversationId);
    if (value.type !== "content") throw new Error("Choose a text content cursor.");
    const state = this.contentState(conversationId, value.kind, value.id);
    if (state.total !== value.total || state.sequence !== value.sequence || state.revision !== value.revision) {
      throw new Error("This text has changed. Reload the history before opening it again.");
    }
    const text = this.text(conversationId, value.kind, value.id, state, value.offset, HISTORY_CONTENT_BYTES);
    const next = value.offset + Buffer.byteLength(text);
    return { kind: "conversation.content", conversationId, text, offsetBytes: value.offset, totalBytes: value.total,
      nextCursor: next < value.total ? this.encode({ ...value, offset: next }) : null };
  }

  textPreview(conversationId: string, kind: TextKind, id: string, maximumBytes: number): string {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4 || maximumBytes > 512 * 1024) throw new Error("Invalid transcript preview size.");
    const state = this.contentState(conversationId, kind, id);
    return this.text(conversationId, kind, id, state, 0, maximumBytes);
  }

  load(conversationId: string, options: ConversationHistoryRequest = {}): ConversationDetail | null {
    return this.database.transaction(() => this.loadWindow(conversationId, options))();
  }

  private loadWindow(conversationId: string, options: ConversationHistoryRequest): ConversationDetail | null {
    let metadataBytes = 0;
    const preflight = (table: string, predicate: string, parameters: (string | number)[], budgetBytes = 1024 * 1024): void => {
      let columns = this.metadataColumns.get(table);
      if (!columns) {
        columns = (this.database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[])
          .filter((column) => column.type === "TEXT"
            && !(table === "messages" && column.name === "content")
            && !(table === "agent_reasonings" && column.name === "content")
            && !(table === "activities" && column.name === "detail"))
          .map((column) => column.name);
        this.metadataColumns.set(table, columns);
      }
      const expression = columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(" + ") || "0";
      const totals = this.database.prepare(`SELECT COALESCE(SUM(${expression}), 0) AS bytes, COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get(...parameters) as { bytes: number; count: number };
      metadataBytes += totals.bytes;
      if (metadataBytes > budgetBytes || totals.count > 4096) throw new Error("This history page contains oversized metadata. Its stored content is preserved; choose another message from search.");
    };
    preflight("conversations", "id = ?", [conversationId]);
    const conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
    if (!conversation) return null;
    let marks: Watermarks; let boundary: Key | undefined; let direction: "older" | "newer" = "older";
    if (options.cursor) {
      const cursor = this.decode(options.cursor, conversationId);
      if (cursor.type !== "history") throw new Error("Choose a history page cursor.");
      ({ marks, boundary, direction } = cursor);
    } else {
      marks = this.marks(conversationId);
      if (options.anchorMessageId) {
        const anchor = this.database.prepare("SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?").get(options.anchorMessageId, conversationId) as { created_at: string } | undefined;
        if (!anchor) throw new Error("This message is no longer available in this chat.");
        boundary = [anchor.created_at, "message", options.anchorMessageId];
      }
    }
    const records = this.records(conversationId, marks, boundary, direction, Boolean(options.anchorMessageId));
    const ids = (kind: RecordKind) => records.filter((r) => r.kind === kind).map((r) => r.id);
    const turnIds = [...new Set(records.flatMap((r) => r.turn_id ? [r.turn_id] : []))];
    const byIds = <T>(table: string, recordIds: string[], columns = "*"): T[] => {
      if (!recordIds.length) return [];
      const predicate = `conversation_id = ? AND id IN (${placeholders(recordIds)})`;
      preflight(table, predicate, [conversationId, ...recordIds]);
      return this.database.prepare(`SELECT ${columns} FROM ${table} WHERE ${predicate} ORDER BY created_at, id`).all(conversationId, ...recordIds) as T[];
    };
    const turns = byIds<AgentTurnRow>("agent_turns", turnIds);
    const messageIds = [...new Set([...ids("message"), ...turns.flatMap((t) => [t.user_message_id, ...(t.terminal_assistant_message_id ? [t.terminal_assistant_message_id] : [])])])];
    const checkpointIds = [...new Set([...ids("checkpoint"), ...turns.flatMap((t) => t.checkpoint_id ? [t.checkpoint_id] : [])])];
    const deferredContent: ConversationDeferredContent[] = [];
    const preview = (kind: TextKind, id: string, label: string): string => {
      const state = this.contentState(conversationId, kind, id);
      if (state.total > HISTORY_PREVIEW_BYTES) deferredContent.push({ kind, id, label, totalBytes: state.total,
        cursor: this.encode({ type: "content", conversationId, kind, id, offset: 0, total: state.total, revision: state.revision, sequence: state.sequence }) });
      return this.text(conversationId, kind, id, state, 0, HISTORY_PREVIEW_BYTES);
    };
    const messages = byIds<MessageRow>("messages", messageIds, "id, conversation_id, turn_id, role, '' AS content, attachments_json, compaction_json, private_connect_device_id, created_at")
      .map((row) => messageFromRow({ ...row, content: preview("message", row.id, row.role === "user" ? "User message" : "Assistant message") }));
    const activities = byIds<ActivityRow>("activities", ids("activity"), "id, conversation_id, run_id, turn_id, kind, title, NULL AS detail, status, created_at")
      .map((row) => activityFromRow({ ...row, detail: preview("activity", row.id, row.title) || null }));
    const reasonings = byIds<AgentReasoningRow>("agent_reasonings", ids("reasoning"), "id, conversation_id, run_id, turn_id, '' AS content, status, created_at")
      .map((row) => reasoningFromRow({ ...row, content: preview("reasoning", row.id, "Reasoning") }));
    const forTurns = <T>(table: string): T[] => {
      const legacyPlanIds = table === "agent_plans" ? ids("plan") : [];
      if (!turnIds.length && !legacyPlanIds.length) return [];
      const alternatives = [
        ...(turnIds.length ? [`turn_id IN (${placeholders(turnIds)})`] : []),
        ...(legacyPlanIds.length ? [`(turn_id IS NULL AND run_id IN (${placeholders(legacyPlanIds)}))`] : []),
      ];
      const predicate = `conversation_id = ? AND (${alternatives.join(" OR ")})`;
      const parameters = [conversationId, ...turnIds, ...legacyPlanIds];
      preflight(table, predicate, parameters);
      return this.database.prepare(`SELECT * FROM ${table} WHERE ${predicate}`).all(...parameters) as T[];
    };
    preflight("thread_usage", "conversation_id = ?", [conversationId]);
    preflight("agent_goals", "conversation_id = ?", [conversationId]);
    const reviewRows = <T>(table: string, order: string): T[] => {
      preflight(table, "conversation_id = ?", [conversationId], HISTORY_MAX_BYTES / 2);
      return this.database.prepare(`SELECT * FROM ${table} WHERE conversation_id = ? ORDER BY ${order}`).all(conversationId) as T[];
    };
    const edgeCursor = (row: HistoryRecord | undefined, edgeDirection: "older" | "newer"): string | null => row && this.records(conversationId, marks, keyOf(row), edgeDirection, false, 1).length
      ? this.encode({ type: "history", conversationId, marks, boundary: keyOf(row), direction: edgeDirection }) : null;
    const detail: ConversationDetail = {
      conversation: conversationFromRow(conversation), agentTurns: turns.map(agentTurnFromRow),
      turnGitArtifacts: forTurns<TurnGitArtifactRow>("turn_git_artifacts").map(turnGitArtifactFromRow),
      messages, activities, reasonings,
      // Traces are turn dependencies: newer tool activity must not hide live
      // controls or sever nested-agent ancestry. forTurns preflights their size.
      subagents: forTurns<SubagentTraceRow>("subagent_traces")
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .map(subagentTraceFromRow),
      checkpoints: byIds<CheckpointRow>("checkpoints", checkpointIds).map(checkpointFromRow),
      usage: (this.database.prepare("SELECT * FROM thread_usage WHERE conversation_id = ?").all(conversationId) as ThreadUsageRow[]).map(usageFromRow),
      goals: (this.database.prepare("SELECT * FROM agent_goals WHERE conversation_id = ?").all(conversationId) as AgentGoalRow[]).map(agentGoalFromRow),
      plans: forTurns<AgentPlanRow>("agent_plans").map(planFromRow),
      // Review tools consume these current collections independently of the transcript page.
      reviewSummaries: reviewRows<DiffReviewSummaryRow>("diff_review_summaries", "generated_at").flatMap((row) => {
        const summary = reviewSummaryFromRow(row); return summary ? [summary] : [];
      }),
      reviewStates: reviewRows<DiffReviewStateRow>("diff_review_states", "updated_at").map(reviewStateFromRow),
      reviewNotes: reviewRows<DiffReviewNoteRow>("diff_review_notes", "created_at, id").map(reviewNoteFromRow),
      history: { olderCursor: edgeCursor(records[0], "older"), newerCursor: edgeCursor(records.at(-1), "newer"), recordCount: records.length },
      deferredContent,
    };
    // Defensive ceiling for legacy metadata that predates the current field bounds.
    // A failed detail response is small and keeps the socket usable.
    if (Buffer.byteLength(JSON.stringify(detail)) > HISTORY_MAX_BYTES) {
      throw new Error("This history page contains oversized metadata. Its stored content is preserved; choose another message from search or open an earlier page.");
    }
    return detail;
  }
}
