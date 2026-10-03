import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import type { CliConversationCandidate, CliConversationPreview, CliConversationScan, CliProvider } from "../../shared/cli-conversations";
import { environmentValue, expandHomePath } from "../environment";
import { acpEnvironmentSecretValues } from "../provider/acp-redaction";
import type { CliSessionOwnership } from "../persistence/cli-conversation-import";
import { RuntimeRequestError } from "../runtime-errors";
import { parseCliTranscript, transcriptWorkspace, type ParsedCliTranscript } from "./transcript";

export const CLI_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const HEAD_CHUNK_BYTES = 16 * 1024;
const HEAD_MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 100;
const GRANT_LIFETIME_MS = 10 * 60 * 1000;
export interface CliScanLimits { entries: number; reads: number; headerBytes: number; bytes: number; milliseconds: number }
const DEFAULT_SCAN_LIMITS: CliScanLimits = { entries: 3_000, reads: 1_000, headerBytes: 32 * 1024 * 1024, bytes: 64 * 1024 * 1024, milliseconds: 5_000 };
interface Root { providerId: CliProvider; path: string }
interface Grant { projectId: string; workspace: string; root: string; path: string; providerId: CliProvider; expiresAt: number }
interface Found { grant: Grant; candidate: Omit<CliConversationCandidate, "id"> }
export interface ReadCliConversation { transcript: ParsedCliTranscript; revision: string; sourceKey: string; providerId: CliProvider }

export function cliConversationRoots(environment: NodeJS.ProcessEnv = process.env): Root[] {
  const root = (key: string, fallback: string): string => {
    const value = environmentValue(environment, key)?.trim();
    return value ? resolve(expandHomePath(value)) : join(homedir(), fallback);
  };
  return [
    { providerId: "codex", path: join(root("CODEX_HOME", ".codex"), "sessions") },
    { providerId: "codex", path: join(root("CODEX_HOME", ".codex"), "archived_sessions") },
    { providerId: "claude", path: join(root("CLAUDE_CONFIG_DIR", ".claude"), "projects") },
  ];
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function openTranscript(root: string, path: string) {
  if (!contained(root, path) || relative(path, await realpath(path)) !== "") throw new Error("Invalid transcript path.");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsupported transcript file.");
  const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
  try {
    const pinned = await handle.stat();
    if (!pinned.isFile() || pinned.dev !== before.dev || pinned.ino !== before.ino) throw new Error("Transcript changed.");
    return { handle, before, pinned };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readHead(root: string, path: string, provider: CliProvider): Promise<{ cwd: string | null; bytes: number }> {
  const { handle } = await openTranscript(root, path);
  try {
    let head = Buffer.alloc(0);
    while (head.length < HEAD_MAX_BYTES) {
      const chunk = Buffer.alloc(HEAD_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, head.length);
      head = Buffer.concat([head, chunk.subarray(0, bytesRead)]);
      const ended = bytesRead < chunk.length;
      const cwd = transcriptWorkspace(`${head.toString("utf8")}${ended ? "\n" : ""}`, provider);
      if (cwd !== undefined || ended) return { cwd: cwd ?? null, bytes: head.length };
    }
    return { cwd: null, bytes: head.length };
  } finally { await handle.close(); }
}

class OversizedTranscript extends Error {}

async function readTranscript(root: string, path: string): Promise<{ source: string; date: string; bytes: number; revision: string }> {
  const { handle, before, pinned } = await openTranscript(root, path);
  try {
    if (before.size > CLI_TRANSCRIPT_MAX_BYTES || pinned.size > CLI_TRANSCRIPT_MAX_BYTES) throw new OversizedTranscript("Transcript is too large.");
    if (pinned.size !== before.size) throw new Error("Transcript changed.");
    const buffer = Buffer.alloc(pinned.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (offset !== pinned.size || after.size !== pinned.size || after.mtimeMs !== pinned.mtimeMs || after.ctimeMs !== pinned.ctimeMs
      || current.dev !== pinned.dev || current.ino !== pinned.ino || relative(path, await realpath(path)) !== "") throw new Error("Transcript changed.");
    const bytes = buffer.subarray(0, offset);
    return { source: bytes.toString("utf8"), date: after.mtime.toISOString(), bytes: offset, revision: createHash("sha256").update(bytes).digest("hex") };
  } finally { await handle.close(); }
}

export class CliConversationDiscovery {
  private readonly grants = new Map<string, Grant>();
  private readonly limits: CliScanLimits;
  private queue: Promise<unknown> = Promise.resolve();
  private latest: { key: string; scan: Promise<CliConversationScan> } | null = null;
  constructor(
    private readonly roots: readonly Root[] = cliConversationRoots(),
    private readonly secrets: readonly string[] = acpEnvironmentSecretValues(process.env),
    private readonly signal?: AbortSignal,
    limits: Partial<CliScanLimits> = {},
  ) {
    this.limits = { ...DEFAULT_SCAN_LIMITS, ...limits };
  }

  scan(projectId: string, workspacePath: string, imported: (provider: CliProvider, sessionId: string) => CliSessionOwnership): Promise<CliConversationScan> {
    const key = `${projectId}\0${workspacePath}`;
    if (this.latest?.key === key) return this.latest.scan;
    const entry = { key, scan: this.queue.then(() => this.collect(projectId, workspacePath, imported)) };
    const settle = (): void => { if (this.latest === entry) this.latest = null; };
    this.latest = entry;
    this.queue = entry.scan.then(settle, settle);
    return entry.scan;
  }

  private async collect(projectId: string, workspacePath: string, imported: (provider: CliProvider, sessionId: string) => CliSessionOwnership): Promise<CliConversationScan> {
    this.signal?.throwIfAborted();
    const workspace = await realpath(workspacePath);
    const resolved = new Map<string, Promise<boolean>>();
    const inWorkspace = (cwd: string): Promise<boolean> => {
      let match = resolved.get(cwd);
      if (!match) {
        match = isAbsolute(cwd) && !cwd.includes("\0")
          ? realpath(cwd).then((path) => relative(workspace, path) === "", () => false)
          : Promise.resolve(false);
        resolved.set(cwd, match);
      }
      return match;
    };
    const found: Found[] = [];
    let limited = false;
    let skipped = 0;
    let oversized = 0;
    for (const providerId of ["codex", "claude"] as const) {
      const roots = this.roots.filter((root) => root.providerId === providerId);
      if (!roots.length) continue;
      const result = await this.scanProvider(providerId, roots, projectId, workspace, inWorkspace, imported);
      found.push(...result.found);
      limited ||= result.limited;
      skipped += result.skipped;
      oversized += result.oversized;
    }
    found.sort((left, right) => right.candidate.updatedAt.localeCompare(left.candidate.updatedAt, "en"));
    if (found.length > MAX_CANDIDATES) limited = true;
    for (const [id, grant] of this.grants) if (grant.expiresAt <= Date.now() || grant.projectId === projectId) this.grants.delete(id);
    const candidates = found.slice(0, MAX_CANDIDATES).map(({ grant, candidate }) => {
      const id = randomUUID();
      this.grants.set(id, grant);
      return { id, ...candidate };
    });
    while (this.grants.size > 400) this.grants.delete(this.grants.keys().next().value!);
    return { candidates, limited, skipped, oversized };
  }

  private async scanProvider(
    providerId: CliProvider,
    sources: readonly Root[],
    projectId: string,
    workspace: string,
    inWorkspace: (cwd: string) => Promise<boolean>,
    imported: (provider: CliProvider, sessionId: string) => CliSessionOwnership,
  ): Promise<{ found: Found[]; limited: boolean; skipped: number; oversized: number }> {
    const found: Found[] = [];
    let limited = false;
    let skipped = 0;
    let oversized = 0;
    let entries = 0;
    let reads = 0;
    let headerBytes = 0;
    let bytes = 0;
    const deadline = Date.now() + this.limits.milliseconds;
    const exhausted = (): boolean => {
      this.signal?.throwIfAborted();
      if (reads < this.limits.reads && headerBytes < this.limits.headerBytes && Date.now() < deadline) return false;
      limited = true;
      return true;
    };
    const codex = providerId === "codex";
    const files: Array<{ root: string; path: string; mtime: number; size: number }> = [];
    for (const source of sources) {
      let root: string;
      try { root = await realpath(source.path); } catch { continue; }
      const pending = [{ path: root, depth: 0, mtime: 0 }];
      while (pending.length && entries < this.limits.entries && !exhausted()) {
        pending.sort(codex ? (a, b) => b.path.localeCompare(a.path, "en") : (a, b) => b.mtime - a.mtime);
        const directory = pending.shift()!;
        try {
          if (relative(directory.path, await realpath(directory.path)) !== "") continue;
          for await (const entry of await opendir(directory.path)) {
            if (entries >= this.limits.entries) { limited = true; break; }
            entries += 1;
            if (exhausted()) break;
            const path = join(directory.path, entry.name);
            if (entry.isDirectory() && directory.depth < (codex ? 3 : 1)) pending.push({ path, depth: directory.depth + 1, mtime: codex ? 0 : (await lstat(path)).mtimeMs });
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
              const info = await lstat(path);
              files.push({ root, path, mtime: info.mtimeMs, size: info.size });
            }
          }
        } catch { continue; }
      }
      if (pending.length) limited = true;
    }
    files.sort((left, right) => right.mtime - left.mtime);
    const seen = new Set<string>();
    for (const file of files) {
      if (exhausted()) break;
      reads += 1;
      let head: { cwd: string | null; bytes: number };
      try { head = await readHead(file.root, file.path, providerId); } catch { continue; }
      headerBytes += head.bytes;
      if (!head.cwd || !await inWorkspace(head.cwd)) continue;
      if (found.length >= MAX_CANDIDATES || bytes >= this.limits.bytes) { limited = true; break; }
      if (file.size > CLI_TRANSCRIPT_MAX_BYTES) { oversized += 1; skipped += 1; continue; }
      try {
        const read = await readTranscript(file.root, file.path);
        bytes += read.bytes;
        const transcript = parseCliTranscript(read.source, providerId, read.date, this.secrets);
        if (!await inWorkspace(transcript.cwd) || seen.has(transcript.sessionId)) continue;
        seen.add(transcript.sessionId);
        const ownership = imported(providerId, transcript.sessionId);
        if (ownership.owned) continue;
        found.push({
          grant: { projectId, workspace, root: file.root, path: file.path, providerId, expiresAt: Date.now() + GRANT_LIFETIME_MS },
          candidate: { providerId, title: transcript.title, updatedAt: transcript.updatedAt, importedConversationId: ownership.importedConversationId, opening: transcript.opening },
        });
      } catch (error) {
        skipped += 1;
        if (error instanceof OversizedTranscript) oversized += 1;
      }
    }
    return { found, limited, skipped, oversized };
  }

  async read(projectId: string, workspacePath: string, candidateId: string): Promise<ReadCliConversation> {
    this.signal?.throwIfAborted();
    const grant = this.grants.get(candidateId);
    if (!grant || grant.projectId !== projectId || grant.expiresAt <= Date.now()) throw new RuntimeRequestError("This conversation list expired. Scan again.");
    try {
      const workspace = await realpath(workspacePath);
      if (relative(workspace, grant.workspace) !== "") throw new Error("Workspace changed.");
      const read = await readTranscript(grant.root, grant.path);
      const transcript = parseCliTranscript(read.source, grant.providerId, read.date, this.secrets);
      if (!isAbsolute(transcript.cwd) || relative(workspace, await realpath(transcript.cwd)) !== "") throw new Error("Workspace changed.");
      this.signal?.throwIfAborted();
      return { transcript, revision: read.revision, sourceKey: createHash("sha256").update(`${grant.providerId}\0${grant.root}\0${transcript.sessionId}`).digest("hex"), providerId: grant.providerId };
    } catch {
      throw new RuntimeRequestError("This CLI conversation changed or is no longer readable. Scan again.");
    }
  }

  preview(candidateId: string, value: ReadCliConversation, importedConversationId: string | null): CliConversationPreview {
    return {
      candidate: { id: candidateId, providerId: value.providerId, title: value.transcript.title, updatedAt: value.transcript.updatedAt, importedConversationId, opening: value.transcript.opening },
      revision: value.revision, messages: value.transcript.messages, omittedMessages: value.transcript.omittedMessages,
    };
  }
}
