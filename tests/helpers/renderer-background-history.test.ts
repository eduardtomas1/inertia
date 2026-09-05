import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { seedBackgroundHistoryProfile } from "./renderer-background-history";

describe("background renderer history fixture", () => {
  it.each([
    { turns: 2, mature: false, conversations: 1, totalTurns: 2, activities: 148, messages: 16 },
    { turns: 128, mature: true, conversations: 41, totalTurns: 1_008, activities: 67_552, messages: 8_064 },
  ])("preserves the complete $conversations-history dataset and record ownership", (fixture) => {
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
      const seeded = seedBackgroundHistoryProfile(databasePath, workspace, fixture.turns, fixture.mature);
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
        expect(database.prepare(`SELECT COUNT(*) AS count FROM activities a
          LEFT JOIN agent_turns t ON t.id = a.turn_id
          WHERE t.id IS NULL OR t.conversation_id != a.conversation_id OR t.run_id != a.run_id
        `).get()).toEqual({ count: 0 });
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
        for (const turn of detail.agentTurns) {
          const index = Number(turn.id.split("-turn-").at(-1));
          expect(detail.activities.filter(({ turnId }) => turnId === turn.id).map(({ title }) => title).sort())
            .toEqual(Array.from({ length: 74 }, (_, activity) => `Command ${index}.${activity}`).sort());
        }
        for (const activity of detail.activities) {
          const index = Number(activity.turnId!.split("-turn-").at(-1));
          expect(activity).toMatchObject({
            kind: "command", status: "completed",
            title: expect.stringMatching(new RegExp(`^Command ${index}\\.\\d+$`, "u")),
            detail: "Synthetic bounded-history fixture. ".repeat(20),
          });
        }
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
