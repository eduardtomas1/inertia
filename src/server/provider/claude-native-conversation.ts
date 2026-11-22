import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  forkSession, getSessionMessages,
  type SessionKey, type SessionStore, type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import { claudeEnvironmentValue, claudeUserConfigHome, plainPathComponents, readBoundedRegularFile } from "./claude-config-files";
import { controlNativeConversation, type NativeMutationProgress } from "./native-conversation-control";
import {
  checkClaudeSkillOperation, createClaudeSkillDeadline, raceClaudeSkillOperation, runClaudeSkillFilesystemOperation,
  type ClaudeSkillFilesystemTestSeam, type ClaudeSkillOperationControl,
} from "./claude-skill-operation";
import {
  NativeConversationRejection, retainedNativeHead,
  type NativeConversationContinuation, type NativeConversationOperations,
} from "./native-conversation-operations";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 20_000;
const MAX_PROJECT_FOLDERS = 20_000;
const PROJECT_KEY = /^[^/\\\u0000-\u001f\u007f]{1,240}$/u;
const MAX_REMEMBERED_FOLDERS = 256;
/** The other project folder last found holding a session, by Claude home and session id, so a moved chat's
 * every settle does not rescan the whole home. Advisory: the file is checked again before it is used. */
const rememberedFolders = new Map<string, string>();

function rememberFolder(memoryKey: string, projectKey: string): void {
  rememberedFolders.delete(memoryKey);
  rememberedFolders.set(memoryKey, projectKey);
  if (rememberedFolders.size > MAX_REMEMBERED_FOLDERS) rememberedFolders.delete(rememberedFolders.keys().next().value!);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function reject(reason: string): never { throw new NativeConversationRejection("rejected", reason); }

/** The complete lines of a transcript a running Claude may still be appending to: an unterminated last line is
 * a later entry being written, never part of a settled turn. */
function completeLines(bytes: Buffer): Buffer {
  return bytes.at(-1) === 0x0a ? bytes : bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
}

function parseTranscript(bytes: Buffer, sessionId: string): SessionStoreEntry[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 0 || lines.length > MAX_TRANSCRIPT_ENTRIES) reject("native-transcript-limit");
  return lines.map((line) => {
    const entry: unknown = JSON.parse(line);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !("type" in entry) || typeof entry.type !== "string"
      || ("sessionId" in entry && entry.sessionId !== sessionId)) reject("invalid-native-transcript");
    return entry as SessionStoreEntry;
  });
}

/** SDK owns chain selection and UUID remapping; this adapter owns filesystem authority. */
class ScopedClaudeTranscriptStore implements SessionStore {
  private source: SessionStoreEntry[] | null = null;
  private projectKey: string | null = null;
  /** Whether the source was read from a project folder other than the cwd's. */
  loadedElsewhere = false;
  private fork: { sessionId: string; entries: SessionStoreEntry[]; bytes: Buffer } | null = null;

  constructor(
    private readonly home: string,
    private readonly sourceId: string,
    private readonly signal: AbortSignal,
    private readonly configuredProjectKey: string | undefined,
    private readonly filesystem?: ClaudeSkillFilesystemTestSeam,
    /** False where the answer is evidence that must hold now: the full unique search always runs. */
    private readonly useRememberedFolder = true,
    /** The source may be running, so its transcript may end in a partly written entry. */
    private readonly liveSource = false,
  ) {}

  private checkKey(key: SessionKey): void {
    this.signal.throwIfAborted();
    if (key.subpath !== undefined || !UUID.test(key.sessionId)
      || !PROJECT_KEY.test(key.projectKey)
      || key.projectKey === "." || key.projectKey === ".."
      || (this.projectKey !== null && key.projectKey !== this.projectKey)
      || (this.configuredProjectKey !== undefined && key.projectKey !== this.configuredProjectKey)) {
      reject("native-transcript-scope-mismatch");
    }
    this.projectKey = key.projectKey;
  }

  private async hasTranscript(projectKey: string, control: ClaudeSkillOperationControl): Promise<boolean> {
    const path = join(this.home, "projects", projectKey, `${this.sourceId}.jsonl`);
    try {
      const status = await runClaudeSkillFilesystemOperation(control, "lstat", path, async () => await lstat(path));
      return status.isFile();
    } catch {
      checkClaudeSkillOperation(control);
      return false;
    }
  }

  /**
   * The project folder that holds the source transcript. Claude Code names the folder after the cwd the
   * session started in and keeps appending there when the session is resumed from another checkout, so a
   * moved chat's transcript stays in its first checkout's folder. Like Claude Code's own `--resume`, look in
   * the cwd's folder first, then accept exactly one other folder of this Claude home that holds the session
   * (T3: "let the SDK find the session by ID within this Claude home"). None or several leave the cwd's
   * folder, which reads as unavailable. A configured project folder name is never widened.
   */
  private async sourceProjectKey(key: SessionKey, control: ClaudeSkillOperationControl): Promise<string> {
    if (this.configuredProjectKey !== undefined || await this.hasTranscript(key.projectKey, control)) return key.projectKey;
    const memoryKey = `${this.home}\u0000${this.sourceId}`;
    const remembered = this.useRememberedFolder ? rememberedFolders.get(memoryKey) : undefined;
    if (remembered !== undefined && remembered !== key.projectKey && await this.hasTranscript(remembered, control)) return remembered;
    rememberedFolders.delete(memoryKey);
    const found = await this.searchProjectFolders(key, control);
    if (found !== null) rememberFolder(memoryKey, found);
    return found ?? key.projectKey;
  }

  private async searchProjectFolders(key: SessionKey, control: ClaudeSkillOperationControl): Promise<string | null> {
    const projects = join(this.home, "projects");
    if (!await plainPathComponents(this.home, projects, control)) return null;
    let found: string | null = null;
    let folders = 0;
    try {
      const directory = await runClaudeSkillFilesystemOperation(control, "opendir", projects, async () => await opendir(projects));
      try {
        for await (const entry of directory) {
          checkClaudeSkillOperation(control);
          if (!entry.isDirectory() || entry.name === key.projectKey || !PROJECT_KEY.test(entry.name)
            || entry.name === "." || entry.name === "..") continue;
          if ((folders += 1) > MAX_PROJECT_FOLDERS) return null;
          if (!await this.hasTranscript(entry.name, control)) continue;
          if (found !== null) return null;
          found = entry.name;
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    } catch {
      checkClaudeSkillOperation(control);
      return null;
    }
    return found;
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    this.checkKey(key);
    if (key.sessionId === this.fork?.sessionId) return this.fork.entries;
    if (key.sessionId !== this.sourceId) reject("native-session-mismatch");
    if (this.source) return this.source;
    const control = { ...this.filesystem, signal: this.signal };
    const sourceKey = await this.sourceProjectKey(key, control);
    const path = join(this.home, "projects", sourceKey, `${key.sessionId}.jsonl`);
    if (!await plainPathComponents(this.home, path, control)) reject("native-transcript-unavailable");
    const before = await lstat(path, { bigint: true });
    const bytes = await readBoundedRegularFile(
      path, this.home, MAX_TRANSCRIPT_BYTES, control,
    );
    if (!bytes) reject("native-transcript-unavailable");
    const after = await lstat(path, { bigint: true });
    this.signal.throwIfAborted();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== after.size) reject("native-history-changed-during-read");
    this.source = parseTranscript(this.liveSource ? completeLines(bytes) : bytes, this.sourceId);
    this.loadedElsewhere = sourceKey !== key.projectKey;
    return this.source;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.checkKey(key);
    if (this.fork || key.sessionId === this.sourceId || entries.length > MAX_TRANSCRIPT_ENTRIES) {
      throw new Error("Unexpected native fork write.");
    }
    const bytes = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new Error("Native fork exceeded its size bound.");
    this.fork = { sessionId: key.sessionId, entries: parseTranscript(bytes, key.sessionId), bytes };
  }

  /**
   * Creates the cwd's project folder when Claude Code has never run there (a fork into a new checkout), as
   * Claude Code would: private, directly under a canonical `projects` folder, never through a symlink. An
   * existing entry is left to the caller's identity checks.
   */
  private async ensureProjectFolder(directory: string, control: ClaudeSkillOperationControl): Promise<void> {
    try {
      await lstat(directory);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const projects = join(this.home, "projects");
    if (!await plainPathComponents(this.home, projects, control) || await realpath(projects) !== projects) {
      reject("unsafe-native-transcript-directory");
    }
    const parent = await lstat(projects);
    if (!parent.isDirectory()) reject("unsafe-native-transcript-directory");
    this.signal.throwIfAborted();
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const currentParent = await lstat(projects);
    if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) reject("unsafe-native-transcript-directory");
  }

  async persist(sessionId: string, progress: NativeMutationProgress): Promise<void> {
    if (!this.fork || this.fork.sessionId !== sessionId || !this.projectKey) throw new Error("Native fork was not captured.");
    const directory = join(this.home, "projects", this.projectKey);
    const path = join(directory, `${sessionId}.jsonl`);
    const control = { signal: this.signal };
    await this.ensureProjectFolder(directory, control);
    if (!await plainPathComponents(this.home, directory, control) || await realpath(directory) !== directory) {
      reject("unsafe-native-transcript-directory");
    }
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) reject("unsafe-native-transcript-directory");
    this.signal.throwIfAborted();
    // Exclusive/no-follow creation never replaces existing history. Verify the
    // opened inode and parent before writing transcript content. On uncertainty,
    // preserve the known fork ID for reconciliation; never unlink through a
    // possibly changed path or retry the mutation automatically.
    progress.mutationMayHaveOccurred = true;
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | FILE_OPEN_NO_FOLLOW, 0o600);
    try {
      const opened = await handle.stat();
      const verify = async (): Promise<void> => {
        this.signal.throwIfAborted();
        if (!await plainPathComponents(this.home, path, control) || await realpath(path) !== path) throw new Error("Native transcript path changed.");
        const currentParent = await lstat(directory);
        const current = await lstat(path);
        if (parent.dev !== currentParent.dev || parent.ino !== currentParent.ino
          || opened.dev !== current.dev || opened.ino !== current.ino || !current.isFile() || current.nlink !== 1) {
          throw new Error("Native transcript identity changed.");
        }
      };
      await verify();
      this.signal.throwIfAborted();
      await handle.writeFile(this.fork.bytes);
      await handle.sync();
      await verify();
    } finally {
      await handle.close();
    }
  }
}

export function createClaudeNativeConversationOperations(
  active: ReadonlySet<string>,
  filesystem?: ClaudeSkillFilesystemTestSeam,
): NativeConversationOperations {
  return {
    capabilities: { fork: "native", rollback: "resume-cursor" },
    execute: async (request, launch) => await controlNativeConversation(request, launch, active, false, async (signal, progress) => {
      if (launch.harnessConfiguration && launch.harnessConfiguration.kind !== "claude-messages") {
        reject("incompatible-harness-configuration");
      }
      const sourceId = request.source.nativeConversationId;
      if (!UUID.test(sourceId) || (request.source.nativeSessionId !== undefined && request.source.nativeSessionId !== sourceId)) reject("native-session-mismatch");
      const home = await claudeUserConfigHome(launch.environment, { signal });
      if (!home) reject("native-transcript-home-unavailable");
      const live = request.kind === "fork" && request.source.live === true;
      const store = new ScopedClaudeTranscriptStore(home, sourceId, signal, claudeEnvironmentValue(launch.environment, "CLAUDE_CODE_PROJECT_DIR_NAME"), filesystem,
        true, live);
      const options = { dir: launch.cwd, sessionStore: store, includeSystemMessages: true, limit: MAX_TRANSCRIPT_ENTRIES };
      // One snapshot: the fork below loads the same entries from the store, never a later read.
      const messages = await getSessionMessages(sourceId, options);
      signal.throwIfAborted();
      if (!messages.length || messages.some((message) => !UUID.test(message.uuid) || message.session_id !== sourceId)) reject("invalid-native-history");
      const head = messages.at(-1)!.uuid;
      const kept = retainedNativeHead(request.boundary);
      const keptIndex = kept === null ? -1 : messages.findIndex((message) => message.uuid === kept);
      if (live) {
        // A running later turn writes past the settled head, so the live head bounds nothing (T3
        // `ClaudeAdapterV2.ts:2777`); the fork is cut at the boundary turn's own settled cursor. The settled head
        // must still be on the live chain, so the later writes extend the history Inertia recorded instead of
        // replacing it, and the boundary must be at or before it.
        const settledIndex = messages.findIndex((message) => message.uuid === request.source.expectedHeadId);
        if (settledIndex < 0) reject("native-head-changed");
        if (keptIndex < 0 || keptIndex > settledIndex) reject("native-boundary-not-found");
      } else {
        if (head !== request.source.expectedHeadId) reject("native-head-changed");
        if (kept !== null && keptIndex < 0) reject("native-boundary-not-found");
      }
      if (request.kind === "rollback") {
        if (kept === head) return { status: "completed", effect: "unchanged", backing: { nativeConversationId: sourceId, headId: head, persistedHeadId: head } };
        if (kept === null) {
          const id = randomUUID();
          return { status: "completed", effect: "new-session", backing: {
            nativeConversationId: id, headId: null, persistedHeadId: null, continuation: { kind: "new-session", nativeConversationId: id },
          } };
        }
        return { status: "completed", effect: "resume-cursor", backing: {
          nativeConversationId: sourceId, headId: kept, persistedHeadId: head,
          continuation: { kind: "resume-cursor", nativeConversationId: sourceId, resumeSessionAt: kept },
        } };
      }
      if (kept === null) throw new NativeConversationRejection("unsupported", "empty-native-fork-boundary");
      const fork = await forkSession(sourceId, { ...options, upToMessageId: kept });
      signal.throwIfAborted();
      if (!UUID.test(fork.sessionId) || fork.sessionId === sourceId) throw new Error("Invalid native fork identity.");
      progress.createdNativeConversationId = fork.sessionId;
      const forkMessages = await getSessionMessages(fork.sessionId, options);
      const forkHead = forkMessages.at(-1)?.uuid;
      if (!forkHead || !UUID.test(forkHead) || forkMessages.some((message) => message.session_id !== fork.sessionId)) {
        throw new Error("Invalid native fork boundary.");
      }
      await store.persist(fork.sessionId, progress);
      return { status: "completed", effect: "native-fork", backing: { nativeConversationId: fork.sessionId, headId: forkHead, persistedHeadId: forkHead } };
    }, { forksLiveSource: true }),
  };
}

/** Read only after the exact SDK run has stopped; wire message UUIDs alone do not prove persistence. */
export async function readClaudePersistedNativeHead(sessionId: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<string | null> {
  if (!UUID.test(sessionId)) return null;
  const deadline = createClaudeSkillDeadline(2_000, "Claude history boundary timed out.");
  try {
    return await raceClaudeSkillOperation((async () => {
      const home = await claudeUserConfigHome(environment, { signal: deadline.signal });
      if (!home) return null;
      const store = new ScopedClaudeTranscriptStore(home, sessionId, deadline.signal, claudeEnvironmentValue(environment, "CLAUDE_CODE_PROJECT_DIR_NAME"));
      const messages = await getSessionMessages(sessionId, { dir: cwd, sessionStore: store, includeSystemMessages: true, limit: MAX_TRANSCRIPT_ENTRIES });
      if (!messages.length || messages.some((message) => !UUID.test(message.uuid) || message.session_id !== sessionId)) return null;
      return messages.at(-1)!.uuid;
    })(), deadline.signal);
  } catch { return null; }
  finally { deadline.dispose(); }
}

/**
 * After Claude Code refused to resume a session from `cwd`: whether the session's transcript is still in this
 * Claude home, in exactly one project folder other than the cwd's. Then only that Claude Code could not find it
 * from here (it predates the moved-cwd lookup); otherwise the session is really gone.
 */
export async function claudeSessionStoredElsewhere(sessionId: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (!UUID.test(sessionId)) return false;
  // Claude Code resolves a relative CLAUDE_CONFIG_DIR itself; Inertia would read ~/.claude instead, a
  // different home whose contents prove nothing about the one Claude Code searched.
  const configured = claudeEnvironmentValue(environment, "CLAUDE_CONFIG_DIR")?.trim();
  if (configured && !isAbsolute(configured)) return false;
  const deadline = createClaudeSkillDeadline(2_000, "Claude session lookup timed out.");
  try {
    return await raceClaudeSkillOperation((async () => {
      const home = await claudeUserConfigHome(environment, { signal: deadline.signal });
      if (!home) return false;
      const store = new ScopedClaudeTranscriptStore(home, sessionId, deadline.signal, claudeEnvironmentValue(environment, "CLAUDE_CODE_PROJECT_DIR_NAME"),
        undefined, false);
      const messages = await getSessionMessages(sessionId, { dir: cwd, sessionStore: store, includeSystemMessages: true, limit: MAX_TRANSCRIPT_ENTRIES });
      return messages.length > 0 && messages.every((message) => message.session_id === sessionId) && store.loadedElsewhere;
    })(), deadline.signal);
  } catch { return false; }
  finally { deadline.dispose(); }
}

export function claudeNativeContinuationOptions(
  sessionId: string | undefined,
  continuation: NativeConversationContinuation | undefined,
): { resume?: string; resumeSessionAt?: string; sessionId?: string } {
  if (!continuation) return sessionId ? { resume: sessionId } : {};
  if (!UUID.test(continuation.nativeConversationId)
    || (sessionId !== undefined && sessionId !== continuation.nativeConversationId)) {
    throw new Error("Claude continuation does not match the selected native session.");
  }
  if (continuation.kind === "new-session") return { sessionId: continuation.nativeConversationId };
  if (!sessionId || !UUID.test(continuation.resumeSessionAt)) throw new Error("Claude continuation cursor is invalid.");
  return { resume: sessionId, resumeSessionAt: continuation.resumeSessionAt };
}
