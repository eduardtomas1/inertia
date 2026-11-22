import type Database from "better-sqlite3";

import type { AgentTurn, ChatMessage } from "../../shared/contracts";
import { SEND_TO_USER_MAX_PER_TURN, isSendToUserContent } from "../../shared/send-to-user";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { requireTimestamp } from "./codecs";
import type { CreateMessageOptions } from "./types";

export interface CreateSentToUserMessageInput {
  conversationId: string;
  runId: string;
  turnId: string;
  content: string;
  createdAt?: string;
}

interface SentToUserStore {
  assertAgentTurnIdentity(conversationId: string, runId: string, turnId: string): AgentTurn;
  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"],
    attachments: [],
    turnId: string,
    createdAt: string,
    options: CreateMessageOptions,
  ): ChatMessage;
}

/** The exact source turn settled before the message could be stored. */
export class SentToUserTurnInactiveError extends Error {
  constructor() {
    super("The turn that sent this message is no longer active.");
    this.name = "SentToUserTurnInactiveError";
  }
}

/** The source turn already holds SEND_TO_USER_MAX_PER_TURN messages. */
export class SentToUserLimitReachedError extends Error {
  constructor() {
    super(`This turn already has ${SEND_TO_USER_MAX_PER_TURN} messages to the user.`);
    this.name = "SentToUserLimitReachedError";
  }
}

/** Stores the Markdown an agent shows the user mid-turn as turn-scoped system messages. */
export class SentToUserRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly store: SentToUserStore,
  ) {}

  create(input: CreateSentToUserMessageInput): ChatMessage {
    if (!isSendToUserContent(input.content)) throw new Error("Invalid message to the user.");
    const createdAt = input.createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(input.createdAt, "Message to the user creation time");
    return this.database.transaction((): ChatMessage => {
      const turn = this.store.assertAgentTurnIdentity(input.conversationId, input.runId, input.turnId);
      if (isAgentTurnTerminalStatus(turn.status)) throw new SentToUserTurnInactiveError();
      const { count } = this.database.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE turn_id = ? AND sent_to_user = 1",
      ).get(input.turnId) as { count: number };
      if (count >= SEND_TO_USER_MAX_PER_TURN) throw new SentToUserLimitReachedError();
      return this.store.createMessage(
        input.conversationId,
        input.content,
        "system",
        [],
        input.turnId,
        createdAt,
        { sentToUser: true, activateConversation: false },
      );
    })();
  }
}
