import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
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

export async function readPiSessionHeader(path: string, root: string, signal?: AbortSignal): Promise<JsonObject> {
  signal?.throwIfAborted();
  if (!isContainedPath(root, path) || dirname(path) !== root
    || !await plainPathComponents(root, path, { signal }) || await realpath(path) !== path) {
    throw new Error("Pi session reference escaped its owned directory.");
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 256 * 1024 * 1024) throw new Error("Pi session is not a bounded regular file.");
  const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(path) !== path) {
      throw new Error("Pi session identity changed while opening.");
    }
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

export async function findPiSessionFile(root: string, sessionId: string, cwd: string, signal?: AbortSignal): Promise<string> {
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
  if (!found) throw new Error("The selected Pi session no longer exists.");
  const header = await readPiSessionHeader(found, root, signal);
  if (header.id !== sessionId || await realpath(header.cwd as string) !== await realpath(cwd)) {
    throw new Error("Pi session does not belong to the selected workspace.");
  }
  return found;
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
