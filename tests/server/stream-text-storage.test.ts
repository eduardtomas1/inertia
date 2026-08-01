import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";

const directories: string[] = [];

function runtime(): {
  databasePath: string;
  directory: string;
  store: RuntimeStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "inertia-stream-storage-"));
  directories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  return {
    databasePath,
    directory,
    store: new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("append-oriented stream text persistence", () => {
  it("writes linear chunks, reconstructs exact ordering after restart, and compacts at settlement", () => {
    const current = runtime();
    const project = current.store.createProject("Stream", current.directory);
    const conversation = current.store.createConversation(project.id, "Stream");
    const user = current.store.createMessage(conversation.id, "Start", "user");
    const turn = current.store.createAgentTurn({
      id: "turn-stream-storage",
      conversationId: conversation.id,
      runId: "run-stream-storage",
      userMessageId: user.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    current.store.updateAgentTurnLifecycle(turn.id, {
      status: "running",
    });
    const assistant = current.store.createMessage(
      conversation.id,
      "prefix:",
      "assistant",
      [],
      turn.id,
      "2026-01-01T00:00:02.000Z",
    );
    const deltas = Array.from(
      { length: 1_000 },
      (_, index) => `[${String(index).padStart(4, "0")}]`,
    );
    for (const delta of deltas) {
      current.store.appendMessageContent(assistant.id, delta);
    }
    const reasoning = current.store.createReasoning(
      conversation.id,
      turn.runId,
      turn.id,
    );
    current.store.appendReasoningContent(reasoning.id, "durable reasoning");
    expect(current.store.message(assistant.id).content)
      .toBe(`prefix:${deltas.join("")}`);
    current.store.close();

    const rawBeforeRestart = new Database(current.databasePath, {
      readonly: true,
    });
    expect((rawBeforeRestart.prepare(
      "SELECT content FROM messages WHERE id = ?",
    ).get(assistant.id) as { content: string }).content).toBe("prefix:");
    expect((rawBeforeRestart.prepare(`
      SELECT COUNT(*) AS count, SUM(length(content)) AS characters
      FROM message_content_chunks WHERE message_id = ?
    `).get(assistant.id) as { count: number; characters: number }))
      .toEqual({ count: 1_000, characters: deltas.join("").length });
    rawBeforeRestart.close();

    const reopened = new RuntimeStore(
      current.databasePath,
      current.directory,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.conversationDetail(conversation.id)?.messages
      .find(({ id }) => id === assistant.id)?.content)
      .toBe(`prefix:${deltas.join("")}`);
    reopened.settleAgentTurn(turn.id, {
      status: "completed",
      terminalAssistantMessageId: assistant.id,
      terminalReason: "completed",
    });
    reopened.close();

    const compacted = new Database(current.databasePath, { readonly: true });
    expect((compacted.prepare(
      "SELECT content FROM messages WHERE id = ?",
    ).get(assistant.id) as { content: string }).content)
      .toBe(`prefix:${deltas.join("")}`);
    expect((compacted.prepare(`
      SELECT COUNT(*) AS count
      FROM message_content_chunks WHERE message_id = ?
    `).get(assistant.id) as { count: number }).count).toBe(0);
    expect((compacted.prepare(`
      SELECT COUNT(*) AS count
      FROM reasoning_content_chunks WHERE reasoning_id = ?
    `).get(reasoning.id) as { count: number }).count).toBe(0);
    expect((compacted.prepare(
      "SELECT content FROM agent_reasonings WHERE id = ?",
    ).get(reasoning.id) as { content: string }).content)
      .toBe("durable reasoning");
    compacted.close();
  });

  it("replacements and terminal reasoning updates atomically discard obsolete chunks", () => {
    const current = runtime();
    const project = current.store.createProject("Replace", current.directory);
    const conversation = current.store.createConversation(project.id, "Replace");
    const message = current.store.createMessage(
      conversation.id,
      "old",
      "assistant",
    );
    current.store.appendMessageContent(message.id, "-chunk-one");
    current.store.appendMessageContent(message.id, "-chunk-two");
    current.store.updateMessageContent(message.id, "authoritative replacement");
    expect(current.store.message(message.id).content)
      .toBe("authoritative replacement");

    const reasoning = current.store.createReasoning(
      conversation.id,
      "run-reasoning",
    );
    current.store.appendReasoningContent(reasoning.id, "old ");
    current.store.appendReasoningContent(reasoning.id, "reasoning");
    current.store.updateReasoning(reasoning.id, {
      content: "final reasoning",
      status: "completed",
    });
    expect(current.store.conversationDetail(conversation.id)?.reasonings[0])
      .toMatchObject({ content: "final reasoning", status: "completed" });
    current.store.close();

    const database = new Database(current.databasePath, { readonly: true });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM message_content_chunks",
    ).get() as { count: number }).count).toBe(0);
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM reasoning_content_chunks",
    ).get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("upgrades a schema-37 database without rewriting existing message values", () => {
    const current = runtime();
    const project = current.store.createProject("Upgrade", current.directory);
    const conversation = current.store.createConversation(project.id, "Upgrade");
    const message = current.store.createMessage(
      conversation.id,
      "schema-37 content",
      "assistant",
    );
    current.store.close();

    const old = new Database(current.databasePath);
    old.exec(`
      DROP TABLE message_content_chunks;
      DROP TABLE reasoning_content_chunks;
      DELETE FROM schema_migrations WHERE version = 38;
    `);
    old.close();

    const upgraded = new RuntimeStore(
      current.databasePath,
      current.directory,
      { recoverInterruptedRuns: false },
    );
    expect(upgraded.message(message.id).content).toBe("schema-37 content");
    upgraded.appendMessageContent(message.id, " plus chunk");
    expect(upgraded.message(message.id).content)
      .toBe("schema-37 content plus chunk");
    upgraded.close();

    const database = new Database(current.databasePath, { readonly: true });
    expect((database.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version)
      .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM message_content_chunks",
    ).get() as { count: number }).count).toBe(1);
    database.close();
  });

  it("recovers durable chunks after a restart and compacts interrupted turn text", () => {
    const current = runtime();
    const project = current.store.createProject("Crash", current.directory);
    const conversation = current.store.createConversation(project.id, "Crash");
    const user = current.store.createMessage(conversation.id, "request", "user");
    const turn = current.store.createAgentTurn({
      id: "turn-crash-recovery",
      conversationId: conversation.id,
      runId: "run-crash-recovery",
      userMessageId: user.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    current.store.updateAgentTurnLifecycle(turn.id, { status: "running" });
    const assistant = current.store.createMessage(
      conversation.id,
      "durable-",
      "assistant",
      [],
      turn.id,
    );
    current.store.appendMessageContent(assistant.id, "before-");
    current.store.appendMessageContent(assistant.id, "crash");
    const reasoning = current.store.createReasoning(
      conversation.id,
      turn.runId,
      turn.id,
    );
    current.store.appendReasoningContent(reasoning.id, "reasoning-");
    current.store.appendReasoningContent(reasoning.id, "survives");
    current.store.close();

    const recovered = new RuntimeStore(current.databasePath, current.directory);
    expect(recovered.agentTurn(turn.id)).toMatchObject({
      status: "interrupted",
      terminalReason: "runtime-restart",
    });
    expect(recovered.message(assistant.id).content).toBe("durable-before-crash");
    expect(recovered.conversationDetail(conversation.id)?.reasonings[0])
      .toMatchObject({ content: "reasoning-survives", status: "failed" });
    recovered.close();

    const database = new Database(current.databasePath, { readonly: true });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM message_content_chunks",
    ).get() as { count: number }).count).toBe(0);
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM reasoning_content_chunks",
    ).get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("rolls terminal identity and chunk compaction back together on a storage fault", () => {
    const current = runtime();
    const project = current.store.createProject("Fault", current.directory);
    const conversation = current.store.createConversation(project.id, "Fault");
    const user = current.store.createMessage(conversation.id, "request", "user");
    const turn = current.store.createAgentTurn({
      id: "turn-compaction-fault",
      conversationId: conversation.id,
      runId: "run-compaction-fault",
      userMessageId: user.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    current.store.updateAgentTurnLifecycle(turn.id, { status: "running" });
    const assistant = current.store.createMessage(
      conversation.id,
      "base-",
      "assistant",
      [],
      turn.id,
    );
    current.store.appendMessageContent(assistant.id, "chunk");
    current.store.close();

    const injected = new Database(current.databasePath);
    injected.exec(`
      CREATE TRIGGER fail_message_chunk_compaction
      BEFORE DELETE ON message_content_chunks
      BEGIN
        SELECT RAISE(ABORT, 'injected compaction failure');
      END;
    `);
    injected.close();

    const reopened = new RuntimeStore(
      current.databasePath,
      current.directory,
      { recoverInterruptedRuns: false },
    );
    expect(() => reopened.settleAgentTurn(turn.id, {
      status: "completed",
      terminalAssistantMessageId: assistant.id,
      terminalReason: "completed",
    })).toThrow("injected compaction failure");
    expect(reopened.agentTurn(turn.id)).toMatchObject({
      status: "running",
      terminalAssistantMessageId: null,
    });
    expect(reopened.message(assistant.id).content).toBe("base-chunk");

    const repair = new Database(current.databasePath);
    repair.exec("DROP TRIGGER fail_message_chunk_compaction");
    repair.close();
    expect(reopened.settleAgentTurn(turn.id, {
      status: "completed",
      terminalAssistantMessageId: assistant.id,
      terminalReason: "completed",
    }).settled).toBe(true);
    reopened.close();
  });
});
