import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import type { CliConversationCandidate, CliConversationPreview, CliConversationScan, CliProvider } from "../../shared/cli-conversations";
import { environmentValue, expandHomePath } from "../environment";
import { acpEnvironmentSecretValues } from "../provider/acp-redaction";
import { RuntimeRequestError } from "../runtime-errors";
import { parseCliTranscript, type ParsedCliTranscript } from "./transcript";

export const CLI_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const SCAN_MAX_BYTES = 64 * 1024 * 1024;
const GRANT_LIFETIME_MS = 10 * 60 * 1000;
interface Root { providerId: CliProvider; path: string }
interface Grant { projectId: string; workspace: string; root: string; path: string; providerId: CliProvider; expiresAt: number }
export interface ReadCliConversation { transcript: ParsedCliTranscript; revision: string; sourceKey: string; providerId: CliProvider }

export function cliConversationRoots(environment: NodeJS.ProcessEnv = process.env): Root[] {
  const root = (key: string, fallback: string): string => {
    const value = environmentValue(environment, key)?.trim();
    return value ? resolve(expandHomePath(value)) : join(homedir(), fallback);
  };
  return [
    { providerId: "codex", path: join(root("CODEX_HOME", ".codex"), "sessions") },
    { providerId: "claude", path: join(root("CLAUDE_CONFIG_DIR", ".claude"), "projects") },
  ];
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

/** Fixed-size descriptor reads prevent file growth, links and special files widening import authority. */
async function readTranscript(root: string, path: string): Promise<{ source: string; date: string; bytes: number; revision: string }> {
  if (!contained(root, path) || relative(path, await realpath(path)) !== "") throw new Error("Invalid transcript path.");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > CLI_TRANSCRIPT_MAX_BYTES) throw new Error("Unsupported transcript file.");
  const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
  try {
    const pinned = await handle.stat();
    if (!pinned.isFile() || pinned.dev !== before.dev || pinned.ino !== before.ino || pinned.size !== before.size) throw new Error("Transcript changed.");
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
  private scanning = false;
  constructor(
    private readonly roots: readonly Root[] = cliConversationRoots(),
    private readonly secrets: readonly string[] = acpEnvironmentSecretValues(process.env),
    private readonly signal?: AbortSignal,
  ) {}

  async scan(projectId: string, workspacePath: string, imported: (provider: CliProvider, sessionId: string) => string | null): Promise<CliConversationScan> {
    if (this.scanning) throw new RuntimeRequestError("A CLI conversation scan is already running. Try again shortly.");
    this.scanning = true;
    try {
      const workspace = await realpath(workspacePath);
      const candidates: CliConversationCandidate[] = [];
      let operations = 0;
      let bytes = 0;
      let skipped = 0;
      let limited = false;
      const deadline = Date.now() + 8_000;
      const seen = new Set<string>();
      // Bound retained capabilities even when many projects are scanned.
      for (const [id, grant] of this.grants) if (grant.expiresAt <= Date.now() || grant.projectId === projectId) this.grants.delete(id);
      while (this.grants.size > 400) this.grants.delete(this.grants.keys().next().value!);
      const exhausted = (): boolean => {
        this.signal?.throwIfAborted();
        if (operations >= 4_000 || bytes >= SCAN_MAX_BYTES || Date.now() >= deadline || candidates.length >= 100) { limited = true; return true; }
        return false;
      };
      for (const source of this.roots) {
        let root: string;
        try { root = await realpath(source.path); } catch { continue; }
        const files: Array<{ path: string; mtime: number }> = [];
        const pending = [{ path: root, depth: 0 }];
        while (pending.length && operations < 3_000 && !exhausted()) {
          if (source.providerId === "codex") pending.sort((a, b) => b.path.localeCompare(a.path, "en"));
          const directory = pending.shift()!;
          try {
            if (relative(directory.path, await realpath(directory.path)) !== "") continue;
            const entries = await opendir(directory.path);
            for await (const entry of entries) {
              operations += 1;
              if (operations >= 3_000) { limited = true; break; }
              if (exhausted()) break;
              const path = join(directory.path, entry.name);
              if (entry.isDirectory() && directory.depth < (source.providerId === "codex" ? 3 : 1)) pending.push({ path, depth: directory.depth + 1 });
              if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                const info = await lstat(path);
                if (info.size <= CLI_TRANSCRIPT_MAX_BYTES) files.push({ path, mtime: info.mtimeMs });
                else skipped += 1;
              }
            }
          } catch { skipped += 1; }
        }
        files.sort((left, right) => right.mtime - left.mtime);
        for (const file of files) {
          if (exhausted()) break;
          operations += 1;
          try {
            const read = await readTranscript(root, file.path);
            bytes += read.bytes;
            const transcript = parseCliTranscript(read.source, source.providerId, read.date, this.secrets);
            if (!isAbsolute(transcript.cwd) || relative(workspace, await realpath(transcript.cwd)) !== "") continue;
            const key = `${source.providerId}:${transcript.sessionId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const id = randomUUID();
            this.grants.set(id, { projectId, workspace, root, path: file.path, providerId: source.providerId, expiresAt: Date.now() + GRANT_LIFETIME_MS });
            candidates.push({ id, providerId: source.providerId, title: transcript.title, updatedAt: transcript.updatedAt, importedConversationId: imported(source.providerId, transcript.sessionId) });
          } catch { skipped += 1; }
        }
      }
      return { candidates: candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt, "en")), limited, skipped };
    } finally { this.scanning = false; }
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
      throw new RuntimeRequestError("This CLI conversation changed or is no longer readable. Close the CLI session and scan again.");
    }
  }

  preview(candidateId: string, value: ReadCliConversation, importedConversationId: string | null): CliConversationPreview {
    return {
      candidate: { id: candidateId, providerId: value.providerId, title: value.transcript.title, updatedAt: value.transcript.updatedAt, importedConversationId },
      revision: value.revision, messages: value.transcript.messages, omittedMessages: value.transcript.omittedMessages,
    };
  }
}
