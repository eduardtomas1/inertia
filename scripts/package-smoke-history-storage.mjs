import { deepStrictEqual, ok } from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const imageSmokeId = "00000000-0000-4000-8000-000000000018";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function directFile(root, path, maxBytes) {
  const canonicalRoot = await realpath(root);
  const child = relative(canonicalRoot, path);
  ok(child && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`),
    "Smoke fixture file escapes its disposable root.");
  let ancestor = canonicalRoot;
  for (const segment of child.split(sep).slice(0, -1)) {
    ancestor = join(ancestor, segment);
    const info = await lstat(ancestor);
    ok(info.isDirectory() && !info.isSymbolicLink(), "Smoke fixture directory is not direct.");
  }
  const info = await lstat(path);
  ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maxBytes
    && await realpath(path) === path, "Smoke fixture file is not direct or bounded.");
  return info;
}

async function readFixture(root, path, maxBytes) {
  const before = await directFile(root, path, maxBytes);
  const file = await open(path, constants.O_RDONLY);
  try {
    const pinned = await file.stat();
    ok(pinned.dev === before.dev && pinned.ino === before.ino && pinned.size === before.size,
      "Smoke fixture file was replaced while opening it.");
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    ok(bytesRead === before.size, "Smoke fixture file changed size while reading it.");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

async function databaseFor(stateRoot, readOnly) {
  const path = join(stateRoot, "data", "inertia.sqlite");
  await directFile(stateRoot, path, 1024 * 1024 * 1024);
  // Raw SQLite only: opening N-1's database must not run current migrations.
  const database = new DatabaseSync(path, { readOnly });
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return database;
}

function persistedMessage(database, id) {
  const row = database.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  if (!row) return null;
  const chunks = database.prepare(`SELECT content FROM message_content_chunks
    WHERE message_id = ? ORDER BY sequence`).all(id);
  return { id: row.id, conversationId: row.conversation_id, turnId: row.turn_id,
    role: row.role, content: row.content + chunks.map(({ content }) => content).join(""),
    attachments: JSON.parse(row.attachments_json), createdAt: row.created_at };
}

function assertPersistedTurn(database, proof) {
  for (const message of proof.messages) {
    deepStrictEqual(persistedMessage(database, message.id), message,
      "Saved message/content/attachments did not survive clean shutdown.");
  }
  for (const turn of proof.agentTurns) {
    const saved = database.prepare(`SELECT id, conversation_id, run_id, user_message_id,
      terminal_assistant_message_id, provider_id, status, started_at, completed_at,
      provider_session_after FROM agent_turns WHERE id = ?`).get(turn.id);
    deepStrictEqual(saved && { ...saved }, {
      id: turn.id, conversation_id: turn.conversationId, run_id: turn.runId,
      user_message_id: turn.userMessageId, terminal_assistant_message_id: turn.terminalAssistantMessageId,
      provider_id: "codex", status: "completed", started_at: turn.startedAt,
      completed_at: turn.completedAt, provider_session_after: turn.providerSessionAfter,
    }, "Completed provider turn did not survive clean shutdown.");
  }
}

export async function readHistoryBaseline(path) {
  const baseline = JSON.parse(await readFixture(dirname(path), path, 256 * 1024));
  ok(baseline.version === 1 && uuid.test(baseline.conversation?.id)
    && uuid.test(baseline.attachment?.id) && baseline.messages?.length === 2
    && baseline.agentTurns?.length === 1, "Invalid installed-upgrade history baseline.");
  return baseline;
}

export async function assertHistoryAttachment(stateRoot, baseline) {
  const { id } = baseline.attachment;
  ok(uuid.test(id) && id !== imageSmokeId, "Historical attachment identity is not independent.");
  const directory = join(stateRoot, "data", "conversation-attachments", id);
  const metadata = JSON.parse(await readFixture(stateRoot, join(directory, "metadata.json"), 4096));
  deepStrictEqual(metadata, baseline.attachment, "Historical attachment metadata changed.");
  const bytes = await readFixture(stateRoot, join(directory, `${id}.png`), 4096);
  ok(bytes.length === metadata.size && hash(bytes) === metadata.digest
    && bytes.toString("base64") === baseline.attachmentBytes,
  "Historical attachment bytes changed or disappeared.");
}

export async function prepareHistoryBaseline(stateRoot, path, proof) {
  const source = join(stateRoot, "data", "conversation-attachments", imageSmokeId);
  const original = JSON.parse(await readFixture(stateRoot, join(source, "metadata.json"), 4096));
  const bytes = await readFixture(stateRoot, join(source, `${imageSmokeId}.png`), 4096);
  ok(original.id === imageSmokeId && original.extension === "png"
    && original.mimeType === "image/png" && original.size === bytes.length
    && original.digest === hash(bytes), "N-1 did not retain the expected real image bytes.");
  const id = randomUUID();
  const metadata = { ...original, id, name: "Saved before upgrade Ω.png" };
  const attachment = { id, path: id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size };
  const directory = join(stateRoot, "data", "conversation-attachments", id);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, `${id}.png`), bytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
  const database = await databaseFor(stateRoot, false);
  try {
    assertPersistedTurn(database, proof);
    // Fixture preparation after confirmed N-1 shutdown, not upload UI proof.
    // Bind N-1's retained bytes to its actual saved user message using only
    // its existing schema; never instantiate the candidate RuntimeStore here.
    const user = proof.messages.find(({ role }) => role === "user");
    const changed = database.prepare(`UPDATE messages SET attachments_json = ?
      WHERE id = ? AND conversation_id = ? AND turn_id = ? AND role = 'user'
      AND attachments_json = '[]'`).run(JSON.stringify([attachment]),
    user.id, user.conversationId, user.turnId);
    ok(changed.changes === 1, "N-1 historical attachment binding did not match its saved message.");
    const baseline = { version: 1, ...proof,
      messages: proof.messages.map((message) => message.id === user.id
        ? { ...message, attachments: [attachment] } : message),
      attachment: metadata, attachmentBytes: bytes.toString("base64") };
    assertPersistedTurn(database, baseline);
    await assertHistoryAttachment(stateRoot, baseline);
    // Kept outside application state: deleting or recreating the profile cannot
    // replace the expected history. The candidate only reads this file.
    await writeFile(path, JSON.stringify(baseline, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return baseline;
  } finally { database.close(); }
}

export async function assertHistoryAfterShutdown(stateRoot, proof, baseline = null) {
  const database = await databaseFor(stateRoot, true);
  try {
    if (baseline) assertPersistedTurn(database, baseline);
    assertPersistedTurn(database, proof);
  } finally { database.close(); }
  if (baseline) await assertHistoryAttachment(stateRoot, baseline);
}
