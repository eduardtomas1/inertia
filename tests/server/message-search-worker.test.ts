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
    const insert = db.prepare("INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at) VALUES (?, ?, NULL, 'user', ?, '[]', '2026-09-07T00:00:00.000Z')");
    db.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) {
        insert.run(`message-${String(index).padStart(6, "0")}`, conversationId, index === 99_999 ? "The rare needle" : "a".repeat(500));
      }
    })();
  } finally { db.close(); }
// Seeding 50 MiB plus indexes competes with the full suite's filesystem work.
// This bounds fixture construction only; worker search/cancellation deadlines
// and the real 100,000-message workload below are unchanged.
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
