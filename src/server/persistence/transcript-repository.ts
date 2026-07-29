import { randomUUID } from "node:crypto";

import {
  isAgentTurnTerminalStatus,
  type ChatAttachment,
  type ChatMessage,
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

  createFollowUpMessage(
    conversationId: string,
    turnId: string,
    content: string,
    createdAt?: string,
  ): ChatMessage {
    const conversation = this.context.requireConversation(conversationId);
    const turn = agentTurnFromRow(this.context.requireAgentTurn(turnId));
    if (
      turn.conversationId !== conversationId
      || isAgentTurnTerminalStatus(turn.status)
    ) {
      throw new Error("The active turn cannot accept this follow-up.");
    }
    const now = createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(createdAt, "Follow-up creation time");
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId,
      turnId,
      role: "user",
      content,
      attachments: [],
      createdAt: now,
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
        SET updated_at = ?, settled_at = NULL, last_viewed_at = ?
        WHERE id = ?
      `).run(now, now, conversationId);
      this.context.touchProject(conversation.project_id, now);
    })();
    return message;
  }

  deleteFollowUpMessage(
    messageId: string,
    conversationId: string,
    turnId: string,
  ): boolean {
    const result = this.context.database.prepare(`
      DELETE FROM messages
      WHERE id = ? AND conversation_id = ? AND turn_id = ? AND role = 'user'
        AND id <> (
          SELECT user_message_id FROM agent_turns WHERE id = ?
        )
    `).run(messageId, conversationId, turnId, turnId);
    return result.changes > 0;
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
    const message = this.context.database.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(messageId) as { conversation_id: string } | undefined;
    if (!message) throw new RecordNotFoundError("Message not found.");
    this.context.database.transaction(() => {
      this.context.database.prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, messageId);
      this.context.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), message.conversation_id);
    })();
  }
}
