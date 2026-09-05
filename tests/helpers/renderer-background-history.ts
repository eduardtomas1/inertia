import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";

interface HistoryCounts {
  conversations: number;
  turns: number;
  activities: number;
  messages: number;
}

/** Builds synthetic persisted history before launching the measured renderer. */
export function seedBackgroundHistoryProfile(
  databasePath: string,
  workspaceDirectory: string,
  turns: number,
  mature: boolean,
): HistoryCounts & { conversationId: string } {
  // Opening RuntimeStore validates the entire existing database. Keep one
  // lifetime for the profile instead of reopening its growing history 41 times.
  const store = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    const counts = database.prepare(`SELECT
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM agent_turns) AS turns,
      (SELECT COUNT(*) FROM activities) AS activities,
      (SELECT COUNT(*) FROM messages) AS messages
    `);
    const before = counts.get() as HistoryCounts;
    const projectId = store.shellSnapshot().activeProjectId!;
    const activityBatches: Array<{
      conversationId: string; turnId: string; runId: string; index: number; count: number;
    }> = [];
    const seedHistory = (turnCount: number, name: string, activitiesPerTurn: number): string => {
      const conversation = store.createConversation(projectId, name);
      store.updateConversation(conversation.id, {
        reasoningEffort: "ultra",
        modelSelection: { ...conversation.modelSelection, reasoningEffort: "ultra" },
      });
      for (let index = 0; index < turnCount; index++) {
        const requestedAt = new Date(Date.now() - 200_000 + index * 1_000).toISOString();
        const { turn } = store.beginAgentTurn({
          id: `${conversation.id}-turn-${index}`, runId: `${conversation.id}-run-${index}`,
          conversationId: conversation.id, content: `History request ${index}`,
          providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
          model: "gpt-5.6", reasoningEffort: "ultra", interactionMode: "build", accessMode: "supervised",
          configurationRevision: 1, association: "authoritative", requestedAt,
        });
        activityBatches.push({
          conversationId: conversation.id, turnId: turn.id, runId: turn.runId,
          index, count: activitiesPerTurn,
        });
        for (let message = 0; message < 6; message++) store.createMessage(
          conversation.id, `Commentary ${index}.${message}`, "assistant", [], turn.id, requestedAt,
        );
        const answer = store.createMessage(conversation.id, `Final answer ${index}`, "assistant", [], turn.id, requestedAt);
        store.updateAgentTurnLifecycle(turn.id, {
          status: "completed", startedAt: requestedAt, completedAt: requestedAt, updatedAt: requestedAt,
          terminalAssistantMessageId: answer.id, terminalReason: "provider-completed",
        });
      }
      return conversation.id;
    };
    if (mature) for (let index = 0; index < 40; index++) {
      seedHistory(22, `Other synthetic history ${index}`, 66);
    }
    const conversationId = seedHistory(turns, "Background history fixture", 74);

    // This test measures rendering, not 67,552 individual mutation/commit
    // calls. Insert the same owned records with one prepared statement and
    // transaction. Store writes finish first: its separate connection must
    // never write while this transaction owns the database.
    const insert = database.prepare(`INSERT INTO activities
      (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at)
      VALUES (?, ?, ?, ?, 'command', ?, ?, 'completed', ?)`);
    const detail = "Synthetic bounded-history fixture. ".repeat(20);
    database.transaction(() => {
      for (const batch of activityBatches) {
        for (let activity = 0; activity < batch.count; activity++) insert.run(
          randomUUID(), batch.conversationId, batch.runId, batch.turnId,
          `Command ${batch.index}.${activity}`, detail, new Date().toISOString(),
        );
      }
    })();
    const after = counts.get() as HistoryCounts;
    return {
      conversationId,
      conversations: after.conversations - before.conversations,
      turns: after.turns - before.turns,
      activities: after.activities - before.activities,
      messages: after.messages - before.messages,
    };
  } finally {
    database?.close();
    store.close();
  }
}
