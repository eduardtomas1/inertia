import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";
import { indexMessageSearchBatch } from "../../src/server/persistence/message-search-indexer";
import { messageSearchIndexQuery } from "../../src/server/persistence/message-search-terms";
import type { MessageSearchContinuation } from "../../src/shared/message-search";
import { messageSearchResultSchema } from "../../src/shared/message-search-schema";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-message-search-index-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "inertia.sqlite");
  const opened = { store: new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false }) };
  cleanup.push(() => opened.store.close());
  const project = opened.store.createProject("Index fixture", directory);
  const conversation = opened.store.createConversation(project.id, "Indexed history");
  const reader = new Database(databasePath, { readonly: true });
  const writer = new Database(databasePath);
  cleanup.push(() => { reader.close(); writer.close(); });
  return {
    get store() { return opened.store; },
    restart() { opened.store.close(); opened.store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false }); },
    reader, writer, databasePath, directory, project, conversation,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
}

function documents(database: Database.Database): Array<{ messageId: string; state: number }> {
  return database.prepare("SELECT message_id AS messageId, state FROM message_search_documents ORDER BY message_id").all() as Array<{ messageId: string; state: number }>;
}

function documentState(database: Database.Database, messageId: string): number | undefined {
  return database.prepare("SELECT state FROM message_search_documents WHERE message_id = ?").pluck().get(messageId) as number | undefined;
}

function indexMatches(database: Database.Database, trigram: string): number[] {
  return database.prepare("SELECT rowid FROM message_search_index WHERE message_search_index MATCH ?").pluck().all(`"${trigram}"`) as number[];
}

function indexRows(database: Database.Database): number {
  return database.prepare("SELECT count(*) FROM message_search_index").pluck().get() as number;
}

function backfillState(database: Database.Database) {
  return database.prepare("SELECT complete, before_created_at AS createdAt, before_message_id AS messageId FROM message_search_backfill").get();
}

function resetToUnindexedHistory(writer: Database.Database): void {
  writer.exec(`
    INSERT INTO message_search_index (message_search_index) VALUES ('delete-all');
    DELETE FROM message_search_documents;
    UPDATE message_search_backfill SET complete = 0, before_created_at = NULL, before_message_id = NULL;
  `);
}

function indexEverything(store: RuntimeStore): void {
  for (let batch = 0; batch < 1_000; batch += 1) if (!store.indexMessageSearchBatch(1_000).remaining) return;
  throw new Error("Indexing did not settle.");
}

function answer(store: RuntimeStore, conversationId: string, content: string, createdAt?: string) {
  const user = store.createMessage(conversationId, "Please investigate", "user", [], null, createdAt);
  const turn = store.createAgentTurn({
    id: randomUUID(), conversationId, runId: randomUUID(), userMessageId: user.id,
    providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
    model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
    configurationRevision: 0, association: "authoritative",
  });
  const message = store.createMessage(conversationId, content, "assistant", [], turn.id, createdAt);
  return { turn, message };
}

function pageAll(
  database: Database.Database,
  query: string,
  options: { sortedCandidateLimit?: number; now?: () => number; maxScanMs?: number; between?: () => void } = {},
): { ids: string[]; pages: number } {
  const ids: string[] = [];
  let continuation: MessageSearchContinuation | null = null;
  for (let pages = 1; pages < 500; pages += 1) {
    const result = searchMessages(database, query, { ...options, continuation });
    expect(messageSearchResultSchema.safeParse(result).success).toBe(true);
    ids.push(...result.hits.map(({ messageId }) => messageId));
    continuation = result.continuation ?? null;
    if (!continuation) return { ids, pages };
    options.between?.();
  }
  throw new Error("Paging did not finish.");
}

describe("message search index maintenance", () => {
  it("records every write as pending and leaves streamed, rewritten and compacted text stale until the indexer runs", async () => {
    const { store, reader, conversation } = await fixture();
    const user = store.createMessage(conversation.id, "alpha needle");
    expect(documentState(reader, user.id)).toBe(0);
    expect(indexMatches(reader, "eed")).toEqual([]);
    expect(searchMessages(reader, "alpha needle").hits.map(({ messageId }) => messageId)).toEqual([user.id]);
    indexEverything(store);
    expect(documentState(reader, user.id)).toBe(1);
    expect(indexMatches(reader, "eed")).toHaveLength(1);

    const { turn, message } = answer(store, conversation.id, "streamed nee");
    indexEverything(store);
    expect(documentState(reader, message.id)).toBe(1);
    store.appendMessageContent(message.id, "dle beta");
    store.appendMessageContent(message.id, " gamma");
    expect(documentState(reader, message.id)).toBe(0);
    expect(indexMatches(reader, "amm")).toEqual([]);
    expect(store.indexMessageSearchBatch(1_000)).toMatchObject({ remaining: false });
    expect(documentState(reader, message.id)).toBe(0);
    store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalAssistantMessageId: message.id, terminalReason: "provider-completed" });
    expect(reader.prepare("SELECT count(*) FROM message_content_chunks").pluck().get()).toBe(0);
    expect(documentState(reader, message.id)).toBe(0);
    expect(searchMessages(reader, "needle beta gamma").hits.map(({ messageId }) => messageId)).toEqual([message.id]);
    indexEverything(store);
    expect(documentState(reader, message.id)).toBe(1);
    expect(indexMatches(reader, "a g")).toHaveLength(1);
    expect(searchMessages(reader, "needle beta gamma").hits.map(({ messageId }) => messageId)).toEqual([message.id]);

    store.updateMessageContent(user.id, "rewritten text");
    expect(documentState(reader, user.id)).toBe(0);
    expect(searchMessages(reader, "alpha").hits).toEqual([]);
    expect(searchMessages(reader, "rewritten").hits.map(({ messageId }) => messageId)).toEqual([user.id]);
    indexEverything(store);
    expect(documentState(reader, user.id)).toBe(1);
    expect(indexMatches(reader, "lph")).toEqual([]);
    expect(indexMatches(reader, "wri")).toHaveLength(1);
    expect(indexRows(reader)).toBe(documents(reader).length);
  });

  it("keeps planner statistics off the index shadow tables so small writes stay cheap as the index grows", async () => {
    const context = await fixture();
    const shadowStatistics = () => context.reader.prepare(`
      SELECT tbl FROM sqlite_stat1 WHERE tbl LIKE 'message_search_index%' ORDER BY tbl
    `).pluck().all();
    const dataRangePlan = () => {
      const liveDatabase = (context.store as unknown as { database: Database.Database }).database;
      return (liveDatabase.prepare(
        "EXPLAIN QUERY PLAN SELECT id, block FROM message_search_index_data WHERE id >= ? AND id <= ? ORDER BY id ASC",
      ).all(1, 100) as Array<{ detail: string }>).map(({ detail }) => detail).join(" ");
    };
    expect(shadowStatistics()).toEqual([]);
    expect(dataRangePlan()).toContain("USING INTEGER PRIMARY KEY");
    context.store.createMessage(context.conversation.id, "statistics needle");
    indexEverything(context.store);
    context.writer.exec("ANALYZE");
    expect(shadowStatistics()).not.toEqual([]);
    context.restart();
    expect(shadowStatistics()).toEqual([]);
    expect(context.reader.prepare("SELECT count(*) FROM sqlite_stat1 WHERE tbl = 'messages'").pluck().get()).toBeGreaterThan(0);
    context.restart();
    expect(dataRangePlan()).toContain("USING INTEGER PRIMARY KEY");
  });

  it("removes index rows with their messages, conversations and projects", async () => {
    const { store, reader, directory, project, conversation } = await fixture();
    const other = store.createConversation(project.id, "Other");
    const secondProject = store.createProject("Second", directory);
    const third = store.createConversation(secondProject.id, "Third");
    store.createMessage(conversation.id, "first needle");
    store.createMessage(other.id, "second needle");
    store.createMessage(third.id, "third needle");
    const streamed = store.createMessage(third.id, "streamed needle");
    indexEverything(store);
    store.appendMessageContent(streamed.id, " chunk");
    expect(documents(reader)).toHaveLength(4);
    store.deleteConversation(other.id);
    expect(documents(reader)).toHaveLength(3);
    expect(indexMatches(reader, "eed")).toHaveLength(2);
    store.removeProject(secondProject.id);
    expect(documents(reader)).toHaveLength(1);
    expect(indexRows(reader)).toBe(1);
    expect(searchMessages(reader, "needle").hits.map(({ snippet }) => snippet)).toEqual(["first needle"]);
  });

  it("keeps archived chats indexed and filters them at query time", async () => {
    const { store, reader, project } = await fixture();
    const archived = store.createConversation(project.id, "Archived");
    const message = store.createMessage(archived.id, "archived needle");
    indexEverything(store);
    store.archiveConversation(archived.id, true);
    expect(documentState(reader, message.id)).toBe(1);
    expect(searchMessages(reader, "needle").hits).toEqual([]);
    store.archiveConversation(archived.id, false);
    expect(searchMessages(reader, "needle").hits.map(({ messageId }) => messageId)).toEqual([message.id]);
  });

  it("indexes large messages in the background and reads oversized ones directly", async () => {
    const { store, reader, conversation } = await fixture();
    const large = store.createMessage(conversation.id, `${"x".repeat(70_000)} large needle`);
    const oversized = store.createMessage(conversation.id, `${"y".repeat(300_000)} oversized needle`);
    expect(documentState(reader, large.id)).toBe(0);
    expect(documentState(reader, oversized.id)).toBe(0);
    indexEverything(store);
    expect(documentState(reader, large.id)).toBe(1);
    expect(documentState(reader, oversized.id)).toBe(2);
    expect(searchMessages(reader, "needle").hits.map(({ messageId }) => messageId).sort()).toEqual([large.id, oversized.id].sort());
    store.appendMessageContent(oversized.id, " more");
    expect(documentState(reader, oversized.id)).toBe(0);
    indexEverything(store);
    expect(documentState(reader, oversized.id)).toBe(0);
    expect(searchMessages(reader, "oversized needle more").hits.map(({ messageId }) => messageId)).toEqual([oversized.id]);
    store.updateMessageContent(oversized.id, `${"z".repeat(300_000)} replaced needle`);
    indexEverything(store);
    expect(documentState(reader, oversized.id)).toBe(2);
    expect(searchMessages(reader, "replaced needle").hits.map(({ messageId }) => messageId)).toEqual([oversized.id]);
  });
});

describe("message search backfill", () => {
  it("indexes existing history newest first in bounded batches and resumes after a restart", async () => {
    const context = await fixture();
    const { reader, writer, conversation } = context;
    const messages = Array.from({ length: 12 }, (_, index) => context.store.createMessage(conversation.id, `history needle ${index}`, "user", [], null, at(index)));
    resetToUnindexedHistory(writer);
    expect(backfillState(reader)).toEqual({ complete: 0, createdAt: null, messageId: null });
    let ticks = 0;
    const first = indexMessageSearchBatch(writer, { budgetMs: 4, now: () => ticks++ });
    expect(first).toEqual({ remaining: true, backfillComplete: false });
    const indexed = documents(reader).map(({ messageId }) => messageId);
    expect(indexed.length).toBeGreaterThan(0);
    expect(indexed.length).toBeLessThan(messages.length);
    const newest = messages.slice(-indexed.length);
    expect(indexed.sort()).toEqual(newest.map(({ id }) => id).sort());
    expect(backfillState(reader)).toEqual({ complete: 0, createdAt: newest[0]!.createdAt, messageId: newest[0]!.id });

    const imported = context.store.createMessage(conversation.id, "imported needle", "user", [], null, at(-5));
    const fresh = context.store.createMessage(conversation.id, "fresh needle", "user", [], null, at(100));
    expect(documentState(reader, imported.id)).toBe(0);
    expect(documentState(reader, fresh.id)).toBe(0);

    context.restart();
    for (let batch = 0; batch < 100; batch += 1) {
      ticks = 0;
      const progress = indexMessageSearchBatch(writer, { budgetMs: 4, now: () => ticks++ });
      if (!progress.remaining) break;
    }
    expect(backfillState(reader)).toEqual({ complete: 1, createdAt: null, messageId: null });
    expect(documents(reader).map(({ messageId }) => messageId).sort()).toEqual([...messages.map(({ id }) => id), imported.id, fresh.id].sort());
    expect(documents(reader).every(({ state }) => state === 1)).toBe(true);
    expect(indexRows(reader)).toBe(messages.length + 2);
    expect(context.store.indexMessageSearchBatch(1_000)).toEqual({ remaining: false, backfillComplete: true });
  });

  it("returns ordered hits from both the index and the unindexed range while the backfill runs", async () => {
    const context = await fixture();
    const { reader, writer, conversation, project } = context;
    const archived = context.store.createConversation(project.id, "Archived");
    const expected: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      expected.push(context.store.createMessage(conversation.id, `mixed Needle ${index}`, "user", [], null, at(index * 2)).id);
      context.store.createMessage(archived.id, `mixed needle archived ${index}`, "user", [], null, at(index * 2 + 1));
    }
    context.store.archiveConversation(archived.id, true);
    expected.reverse();
    resetToUnindexedHistory(writer);
    let ticks = 0;
    indexMessageSearchBatch(writer, { budgetMs: 20, now: () => ticks++ });
    expect(documents(reader).length).toBeGreaterThan(5);
    expect(documents(reader).length).toBeLessThan(40);

    const first = searchMessages(reader, "mixed needle");
    expect(first).toMatchObject({ indexing: true, hasMore: true, incomplete: false });
    expect(first.hits.map(({ messageId }) => messageId)).toEqual(expected.slice(0, 20));
    expect(pageAll(reader, "mixed needle").ids).toEqual(expected);
    let clock = 0;
    const bounded = pageAll(reader, "mixed needle", { now: () => clock++, maxScanMs: 12 });
    expect(bounded.ids).toEqual(expected);
    expect(bounded.pages).toBeGreaterThan(3);

    indexEverything(context.store);
    const complete = searchMessages(reader, "mixed needle");
    expect(complete).toMatchObject({ indexing: false, hasMore: true, incomplete: false });
    expect(pageAll(reader, "mixed needle").ids).toEqual(expected);
  });
});

describe("indexed message search matching", () => {
  it("keeps literal substring semantics for punctuation, case, multiple words and short queries", async () => {
    const { store, reader, conversation } = await fixture();
    const call = store.createMessage(conversation.id, "Call Foo.Bar(x) && [y]%_ now");
    const path = store.createMessage(conversation.id, "Open C:\\Users\\Name\\file.ts:42");
    const quoted = store.createMessage(conversation.id, "She said \"quoted words\" -- then --flag=value");
    const decoy = store.createMessage(conversation.id, "abc then bcd and xyz");
    const words = store.createMessage(conversation.id, "the quick   brown fox");
    const find = (query: string) => searchMessages(reader, query).hits.map(({ messageId }) => messageId);
    expect(find("foo.bar(X) && [Y]%_")).toEqual([call.id]);
    expect(find("\\users\\name\\")).toEqual([path.id]);
    expect(find("\"QUOTED WORDS\" --")).toEqual([quoted.id]);
    expect(find("--flag=")).toEqual([quoted.id]);
    expect(find("abcd")).toEqual([]);
    expect(find("bcd and")).toEqual([decoy.id]);
    expect(find("quick   brown")).toEqual([words.id]);
    expect(find("quick brown")).toEqual([]);
    expect(find("xy")).toEqual([decoy.id]);
    expect(find("C:")).toEqual([path.id]);
    expect(messageSearchIndexQuery("xy")).toBeNull();
    expect(messageSearchIndexQuery("a\"b")).toBe("\"a\"\"b\"");
  });

  it("finds text whose case folding differs between JavaScript and the index", async () => {
    const { store, reader, conversation } = await fixture();
    const greek = store.createMessage(conversation.id, "ο λόγος είναι");
    const cyrillic = store.createMessage(conversation.id, "\u1c83оль и перец");
    const longS = store.createMessage(conversation.id, "a \u017ftrange word");
    const kelvin = store.createMessage(conversation.id, "cooled to 5 \u212a today");
    const find = (query: string) => searchMessages(reader, query).hits.map(({ messageId }) => messageId);
    expect(find("ΛΌΓΟΣ ΕΊ")).toEqual([greek.id]);
    expect(find("СОЛЬ И")).toEqual([cyrillic.id]);
    expect(find("STRANGE")).toEqual([longS.id]);
    expect(find("5 k toDAY")).toEqual([kelvin.id]);
    expect(messageSearchIndexQuery("СОЛЬ")).toContain(" OR ");
    expect(messageSearchIndexQuery("needle")).not.toContain(" OR ");
  });

  it("enforces eligibility for indexed candidates on both index strategies", async () => {
    const { store, reader, project, conversation } = await fixture();
    const user = store.createMessage(conversation.id, "eligible needle");
    const { turn, message } = answer(store, conversation.id, "terminal needle");
    store.createMessage(conversation.id, "commentary needle", "assistant", [], turn.id);
    store.updateAgentTurnLifecycle(turn.id, { status: "completed", terminalAssistantMessageId: message.id, terminalReason: "provider-completed" });
    store.createMessage(conversation.id, "system needle", "system", [], turn.id);
    const archived = store.createConversation(project.id, "Archived");
    store.createMessage(archived.id, "archived needle");
    store.archiveConversation(archived.id, true);
    const expected = [message.id, user.id].sort();
    for (const sortedCandidateLimit of [undefined, 0]) {
      expect(searchMessages(reader, "needle", { sortedCandidateLimit }).hits.map(({ messageId }) => messageId).sort()).toEqual(expected);
    }
  });
});

describe("message search continuation", () => {
  async function history(context: Fixture, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(context.store.createMessage(context.conversation.id, `page needle ${index}`, "user", [], null, at(Math.floor(index / 3))).id);
      if (index % 4 === 0) context.store.createMessage(context.conversation.id, "unrelated text", "user", [], null, at(Math.floor(index / 3)));
    }
    indexEverything(context.store);
    return context.reader.prepare(`
      SELECT id FROM messages WHERE content LIKE 'page needle%' ORDER BY created_at DESC, id DESC
    `).pluck().all() as string[];
  }

  it.each([
    ["sorted index candidates", "page needle", undefined],
    ["dense index walk", "page needle", 0],
    ["short query scan", "pa", undefined],
  ] as const)("pages %s by keyset without duplicates or skips while new messages arrive", async (_name, query, sortedCandidateLimit) => {
    const context = await fixture();
    const expected = await history(context, 47);
    let arrived = 0;
    const paged = pageAll(context.reader, query, {
      sortedCandidateLimit,
      between: () => { context.store.createMessage(context.conversation.id, `page needle newer ${arrived++}`, "user", [], null, at(1_000 + arrived)); },
    });
    expect(paged.pages).toBe(3);
    expect(paged.ids).toEqual(expected);
    expect(new Set(paged.ids).size).toBe(paged.ids.length);
  });

  it("resumes at the first unsearched message when the time budget runs out", async () => {
    const context = await fixture();
    const expected = await history(context, 30);
    let clock = 0;
    const first = searchMessages(context.reader, "page needle", { now: () => clock++, maxScanMs: 10 });
    expect(first).toMatchObject({ incomplete: true, hasMore: false });
    expect(first.hits.length).toBeGreaterThan(0);
    expect(first.continuation).toEqual(expect.objectContaining({ messageId: expected[first.hits.length] }));
    clock = 0;
    expect(pageAll(context.reader, "page needle", { now: () => clock++, maxScanMs: 10 }).ids).toEqual(expected);
  });

  it("falls back to cursor-bounded chronological scan when sortedMembership exceeds its time budget", async () => {
    const context = await fixture();
    const expected = await history(context, 12);
    // Use sortedCandidateLimit: 0 so the sortedMembership path runs, and a clock that
    // jumps past half maxScanMs inside sortedMembership but still leaves budget to advance.
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls <= 2 ? 0 : 12 + calls;
    };
    const first = searchMessages(context.reader, "page needle", {
      sortedCandidateLimit: 0,
      now,
      maxScanMs: 20,
      continuation: { createdAt: at(10), messageId: expected[0]! },
    });
    expect(first.hits.length).toBeGreaterThan(0);
    if (first.continuation) {
      expect(first.continuation.messageId).not.toBe(expected[0]);
    }
  });
});
