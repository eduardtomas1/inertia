import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import { objectValue, type JsonObject } from "../codex/protocol";
import { isContainedPath, plainPathComponents } from "./claude-config-files";

export function isPiSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu.test(value);
}

export async function preparePiSessionDirectory(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const parent = await realpath(dirname(path));
  if (parent !== resolve(dirname(path))) throw new Error("Pi configuration directory must be canonical.");
  const before = await lstat(parent);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Pi configuration directory is unsafe.");
  await mkdir(path, { mode: 0o700 });
  return await checkPiDirectory(path, parent, signal);
}

async function checkPiDirectory(path: string, parent: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!await plainPathComponents(parent, path, { signal }) || await realpath(path) !== resolve(path)) throw new Error("Pi session directory is unsafe.");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Pi session directory is unsafe.");
  return resolve(path);
}

export async function ensurePiSessionDirectory(path: string, signal?: AbortSignal): Promise<string> {
  try { return await preparePiSessionDirectory(path, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await checkPiDirectory(path, await realpath(dirname(path)), signal);
  }
}

const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 20_000;

/** Opens an owned session file: directly inside `root`, a plain single-link regular file, bounded, not replaced. */
async function openOwnedPiSessionFile(path: string, root: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!isContainedPath(root, path) || dirname(path) !== root
    || !await plainPathComponents(root, path, { signal }) || await realpath(path) !== path) {
    throw new Error("Pi session reference escaped its owned directory.");
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SESSION_BYTES) throw new Error("Pi session is not a bounded regular file.");
  const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(path) !== path) {
      throw new Error("Pi session identity changed while opening.");
    }
    return { handle, size: opened.size, links: opened.nlink };
  } catch (error) { await handle.close(); throw error; }
}

/** A session file whose entries Inertia cannot read within its limits; a copy of it cannot be verified (an ordinary failure). */
export class PiSessionFormatError extends Error {
  constructor() { super("Pi session entries are invalid or exceed their limits."); }
}

/**
 * The ids of a session file's entries in file order, read without Pi as Pi reads them (`loadEntriesFromFile`): every
 * line after the header, skipping blank and unparseable ones. The owned file stays readable when the checkout it
 * names was removed. Bounded by the file and entry limits.
 */
export async function readPiSessionEntryIds(path: string, root: string, signal?: AbortSignal): Promise<string[]> {
  const { handle, size } = await openOwnedPiSessionFile(path, root, signal);
  try {
    // Not fatal: Pi decodes the same way and keeps such a line.
    const decoder = new TextDecoder("utf-8");
    const ids: string[] = [];
    let pending = Buffer.alloc(0); let offset = 0; let header = true;
    const take = (line: Buffer): void => {
      if (header) { header = false; return; }
      const text = decoder.decode(line);
      if (!text.trim()) return;
      // Pi skips a line it cannot parse (`parseSessionEntryLine`), such as a last line torn by a killed process.
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return; }
      const entry = objectValue(parsed);
      if (!entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 512 || ids.length >= MAX_SESSION_ENTRIES) {
        throw new PiSessionFormatError();
      }
      ids.push(entry.id);
    };
    const chunk = Buffer.alloc(1024 * 1024);
    while (offset < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline = pending.indexOf(10);
      while (newline >= 0) { take(pending.subarray(0, newline)); pending = pending.subarray(newline + 1); newline = pending.indexOf(10); }
      if (pending.length > 32 * 1024 * 1024) throw new PiSessionFormatError();
    }
    take(pending);
    return ids;
  } finally { await handle.close(); }
}

/**
 * Removes a session file this run created and never announced (a copy whose start failed), best effort. Only a
 * single-link regular file directly in `root`, named for `sessionId`, whose header names that session.
 */
export async function removeUnannouncedPiSession(root: string, sessionId: string, path: string): Promise<boolean> {
  try {
    if (!isPiSessionId(sessionId) || dirname(path) !== root || !basename(path).endsWith(`_${sessionId}.jsonl`)) return false;
    const header = await readPiSessionHeader(path, root);
    const { handle, links } = await openOwnedPiSessionFile(path, root);
    await handle.close();
    if (header.id !== sessionId || links !== 1) return false;
    await unlink(path);
    return true;
  } catch { return false; }
}

export async function readPiSessionHeader(path: string, root: string, signal?: AbortSignal): Promise<JsonObject> {
  const { handle } = await openOwnedPiSessionFile(path, root, signal);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) throw new Error("Pi session header is missing or oversized.");
    const header = objectValue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline))));
    if (!header || header.type !== "session" || !isPiSessionId(header.id) || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) {
      throw new Error("Pi session header has invalid native identity.");
    }
    return header;
  } finally { await handle.close(); }
}

/** The session's file does not exist (any longer); a resume can only start a new session. */
export class PiSessionMissingError extends Error {
  constructor() { super("The selected Pi session no longer exists."); }
}

/** Whether a session header's cwd names `cwd`: the same path, or both resolve to the same folder. A missing folder matches only itself. */
export async function piSessionInCheckout(headerCwd: string, cwd: string): Promise<boolean> {
  if (headerCwd === cwd) return true;
  try { return await realpath(headerCwd) === await realpath(cwd); } catch { return false; }
}

/** The owned file of a session and its header, whichever checkout the header names. */
export async function locatePiSessionFile(root: string, sessionId: string, signal?: AbortSignal): Promise<{ file: string; cwd: string }> {
  if (!isPiSessionId(sessionId)) throw new Error("Pi session ID is invalid.");
  const directory = await opendir(root);
  let found: string | undefined; let count = 0;
  for await (const entry of directory) {
    signal?.throwIfAborted();
    if (++count > 10_000) throw new Error("Pi session directory exceeds its lookup limit.");
    if (!entry.name.endsWith(`_${sessionId}.jsonl`)) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || found) throw new Error("Pi session reference is unsafe or ambiguous.");
    found = join(root, entry.name);
  }
  if (!found) throw new PiSessionMissingError();
  const header = await readPiSessionHeader(found, root, signal);
  if (header.id !== sessionId) throw new Error("Pi session header has invalid native identity.");
  return { file: found, cwd: header.cwd as string };
}

export async function findPiSessionFile(root: string, sessionId: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const located = await locatePiSessionFile(root, sessionId, signal);
  if (!await piSessionInCheckout(located.cwd, cwd)) throw new Error("Pi session does not belong to the selected workspace.");
  return located.file;
}

/** The names in the owned session folder, to tell a session Pi creates from one that already existed. */
export async function listPiSessionFiles(root: string, signal?: AbortSignal): Promise<Set<string>> {
  signal?.throwIfAborted();
  const names = await readdir(root);
  if (names.length > 10_000) throw new Error("Pi session directory exceeds its lookup limit.");
  return new Set(names);
}

export async function requireUnusedPiSessionId(root: string, sessionId: string, signal?: AbortSignal): Promise<void> {
  if (!isPiSessionId(sessionId)) throw new Error("Pi session ID is invalid.");
  let count = 0;
  for await (const entry of await opendir(root)) {
    signal?.throwIfAborted();
    if (++count > 10_000) throw new Error("Pi session directory exceeds its lookup limit.");
    if (entry.name.endsWith(`_${sessionId}.jsonl`)) throw new Error("The new Pi session identity already exists.");
  }
}

export interface PiSessionState {
  id: string;
  file: string;
  streaming: boolean;
  compacting: boolean;
  pending: number;
  model: JsonObject | undefined;
  thinking: string | undefined;
}

export function piSessionState(value: unknown, root: string, expectedId?: string): PiSessionState {
  const state = objectValue(value);
  if (!state || !isPiSessionId(state.sessionId) || (expectedId !== undefined && state.sessionId !== expectedId)
    || typeof state.sessionFile !== "string" || !isAbsolute(state.sessionFile)
    || dirname(state.sessionFile) !== root || !basename(state.sessionFile).endsWith(`_${state.sessionId}.jsonl`)
    || typeof state.isStreaming !== "boolean" || typeof state.isCompacting !== "boolean"
    || !Number.isSafeInteger(state.pendingMessageCount) || (state.pendingMessageCount as number) < 0) {
    throw new Error("Pi did not attest the exact owned native session.");
  }
  return { id: state.sessionId, file: state.sessionFile, streaming: state.isStreaming, compacting: state.isCompacting,
    pending: state.pendingMessageCount as number, model: objectValue(state.model),
    thinking: typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined };
}
