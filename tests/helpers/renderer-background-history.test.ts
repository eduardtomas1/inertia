import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { seedBackgroundHistoryProfile } from "./renderer-background-history";

describe("background renderer history fixture", () => {
  for (const fixture of [
    { turns: 2, mature: false, conversations: 1, totalTurns: 2, activities: 148, messages: 16 },
    { turns: 128, mature: true, conversations: 41, totalTurns: 1_008, activities: 67_552, messages: 8_064 },
  ]) it(`preserves the complete ${fixture.conversations}-history dataset and record ownership`,
    // Keep the full-profile bound after batching its synthetic writes. The
    // renderer's separate 300s E2E deadline and idle assertions are unchanged.
    fixture.mature ? { timeout: 90_000 } : {}, () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-background-history-"));
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    mkdirSync(workspace);
    const initial = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    let initialConversationId: string;
    try {
      const project = initial.createProject("Synthetic history project", workspace);
      initialConversationId = initial.createConversation(project.id, "Initial fixture").id;
    } finally { initial.close(); }
    try {
      // Count real SQLite commits rather than asserting a host-dependent speed.
      const probe = new Database(":memory:");
      const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Database.Statement;
      probe.close();
      const run = statementPrototype.run;
      let commits = 0;
      const runSpy = vi.spyOn(statementPrototype, "run").mockImplementation(function (
        this: Database.Statement, ...parameters: unknown[]
      ) {
        if (this.source === "COMMIT") commits++;
        return run.apply(this, parameters);
      });
      let seeded: ReturnType<typeof seedBackgroundHistoryProfile>;
      try {
        seeded = seedBackgroundHistoryProfile(databasePath, workspace, fixture.turns, fixture.mature);
      } finally { runSpy.mockRestore(); }
      // Conversation creation and fixed startup work may commit independently;
      // adding thousands of messages and activities must not add more commits.
      expect(commits).toBeLessThanOrEqual(fixture.conversations + 4);
      expect(seeded).toEqual({
        conversationId: expect.any(String), conversations: fixture.conversations,
        turns: fixture.totalTurns, activities: fixture.activities, messages: fixture.messages,
      });
      const database = new Database(databasePath, { readonly: true });
      try {
        expect(database.pragma("quick_check", { simple: true })).toBe("ok");
        expect(database.pragma("foreign_key_check")).toEqual([]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM conversations").get())
          .toEqual({ count: fixture.conversations + 1 });
        expect(database.prepare(`WITH
          turn_counts AS (SELECT conversation_id, COUNT(*) AS count FROM agent_turns GROUP BY conversation_id)
          SELECT COUNT(*) AS count FROM conversations c
          LEFT JOIN turn_counts t ON t.conversation_id = c.id
          WHERE c.id != ? AND COALESCE(t.count, 0) != CASE WHEN c.id = ? THEN ? ELSE 22 END
        `).get(initialConversationId, seeded.conversationId, fixture.turns)).toEqual({ count: 0 });
        expect(database.prepare(`SELECT COUNT(*) AS count FROM activities a
          LEFT JOIN agent_turns t ON t.id = a.turn_id
          WHERE t.id IS NULL OR t.conversation_id != a.conversation_id OR t.run_id != a.run_id
        `).get()).toEqual({ count: 0 });
        expect(database.prepare(`SELECT COUNT(*) AS count FROM messages m
          LEFT JOIN agent_turns t ON t.id = m.turn_id
          WHERE t.id IS NULL OR t.conversation_id IS NOT m.conversation_id
        `).get()).toEqual({ count: 0 });
        expect(database.prepare(`WITH
          message_counts AS (SELECT turn_id, COUNT(*) AS count FROM messages GROUP BY turn_id),
          activity_counts AS (SELECT turn_id, COUNT(*) AS count FROM activities GROUP BY turn_id)
          SELECT COUNT(*) AS count FROM agent_turns t
          LEFT JOIN message_counts m ON m.turn_id = t.id
          LEFT JOIN activity_counts a ON a.turn_id = t.id
          WHERE COALESCE(m.count, 0) != 8
            OR COALESCE(a.count, 0) != CASE WHEN t.conversation_id = ? THEN 74 ELSE 66 END
        `).get(seeded.conversationId)).toEqual({ count: 0 });
        expect(database.prepare(`SELECT COUNT(*) AS count FROM agent_turns t
          LEFT JOIN messages u ON u.id = t.user_message_id
          LEFT JOIN messages m ON m.id = t.terminal_assistant_message_id
          WHERE t.status != 'completed' OR u.id IS NULL OR u.role != 'user'
            OR m.id IS NULL OR m.role != 'assistant'
            OR u.turn_id IS NOT t.id OR m.turn_id IS NOT t.id
            OR u.conversation_id IS NOT t.conversation_id OR m.conversation_id IS NOT t.conversation_id
        `).get()).toEqual({ count: 0 });
      } finally { database.close(); }
      const reopened = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
      try {
        expect(reopened.shellSnapshot().activeConversationId).toBe(seeded.conversationId);
        expect(reopened.conversationDetail(initialConversationId)?.conversation.title).toBe("Initial fixture");
        const detail = reopened.conversationDetail(seeded.conversationId)!;
        expect(detail.conversation.title).toBe("Background history fixture");
        expect(detail.conversation.modelSelection.reasoningEffort).toBe("ultra");
        expect(detail.agentTurns).toHaveLength(fixture.turns);
        expect(detail.messages).toHaveLength(fixture.turns * 8);
        expect(detail.activities).toHaveLength(fixture.turns * 74);
        const titlesByTurn = new Map<string, string[]>();
        const invalidPayloadIds: string[] = [];
        const expectedPayload = "Synthetic bounded-history fixture. ".repeat(20);
        for (const activity of detail.activities) {
          const titles = titlesByTurn.get(activity.turnId!) ?? [];
          titles.push(activity.title);
          titlesByTurn.set(activity.turnId!, titles);
          if (activity.kind !== "command" || activity.status !== "completed" || activity.detail !== expectedPayload) {
            invalidPayloadIds.push(activity.id);
          }
        }
        expect(invalidPayloadIds).toEqual([]);
        expect(titlesByTurn.size).toBe(fixture.turns);
        for (const turn of detail.agentTurns) {
          const index = Number(turn.id.split("-turn-").at(-1));
          expect(titlesByTurn.get(turn.id)?.sort())
            .toEqual(Array.from({ length: 74 }, (_, activity) => `Command ${index}.${activity}`).sort());
        }
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
