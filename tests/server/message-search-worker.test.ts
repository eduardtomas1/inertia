import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { runMessageSearchWorker as RunWorker } from "../../src/server/persistence/message-search-worker-client";
import { RuntimeStore } from "../../src/server/database";

let directory: string;
let databasePath: string;
let run: typeof RunWorker;

// This hook builds workers, migrates the database and writes ~50 MB. Hosted
// Intel setup has taken 16 seconds; this allowance does not change the worker's
// two-second search budget or the individual test deadlines.
beforeAll(async () => {
  // Keep external native dependencies resolvable from the emitted worker.
  directory = await mkdtemp(resolve("node_modules/.message-search-test-"));
  databasePath = join(directory, "fixture.sqlite");
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await build({
    entryPoints: ["src/server/persistence/message-search-worker.ts", "src/server/persistence/message-search-worker-client.ts"],
    outdir: directory, bundle: true, platform: "node", format: "esm", packages: "external",
  });
  const module = await import(/* @vite-ignore */ pathToFileURL(join(directory, "message-search-worker-client.js")).href) as { runMessageSearchWorker: typeof RunWorker };
  run = module.runMessageSearchWorker;
  const store = new RuntimeStore(databasePath, directory);
  let conversationId: string;
  try {
    const project = store.createProject("Worker search fixture", directory);
    conversationId = store.createConversation(project.id, "Search history").id;
  } finally { store.close(); }
  const db = new Database(databasePath);
  try {
    db.pragma("journal_mode = WAL");
    // Populate the same 100,000-message, ~50 MB history in one atomic statement.
    // Avoid 100,000 JavaScript-to-SQLite calls before exercising the real worker.
    db.prepare(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 99999
      )
      INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at)
      SELECT printf('message-%06d', value), ?, NULL, 'user',
        CASE WHEN value = 99999 THEN 'The rare needle' ELSE ? END,
        '[]', '2026-09-07T00:00:00.000Z'
      FROM sequence
    `).run(conversationId, "a".repeat(500));
    expect(db.prepare("SELECT count(*) AS count, sum(length(content)) AS characters FROM messages").get())
      .toEqual({ count: 100_000, characters: 49_999_515 });
  } finally { db.close(); }
}, 30_000);

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("actual isolated search worker", () => {
  it("searches 100,000 messages while the runtime remains responsive and writable", async () => {
    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 5);
    const writer = new Database(databasePath);
    try {
      const pending = run(databasePath, "rare needle", new AbortController().signal);
      writer.prepare("UPDATE messages SET content = content WHERE id = ?").run("message-000000");
      const result = await pending;
      expect(result.hits[0]?.messageId).toBe("message-099999");
      // Slow CI hosts may legitimately reach the explicit two-second budget.
      expect(result.hasMore).toBe(false);
      expect(heartbeats).toBeGreaterThan(2);
    } finally { clearInterval(timer); writer.close(); }
  });

  it("terminates a running scan and rejects pre-cancelled or missing-database requests", async () => {
    const controller = new AbortController();
    const pending = run(databasePath, "absent needle", controller.signal);
    const rejected = expect(pending).rejects.toThrow(/cancelled/u);
    controller.abort();
    await rejected;
    await expect(run(databasePath, "needle", controller.signal)).rejects.toThrow(/cancelled/u);
    await expect(run(join(directory, "missing.sqlite"), "needle", new AbortController().signal)).rejects.toThrow("Message search failed.");
    // A subsequent worker succeeds after termination; no stale lock or job remains.
    expect((await run(databasePath, "rare needle", new AbortController().signal)).hits).toHaveLength(1);
  });
});
