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
import {
  splitStreamTextChunks,
  STREAM_TEXT_CHUNK_MAX_CHARACTERS,
} from "../../src/server/persistence/stream-text-storage";

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
  it("counts UTF-8 boundaries without changing lone surrogates or NUL text", () => {
    const value = "\0A\u007f\u0080\u07ff\u0800\ud800😀";
    const chunks = splitStreamTextChunks(value);

    expect(chunks).toEqual([value]);
    expect(chunks.join("")).toBe(value);
    expect(Buffer.byteLength(chunks[0]!, "utf8")).toBe(17);
  });

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

  it("transactionally splits one oversized Unicode delta and reconstructs it through restart and settlement", () => {
    const current = runtime();
    const project = current.store.createProject("Large delta", current.directory);
    const conversation = current.store.createConversation(project.id, "Large delta");
    const user = current.store.createMessage(conversation.id, "Start", "user");
    const turn = current.store.createAgentTurn({
      id: "turn-large-single-delta",
      conversationId: conversation.id,
      runId: "run-large-single-delta",
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
      "message-prefix:",
      "assistant",
      [],
      turn.id,
    );
    const reasoning = current.store.createReasoning(
      conversation.id,
      turn.runId,
      turn.id,
    );
    const messageDelta = `${"m".repeat(STREAM_TEXT_CHUNK_MAX_CHARACTERS - 1)}😀tail`;
    const reasoningDelta = `${"r".repeat(STREAM_TEXT_CHUNK_MAX_CHARACTERS)}🧠尾`;

    current.store.appendMessageContent(assistant.id, messageDelta);
    current.store.appendReasoningContent(reasoning.id, reasoningDelta);
    expect(current.store.message(assistant.id).content)
      .toBe(`message-prefix:${messageDelta}`);
    expect(current.store.conversationDetail(conversation.id)?.reasonings[0]?.content)
      .toBe(reasoningDelta);
    current.store.close();

    const raw = new Database(current.databasePath, { readonly: true });
    expect((raw.prepare(`
      SELECT COUNT(*) AS count, MAX(length(content)) AS maximum
      FROM message_content_chunks WHERE message_id = ?
    `).get(assistant.id) as { count: number; maximum: number }))
      .toEqual({ count: 2, maximum: STREAM_TEXT_CHUNK_MAX_CHARACTERS });
    expect((raw.prepare(`
      SELECT COUNT(*) AS count, MAX(length(content)) AS maximum
      FROM reasoning_content_chunks WHERE reasoning_id = ?
    `).get(reasoning.id) as { count: number; maximum: number }))
      .toEqual({ count: 2, maximum: STREAM_TEXT_CHUNK_MAX_CHARACTERS });
    raw.close();

    const reopened = new RuntimeStore(
      current.databasePath,
      current.directory,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.message(assistant.id).content)
      .toBe(`message-prefix:${messageDelta}`);
    expect(reopened.conversationDetail(conversation.id)?.reasonings[0]?.content)
      .toBe(reasoningDelta);
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
      .toBe(`message-prefix:${messageDelta}`);
    expect((compacted.prepare(
      "SELECT content FROM agent_reasonings WHERE id = ?",
    ).get(reasoning.id) as { content: string }).content)
      .toBe(reasoningDelta);
    expect((compacted.prepare(
      "SELECT COUNT(*) AS count FROM message_content_chunks",
    ).get() as { count: number }).count).toBe(0);
    expect((compacted.prepare(
      "SELECT COUNT(*) AS count FROM reasoning_content_chunks",
    ).get() as { count: number }).count).toBe(0);
    compacted.close();
  });

  it("preserves leading NUL chunks through live reads, restart, and terminal compaction", () => {
    const current = runtime();
    const project = current.store.createProject("NUL stream", current.directory);
    const conversation = current.store.createConversation(project.id, "NUL stream");
    const user = current.store.createMessage(conversation.id, "Start", "user");
    const turn = current.store.createAgentTurn({
      id: "turn-leading-nul",
      conversationId: conversation.id,
      runId: "run-leading-nul",
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
      "message:",
      "assistant",
      [],
      turn.id,
    );
    const reasoning = current.store.createReasoning(
      conversation.id,
      turn.runId,
      turn.id,
    );
    const messageDelta = "\0message😀tail";
    const reasoningDelta = "\0reasoning🧠tail";
    current.store.appendMessageContent(assistant.id, messageDelta);
    current.store.appendReasoningContent(reasoning.id, reasoningDelta);
    expect(current.store.message(assistant.id).content)
      .toBe(`message:${messageDelta}`);
    expect(current.store.conversationDetail(conversation.id)?.reasonings[0]?.content)
      .toBe(reasoningDelta);
    current.store.close();

    const reopened = new RuntimeStore(
      current.databasePath,
      current.directory,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.message(assistant.id).content)
      .toBe(`message:${messageDelta}`);
    expect(reopened.conversationDetail(conversation.id)?.reasonings[0]?.content)
      .toBe(reasoningDelta);
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
      .toBe(`message:${messageDelta}`);
    expect((compacted.prepare(
      "SELECT content FROM agent_reasonings WHERE id = ?",
    ).get(reasoning.id) as { content: string }).content)
      .toBe(reasoningDelta);
    expect((compacted.prepare(
      "SELECT COUNT(*) AS count FROM message_content_chunks",
    ).get() as { count: number }).count).toBe(0);
    expect((compacted.prepare(
      "SELECT COUNT(*) AS count FROM reasoning_content_chunks",
    ).get() as { count: number }).count).toBe(0);
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
      DROP TABLE recovery_import_receipts;
      DROP TABLE message_content_chunks;
      DROP TABLE reasoning_content_chunks;
      DELETE FROM schema_migrations WHERE version >= 38;
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
    expect((database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'message_content_chunks'
    `).get() as { sql: string }).sql).toContain("CAST(content AS BLOB)");
    database.close();
  });

  it("upgrades schema-39 chunk rows before accepting NUL-safe appends", () => {
    const current = runtime();
    const project = current.store.createProject("Schema 39", current.directory);
    const conversation = current.store.createConversation(project.id, "Schema 39");
    const message = current.store.createMessage(
      conversation.id,
      "base:",
      "assistant",
    );
    current.store.appendMessageContent(message.id, "existing chunk");
    current.store.close();

    const old = new Database(current.databasePath);
    old.exec(`
      DROP INDEX message_content_chunks_message_sequence_idx;
      ALTER TABLE message_content_chunks RENAME TO message_content_chunks_v40_source;
      CREATE TABLE message_content_chunks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 1048576)
      );
      INSERT INTO message_content_chunks (sequence, message_id, content)
      SELECT sequence, message_id, content FROM message_content_chunks_v40_source;
      DROP TABLE message_content_chunks_v40_source;
      CREATE INDEX message_content_chunks_message_sequence_idx
        ON message_content_chunks(message_id, sequence ASC);

      DROP INDEX reasoning_content_chunks_reasoning_sequence_idx;
      ALTER TABLE reasoning_content_chunks RENAME TO reasoning_content_chunks_v40_source;
      CREATE TABLE reasoning_content_chunks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        reasoning_id TEXT NOT NULL REFERENCES agent_reasonings(id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 1048576)
      );
      INSERT INTO reasoning_content_chunks (sequence, reasoning_id, content)
      SELECT sequence, reasoning_id, content FROM reasoning_content_chunks_v40_source;
      DROP TABLE reasoning_content_chunks_v40_source;
      CREATE INDEX reasoning_content_chunks_reasoning_sequence_idx
        ON reasoning_content_chunks(reasoning_id, sequence ASC);
      DELETE FROM schema_migrations WHERE version = 40;
    `);
    old.close();

    const upgraded = new RuntimeStore(
      current.databasePath,
      current.directory,
      { recoverInterruptedRuns: false },
    );
    expect(upgraded.message(message.id).content).toBe("base:existing chunk");
    upgraded.appendMessageContent(message.id, "\0new chunk");
    expect(upgraded.message(message.id).content)
      .toBe("base:existing chunk\0new chunk");
    upgraded.close();

    const database = new Database(current.databasePath, { readonly: true });
    expect((database.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number }).version)
      .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    expect((database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'message_content_chunks'
    `).get() as { sql: string }).sql).toContain("CAST(content AS BLOB)");
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
