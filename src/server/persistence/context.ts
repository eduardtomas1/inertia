import type Database from "better-sqlite3";

import type {
  AgentTurn,
  ChatAttachment,
  ChatMessage,
} from "../../shared/contracts";
import type {
  AgentTurnRow,
  ConversationRow,
  ProjectRow,
  StateRow,
} from "./rows";
import type { CreateMessageOptions } from "./types";

export interface PersistenceContext {
  assertAgentTurnIdentity(
    conversationId: string,
    runId: string,
    turnId: string,
  ): AgentTurn;
  createMessage(
    conversationId: string,
    content: string,
    role?: ChatMessage["role"],
    attachments?: ChatAttachment[],
    turnId?: string | null,
    createdAt?: string,
    options?: CreateMessageOptions,
  ): ChatMessage;
  database: Database.Database;
  requireAgentTurn(turnId: string): AgentTurnRow;
  requireConversation(conversationId: string): ConversationRow;
  requireProject(projectId: string): ProjectRow;
  selectProject(projectId: string): void;
  state(): StateRow;
  touchProject(projectId: string, timestamp: string): void;
}
