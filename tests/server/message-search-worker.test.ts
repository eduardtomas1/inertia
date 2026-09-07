import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { runMessageSearchWorker as RunWorker } from "../../src/server/persistence/message-search-worker-client";

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
  const db = new Database(databasePath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, archived_at TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, turn_id TEXT, role TEXT, content TEXT, attachments_json TEXT, created_at TEXT);
      CREATE TABLE agent_turns (id TEXT PRIMARY KEY, conversation_id TEXT, terminal_assistant_message_id TEXT);
      CREATE TABLE message_content_chunks (message_id TEXT, sequence INTEGER, content TEXT, PRIMARY KEY(message_id, sequence));
    `);
    const project = "11111111-1111-4111-8111-111111111111";
    db.prepare("INSERT INTO projects VALUES (?)").run(project);
    db.prepare("INSERT INTO conversations VALUES (?, ?, NULL)").run(project, project);
    const insert = db.prepare("INSERT INTO messages VALUES (?, ?, NULL, 'user', ?, '[]', '2026-09-07T00:00:00.000Z')");
    db.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) {
        insert.run(`message-${String(index).padStart(6, "0")}`, project, index === 99_999 ? "The rare needle" : "a".repeat(500));
      }
    })();
  } finally { db.close(); }
});

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
