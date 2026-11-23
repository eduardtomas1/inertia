import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";
import { MessageSearchIndexWorker } from "../../src/server/persistence/message-search-index-worker-client";

let directory: string;
let entry: URL;

beforeAll(async () => {
  directory = await mkdtemp(resolve("node_modules/.message-search-index-worker-test-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await build({
    entryPoints: ["src/server/persistence/message-search-index-worker.ts"],
    outdir: directory, bundle: true, platform: "node", format: "esm", packages: "external",
  });
  entry = pathToFileURL(join(directory, "message-search-index-worker.js"));
}, 60_000);

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("isolated message search index worker", () => {
  it("indexes and merges on its own connection, then refuses work once closed", async () => {
    const databasePath = join(directory, `index-${Date.now()}.sqlite`);
    const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    const conversation = store.createConversation(store.createProject("Worker index", directory).id, "History");
    const messages = Array.from({ length: 150 }, (_, index) => store.createMessage(conversation.id, `worker needle ${index}`));
    const worker = new MessageSearchIndexWorker(databasePath, entry);
    const reader = new Database(databasePath, { readonly: true });
    try {
      let batches = 0;
      for (;;) {
        batches += 1;
        const progress = await worker.batch({ budgetMs: 1_000, mergeMs: 25 });
        if (!progress.remaining) break;
        expect(batches).toBeLessThan(50);
      }
      expect(reader.prepare("SELECT count(*) FROM message_search_documents WHERE state = 1").pluck().get()).toBe(messages.length);
      expect(searchMessages(reader, "worker needle 149").hits.map(({ messageId }) => messageId)).toEqual([messages[149]!.id]);
      store.createMessage(conversation.id, "written while the worker is open");
      expect(await worker.batch({ budgetMs: 1_000, mergeMs: 0 })).toEqual({ remaining: false, backfillComplete: true });
      await worker.close();
      await expect(worker.batch({ budgetMs: 10, mergeMs: 0 })).rejects.toThrow(/closed/u);
      await worker.close();
    } finally {
      reader.close();
      store.close();
      await worker.close();
    }
  });

  it("rejects its batches and restarts after the worker fails", async () => {
    const worker = new MessageSearchIndexWorker(join(directory, "missing.sqlite"), entry);
    try {
      await expect(worker.batch({ budgetMs: 10, mergeMs: 0 })).rejects.toThrow(/worker/u);
      await expect(worker.batch({ budgetMs: 10, mergeMs: 0 })).rejects.toThrow(/worker/u);
    } finally { await worker.close(); }
  });
});
