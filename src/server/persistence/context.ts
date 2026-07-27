import type Database from "better-sqlite3";

import type { AgentTurn } from "../../shared/contracts";
import type {
  AgentTurnRow,
  ConversationRow,
  ProjectRow,
  StateRow,
} from "./rows";

export interface PersistenceContext {
  assertAgentTurnIdentity(
    conversationId: string,
    runId: string,
    turnId: string,
  ): AgentTurn;
  database: Database.Database;
  requireAgentTurn(turnId: string): AgentTurnRow;
  requireConversation(conversationId: string): ConversationRow;
  requireProject(projectId: string): ProjectRow;
  selectProject(projectId: string): void;
  state(): StateRow;
  touchProject(projectId: string, timestamp: string): void;
}
