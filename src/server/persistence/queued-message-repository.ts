import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChatAttachment, Conversation } from "../../shared/contracts";
import { MAX_QUEUED_MESSAGES, type QueuedMessage } from "../../shared/queued-messages";
import { parseStoredAttachments, rendererSafeAttachments } from "./codecs";

interface QueueRow {
  id: string; conversation_id: string; content: string; attachments_json: string;
  intent_digest: string; route_identity: string; state: QueuedMessage["state"];
  created_at: string; error: string | null; turn_id: string | null; user_message_id: string | null;
}
function project(row: QueueRow): QueuedMessage {
  return { id: row.id, conversationId: row.conversation_id, content: row.content,
    attachments: rendererSafeAttachments(parseStoredAttachments(row.attachments_json)),
    state: row.state, createdAt: row.created_at, error: row.error,
    turnId: row.turn_id, userMessageId: row.user_message_id };
}
export function queuedRouteIdentity(conversation: Conversation): string {
  return JSON.stringify([conversation.projectId, conversation.worktreePath, conversation.providerId,
    conversation.modelSelection, conversation.model, conversation.reasoningEffort,
    conversation.interactionMode, conversation.accessMode]);
}
export function queuedIntentDigest(content: string, attachments: readonly ChatAttachment[]): string {
  return createHash("sha256").update(JSON.stringify([content.trim(), attachments.map(({ id }) => id)])).digest("hex");
}
export class QueuedMessageRepository {
  constructor(private readonly database: Database.Database) {}

  get(conversationId: string, id: string): QueuedMessage | null {
    const row = this.database.prepare("SELECT * FROM queued_messages WHERE id = ? AND conversation_id = ?")
      .get(id, conversationId) as QueueRow | undefined;
    return row ? project(row) : null;
  }
  replay(conversationId: string, id: string, digest: string): QueuedMessage | null {
    const row = this.database.prepare("SELECT * FROM queued_messages WHERE id = ?").get(id) as QueueRow | undefined;
    if (!row) return null;
    if (row.conversation_id !== conversationId || row.intent_digest !== digest) {
      throw new Error("The queued message identity was reused for a different request.");
    }
    return project(row);
  }
  list(conversationId: string): QueuedMessage[] {
    return (this.database.prepare("SELECT * FROM queued_messages WHERE conversation_id = ? AND state IN ('waiting','dispatching','blocked') ORDER BY sequence")
      .all(conversationId) as QueueRow[]).map(project);
  }
  pendingConversationIds(): string[] {
    return (this.database.prepare("SELECT DISTINCT conversation_id FROM queued_messages WHERE state = 'waiting'").all() as { conversation_id: string }[])
      .map(({ conversation_id }) => conversation_id);
  }
  add(input: { id: string; conversation: Conversation; content: string; attachments: readonly ChatAttachment[]; digest: string }): QueuedMessage {
    return this.database.transaction(() => {
      const existing = this.replay(input.conversation.id, input.id, input.digest);
      if (existing) return existing;
      if (this.list(input.conversation.id).length >= MAX_QUEUED_MESSAGES) throw new Error("This chat already has three queued messages.");
      this.database.prepare(`INSERT INTO queued_messages (id, conversation_id, content, attachments_json, intent_digest, route_identity, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`).run(input.id, input.conversation.id, input.content.trim(),
        JSON.stringify(rendererSafeAttachments(input.attachments)), input.digest, queuedRouteIdentity(input.conversation), new Date().toISOString());
      return this.get(input.conversation.id, input.id)!;
    })();
  }
  routeMatches(message: QueuedMessage, conversation: Conversation): boolean {
    const row = this.database.prepare("SELECT route_identity FROM queued_messages WHERE id = ? AND conversation_id = ?")
      .get(message.id, conversation.id) as { route_identity: string } | undefined;
    return row?.route_identity === queuedRouteIdentity(conversation);
  }
  claim(conversationId: string, id: string): boolean {
    return this.database.prepare("UPDATE queued_messages SET state = 'dispatching', error = NULL WHERE id = ? AND conversation_id = ? AND state IN ('waiting','blocked')")
      .run(id, conversationId).changes === 1;
  }
  block(conversationId: string, id: string, error: string): void {
    this.database.prepare("UPDATE queued_messages SET state = 'blocked', error = ? WHERE id = ? AND conversation_id = ? AND state IN ('waiting','dispatching','blocked')")
      .run(error.slice(0, 1000), id, conversationId);
  }
  cancel(conversationId: string, id: string): QueuedMessage | null {
    const item = this.get(conversationId, id);
    if (!item || !["waiting", "blocked"].includes(item.state)) return null;
    this.database.prepare("UPDATE queued_messages SET state = 'cancelled', content = '', attachments_json = '[]', error = NULL WHERE id = ? AND conversation_id = ?")
      .run(id, conversationId);
    return item;
  }
  reconcile(): void {
    // Provider start is downstream of the transaction that changes this row
    // to accepted. A dispatching row therefore never started a provider turn.
    this.database.prepare("UPDATE queued_messages SET state = 'waiting', error = NULL WHERE state = 'dispatching' AND turn_id IS NULL").run();
  }
  attachments(conversationId?: string): ChatAttachment[] {
    const rows = (conversationId === undefined
      ? this.database.prepare("SELECT attachments_json FROM queued_messages WHERE state IN ('waiting','dispatching','blocked')").all()
      : this.database.prepare("SELECT attachments_json FROM queued_messages WHERE conversation_id = ? AND state IN ('waiting','dispatching','blocked')").all(conversationId)) as { attachments_json: string }[];
    return rows.flatMap(({ attachments_json }) => rendererSafeAttachments(parseStoredAttachments(attachments_json)));
  }
  referencedAttachmentIds(candidateIds: readonly string[], transcriptIds: Set<string>): Set<string> {
    const candidates = new Set(candidateIds);
    if (candidates.size === 0) return transcriptIds;
    const rows = this.database.prepare(`
      SELECT attachments_json FROM queued_messages
      WHERE state IN ('waiting','dispatching','blocked') AND attachments_json <> '[]'
        AND (json_valid(attachments_json) = 0 OR EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(attachments_json) THEN attachments_json ELSE '[]' END) AS node
          WHERE node.atom IN (SELECT value FROM json_each(?))
        ))
    `).all(JSON.stringify([...candidates])) as { attachments_json: string }[];
    for (const row of rows) for (const attachment of parseStoredAttachments(row.attachments_json)) {
      if (candidates.has(attachment.id)) transcriptIds.add(attachment.id);
    }
    return transcriptIds;
  }
  excludeQueuedAttachments(candidateIds: readonly string[]): string[] {
    const queued = this.referencedAttachmentIds(candidateIds, new Set());
    return candidateIds.filter((id) => !queued.has(id));
  }
}
