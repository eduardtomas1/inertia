import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
  win32,
} from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";

const GEMINI_DIRECTORY = ".gemini";
const MAX_PROJECT_DIRECTORIES = 4_096;
const MAX_CHAT_FILES = 16_384;
const MAX_SESSION_IDENTITIES = 1_024;
const MAX_SESSION_ID_CHARS = 200;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_METADATA_LINE_BYTES = 64 * 1024;
const SESSION_FILE_PATTERN = /^session-[^-].*\.jsonl?$/u;

export interface GeminiSessionCleanupRequest {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionIds: readonly string[];
  requiredSessionIds?: readonly string[];
  platform?: NodeJS.Platform;
}

/**
 * Gemini CLI 0.58 records ACP chats even when the client never uses native
 * resume. Remove only files whose first metadata record attests one of this
 * run's exact, random session identities and whose project ownership marker
 * attests the exact workspace. This avoids the CLI's `--delete-session`
 * numeric-index fallback, which can delete an unrelated session when an
 * absent UUID begins with a digit.
 */
export async function cleanupGeminiSessionArtifacts(
  request: GeminiSessionCleanupRequest,
): Promise<void> {
  const platform = request.platform ?? process.platform;
  const sessionIds = [...new Set(request.sessionIds.map(validateSessionId))];
  const requiredSessionIds = new Set(
    (request.requiredSessionIds ?? []).map(validateSessionId),
  );
  if (sessionIds.length === 0) return;
  if ([...requiredSessionIds].some((sessionId) => !sessionIds.includes(sessionId))) {
    throw new Error(
      "Gemini session cleanup received an unowned required session identity.",
    );
  }

  const geminiHome = geminiDataDirectory(
    request.environment,
    request.cwd,
    platform,
  );
  const tempRoot = join(geminiHome, "tmp");
  const projectDirectory = await ownedProjectDirectory(
    tempRoot,
    request.cwd,
    platform,
  );
  if (!projectDirectory) {
    if (
      requiredSessionIds.size > 0
      || await unattestedArtifactsExist(tempRoot, sessionIds)
    ) {
      throw new Error(
        "Gemini session cleanup could not attest the workspace storage directory.",
      );
    }
    return;
  }

  const chatsDirectory = join(projectDirectory, "chats");
  const discoveredIds = new Set(sessionIds);
  const attestedIds = await matchingAttestedChatIds(
    chatsDirectory,
    discoveredIds,
  );
  if ([...requiredSessionIds].some((sessionId) => !attestedIds.has(sessionId))) {
    throw new Error(
      "Gemini session cleanup could not attest every expected chat record.",
    );
  }
  await collectSubagentSessionIds(
    chatsDirectory,
    sessionIds,
    discoveredIds,
  );
  await deleteAttestedChatFiles(chatsDirectory, discoveredIds);

  for (const sessionId of discoveredIds) {
    await removeExactArtifact(join(
      projectDirectory,
      "logs",
      `session-${sessionId}.jsonl`,
    ));
    await removeExactArtifact(join(
      projectDirectory,
      "tool-outputs",
      `session-${sessionId}`,
    ));
    await removeExactArtifact(join(projectDirectory, sessionId));
    await removeExactArtifact(join(chatsDirectory, sessionId));
  }

  const remaining = await matchingAttestedChatIds(
    chatsDirectory,
    discoveredIds,
  );
  if (remaining.size > 0) {
    throw new Error("Gemini session cleanup could not remove every owned chat record.");
  }
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const normalized = name.toUpperCase();
  // Match Node's documented Windows spawn behavior: environment keys are
  // sorted and only the first case-insensitive duplicate reaches the child.
  return Object.entries(environment)
    .filter(([key]) => key.toUpperCase() === normalized)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0]?.[1];
}

function geminiDataDirectory(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): string {
  const configuredHome = environmentValue(
    environment,
    "GEMINI_CLI_HOME",
    platform,
  );
  const environmentHome = platform === "win32"
    ? environmentValue(environment, "USERPROFILE", platform)
      ?? environmentValue(environment, "HOME", platform)
    : environmentValue(environment, "HOME", platform);
  const home = configuredHome || environmentHome || homedir();
  if (!home || home.includes("\0")) {
    throw new Error("Gemini session cleanup could not resolve its data directory.");
  }
  const absoluteHome = isAbsolute(home) ? home : resolve(cwd, home);
  return join(absoluteHome, GEMINI_DIRECTORY);
}

async function ownedProjectDirectory(
  tempRoot: string,
  cwd: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (entries.length > MAX_PROJECT_DIRECTORIES) {
    throw new Error("Gemini session cleanup exceeded its project-directory bound.");
  }
  const wanted = normalizedPath(cwd, platform);
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(tempRoot, entry.name);
    const marker = await readBoundedFile(
      join(directory, ".project_root"),
      MAX_MARKER_BYTES,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ELOOP") return null;
      throw error;
    });
    if (
      marker !== null
      && normalizedPath(marker.trim(), platform) === wanted
    ) matches.push(directory);
  }
  if (matches.length > 1) {
    throw new Error("Gemini session cleanup found ambiguous workspace storage.");
  }
  return matches[0] ?? null;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const absolute = platform === "win32"
    ? win32.resolve(value)
    : resolve(value);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function collectSubagentSessionIds(
  chatsDirectory: string,
  parentIds: readonly string[],
  result: Set<string>,
): Promise<void> {
  const pending = [...parentIds];
  for (let index = 0; index < pending.length; index += 1) {
    const parentId = pending[index];
    const directory = join(chatsDirectory, parentId);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_CHAT_FILES) {
      throw new Error("Gemini session cleanup exceeded its subagent-file bound.");
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const sessionId = await sessionIdFromMetadataFile(join(directory, entry.name));
      if (!sessionId || result.has(sessionId)) continue;
      if (result.size >= MAX_SESSION_IDENTITIES) {
        throw new Error("Gemini session cleanup exceeded its session-identity bound.");
      }
      result.add(sessionId);
      pending.push(sessionId);
    }
  }
}

async function deleteAttestedChatFiles(
  chatsDirectory: string,
  sessionIds: ReadonlySet<string>,
): Promise<void> {
  const files = await chatFileNames(chatsDirectory);
  for (const file of files) {
    const path = join(chatsDirectory, file);
    const sessionId = await sessionIdFromMetadataFile(path);
    if (!sessionId || !sessionIds.has(sessionId)) continue;
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) continue;
    const confirmed = await sessionIdFromMetadataFile(path);
    const after = await lstat(path);
    if (
      confirmed !== sessionId
      || !after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      throw new Error("Gemini session cleanup observed a changing chat record.");
    }
    await unlink(path);
  }
}

async function matchingAttestedChatIds(
  chatsDirectory: string,
  sessionIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const remaining = new Set<string>();
  for (const file of await chatFileNames(chatsDirectory)) {
    const sessionId = await sessionIdFromMetadataFile(join(chatsDirectory, file));
    if (sessionId && sessionIds.has(sessionId)) remaining.add(sessionId);
  }
  return remaining;
}

async function chatFileNames(chatsDirectory: string): Promise<string[]> {
  const entries = await readdir(chatsDirectory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (entries.length > MAX_CHAT_FILES) {
    throw new Error("Gemini session cleanup exceeded its chat-file bound.");
  }
  return entries.filter((entry) =>
    entry.isFile()
    && !entry.isSymbolicLink()
    && SESSION_FILE_PATTERN.test(entry.name)
  ).map(({ name }) => name);
}

async function sessionIdFromMetadataFile(path: string): Promise<string | null> {
  const line = await readFirstLine(path, MAX_METADATA_LINE_BYTES).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ELOOP") return null;
      throw error;
    },
  );
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== "object"
      || parsed === null
      || !("sessionId" in parsed)
      || typeof parsed.sessionId !== "string"
    ) return null;
    return validateSessionId(parsed.sessionId);
  } catch {
    return null;
  }
}

async function readFirstLine(path: string, maxBytes: number): Promise<string> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? FILE_OPEN_NO_FOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1) return "";
    const length = Math.min(info.size, maxBytes + 1);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 && bytesRead > maxBytes) {
      throw new Error("Gemini session metadata exceeded its bounded first line.");
    }
    return buffer.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? FILE_OPEN_NO_FOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error("Gemini session cleanup found an invalid ownership marker.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function removeExactArtifact(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await unlink(path);
    return;
  }
  await rm(path, { recursive: true, force: false });
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function unattestedArtifactsExist(
  tempRoot: string,
  sessionIds: ReadonlySet<string> | readonly string[],
): Promise<boolean> {
  const wanted = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (entries.length > MAX_PROJECT_DIRECTORIES) {
    throw new Error("Gemini session cleanup exceeded its project-directory bound.");
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const project = join(tempRoot, entry.name);
    if ((await matchingAttestedChatIds(join(project, "chats"), wanted)).size > 0) {
      return true;
    }
    for (const sessionId of wanted) {
      for (const artifact of [
        join(project, "logs", `session-${sessionId}.jsonl`),
        join(project, "tool-outputs", `session-${sessionId}`),
        join(project, sessionId),
        join(project, "chats", sessionId),
      ]) {
        if (await pathExists(artifact)) return true;
      }
    }
  }
  return false;
}

function validateSessionId(value: string): string {
  if (
    value.length < 8
    || value.length > MAX_SESSION_ID_CHARS
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) throw new Error("Gemini session cleanup received an invalid session identity.");
  return value;
}
