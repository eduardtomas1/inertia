import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { agentContextReadsMigration } from "../../src/server/persistence/migrations/agent-context-reads";
import { AGENT_CONTEXT_READ_MANAGED_ACCESS_SCHEMA_VERSION } from "../../src/server/persistence/migrations/agent-context-read-managed-access";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import type { Conversation } from "../../src/shared/contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function begin(store: RuntimeStore, conversation: Conversation, content: string) {
  return store.beginAgentTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    runId: randomUUID(),
    content,
    activateConversation: false,
    providerId: conversation.providerId,
    harnessId: conversation.modelSelection.harnessId,
    backendProfileId: conversation.modelSelection.backendProfileId,
    model: conversation.modelSelection.modelId,
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
}

type ReadRow = { source_conversation_id: string; source_turn_id: string | null; access: string; page_count: number };

function readRows(database: Database.Database): ReadRow[] {
  return database.prepare(`
    SELECT source_conversation_id, source_turn_id, access, page_count
    FROM agent_context_reads ORDER BY created_at, id
  `).all() as ReadRow[];
}

function insertRead(database: Database.Database, row: {
  target: string; turnId: string; messageId: string; source: string; access: string;
}): void {
  database.prepare(`
    INSERT INTO agent_context_reads (
      id, target_conversation_id, target_turn_id, target_user_message_id,
      source_conversation_id, source_conversation_title, source_turn_id,
      access, page_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Source', NULL, ?, 1, '2030-01-01T00:00:09.000Z', '2030-01-01T00:00:09.000Z')
  `).run(randomUUID(), row.target, row.turnId, row.messageId, row.source, row.access);
}

describe("RecordManagedAgentContextReads migration", () => {
  it("upgrades a schema 106 read log in place, keeps watched reads, and then accepts managed reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-managed-read-migration-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const databasePath = join(root, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    const project = store.createProject("Billing", workspace);
    const target = store.createConversation(project.id, "Reader", { activate: false });
    const source = store.createConversation(project.id, "Source", { activate: false });
    const watched = store.createConversation(project.id, "Watched", { activate: false });
    const sourceTurn = begin(store, source, "Source work.");
    const turn = begin(store, target, "Read the other chats.");
    const record = (sourceConversationId: string, sourceTurnId: string | null, access: "own" | "referenced" | "approved" | "watched", now: string) =>
      store.contextPackets.turnReads.recordRead({
        targetConversationId: target.id,
        targetTurnId: turn.id,
        targetUserMessageId: turn.userMessageId,
        sourceConversationId,
        sourceTurnId,
        access,
        now,
      });
    record(target.id, null, "own", "2030-01-01T00:00:01.000Z");
    record(source.id, null, "referenced", "2030-01-01T00:00:02.000Z");
    record(source.id, sourceTurn.id, "approved", "2030-01-01T00:00:03.000Z");
    record(source.id, sourceTurn.id, "approved", "2030-01-01T00:00:04.000Z");
    record(watched.id, null, "watched", "2030-01-01T00:00:05.000Z");
    store.close();

    // Rebuild the read log exactly as schema 99 through 106 created it.
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      ALTER TABLE agent_context_reads RENAME TO agent_context_reads_current;
      DROP INDEX agent_context_reads_identity_idx;
      DROP INDEX agent_context_reads_target_idx;
    `);
    const schema99ReadLog = (agentContextReadsMigration.up as string).replace(
      "CHECK (access IN ('own', 'referenced', 'approved'))",
      "CHECK (access IN ('own', 'referenced', 'approved', 'watched'))",
    );
    expect(schema99ReadLog).toContain("'watched'");
    legacy.exec(schema99ReadLog);
    legacy.exec(`
      INSERT INTO agent_context_reads SELECT * FROM agent_context_reads_current;
      DROP TABLE agent_context_reads_current;
    `);
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(AGENT_CONTEXT_READ_MANAGED_ACCESS_SCHEMA_VERSION);
    const before = readRows(legacy);
    expect(before).toEqual([
      { source_conversation_id: target.id, source_turn_id: null, access: "own", page_count: 1 },
      { source_conversation_id: source.id, source_turn_id: null, access: "referenced", page_count: 1 },
      { source_conversation_id: source.id, source_turn_id: sourceTurn.id, access: "approved", page_count: 2 },
      { source_conversation_id: watched.id, source_turn_id: null, access: "watched", page_count: 1 },
    ]);
    expect(() => insertRead(legacy, {
      target: target.id, turnId: turn.id, messageId: turn.userMessageId, source: randomUUID(), access: "managed",
    })).toThrow(/CHECK constraint failed/u);
    legacy.close();

    const upgraded = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    upgraded.close();
    const inspected = new Database(databasePath);
    try {
      expect(AGENT_CONTEXT_READ_MANAGED_ACCESS_SCHEMA_VERSION).toBeLessThanOrEqual(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(inspected.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = ?")
        .get(AGENT_CONTEXT_READ_MANAGED_ACCESS_SCHEMA_VERSION))
        .toEqual({ applied: 1 });
      expect(inspected.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_context_reads'")
        .get()).toMatchObject({ sql: expect.stringContaining("'watched', 'managed'") });
      expect(readRows(inspected)).toEqual(before);
      expect((inspected.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_context_reads' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map(({ name }) => name))
        .toEqual(["agent_context_reads_identity_idx", "agent_context_reads_target_idx"]);
      expect(inspected.pragma("foreign_key_check")).toEqual([]);
      const child = randomUUID();
      insertRead(inspected, {
        target: target.id, turnId: turn.id, messageId: turn.userMessageId, source: child, access: "managed",
      });
      expect(() => insertRead(inspected, {
        target: target.id, turnId: turn.id, messageId: turn.userMessageId, source: randomUUID(), access: "delegated",
      })).toThrow(/CHECK constraint failed/u);
      expect(() => insertRead(inspected, {
        target: target.id, turnId: turn.id, messageId: turn.userMessageId, source: child, access: "managed",
      })).toThrow(/UNIQUE constraint failed/u);
      inspected.pragma("foreign_keys = ON");
      inspected.prepare("DELETE FROM conversations WHERE id = ?").run(target.id);
      expect(readRows(inspected)).toEqual([]);
    } finally {
      inspected.close();
    }
  });
});
