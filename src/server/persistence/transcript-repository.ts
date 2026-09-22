import { readContinuationHistory } from "./continuation-history";
import type { MessageSearchTarget } from "../../shared/message-search";
import { isContextCompaction } from "../../shared/context-compaction";
import { isMessageOriginDeviceId } from "../../shared/contracts/chat-message-schema";
import { AGENT_TURN_STATUSES, isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { randomUUID } from "node:crypto";

import type {
  ChatAttachment,
  ChatMessage,
} from "../../shared/contracts";
import {
  agentTurnFromRow,
  messageFromRow,
  parseSnapshotAttachments as parseAttachments,
  rendererSafeAttachments,
  requireTimestamp,
} from "./codecs";
import type { PersistenceContext } from "./context";
import { RecordNotFoundError } from "./errors";
import type { MessageRow } from "./rows";
import {
  appendMessageContentChunks,
  MESSAGE_PROJECTION_COLUMNS,
  replaceMessageContent,
} from "./stream-text-storage";
import type { CreateMessageOptions } from "./types";

type TranscriptPersistenceContext = Pick<
  PersistenceContext,
  | "assertAgentTurnIdentity"
  | "database"
  | "requireAgentTurn"
  | "requireConversation"
  | "touchProject"
>;

function projectAttachments(
  rows: ReadonlyArray<Pick<MessageRow, "attachments_json">>,
): ChatAttachment[] {
  return rows.flatMap((row) => rendererSafeAttachments(
    parseAttachments(row.attachments_json),
  ));
}

export class TranscriptRepository {
  constructor(private readonly context: TranscriptPersistenceContext) {}

  continuationHistory(conversationId: string): ReturnType<typeof readContinuationHistory> {
    this.context.requireConversation(conversationId);
    return readContinuationHistory(this.context.database, conversationId);
  }

  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"] = "user",
    attachments: ChatAttachment[] = [],
    turnId: string | null = null,
    createdAt?: string,
    options: CreateMessageOptions = {},
  ): ChatMessage {
    return this.createMessageWithId(
      randomUUID(),
      conversationId,
      content,
      role,
      attachments,
      turnId,
      createdAt,
      options,
    );
  }

  createRecoveredMessage(
    id: string,
    conversationId: string,
    content: string,
    role: ChatMessage["role"],
    createdAt: string,
  ): ChatMessage {
    return this.createMessageWithId(
      id,
      conversationId,
      content,
      role,
      [],
      null,
      createdAt,
      { activateConversation: false },
    );
  }

  private createMessageWithId(
    id: string,
    conversationId: string,
    content: string,
    role: ChatMessage["role"],
    attachments: ChatAttachment[],
    turnId: string | null,
    createdAt: string | undefined,
    options: CreateMessageOptions,
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
    if (options.compaction && (role !== "system" || turnId !== null || !isContextCompaction(options.compaction))) throw new Error("Invalid compaction receipt.");
    if (options.privateConnectDeviceId !== undefined
      && (role !== "user" || !isMessageOriginDeviceId(options.privateConnectDeviceId))) throw new Error("Invalid remote message origin.");
    const message: ChatMessage = { id, conversationId, turnId, role, content, attachments, createdAt: now, ...(options.compaction ? { compaction: options.compaction } : {}) };
    if (options.privateConnectDeviceId !== undefined) message.privateConnectDeviceId = options.privateConnectDeviceId;
    const persistedAttachments = rendererSafeAttachments(attachments);
    this.context.database.transaction(() => {
      this.context.database.prepare(`INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at, compaction_json, private_connect_device_id) VALUES (@id, @conversationId, @turnId, @role, @content, @attachmentsJson, @createdAt, @compactionJson, @privateConnectDeviceId)`).run({ ...message, attachmentsJson: JSON.stringify(persistedAttachments), compactionJson: options.compaction ? JSON.stringify(options.compaction) : null, privateConnectDeviceId: options.privateConnectDeviceId ?? null });
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
    return {
      ...message,
      attachments: persistedAttachments,
    };
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
    attachments: readonly ChatAttachment[] = [],
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
      attachments: rendererSafeAttachments(attachments),
      createdAt: submittedAt,
    };
    this.context.database.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO messages (
          id, conversation_id, turn_id, role, content,
          attachments_json, created_at
        ) VALUES (@id, @conversationId, @turnId, 'user', @content, @attachmentsJson, @createdAt)
      `).run({
        ...message,
        attachmentsJson: JSON.stringify(message.attachments),
      });
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
    const row = this.context.database.prepare(`
      SELECT ${MESSAGE_PROJECTION_COLUMNS}
      FROM messages
      WHERE messages.id = ?
    `).get(messageId) as MessageRow | undefined;
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
    if (replaceMessageContent(this.context.database, messageId, content) === 0) {
      throw new RecordNotFoundError("Message not found.");
    }
  }

  replaceAssistantMessagesForTurnSnapshot(
    turnId: string,
    retainedMessageId: string | null,
    content: string,
  ): void {
    if (!retainedMessageId && content) {
      throw new Error("A non-empty assistant snapshot requires a message.");
    }
    this.context.database.transaction(() => {
      const turn = this.context.requireAgentTurn(turnId);
      if (retainedMessageId) {
        const retained = this.context.database.prepare(`
          SELECT id, turn_id, role
          FROM messages
          WHERE id = ?
        `).get(retainedMessageId) as Pick<
          MessageRow,
          "id" | "turn_id" | "role"
        > | undefined;
        if (
          !retained
          || retained.turn_id !== turnId
          || retained.role !== "assistant"
        ) {
          throw new Error(
            "The retained assistant message does not belong to this turn.",
          );
        }
        if (replaceMessageContent(
          this.context.database,
          retainedMessageId,
          content,
        ) !== 1) {
          throw new RecordNotFoundError("Message not found.");
        }
      }
      this.context.database.prepare(`
        DELETE FROM messages
        WHERE conversation_id = ? AND turn_id = ?
          AND role = 'assistant'
          AND (? IS NULL OR id <> ?)
      `).run(turn.conversation_id, turnId, retainedMessageId, retainedMessageId);
    })();
  }

  appendMessageContent(messageId: string, delta: string): void {
    if (!delta) return;
    if (!appendMessageContentChunks(this.context.database, messageId, delta)) {
      throw new RecordNotFoundError("Message not found.");
    }
  }

  attachments(conversationId?: string): ChatAttachment[] {
    const rows = (conversationId === undefined
      ? this.context.database.prepare(`
          SELECT messages.attachments_json
          FROM messages
          ORDER BY messages.created_at ASC, messages.id ASC
        `).all()
      : this.context.database.prepare(`
          SELECT messages.attachments_json
          FROM messages
          WHERE messages.conversation_id = ?
          ORDER BY messages.created_at ASC, messages.id ASC
        `).all(conversationId)) as Array<Pick<MessageRow, "attachments_json">>;
    return projectAttachments(rows);
  }

  evictableAttachmentIds(): string[] {
    const rows = this.context.database.prepare(`
      SELECT messages.attachments_json, EXISTS (
        SELECT 1 FROM agent_turns
        WHERE (agent_turns.id = messages.turn_id OR agent_turns.user_message_id = messages.id)
          AND agent_turns.status IN (SELECT value FROM json_each(?))
      ) AS active
      FROM messages
      WHERE messages.attachments_json <> '[]'
      ORDER BY messages.created_at ASC, messages.id ASC
    `).all(JSON.stringify(AGENT_TURN_STATUSES.filter((status) => !isAgentTurnTerminalStatus(status)))) as Array<
      Pick<MessageRow, "attachments_json"> & { active: number }>;
    const active = new Set(projectAttachments(rows.filter((row) => row.active === 1)).map(({ id }) => id));
    return [...new Set(projectAttachments(rows).map(({ id }) => id))].filter((id) => !active.has(id));
  }

  referencedAttachmentIds(candidateIds: readonly string[]): Set<string> {
    const candidates = new Set(candidateIds);
    if (candidates.size === 0) return new Set();
    const rows = this.context.database.prepare(`
      SELECT messages.attachments_json
      FROM messages
      WHERE messages.attachments_json <> '[]'
        AND (
          json_valid(messages.attachments_json) = 0
          OR EXISTS (
            SELECT 1
            FROM json_tree(CASE
              WHEN json_valid(messages.attachments_json)
                THEN messages.attachments_json
              ELSE '[]'
            END) AS node
            WHERE node.atom IN (SELECT value FROM json_each(?))
          )
        )
    `).all(JSON.stringify([...candidates])) as Array<Pick<MessageRow, "attachments_json">>;
    return new Set(projectAttachments(rows)
      .map(({ id }) => id)
      .filter((id) => candidates.has(id)));
  }

  messageSearchTarget(messageId: string): MessageSearchTarget | null {
    // Identity-only lookup: revealing a hit must never reconstruct a transcript
    // on the runtime's main thread. Repeat the search eligibility check here.
    return this.context.database.prepare(`
      SELECT c.project_id AS projectId, m.conversation_id AS conversationId,
        m.turn_id AS turnId, m.id AS messageId
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN agent_turns t ON t.id = m.turn_id AND t.conversation_id = c.id
      WHERE m.id = ? AND c.archived_at IS NULL AND (
        m.role = 'user' OR (m.role = 'assistant' AND t.terminal_assistant_message_id = m.id)
      )
    `).get(messageId) as MessageSearchTarget | undefined ?? null;
  }

  message(messageId: string): ChatMessage {
    const row = this.context.database.prepare(`
      SELECT ${MESSAGE_PROJECTION_COLUMNS}
      FROM messages
      WHERE messages.id = ?
    `).get(messageId) as MessageRow | undefined;
    if (!row) throw new RecordNotFoundError("Message not found.");
    return messageFromRow(row);
  }
}
