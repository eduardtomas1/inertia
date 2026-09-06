import type Database from "better-sqlite3";

import type { AgentTurnRow, ConversationRow } from "../../src/server/persistence/rows";
import { TranscriptRepository } from "../../src/server/persistence/transcript-repository";
import { TurnLedgerRepository } from "../../src/server/persistence/turn-ledger-repository";

/** Uses the production writers on the fixture's single transaction connection. */
export function backgroundHistoryWriters(database: Database.Database) {
  const conversation = database.prepare("SELECT * FROM conversations WHERE id = ?");
  const turn = database.prepare("SELECT * FROM agent_turns WHERE id = ?");
  const touchProject = database.prepare("UPDATE projects SET updated_at = MAX(updated_at, ?) WHERE id = ?");
  const requireConversation = (id: string): ConversationRow => {
    const row = conversation.get(id) as ConversationRow | undefined;
    if (!row) throw new Error("History fixture conversation not found.");
    return row;
  };
  const requireAgentTurn = (id: string): AgentTurnRow => {
    const row = turn.get(id) as AgentTurnRow | undefined;
    if (!row) throw new Error("History fixture turn not found.");
    return row;
  };
  const transcript: TranscriptRepository = new TranscriptRepository({
    database, requireConversation, requireAgentTurn,
    assertAgentTurnIdentity: (conversationId, runId, turnId) =>
      turns.assertIdentity(conversationId, runId, turnId),
    touchProject: (id, timestamp) => { touchProject.run(timestamp, id); },
  });
  const turns: TurnLedgerRepository = new TurnLedgerRepository({
    database, requireConversation, requireAgentTurn,
    createMessage: (...args) => transcript.createMessage(...args),
  });
  return { transcript, turns };
}
