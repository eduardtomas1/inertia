import { randomUUID } from "node:crypto";

import type {
  ChatAttachment,
  ChatMessage,
} from "../../shared/contracts";
import {
  agentTurnFromRow,
  messageFromRow,
  requireTimestamp,
} from "./codecs";
import type { PersistenceContext } from "./context";
import { RecordNotFoundError } from "./errors";
import type { MessageRow } from "./rows";
import type { CreateMessageOptions } from "./types";

type TranscriptPersistenceContext = Pick<
  PersistenceContext,
  | "assertAgentTurnIdentity"
  | "database"
  | "requireAgentTurn"
  | "requireConversation"
  | "touchProject"
>;

export class TranscriptRepository {
  constructor(private readonly context: TranscriptPersistenceContext) {}

  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"] = "user",
    attachments: ChatAttachment[] = [],
    turnId: string | null = null,
    createdAt?: string,
    options: CreateMessageOptions = {},
  ): ChatMessage {
    const conversation = this.context.requireConversation(conversationId);
    if (turnId) {
      const turn = agentTurnFromRow(this.context.requireAgentTurn(turnId));
      if (turn.conversationId !== conversationId) throw new Error("The message turn belongs to a different conversation.");
      if (role === "user" && turn.userMessageId) {
        throw new Error("Create the user message before creating its agent turn.");
      }
    }
    const now = createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(createdAt, "Message creation time");
    const message: ChatMessage = { id: randomUUID(), conversationId, turnId, role, content, attachments, createdAt: now };
    this.context.database.transaction(() => {
      this.context.database.prepare(`INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at) VALUES (@id, @conversationId, @turnId, @role, @content, @attachmentsJson, @createdAt)`).run({ ...message, attachmentsJson: JSON.stringify(attachments) });
      this.context.database.prepare(`
        UPDATE conversations
        SET updated_at = ?, settled_at = NULL,
            last_viewed_at = CASE WHEN ? = 'user' THEN ? ELSE last_viewed_at END
        WHERE id = ?
      `).run(now, role, now, conversationId);
      this.context.touchProject(conversation.project_id, now);
      if (role === "user" && options.activateConversation !== false) {
        this.context.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1")
          .run(conversation.project_id, conversationId);
      }
    })();
    return message;
  }

  /**
   * Persists a parent follow-up only after the active harness acknowledged it.
   * The turn may have settled during that acknowledgement race; retaining the
   * accepted input is more truthful than either dropping it or persisting it
   * before the harness has accepted it. Message ordering uses submission time;
   * transcript and project freshness use the later acknowledgement time.
   */
  createAcknowledgedFollowUpMessage(
    conversationId: string,
    turnId: string,
    content: string,
    createdAt?: string,
    acknowledgedAt?: string,
  ): ChatMessage {
    const conversation = this.context.requireConversation(conversationId);
    const turn = agentTurnFromRow(this.context.requireAgentTurn(turnId));
    if (turn.conversationId !== conversationId) {
      throw new Error("The follow-up turn belongs to a different conversation.");
    }
    const submittedAt = createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(createdAt, "Follow-up creation time");
    const freshnessAt = acknowledgedAt === undefined
      ? submittedAt
      : requireTimestamp(acknowledgedAt, "Follow-up acknowledgement time");
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId,
      turnId,
      role: "user",
      content,
      attachments: [],
      createdAt: submittedAt,
    };
    this.context.database.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO messages (
          id, conversation_id, turn_id, role, content,
          attachments_json, created_at
        ) VALUES (@id, @conversationId, @turnId, 'user', @content, '[]', @createdAt)
      `).run(message);
      this.context.database.prepare(`
        UPDATE conversations
        SET updated_at = MAX(updated_at, ?),
          last_viewed_at = MAX(last_viewed_at, ?)
        WHERE id = ?
      `).run(freshnessAt, freshnessAt, conversationId);
      this.context.touchProject(conversation.project_id, freshnessAt);
    })();
    return message;
  }

  associateMessageWithTurn(
    messageId: string,
    conversationId: string,
    runId: string,
    turnId: string,
  ): ChatMessage {
    const turn = this.context.assertAgentTurnIdentity(conversationId, runId, turnId);
    const row = this.context.database.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!row || row.conversation_id !== conversationId) throw new RecordNotFoundError("Message not found.");
    if (row.role === "user" && turn.userMessageId !== messageId) {
      throw new Error("The user message is owned by a different turn.");
    }
    if (row.turn_id !== null && row.turn_id !== turnId) {
      throw new Error("The message is already owned by a different turn.");
    }
    if (row.turn_id === null) {
      this.context.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turnId, messageId);
    }
    return { ...messageFromRow(row), turnId };
  }

  updateMessageContent(messageId: string, content: string): void {
    const result = this.context.database.prepare(
      "UPDATE messages SET content = ? WHERE id = ?",
    ).run(content, messageId);
    if (result.changes === 0) throw new RecordNotFoundError("Message not found.");
  }

  appendMessageContent(messageId: string, delta: string): void {
    if (!delta) return;
    const result = this.context.database.prepare(
      "UPDATE messages SET content = content || ? WHERE id = ?",
    ).run(delta, messageId);
    if (result.changes === 0) throw new RecordNotFoundError("Message not found.");
  }

  message(messageId: string): ChatMessage {
    const row = this.context.database.prepare(
      "SELECT * FROM messages WHERE id = ?",
    ).get(messageId) as MessageRow | undefined;
    if (!row) throw new RecordNotFoundError("Message not found.");
    return messageFromRow(row);
  }
}
