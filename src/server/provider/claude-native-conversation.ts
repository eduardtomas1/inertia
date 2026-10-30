import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  forkSession, getSessionMessages,
  type SessionKey, type SessionStore, type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import { claudeEnvironmentValue, claudeUserConfigHome, plainPathComponents, readBoundedRegularFile } from "./claude-config-files";
import { controlNativeConversation, type NativeMutationProgress } from "./native-conversation-control";
import { createClaudeSkillDeadline, raceClaudeSkillOperation, type ClaudeSkillFilesystemTestSeam } from "./claude-skill-operation";
import {
  NativeConversationRejection, retainedNativeHead,
  type NativeConversationContinuation, type NativeConversationOperations,
} from "./native-conversation-operations";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function reject(reason: string): never { throw new NativeConversationRejection("rejected", reason); }

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
  private fork: { sessionId: string; entries: SessionStoreEntry[]; bytes: Buffer } | null = null;

  constructor(
    private readonly home: string,
    private readonly sourceId: string,
    private readonly signal: AbortSignal,
    private readonly configuredProjectKey: string | undefined,
    private readonly filesystem?: ClaudeSkillFilesystemTestSeam,
  ) {}

  private checkKey(key: SessionKey): void {
    this.signal.throwIfAborted();
    if (key.subpath !== undefined || !UUID.test(key.sessionId)
      || !/^[^/\\\u0000-\u001f\u007f]{1,240}$/u.test(key.projectKey)
      || key.projectKey === "." || key.projectKey === ".."
      || (this.projectKey !== null && key.projectKey !== this.projectKey)
      || (this.configuredProjectKey !== undefined && key.projectKey !== this.configuredProjectKey)) {
      reject("native-transcript-scope-mismatch");
    }
    this.projectKey = key.projectKey;
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    this.checkKey(key);
    if (key.sessionId === this.fork?.sessionId) return this.fork.entries;
    if (key.sessionId !== this.sourceId) reject("native-session-mismatch");
    if (this.source) return this.source;
    const path = join(this.home, "projects", key.projectKey, `${key.sessionId}.jsonl`);
    const control = { ...this.filesystem, signal: this.signal };
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
    this.source = parseTranscript(bytes, this.sourceId);
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

  async persist(sessionId: string, progress: NativeMutationProgress): Promise<void> {
    if (!this.fork || this.fork.sessionId !== sessionId || !this.projectKey) throw new Error("Native fork was not captured.");
    const directory = join(this.home, "projects", this.projectKey);
    const path = join(directory, `${sessionId}.jsonl`);
    const control = { signal: this.signal };
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
      const store = new ScopedClaudeTranscriptStore(home, sourceId, signal, claudeEnvironmentValue(launch.environment, "CLAUDE_CODE_PROJECT_DIR_NAME"), filesystem);
      const options = { dir: launch.cwd, sessionStore: store, includeSystemMessages: true, limit: MAX_TRANSCRIPT_ENTRIES };
      const messages = await getSessionMessages(sourceId, options);
      signal.throwIfAborted();
      if (!messages.length || messages.some((message) => !UUID.test(message.uuid) || message.session_id !== sourceId)) reject("invalid-native-history");
      const head = messages.at(-1)!.uuid;
      if (head !== request.source.expectedHeadId) reject("native-head-changed");
      const kept = retainedNativeHead(request.boundary);
      if (kept !== null && !messages.some((message) => message.uuid === kept)) reject("native-boundary-not-found");
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
    }),
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
