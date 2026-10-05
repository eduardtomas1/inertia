import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import { CLI_TRANSCRIPT_READ_DEADLINE_MS, type CliConversationCandidate, type CliConversationPreview, type CliConversationScan, type CliProvider } from "../../shared/cli-conversations";
import { environmentValue, expandHomePath } from "../environment";
import { acpEnvironmentSecretValues } from "../provider/acp-redaction";
import type { CliSessionOwnership } from "../persistence/cli-conversation-import";
import { RuntimeRequestError } from "../runtime-errors";
import { CLI_HEAD_CHUNK_BYTES, CLI_RECORD_MAX_BYTES, CliTranscriptDeadline, readCliLines } from "./line-reader";
import { CliTranscriptParser, EmptyCliTranscript, transcriptHeader, type CliTranscriptHeader, type ParsedCliTranscript } from "./transcript";

export const CLI_SCAN_FULL_READ_BYTES = 16 * 1024 * 1024;
const HEAD_MAX_BYTES = 1024 * 1024;
const SCAN_PREFIX_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATES = 100;
const GRANT_LIFETIME_MS = 10 * 60 * 1000;
export interface CliScanLimits {
  entries: number; reads: number; headerBytes: number; bytes: number; milliseconds: number;
  fullReadBytes: number; prefixBytes: number; recordBytes: number; readMilliseconds: number;
}
const DEFAULT_SCAN_LIMITS: CliScanLimits = {
  entries: 3_000, reads: 1_000, headerBytes: 32 * 1024 * 1024, bytes: 64 * 1024 * 1024, milliseconds: 5_000,
  fullReadBytes: CLI_SCAN_FULL_READ_BYTES, prefixBytes: SCAN_PREFIX_BYTES, recordBytes: CLI_RECORD_MAX_BYTES, readMilliseconds: CLI_TRANSCRIPT_READ_DEADLINE_MS,
};
interface Root { providerId: CliProvider; path: string }
interface Grant { projectId: string; workspace: string; root: string; path: string; providerId: CliProvider; expiresAt: number }
interface Found { grant: Grant; candidate: Omit<CliConversationCandidate, "id"> }
export interface ReadCliConversation { transcript: ParsedCliTranscript; revision: string; sourceKey: string; providerId: CliProvider; droppedRecords: number }
interface StreamOptions { secrets: readonly string[]; recordBytes: number; deadline: number; signal?: AbortSignal; limit?: number }

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

export function localAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0") && !/^[\\/]{2}/u.test(path);
}

async function readHead(root: string, path: string, provider: CliProvider, signal?: AbortSignal): Promise<{ header: CliTranscriptHeader | null; bytes: number }> {
  const { handle, pinned } = await openTranscript(root, path);
  try {
    let header: CliTranscriptHeader | null | undefined;
    const read = await readCliLines(handle, {
      size: pinned.size, limit: HEAD_MAX_BYTES, chunkBytes: CLI_HEAD_CHUNK_BYTES, deadline: Number.POSITIVE_INFINITY, signal,
      onLine: (line) => {
        header = transcriptHeader(line, provider);
        return header !== undefined;
      },
    });
    return { header: header ?? null, bytes: read.bytes };
  } finally { await handle.close(); }
}

async function streamTranscript(root: string, path: string, provider: CliProvider, options: StreamOptions) {
  const { handle, before, pinned } = await openTranscript(root, path);
  try {
    if (pinned.size !== before.size) throw new Error("Transcript changed.");
    const parser = new CliTranscriptParser(provider, pinned.mtime.toISOString(), options.secrets);
    const read = await readCliLines(handle, {
      size: pinned.size, limit: options.limit, deadline: options.deadline, signal: options.signal, maxLineBytes: options.recordBytes,
      onLine: (line, terminated) => { parser.line(line, terminated); },
    });
    const after = await handle.stat();
    const current = await lstat(path);
    if ((options.limit === undefined && (!read.complete || read.bytes !== pinned.size)) || after.size !== pinned.size || after.mtimeMs !== pinned.mtimeMs
      || after.ctimeMs !== pinned.ctimeMs || current.dev !== pinned.dev || current.ino !== pinned.ino || relative(path, await realpath(path)) !== "") throw new Error("Transcript changed.");
    const transcript = parser.finish();
    return {
      transcript: read.complete ? transcript : { ...transcript, updatedAt: pinned.mtime.toISOString() },
      revision: read.revision, bytes: read.bytes, droppedRecords: read.droppedRecords,
    };
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
        match = localAbsolutePath(cwd)
          ? realpath(cwd).then((path) => relative(workspace, path) === "", () => false)
          : Promise.resolve(false);
        resolved.set(cwd, match);
      }
      return match;
    };
    const found: Found[] = [];
    let limited = false;
    let skipped = 0;
    for (const providerId of ["codex", "claude"] as const) {
      const roots = this.roots.filter((root) => root.providerId === providerId);
      if (!roots.length) continue;
      const result = await this.scanProvider(providerId, roots, projectId, workspace, inWorkspace, imported);
      found.push(...result.found);
      limited ||= result.limited;
      skipped += result.skipped;
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
    return { candidates, limited, skipped };
  }

  private async scanProvider(
    providerId: CliProvider,
    sources: readonly Root[],
    projectId: string,
    workspace: string,
    inWorkspace: (cwd: string) => Promise<boolean>,
    imported: (provider: CliProvider, sessionId: string) => CliSessionOwnership,
  ): Promise<{ found: Found[]; limited: boolean; skipped: number }> {
    const found: Found[] = [];
    let limited = false;
    let skipped = 0;
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
      let head: Awaited<ReturnType<typeof readHead>>;
      try { head = await readHead(file.root, file.path, providerId, this.signal); } catch { continue; }
      headerBytes += head.bytes;
      if (!head.header || !await inWorkspace(head.header.cwd)) continue;
      const named = providerId === "codex" || basename(file.path, ".jsonl") === head.header.sessionId;
      const known = named ? head.header.sessionId : undefined;
      if (known && (seen.has(known) || imported(providerId, known).owned)) continue;
      if (found.length >= MAX_CANDIDATES || bytes >= this.limits.bytes) { limited = true; break; }
      try {
        const { transcript } = await this.scanRead(file, providerId);
        bytes += transcript.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
        if (!await inWorkspace(transcript.cwd) || seen.has(transcript.sessionId)) continue;
        seen.add(transcript.sessionId);
        const ownership = imported(providerId, transcript.sessionId);
        if (ownership.owned) continue;
        found.push({
          grant: { projectId, workspace, root: file.root, path: file.path, providerId, expiresAt: Date.now() + GRANT_LIFETIME_MS },
          candidate: { providerId, title: transcript.title, updatedAt: transcript.updatedAt, importedConversationId: ownership.importedConversationId, importedOmission: ownership.omission, opening: transcript.opening },
        });
      } catch (error) {
        this.signal?.throwIfAborted();
        if (error instanceof EmptyCliTranscript) continue;
        skipped += 1;
      }
    }
    return { found, limited, skipped };
  }

  async read(projectId: string, workspacePath: string, candidateId: string): Promise<ReadCliConversation> {
    this.signal?.throwIfAborted();
    const grant = this.grants.get(candidateId);
    if (!grant || grant.projectId !== projectId || grant.expiresAt <= Date.now()) throw new RuntimeRequestError("This conversation list expired. Scan again.");
    try {
      const workspace = await realpath(workspacePath);
      if (relative(workspace, grant.workspace) !== "") throw new Error("Workspace changed.");
      const read = await streamTranscript(grant.root, grant.path, grant.providerId, this.streamOptions());
      const { transcript } = read;
      if (!localAbsolutePath(transcript.cwd) || relative(workspace, await realpath(transcript.cwd)) !== "") throw new Error("Workspace changed.");
      this.signal?.throwIfAborted();
      return {
        transcript, revision: read.revision, providerId: grant.providerId, droppedRecords: read.droppedRecords,
        sourceKey: createHash("sha256").update(`${grant.providerId}\0${grant.root}\0${transcript.sessionId}`).digest("hex"),
      };
    } catch (error) {
      this.signal?.throwIfAborted();
      if (error instanceof CliTranscriptDeadline) {
        throw new RuntimeRequestError(`This CLI conversation took longer than ${Math.round(this.limits.readMilliseconds / 1000)} seconds to read. Try again.`);
      }
      throw new RuntimeRequestError("This CLI conversation changed or is no longer readable. Scan again.");
    }
  }

  private async scanRead(file: { root: string; path: string; size: number }, providerId: CliProvider) {
    if (file.size <= this.limits.fullReadBytes) return await streamTranscript(file.root, file.path, providerId, this.streamOptions());
    try {
      return await streamTranscript(file.root, file.path, providerId, { ...this.streamOptions(), limit: this.limits.prefixBytes });
    } catch (error) {
      if (!(error instanceof EmptyCliTranscript)) throw error;
      return await streamTranscript(file.root, file.path, providerId, this.streamOptions());
    }
  }

  private streamOptions(): StreamOptions {
    return { secrets: this.secrets, recordBytes: this.limits.recordBytes, deadline: Date.now() + this.limits.readMilliseconds, signal: this.signal };
  }

  preview(candidateId: string, value: ReadCliConversation, ownership: Pick<CliSessionOwnership, "importedConversationId" | "omission">): CliConversationPreview {
    return {
      candidate: {
        id: candidateId, providerId: value.providerId, title: value.transcript.title, updatedAt: value.transcript.updatedAt,
        importedConversationId: ownership.importedConversationId, importedOmission: ownership.omission, opening: value.transcript.opening,
      },
      revision: value.revision, messages: value.transcript.messages, omittedMessages: value.transcript.omittedMessages,
    };
  }
}
