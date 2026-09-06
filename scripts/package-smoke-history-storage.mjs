import { deepStrictEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";

const imageSmokeId = "00000000-0000-4000-8000-000000000018";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const windowsBootId = /^win32:[0-9a-f]{8}$/u;
const runtimeGenerationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$/u;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const generationHash = (generation) => hash(Buffer.from(generation, "utf8"));

function environmentValue(environment, name) {
  return Object.entries(environment).find(([key, value]) =>
    key.toLowerCase() === name.toLowerCase() && typeof value === "string")?.[1];
}

export function readWindowsSystemBootId(options = {}) {
  const environment = options.environment ?? process.env;
  const spawn = options.spawn ?? spawnSync;
  const root = environmentValue(environment, "SystemRoot");
  ok(typeof root === "string" && root === root.trim() && root.length <= 32_767
    && win32.isAbsolute(root) && /^[a-z]:\\/iu.test(root),
  "The Windows package-smoke boot identity root is invalid.");
  const result = spawn(win32.join(root, "System32", "reg.exe"), [
    "QUERY",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters",
    "/v",
    "BootId",
    "/reg:64",
  ], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 1_000,
    maxBuffer: 4_096,
    env: { SystemRoot: root, SYSTEMROOT: root, WINDIR: root },
  });
  ok(result.status === 0 && !result.error && typeof result.stdout === "string",
    "The Windows package-smoke boot identity is unavailable.");
  const matches = [...result.stdout.matchAll(
    /(?:^|\s)BootId\s+REG_DWORD\s+0x([0-9a-f]{1,8})(?=\s|$)/giu,
  )];
  ok(matches.length === 1, "The Windows package-smoke boot identity is ambiguous.");
  const value = `win32:${matches[0][1].toLowerCase().padStart(8, "0")}`;
  ok(windowsBootId.test(value), "The Windows package-smoke boot identity is invalid.");
  return value;
}

function recoveryFixtureShape(value) {
  ok(value && typeof value === "object" && value.version === 1
    && windowsBootId.test(value.systemBootId)
    && Array.isArray(value.generationIds) && value.generationIds.length === 2
    && value.generationIds.every((generation) => runtimeGenerationId.test(generation))
    && new Set(value.generationIds).size === 2
    && Array.isArray(value.files) && value.files.length === 8
    && Array.isArray(value.directories) && value.directories.length === 2,
  "Invalid Windows zero-PID recovery fixture.");
  const paths = [...value.files.map(({ path }) => path), ...value.directories];
  ok(new Set(paths).size === paths.length && paths.every((path) =>
    typeof path === "string" && path.startsWith(`data${sep}`)
      && !isAbsolute(path) && !path.split(sep).includes("..")),
  "Windows zero-PID recovery fixture paths are invalid.");
  ok(value.files.every((entry) => entry && Object.keys(entry).sort().join("\0") === "path\0sha256"
    && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/u.test(entry.sha256)),
  "Windows zero-PID recovery fixture digests are invalid.");
  return value;
}

async function fixtureFile(stateRoot, root, name, value, files) {
  const path = join(root, name);
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  files.push({ path: relative(stateRoot, path), sha256: hash(bytes) });
}

export async function prepareWindowsLegacyZeroPidRecoveryFixture(
  stateRoot,
  systemBootId,
) {
  ok(windowsBootId.test(systemBootId), "The Windows zero-PID fixture boot identity is invalid.");
  const root = join(stateRoot, "data");
  const rootInfo = await lstat(root);
  ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink()
    && await realpath(root) === root, "The Windows zero-PID fixture root is not direct.");
  const generations = [
    { id: `${randomUUID()}:50`, sessionSuffix: "json", writerSuffix: "active", zeroPidClaims: 2 },
    { id: `${randomUUID()}:51`, sessionSuffix: "retire.tmp", writerSuffix: "retire", zeroPidClaims: 0 },
  ];
  const files = [];
  const directories = [];
  for (const generation of generations) {
    const digest = generationHash(generation.id);
    const lease = { version: 1, runtimeGenerationId: generation.id,
      systemBootId, createdAt: new Date().toISOString() };
    const session = { version: 1, runtimeGenerationId: generation.id, systemBootId };
    const containment = { version: 1, runtimeGenerationId: generation.id, systemBootId,
      containment: { kind: "windows-job-v1", name: `Global\\InertiaRuntime-${digest}` } };
    await fixtureFile(stateRoot, root, `.runtime-generation-lease-${digest}.json`, lease, files);
    await fixtureFile(stateRoot, root,
      `.runtime-owned-process-session-${digest}.${generation.sessionSuffix}`, session, files);
    await fixtureFile(stateRoot, root,
      `.runtime-owned-process-containment-${digest}.json`, containment, files);
    const writer = `.runtime-owned-process-writer-${digest}.${generation.writerSuffix}`;
    await mkdir(join(root, writer), { mode: 0o700 });
    directories.push(relative(stateRoot, join(root, writer)));
    for (let index = 0; index < generation.zeroPidClaims; index += 1) {
      const ownershipId = randomUUID();
      const startedAfterMs = Date.now();
      const claim = { version: 1, state: "owned", ownershipId,
        runtimeGenerationId: generation.id, systemBootId,
        process: { platform: "win32", pid: 0, processGroupId: null,
          startedAfterMs, startedBeforeMs: startedAfterMs + 1 } };
      await fixtureFile(stateRoot, root, `.runtime-owned-child-${ownershipId}.json`, claim, files);
    }
  }
  const fixture = recoveryFixtureShape({ version: 1, systemBootId,
    generationIds: generations.map(({ id }) => id), files, directories });
  await assertWindowsLegacyZeroPidRecoveryFixture(stateRoot, fixture);
  return fixture;
}

export async function assertWindowsLegacyZeroPidRecoveryFixture(stateRoot, fixture) {
  recoveryFixtureShape(fixture);
  for (const entry of fixture.files) {
    const bytes = await readFixture(stateRoot, join(stateRoot, entry.path), 4_096);
    ok(hash(bytes) === entry.sha256, "Windows zero-PID recovery fixture changed before launch.");
  }
  for (const relativePath of fixture.directories) {
    const path = join(stateRoot, relativePath);
    const info = await lstat(path);
    ok(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path,
      "Windows zero-PID recovery fixture writer is not direct.");
    ok((await readdir(path)).length === 0,
      "Windows zero-PID recovery fixture writer is not empty.");
  }
}

export async function assertWindowsLegacyZeroPidRecoveryRetired(stateRoot, fixture) {
  recoveryFixtureShape(fixture);
  for (const relativePath of [
    ...fixture.files.map(({ path }) => path),
    ...fixture.directories,
  ]) {
    const info = await lstat(join(stateRoot, relativePath)).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    ok(info === null, `Windows zero-PID recovery artifact was not retired: ${relativePath}`);
  }
}

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
  if (baseline.runtimeRecovery !== undefined) {
    recoveryFixtureShape(baseline.runtimeRecovery);
  }
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

export async function prepareHistoryBaseline(stateRoot, path, proof, options = {}) {
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
    const runtimeRecovery = options.windowsRecoveryBootId
      ? await prepareWindowsLegacyZeroPidRecoveryFixture(
          stateRoot,
          options.windowsRecoveryBootId,
        )
      : undefined;
    const baseline = { version: 1, ...proof,
      messages: proof.messages.map((message) => message.id === user.id
        ? { ...message, attachments: [attachment] } : message),
      attachment: metadata, attachmentBytes: bytes.toString("base64"),
      ...(runtimeRecovery ? { runtimeRecovery } : {}) };
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
