import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { QueuedMessage } from "../../shared/message-queue";
import type { MessageSendAcceptance } from "../../shared/contracts/agent";

type QueueStatus = QueuedMessage["status"] | "accepted" | "removed";
interface QueueRow {
  id: string; conversation_id: string; content: string; fingerprint: string;
  status: QueueStatus; position: number; after_turn_id: string | null;
  accepted_turn_id: string | null; accepted_message_id: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}
export class MessageQueueError extends Error {}
const pending = "status NOT IN ('accepted', 'removed')";
const project = (row: QueueRow): QueuedMessage => ({
  id: row.id, conversationId: row.conversation_id, content: row.content,
  createdAt: row.created_at, status: row.status as QueuedMessage["status"],
  afterTurnId: row.after_turn_id, lastError: row.last_error,
});

export class MessageQueueRepository {
  constructor(private readonly database: Database.Database) {}

  list(conversationId: string): QueuedMessage[] {
    return (this.database.prepare(`SELECT * FROM queued_messages WHERE conversation_id = ? AND ${pending} ORDER BY position, id LIMIT 10`)
      .all(conversationId) as QueueRow[]).map(project);
  }

  conversationIds(): string[] {
    return (this.database.prepare(`SELECT DISTINCT conversation_id FROM queued_messages WHERE ${pending} LIMIT 1000`)
      .all() as Array<{ conversation_id: string }>).map((row) => row.conversation_id);
  }

  enqueue(input: { id: string; conversationId: string; content: string; afterTurnId: string | null }): void {
    this.database.transaction(() => {
      const fingerprint = createHash("sha256").update(input.conversationId).update("\0").update(input.content).digest("hex");
      const existing = this.database.prepare("SELECT * FROM queued_messages WHERE id = ?").get(input.id) as QueueRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new MessageQueueError("This queue identity already belongs to different content.");
        return; // A replay must never reopen an accepted, uncertain, or removed dispatch.
      }
      const count = this.database.prepare(`SELECT COUNT(*) AS count FROM queued_messages WHERE ${pending}`).get() as { count: number };
      if (count.count >= 1000 || this.list(input.conversationId).length >= 3) throw new MessageQueueError("The message queue is full. Remove a queued message first.");
      const last = this.database.prepare("SELECT COALESCE(MAX(position), 0) AS position FROM queued_messages WHERE conversation_id = ?").get(input.conversationId) as { position: number };
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO queued_messages (id, conversation_id, content, fingerprint, status, position, after_turn_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(input.id, input.conversationId, input.content, fingerprint, last.position + 1, input.afterTurnId, now, now);
    })();
  }

  remove(conversationId: string, id: string): void {
    const now = new Date().toISOString();
    // Removal can outrun an enqueue from another window or a lost response.
    // Keep that cancelled identity closed even when no enqueue reached us yet.
    this.database.prepare("INSERT OR IGNORE INTO queued_messages (id, conversation_id, content, fingerprint, status, position, created_at, updated_at) VALUES (?, ?, '', ?, 'removed', 0, ?, ?)")
      .run(id, conversationId, "0".repeat(64), now, now);
    const row = this.require(conversationId, id);
    if (row.status === "dispatching") throw new MessageQueueError("Wait for this queued send to settle before removing it.");
    if (row.status === "accepted" || row.status === "removed") return;
    this.database.prepare("UPDATE queued_messages SET status = 'removed', content = '', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  pause(conversationId: string, id: string, paused: boolean): void {
    const row = this.require(conversationId, id);
    if (!["queued", "paused", "rejected"].includes(row.status)) throw new MessageQueueError("This send cannot be resumed until its delivery is reconciled.");
    this.database.prepare("UPDATE queued_messages SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(paused ? "paused" : "queued", new Date().toISOString(), id);
  }

  move(conversationId: string, id: string, direction: "up" | "down"): void {
    this.database.transaction(() => {
      const rows = this.list(conversationId);
      const index = rows.findIndex((row) => row.id === id);
      const other = rows[index + (direction === "up" ? -1 : 1)];
      if (index < 0 || !other) return;
      const row = this.require(conversationId, id);
      const target = this.require(conversationId, other.id);
      if (row.status === "dispatching" || target.status === "dispatching") throw new MessageQueueError("Wait for the active queued send before reordering.");
      const update = this.database.prepare("UPDATE queued_messages SET position = ? WHERE id = ?");
      update.run(target.position, row.id); update.run(row.position, target.id);
    })();
  }

  claim(conversationId: string, id: string, manual: boolean): QueuedMessage | null {
    const row = this.require(conversationId, id);
    const allowed = manual ? ["queued", "paused", "rejected"] : ["queued"];
    if (!allowed.includes(row.status)) return null;
    this.database.prepare("UPDATE queued_messages SET status = 'dispatching', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return project(row);
  }

  accept(id: string, receipt: MessageSendAcceptance, reconciled = false): void {
    this.database.transaction(() => {
      const row = this.require(receipt.conversationId, id);
      if (row.status === "accepted") return;
      if (row.status !== "dispatching" && !(reconciled && row.status === "uncertain")) throw new MessageQueueError("The queued send no longer owns its dispatch.");
      this.database.prepare("UPDATE queued_messages SET status = 'accepted', content = '', accepted_turn_id = ?, accepted_message_id = ?, updated_at = ? WHERE id = ?")
        .run(receipt.turnId, receipt.userMessageId, new Date().toISOString(), id);
      this.database.prepare(`UPDATE queued_messages SET after_turn_id = ? WHERE conversation_id = ? AND ${pending}`)
        .run(receipt.turnId, receipt.conversationId);
    })();
  }

  fail(id: string, uncertain: boolean, message: string): void {
    this.database.prepare("UPDATE queued_messages SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'dispatching'")
      .run(uncertain ? "uncertain" : "rejected", message.slice(0, 1000), new Date().toISOString(), id);
  }

  recoverInterrupted(): void {
    this.database.prepare("UPDATE queued_messages SET status = 'uncertain', last_error = 'The runtime restarted during delivery. Check this chat before removing or sending new work.', updated_at = ? WHERE status = 'dispatching'")
      .run(new Date().toISOString());
  }

  restore(conversationId: string, message: Pick<QueuedMessage, "content" | "createdAt" | "status">): void {
    const id = randomUUID();
    this.enqueue({ id, conversationId, content: message.content, afterTurnId: null });
    const uncertain = message.status === "dispatching" || message.status === "uncertain";
    this.database.prepare("UPDATE queued_messages SET status = ?, created_at = ?, last_error = ? WHERE id = ?")
      .run(uncertain ? "uncertain" : "paused", message.createdAt,
        uncertain ? "Recovered delivery could not be confirmed. Check this chat before sending new work." : null, id);
  }

  private require(conversationId: string, id: string): QueueRow {
    const row = this.database.prepare("SELECT * FROM queued_messages WHERE conversation_id = ? AND id = ?").get(conversationId, id) as QueueRow | undefined;
    if (!row) throw new MessageQueueError("That queued message is no longer available.");
    return row;
  }
}
