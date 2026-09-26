import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { agentThreadTargetOwnershipMigration } from "../../src/server/persistence/migrations/agent-thread-target-ownership";

describe("managed turn ownership migration", () => {
  it("preserves old operations without inventing cancellation authority", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE agent_thread_operations (id TEXT PRIMARY KEY, child_conversation_id TEXT); INSERT INTO agent_thread_operations VALUES ('legacy', 'child');");
      const migration = agentThreadTargetOwnershipMigration.up;
      if (typeof migration !== "string") throw new Error("Expected a SQL migration");
      database.transaction(() => database.exec(migration))();
      expect(database.prepare("SELECT * FROM agent_thread_operations").get()).toEqual({
        id: "legacy", child_conversation_id: "child", target_turn_id: null, target_run_id: null,
      });
      database.prepare("UPDATE agent_thread_operations SET target_turn_id = ?, target_run_id = ?").run("turn-A", "run-A");
      expect(database.prepare("SELECT target_turn_id, target_run_id FROM agent_thread_operations").get())
        .toEqual({ target_turn_id: "turn-A", target_run_id: "run-A" });
    } finally { database.close(); }
  });
});
