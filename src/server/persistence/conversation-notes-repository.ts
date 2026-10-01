import type Database from "better-sqlite3";
import {
  conversationNoteContentSchema,
  type ConversationNote,
  type ConversationNotesResult,
} from "../../shared/conversation-notes";

/** Notes are fetched on demand, never included in shell snapshots or agent context. */
export class ConversationNotesRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly requireConversation: (id: string) => unknown,
  ) {}

  get(conversationId: string): ConversationNote {
    this.requireConversation(conversationId);
    return (this.database.prepare(`
      SELECT conversation_id AS conversationId, content, revision, updated_at AS updatedAt
      FROM conversation_notes WHERE conversation_id = ?
    `).get(conversationId) as ConversationNote | undefined)
      ?? { conversationId, content: "", revision: 0, updatedAt: null };
  }

  update(conversationId: string, content: string, expectedRevision: number): ConversationNotesResult {
    conversationNoteContentSchema.parse(content);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Invalid note revision.");
    }
    return this.database.transaction((): ConversationNotesResult => {
      const current = this.get(conversationId);
      // An acknowledged retry after a disconnect is harmless, including clearing a note.
      if (current.content === content) return { kind: "conversation.notes", outcome: "saved", note: current };
      if (current.revision !== expectedRevision) return { kind: "conversation.notes", outcome: "conflict", note: current };
      const note = { conversationId, content, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.database.prepare(`
        INSERT INTO conversation_notes (conversation_id, content, revision, updated_at)
        VALUES (@conversationId, @content, @revision, @updatedAt)
        ON CONFLICT(conversation_id) DO UPDATE SET content = excluded.content,
          revision = excluded.revision, updated_at = excluded.updated_at
      `).run(note);
      return { kind: "conversation.notes", outcome: "saved", note };
    })();
  }
}
