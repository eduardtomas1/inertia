import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { FILE_OPEN_DIRECTORY, FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import { CursorSdkStoreRecords, type CursorSdkStoreMutation } from "./cursor-sdk-store-records";

const JOURNAL = "native-store.v1.jsonl";
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
interface PinnedDirectory { path: string; fd: number; stat: BigIntStats }
let flock: ((fd: number) => number) | undefined;

function acquireLock(fd: number): void {
  if (!flock) {
    const require = createRequire(import.meta.url);
    const ffi = require("ffi-rs") as typeof import("ffi-rs");
    const library = "inertia-cursor-sdk-store";
    ffi.open({ library, path: "" });
    flock = (descriptor) => ffi.load({ library, funcName: "flock", retType: ffi.DataType.I32,
      paramsType: [ffi.DataType.I32, ffi.DataType.I32], paramsValue: [descriptor, 6] });
  }
  if (flock(fd) !== 0) throw new Error("Cursor SDK native store is already in use or cannot be locked.");
}

function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function fdPath(fd: number): string { return `/proc/self/fd/${fd}`; }
function assertPrivate(stat: BigIntStats, directory: boolean): void {
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
    || !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)) {
    throw new Error("Cursor SDK store requires private owned directories and single-link regular files.");
  }
}
function closeDirectories(chain: PinnedDirectory[]): void {
  for (const entry of chain.reverse()) closeSync(entry.fd);
}
function pinDirectory(path: string): PinnedDirectory[] {
  if (process.platform !== "linux" || !FILE_OPEN_NO_FOLLOW || !FILE_OPEN_DIRECTORY) {
    throw new Error("Cursor SDK durable store containment is verified only on Linux.");
  }
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Cursor SDK store paths must be canonical.");
  const parts = path.split(sep).filter(Boolean);
  if (parts.length > 64) throw new Error("Cursor SDK store path exceeds its limit.");
  const chain: PinnedDirectory[] = [];
  try {
    for (const name of ["/", ...parts]) {
      const previous = chain.at(-1);
      const requested = previous ? join(fdPath(previous.fd), name) : "/";
      const fd = openSync(requested, constants.O_RDONLY | FILE_OPEN_DIRECTORY | FILE_OPEN_NO_FOLLOW);
      chain.push({ path: previous ? join(previous.path, name) : "/", fd, stat: fstatSync(fd, { bigint: true }) });
    }
    verifyDirectories(chain);
    return chain;
  } catch (error) { closeDirectories(chain); throw error; }
}
function verifyDirectories(chain: readonly PinnedDirectory[]): void {
  for (const entry of chain) {
    const named = lstatSync(entry.path, { bigint: true });
    if (!named.isDirectory() || named.isSymbolicLink() || !same(entry.stat, named)
      || readlinkSync(fdPath(entry.fd)) !== entry.path) throw new Error("Cursor SDK store directory authority changed.");
  }
  assertPrivate(fstatSync(chain.at(-1)!.fd, { bigint: true }), true);
}
function createChild(parent: PinnedDirectory, name: string, existing = false): PinnedDirectory {
  const path = join(fdPath(parent.fd), name);
  if (!existing) {
    try { mkdirSync(path, { mode: 0o700 }); fsyncSync(parent.fd); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | FILE_OPEN_DIRECTORY | FILE_OPEN_NO_FOLLOW); }
  catch { throw new Error("Cursor SDK store namespace escaped or is not a directory."); }
  return { path: join(parent.path, name), fd, stat: fstatSync(fd, { bigint: true }) };
}

/**
 * The store of one provider instance in one checkout. `existing` opens the store a moved chat's session was
 * created in: nothing is created, and the checkout is a recorded key that need not exist any more (a removed
 * worktree), so it must be absolute and normalized rather than canonical on disk.
 */
export async function cursorSdkStoreDirectory(providerStateRoot: string, workspace: string, providerInstanceId: string,
  existing = false): Promise<string> {
  if (!isAbsolute(workspace) || !providerInstanceId.trim() || providerInstanceId.length > 1024
    || providerInstanceId.includes("\0") || workspace.includes("\0") || resolve(workspace) !== workspace
    || (!existing && realpathSync(workspace) !== workspace)) {
    throw new Error("Cursor SDK store identity and workspace must be canonical.");
  }
  const chain = pinDirectory(providerStateRoot);
  try {
    const identity = createHash("sha256").update(JSON.stringify([providerInstanceId, workspace])).digest("hex");
    for (const child of ["cursor-sdk", identity]) {
      if (existing && !childExists(chain.at(-1)!, child)) throw new CursorSdkStoreMissingError();
      chain.push(createChild(chain.at(-1)!, child, existing));
      verifyDirectories(chain);
    }
    return chain.at(-1)!.path;
  } finally { closeDirectories(chain); }
}

/** The store looked up does not exist; any other lookup failure is a storage error. */
export class CursorSdkStoreMissingError extends Error {
  constructor() { super("Cursor SDK store does not exist."); }
}

function childExists(parent: PinnedDirectory, name: string): boolean {
  try { lstatSync(join(fdPath(parent.fd), name)); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}

/** `existing`: open a store that already holds a journal for `workspace` (see `cursorSdkStoreDirectory`); never create one. */
export async function openCursorSdkStore(directory: string, workspace: string, secret?: string, existing = false): Promise<CursorSdkStoreRecords> {
  if (!isAbsolute(workspace) || workspace.includes("\0") || resolve(workspace) !== workspace
    || (!existing && realpathSync(workspace) !== workspace)) throw new Error("Cursor SDK workspace must be canonical.");
  const chain = pinDirectory(directory);
  let fd: number | undefined;
  let closed = false;
  let poisoned = false;
  let size = 0;
  let sequence = 0;
  let observed: BigIntStats;
  const root = chain.at(-1)!;
  const path = join(fdPath(root.fd), JOURNAL);
  const checkEntries = () => {
    if (readdirSync(fdPath(root.fd)).some((name) => name !== JOURNAL)) {
      throw new Error("Cursor SDK store contains legacy SQLite or unrecognized data; explicit migration is required.");
    }
  };
  const check = () => {
    if (closed || poisoned) throw new Error("Cursor SDK store is closed or requires recovery.");
    verifyDirectories(chain);
    checkEntries();
    const current = fstatSync(fd!, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    assertPrivate(current, false);
    if (named.isSymbolicLink() || !same(current, named) || !same(current, observed)
      || current.size !== BigInt(size) || current.mtimeNs !== observed.mtimeNs || current.ctimeNs !== observed.ctimeNs) {
      throw new Error("Cursor SDK store file authority changed.");
    }
  };
  const dispose = async () => {
    if (closed) return;
    closed = true;
    try { if (fd !== undefined) closeSync(fd); }
    finally { closeDirectories(chain); }
  };
  try {
    checkEntries();
    try { fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NONBLOCK | FILE_OPEN_NO_FOLLOW); }
    catch (error) {
      if (existing || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | FILE_OPEN_NO_FOLLOW, 0o600);
    }
    observed = fstatSync(fd, { bigint: true });
    assertPrivate(observed, false);
    acquireLock(fd);
    size = Number(observed.size);
    if (size > MAX_JOURNAL_BYTES) throw new Error("Cursor SDK journal exceeds its limit.");
    check();
    const append = (record: unknown) => {
      check();
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
      if (bytes.length > MAX_RECORD_BYTES || size + bytes.length > MAX_JOURNAL_BYTES) throw new Error("Cursor SDK journal exceeds its limit.");
      try {
        let written = 0;
        while (written < bytes.length) {
          const count = writeSync(fd!, bytes, written, bytes.length - written);
          if (!count) throw new Error("Cursor SDK journal write made no progress.");
          written += count;
        }
        fsyncSync(fd!);
        fsyncSync(root.fd);
        size += bytes.length;
        observed = fstatSync(fd!, { bigint: true });
        check();
      } catch (error) { poisoned = true; throw error; }
    };
    if (size === 0 && existing) throw new Error("Cursor SDK journal identity is invalid.");
    if (size === 0) append({ version: 1, workspace });
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) throw new Error("Cursor SDK journal read was truncated.");
      offset += count;
    }
    check();
    if (bytes.length !== size || bytes.at(-1) !== 10) throw new Error("Cursor SDK journal is truncated; explicit recovery is required.");
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n");
    lines.pop();
    const header: unknown = JSON.parse(lines.shift()!);
    if (!header || typeof header !== "object" || !("version" in header) || header.version !== 1
      || !("workspace" in header) || header.workspace !== workspace || Object.keys(header).length !== 2) throw new Error("Cursor SDK journal identity is invalid.");
    const store = new CursorSdkStoreRecords(check, (mutation: CursorSdkStoreMutation) => {
      append({ sequence: sequence + 1, mutation }); sequence += 1;
    }, dispose, secret);
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("Cursor SDK journal record exceeds its limit.");
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== "object" || !("sequence" in record) || record.sequence !== sequence + 1
        || !("mutation" in record) || Object.keys(record).length !== 2) throw new Error("Cursor SDK journal sequence is invalid.");
      store.replay(record.mutation); sequence += 1;
    }
    return store;
  } catch (error) { await dispose(); throw error; }
}

const ADOPTION_STAGING = ".adopting-";

function agentStoreName(providerInstanceId: string, agentId: string): string {
  if (!providerInstanceId.trim() || providerInstanceId.length > 1024 || providerInstanceId.includes("\0")
    || !agentId.trim() || agentId.length > 512 || agentId.includes("\0")) throw new Error("Cursor SDK agent store identity is invalid.");
  return createHash("sha256").update(JSON.stringify(["agent", providerInstanceId, agentId])).digest("hex");
}

/**
 * The store of one agent that left the checkout it was created in (adopted, see `adoptCursorSdkAgent`). Unlike a
 * checkout store it is used only by runs of that agent, which are one chat's runs, so moved chats never contend for
 * a lock. `create` makes the directory; otherwise null when it does not exist.
 */
export async function cursorSdkAgentStoreDirectory(providerStateRoot: string, providerInstanceId: string, agentId: string,
  create: boolean): Promise<string | null> {
  const name = agentStoreName(providerInstanceId, agentId);
  const chain = pinDirectory(providerStateRoot);
  try {
    for (const child of ["cursor-sdk", name]) {
      if (!create && !childExists(chain.at(-1)!, child)) return null;
      chain.push(createChild(chain.at(-1)!, child, !create));
      verifyDirectories(chain);
    }
    return chain.at(-1)!.path;
  } finally { closeDirectories(chain); }
}

/** Whether a store directory holds a journal. */
export async function cursorSdkStoreHasJournal(directory: string): Promise<boolean> {
  const chain = pinDirectory(directory);
  try { return readdirSync(fdPath(chain.at(-1)!.fd)).includes(JOURNAL); }
  finally { closeDirectories(chain); }
}

/**
 * The committed records of a checkout store, read without its lock: another chat may be running on that store.
 * The journal is append-only and every record is one line, so the complete lines are a state the store had; a
 * line still being written is left out. Nothing is written to the store.
 */
function readCursorSdkStoreSnapshot(directory: string, workspace: string, secret?: string): CursorSdkStoreRecords {
  const chain = pinDirectory(directory);
  let fd: number | undefined;
  try {
    fd = openSync(join(fdPath(chain.at(-1)!.fd), JOURNAL), constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    assertPrivate(stat, false);
    const size = Number(stat.size);
    if (size > MAX_JOURNAL_BYTES) throw new Error("Cursor SDK journal exceeds its limit.");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) break;
      offset += count;
    }
    verifyDirectories(chain);
    const end = bytes.subarray(0, offset).lastIndexOf(10);
    if (end < 0) throw new Error("Cursor SDK journal identity is invalid.");
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).split("\n");
    const header: unknown = JSON.parse(lines.shift()!);
    if (!header || typeof header !== "object" || !("version" in header) || header.version !== 1
      || !("workspace" in header) || header.workspace !== workspace || Object.keys(header).length !== 2) throw new Error("Cursor SDK journal identity is invalid.");
    const store = new CursorSdkStoreRecords(() => undefined, () => { throw new Error("Cursor SDK store snapshot is read-only."); },
      async () => undefined, secret);
    let sequence = 0;
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("Cursor SDK journal record exceeds its limit.");
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== "object" || !("sequence" in record) || record.sequence !== sequence + 1
        || !("mutation" in record) || Object.keys(record).length !== 2) throw new Error("Cursor SDK journal sequence is invalid.");
      store.replay(record.mutation); sequence += 1;
    }
    return store;
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeDirectories(chain);
  }
}

/**
 * Holds the exclusive lock of an agent's store directory (`flock` on the directory, non-blocking) while `locked` runs.
 * Adoptions and their cleanup take it, so two adopters of one agent never interleave.
 */
export function withCursorSdkAgentStoreLock<T>(agentDirectory: string, locked: (root: PinnedDirectory) => T): T {
  const chain = pinDirectory(agentDirectory);
  try {
    acquireLock(chain.at(-1)!.fd);
    return locked(chain.at(-1)!);
  } finally { closeDirectories(chain); }
}

/**
 * Makes an agent's own store ready to open: it holds the journal, and nothing else. When it has no journal yet and
 * `adoption` is given, the agent moves in from the checkout store it was created in, the first time a chat runs it in
 * another checkout. Under the agent store's lock:
 *
 * - the checkout store is only read, without its lock (`readCursorSdkStoreSnapshot`), and keeps its records;
 * - only a settled agent is copied (`exportAgent`): a copy caught between its run's and its own terminal write is
 *   refused before anything is written, and a later turn copies again;
 * - the copy is written in full under a staging name and renamed into place, so the store holds the whole agent or no
 *   journal; staging files an interrupted adoption left are removed, also beside a journal;
 * - a journal is never replaced. The journal names the same checkout as the agent document's cwd.
 */
export async function prepareCursorSdkAgentStore(agentDirectory: string, adoption?: {
  sourceDirectory: string; workspace: string; agentId: string; secret?: string;
}): Promise<void> {
  if (adoption && (!isAbsolute(adoption.workspace) || adoption.workspace.includes("\0") || resolve(adoption.workspace) !== adoption.workspace)) {
    throw new Error("Cursor SDK workspace must be canonical.");
  }
  withCursorSdkAgentStoreLock(agentDirectory, (root) => {
    const names = readdirSync(fdPath(root.fd));
    for (const name of names) {
      if (name === JOURNAL) continue;
      const stale = join(fdPath(root.fd), name);
      if (!name.startsWith(ADOPTION_STAGING) || !lstatSync(stale).isFile()) throw new Error("Cursor SDK agent store contains unrecognized data.");
      unlinkSync(stale);
    }
    if (names.includes(JOURNAL)) { fsyncSync(root.fd); return; }
    if (!adoption) throw new Error("Cursor SDK agent store has no journal.");
    const mutations = readCursorSdkStoreSnapshot(adoption.sourceDirectory, adoption.workspace, adoption.secret).exportAgent(adoption.agentId);
    const records = [{ version: 1, workspace: adoption.workspace }, ...mutations.map((mutation, index) => ({ sequence: index + 1, mutation }))]
      .map((record) => Buffer.from(`${JSON.stringify(record)}\n`));
    if (records.some((record) => record.length > MAX_RECORD_BYTES)
      || records.reduce((total, record) => total + record.length, 0) > MAX_JOURNAL_BYTES) throw new Error("Cursor SDK journal exceeds its limit.");
    const staging = join(fdPath(root.fd), `${ADOPTION_STAGING}${randomUUID()}`);
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | FILE_OPEN_NO_FOLLOW, 0o600);
    try {
      for (const bytes of records) {
        let written = 0;
        while (written < bytes.length) {
          const count = writeSync(fd, bytes, written, bytes.length - written);
          if (!count) throw new Error("Cursor SDK journal write made no progress.");
          written += count;
        }
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(staging, join(fdPath(root.fd), JOURNAL));
    fsyncSync(root.fd);
  });
}
