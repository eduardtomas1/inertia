import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";

const GEMINI_DIRECTORY = ".gemini";
const MAX_PROJECT_DIRECTORIES = 4_096;
const MAX_CHAT_FILES = 16_384;
const MAX_REQUEST_SESSION_IDENTITIES = 2;
const MAX_SESSION_IDENTITIES = 1_024;
const MAX_SESSION_ID_CHARS = 200;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_METADATA_LINE_BYTES = 64 * 1024;
const MAX_CLEANUP_DIRECTORY_ENTRIES = 24_576;
const MAX_CLEANUP_FILES_INSPECTED = 16_384;
const MAX_CLEANUP_BYTES_INSPECTED = 32 * 1024 * 1024;
const MAX_CLEANUP_FILESYSTEM_PROBES = 65_536;
const SESSION_FILE_PATTERN = /^session-[^-].*\.jsonl?$/u;
const SUBAGENT_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESERVED_PROJECT_ARTIFACT_NAMES = new Set([
  "chats",
  "checkpoints",
  "context_trace",
  "degraded-blobs",
  "logs",
  "memory",
  "plans",
  "shell_history",
  "tasks",
  "tracker",
  "tool-outputs",
]);

interface GeminiSessionMetadata {
  sessionId: string;
  projectHash: string | null;
  kind: string | null;
}

interface DirectoryAuthority {
  path: string;
  device: bigint;
  inode: bigint;
}

interface OptionalDirectoryAuthority {
  path: string;
  authority: DirectoryAuthority | null;
}

export class GeminiSessionCleanupScanBudget {
  private directoryEntries = 0;
  private files = 0;
  private bytes = 0;
  private filesystemProbes = 0;

  observeDirectoryEntries(count: number): void {
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || count > MAX_CLEANUP_DIRECTORY_ENTRIES - this.directoryEntries
    ) {
      throw new Error(
        "Gemini session cleanup exceeded its aggregate directory-entry safety limit.",
      );
    }
    this.directoryEntries += count;
  }

  beginFile(): void {
    if (this.files >= MAX_CLEANUP_FILES_INSPECTED) {
      throw new Error(
        "Gemini session cleanup exceeded its aggregate file-inspection safety limit.",
      );
    }
    this.files += 1;
  }

  observeBytes(count: number): void {
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || count > MAX_CLEANUP_BYTES_INSPECTED - this.bytes
    ) {
      throw new Error(
        "Gemini session cleanup exceeded its aggregate byte-inspection safety limit.",
      );
    }
    this.bytes += count;
  }

  observeFilesystemProbes(count: number): void {
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || count > MAX_CLEANUP_FILESYSTEM_PROBES - this.filesystemProbes
    ) {
      throw new Error(
        "Gemini session cleanup exceeded its aggregate filesystem-probe safety limit.",
      );
    }
    this.filesystemProbes += count;
  }
}

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
  if (
    request.sessionIds.length > MAX_REQUEST_SESSION_IDENTITIES
    || (request.requiredSessionIds?.length ?? 0) > MAX_REQUEST_SESSION_IDENTITIES
  ) {
    throw new Error(
      "Gemini session cleanup exceeded its request-identity safety limit.",
    );
  }
  const sessionIds = [...new Set(request.sessionIds.map(validateSessionId))];
  const requiredSessionIds = new Set(
    (request.requiredSessionIds ?? []).map(validateSessionId),
  );
  if (sessionIds.length === 0) return;
  if (sessionIds.length > MAX_SESSION_IDENTITIES) {
    throw new Error("Gemini session cleanup exceeded its session-identity bound.");
  }
  if ([...requiredSessionIds].some((sessionId) => !sessionIds.includes(sessionId))) {
    throw new Error(
      "Gemini session cleanup received an unowned required session identity.",
    );
  }
  const scanBudget = new GeminiSessionCleanupScanBudget();

  const geminiHomePath = geminiDataDirectory(
    request.environment,
    request.cwd,
    platform,
  );
  // The configured home is a user-selected boundary and can itself resolve
  // through a platform-managed symlink. The provider-owned `.gemini` directory
  // and every descendant are separately lstat/realpath-attested below.
  const geminiHome = await optionalDirectoryAuthority(geminiHomePath);
  const geminiHomeDirectory = geminiHome.authority;
  if (!geminiHomeDirectory) {
    if (requiredSessionIds.size > 0) {
      throw new Error(
        "Gemini session cleanup could not attest the workspace storage directory.",
      );
    }
    return;
  }
  const tempRoot = await childDirectoryAuthority(geminiHomeDirectory, "tmp");
  const tempRootDirectory = tempRoot.authority;
  if (!tempRootDirectory) {
    if (requiredSessionIds.size > 0) {
      throw new Error(
        "Gemini session cleanup could not attest the workspace storage directory.",
      );
    }
    return;
  }
  const projectDirectory = await ownedProjectDirectory(
    geminiHomeDirectory,
    tempRootDirectory,
    request.cwd,
    platform,
    scanBudget,
  );
  if (!projectDirectory) {
    if (
      requiredSessionIds.size > 0
      || await unattestedArtifactsExist(
        geminiHomeDirectory,
        tempRootDirectory,
        sessionIds,
        scanBudget,
      )
    ) {
      throw new Error(
        "Gemini session cleanup could not attest the workspace storage directory.",
      );
    }
    return;
  }

  const chatsDirectory = await childDirectoryAuthority(
    projectDirectory,
    "chats",
  );
  const discoveredIds = new Set(sessionIds);
  const attestedSessions = await matchingAttestedChats(
    chatsDirectory,
    discoveredIds,
    scanBudget,
  );
  const attestedIds = new Set(attestedSessions.keys());
  if ([...requiredSessionIds].some((sessionId) => !attestedIds.has(sessionId))) {
    throw new Error(
      "Gemini session cleanup could not attest every expected chat record.",
    );
  }
  await collectSubagentSessionIds(
    chatsDirectory,
    sessionIds,
    discoveredIds,
    attestedSessions,
    scanBudget,
  );
  const topLevelAfterDescendantDiscovery = await matchingAttestedChats(
    chatsDirectory,
    discoveredIds,
    scanBudget,
  );
  if (
    [...topLevelAfterDescendantDiscovery.keys()].some(
      (sessionId) => !attestedSessions.has(sessionId),
    )
  ) {
    throw new Error(
      "Gemini session cleanup found an ambiguous descendant chat record.",
    );
  }

  // Validate every fixed ancestor before the first mutation. Re-attestation
  // immediately before each unlink/rm below then detects replacements during
  // cleanup without ever following a provider-created directory symlink.
  const logsDirectory = await childDirectoryAuthority(projectDirectory, "logs");
  const toolOutputsDirectory = await childDirectoryAuthority(
    projectDirectory,
    "tool-outputs",
  );
  await assertDirectoryChain(
    geminiHomeDirectory,
    tempRootDirectory,
    projectDirectory,
  );
  await assertOptionalDirectoryAuthority(chatsDirectory, projectDirectory);
  await assertOptionalDirectoryAuthority(logsDirectory, projectDirectory);
  await assertOptionalDirectoryAuthority(toolOutputsDirectory, projectDirectory);

  await deleteAttestedChatFiles(
    geminiHomeDirectory,
    tempRootDirectory,
    projectDirectory,
    chatsDirectory,
    new Set(sessionIds),
    scanBudget,
  );

  for (const sessionId of discoveredIds) {
    await removeChildArtifact(
      geminiHomeDirectory,
      tempRootDirectory,
      projectDirectory,
      logsDirectory,
      `session-${sessionId}.jsonl`,
    );
    await removeChildArtifact(
      geminiHomeDirectory,
      tempRootDirectory,
      projectDirectory,
      toolOutputsDirectory,
      `session-${sessionId}`,
    );
    await removeExactArtifact(
      join(projectDirectory.path, sessionId),
      [geminiHomeDirectory, tempRootDirectory, projectDirectory],
    );
    await removeChildArtifact(
      geminiHomeDirectory,
      tempRootDirectory,
      projectDirectory,
      chatsDirectory,
      sessionId,
    );
  }

  const remaining = await matchingAttestedChatIds(
    chatsDirectory,
    discoveredIds,
    scanBudget,
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
  const absoluteHome = platformIsAbsolute(home, platform)
    ? home
    : platform === "win32"
      ? win32.resolve(cwd, home)
      : resolve(cwd, home);
  return join(absoluteHome, GEMINI_DIRECTORY);
}

async function ownedProjectDirectory(
  geminiHome: DirectoryAuthority,
  tempRoot: DirectoryAuthority,
  cwd: string,
  platform: NodeJS.Platform,
  budget: GeminiSessionCleanupScanBudget,
): Promise<DirectoryAuthority | null> {
  await assertDirectoryAuthority(geminiHome);
  await assertDirectoryAuthority(tempRoot, geminiHome);
  const entries = await readdir(tempRoot.path, { withFileTypes: true });
  if (entries.length > MAX_PROJECT_DIRECTORIES) {
    throw new Error("Gemini session cleanup exceeded its project-directory bound.");
  }
  budget.observeDirectoryEntries(entries.length);
  const wanted = normalizedPath(cwd, platform);
  const matches: DirectoryAuthority[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = await directoryAuthority(
      join(tempRoot.path, entry.name),
      tempRoot,
    );
    const marker = await readBoundedFile(
      join(directory.path, ".project_root"),
      MAX_MARKER_BYTES,
      budget,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ELOOP") return null;
      throw error;
    });
    const markerPath = marker?.trim() ?? "";
    if (
      marker !== null
      && markerPath.length > 0
      && !markerPath.includes("\0")
      && platformIsAbsolute(markerPath, platform)
      && normalizedPath(markerPath, platform) === wanted
    ) matches.push(directory);
  }
  await assertDirectoryAuthority(geminiHome);
  await assertDirectoryAuthority(tempRoot, geminiHome);
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

function platformIsAbsolute(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : isAbsolute(value);
}

function pathIsContained(parent: string, candidate: string): boolean {
  const offset = relative(parent, candidate);
  return offset === ""
    || (
      offset !== ".."
      && !offset.startsWith(`..${sep}`)
      && !isAbsolute(offset)
    );
}

async function optionalDirectoryAuthority(
  path: string,
  parent?: DirectoryAuthority,
): Promise<OptionalDirectoryAuthority> {
  const info = await lstat(path, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!info) return { path, authority: null };
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Gemini session cleanup found an unsafe storage directory.");
  }
  const canonicalPath = await realpath(path);
  const confirmed = await lstat(path, { bigint: true });
  if (
    !confirmed.isDirectory()
    || confirmed.isSymbolicLink()
    || confirmed.dev !== info.dev
    || confirmed.ino !== info.ino
  ) {
    throw new Error("Gemini session cleanup observed a changing storage directory.");
  }
  if (parent && !pathIsContained(parent.path, canonicalPath)) {
    throw new Error("Gemini session cleanup found a storage path outside its owner.");
  }
  return {
    path,
    authority: {
      path: canonicalPath,
      device: info.dev,
      inode: info.ino,
    },
  };
}

async function directoryAuthority(
  path: string,
  parent?: DirectoryAuthority,
): Promise<DirectoryAuthority> {
  const observed = await optionalDirectoryAuthority(path, parent);
  if (!observed.authority) {
    throw new Error("Gemini session cleanup lost a storage directory.");
  }
  return observed.authority;
}

async function childDirectoryAuthority(
  parent: DirectoryAuthority,
  name: string,
): Promise<OptionalDirectoryAuthority> {
  return await optionalDirectoryAuthority(join(parent.path, name), parent);
}

async function assertDirectoryAuthority(
  expected: DirectoryAuthority,
  parent?: DirectoryAuthority,
): Promise<void> {
  const observed = await directoryAuthority(expected.path, parent);
  if (
    observed.path !== expected.path
    || observed.device !== expected.device
    || observed.inode !== expected.inode
  ) {
    throw new Error("Gemini session cleanup observed a changing storage directory.");
  }
}

async function assertOptionalDirectoryAuthority(
  expected: OptionalDirectoryAuthority,
  parent: DirectoryAuthority,
): Promise<void> {
  await assertDirectoryAuthority(parent);
  const observed = await optionalDirectoryAuthority(expected.path, parent);
  if (!expected.authority && !observed.authority) return;
  if (
    !expected.authority
    || !observed.authority
    || expected.authority.path !== observed.authority.path
    || expected.authority.device !== observed.authority.device
    || expected.authority.inode !== observed.authority.inode
  ) {
    throw new Error("Gemini session cleanup observed a changing storage directory.");
  }
}

async function assertDirectoryChain(
  geminiHome: DirectoryAuthority,
  tempRoot: DirectoryAuthority,
  project: DirectoryAuthority,
  child?: OptionalDirectoryAuthority,
): Promise<void> {
  await assertDirectoryAuthority(geminiHome);
  await assertDirectoryAuthority(tempRoot, geminiHome);
  await assertDirectoryAuthority(project, tempRoot);
  if (child) await assertOptionalDirectoryAuthority(child, project);
}

async function collectSubagentSessionIds(
  chatsDirectory: OptionalDirectoryAuthority,
  parentIds: readonly string[],
  result: Set<string>,
  attestedSessions: ReadonlyMap<string, GeminiSessionMetadata>,
  budget: GeminiSessionCleanupScanBudget,
): Promise<void> {
  if (!chatsDirectory.authority) return;
  for (const sessionId of parentIds) {
    const projectHash = attestedSessions.get(sessionId)?.projectHash;
    if (!projectHash) continue;
    const directory = await childDirectoryAuthority(
      chatsDirectory.authority,
      sessionId,
    );
    if (!directory.authority) continue;
    const entries = await readdir(directory.authority.path, {
      withFileTypes: true,
    });
    if (entries.length > MAX_CHAT_FILES) {
      throw new Error("Gemini session cleanup exceeded its subagent-file bound.");
    }
    budget.observeDirectoryEntries(entries.length);
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const metadata = await sessionMetadataFromFile(
        join(directory.authority.path, entry.name),
        budget,
      );
      if (
        !metadata
        || !SUBAGENT_SESSION_ID_PATTERN.test(metadata.sessionId)
        || metadata.kind !== "subagent"
        || metadata.projectHash !== projectHash
        || entry.name !== `${metadata.sessionId}.jsonl`
        || result.has(metadata.sessionId)
      ) continue;
      if (result.size >= MAX_SESSION_IDENTITIES) {
        throw new Error("Gemini session cleanup exceeded its session-identity bound.");
      }
      result.add(metadata.sessionId);
    }
    await assertOptionalDirectoryAuthority(directory, chatsDirectory.authority);
  }
}

async function deleteAttestedChatFiles(
  geminiHome: DirectoryAuthority,
  tempRoot: DirectoryAuthority,
  projectDirectory: DirectoryAuthority,
  chatsDirectory: OptionalDirectoryAuthority,
  sessionIds: ReadonlySet<string>,
  budget: GeminiSessionCleanupScanBudget,
): Promise<void> {
  const files = await chatFileNames(chatsDirectory, budget);
  if (!chatsDirectory.authority) return;
  for (const file of files) {
    const path = join(chatsDirectory.authority.path, file);
    const sessionId = await sessionIdFromMetadataFile(path, budget);
    if (!sessionId || !sessionIds.has(sessionId)) continue;
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) continue;
    const confirmed = await sessionIdFromMetadataFile(path, budget);
    await assertDirectoryChain(
      geminiHome,
      tempRoot,
      projectDirectory,
      chatsDirectory,
    );
    const after = await lstat(path, { bigint: true });
    if (
      confirmed !== sessionId
      || !after.isFile()
      || after.isSymbolicLink()
      || !sameFileSnapshot(before, after)
    ) {
      throw new Error("Gemini session cleanup observed a changing chat record.");
    }
    await unlink(path);
  }
}

async function matchingAttestedChatIds(
  chatsDirectory: OptionalDirectoryAuthority,
  sessionIds: ReadonlySet<string>,
  budget: GeminiSessionCleanupScanBudget,
): Promise<Set<string>> {
  return new Set((await matchingAttestedChats(
    chatsDirectory,
    sessionIds,
    budget,
  )).keys());
}

async function matchingAttestedChats(
  chatsDirectory: OptionalDirectoryAuthority,
  sessionIds: ReadonlySet<string>,
  budget: GeminiSessionCleanupScanBudget,
): Promise<Map<string, GeminiSessionMetadata>> {
  const remaining = new Map<string, GeminiSessionMetadata>();
  for (const file of await chatFileNames(chatsDirectory, budget)) {
    if (!chatsDirectory.authority) break;
    const metadata = await sessionMetadataFromFile(join(
      chatsDirectory.authority.path,
      file,
    ), budget);
    if (metadata && sessionIds.has(metadata.sessionId)) {
      if (remaining.has(metadata.sessionId)) {
        throw new Error(
          "Gemini session cleanup found ambiguous owned chat records.",
        );
      }
      remaining.set(metadata.sessionId, metadata);
    }
  }
  return remaining;
}

async function chatFileNames(
  chatsDirectory: OptionalDirectoryAuthority,
  budget: GeminiSessionCleanupScanBudget,
): Promise<string[]> {
  if (!chatsDirectory.authority) {
    const observed = await optionalDirectoryAuthority(chatsDirectory.path);
    if (observed.authority) {
      throw new Error("Gemini session cleanup observed a changing storage directory.");
    }
    return [];
  }
  await assertDirectoryAuthority(chatsDirectory.authority);
  const entries = await readdir(chatsDirectory.authority.path, {
    withFileTypes: true,
  });
  if (entries.length > MAX_CHAT_FILES) {
    throw new Error("Gemini session cleanup exceeded its chat-file bound.");
  }
  budget.observeDirectoryEntries(entries.length);
  return entries.filter((entry) =>
    entry.isFile()
    && !entry.isSymbolicLink()
    && SESSION_FILE_PATTERN.test(entry.name)
  ).map(({ name }) => name);
}

async function sessionIdFromMetadataFile(
  path: string,
  budget: GeminiSessionCleanupScanBudget,
): Promise<string | null> {
  return (await sessionMetadataFromFile(path, budget))?.sessionId ?? null;
}

async function sessionMetadataFromFile(
  path: string,
  budget: GeminiSessionCleanupScanBudget,
): Promise<GeminiSessionMetadata | null> {
  const line = await readFirstLine(path, MAX_METADATA_LINE_BYTES, budget).catch(
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
    const projectHash = "projectHash" in parsed
      && typeof parsed.projectHash === "string"
      && parsed.projectHash.length > 0
      && parsed.projectHash.length <= 1_024
      && !parsed.projectHash.includes("\0")
      ? parsed.projectHash
      : null;
    const kind = "kind" in parsed && typeof parsed.kind === "string"
      ? parsed.kind
      : null;
    return {
      sessionId: validateSessionId(parsed.sessionId),
      projectHash,
      kind,
    };
  } catch {
    return null;
  }
}

async function readFirstLine(
  path: string,
  maxBytes: number,
  budget: GeminiSessionCleanupScanBudget,
): Promise<string> {
  budget.beginFile();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Gemini session cleanup found unsafe session metadata.");
  }
  const noFollow = "O_NOFOLLOW" in fsConstants ? FILE_OPEN_NO_FOLLOW : 0;
  const nonBlocking = "O_NONBLOCK" in fsConstants
    ? fsConstants.O_NONBLOCK
    : 0;
  const handle = await open(
    path,
    fsConstants.O_RDONLY | noFollow | nonBlocking,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || !sameFileIdentity(before, info)) {
      throw new Error("Gemini session cleanup found unsafe session metadata.");
    }
    if (info.size < 1n) return "";
    const contents = await readDescriptorBytes(handle, maxBytes + 1);
    budget.observeBytes(contents.byteLength);
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(info, after)) {
      throw new Error("Gemini session cleanup observed changing session metadata.");
    }
    const newline = contents.indexOf(0x0a);
    if (newline < 0 && contents.byteLength > maxBytes) {
      throw new Error("Gemini session metadata exceeded its bounded first line.");
    }
    return contents.subarray(0, newline < 0 ? undefined : newline).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  budget: GeminiSessionCleanupScanBudget,
): Promise<string> {
  budget.beginFile();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Gemini session cleanup found an invalid ownership marker.");
  }
  const noFollow = "O_NOFOLLOW" in fsConstants ? FILE_OPEN_NO_FOLLOW : 0;
  const nonBlocking = "O_NONBLOCK" in fsConstants
    ? fsConstants.O_NONBLOCK
    : 0;
  const handle = await open(
    path,
    fsConstants.O_RDONLY | noFollow | nonBlocking,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile()
      || !sameFileIdentity(before, info)
      || info.size > BigInt(maxBytes)
    ) {
      throw new Error("Gemini session cleanup found an invalid ownership marker.");
    }
    const contents = await readDescriptorBytes(handle, maxBytes + 1);
    budget.observeBytes(contents.byteLength);
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(info, after)) {
      throw new Error("Gemini session cleanup observed a changing ownership marker.");
    }
    if (contents.byteLength > maxBytes) {
      throw new Error("Gemini session cleanup found an oversized ownership marker.");
    }
    return contents.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readDescriptorBytes(
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function removeChildArtifact(
  geminiHome: DirectoryAuthority,
  tempRoot: DirectoryAuthority,
  projectDirectory: DirectoryAuthority,
  parent: OptionalDirectoryAuthority,
  name: string,
): Promise<void> {
  await assertDirectoryChain(
    geminiHome,
    tempRoot,
    projectDirectory,
    parent,
  );
  if (!parent.authority) return;
  await removeExactArtifact(
    join(parent.authority.path, name),
    [geminiHome, tempRoot, projectDirectory, parent.authority],
  );
}

async function removeExactArtifact(
  path: string,
  ancestors: readonly DirectoryAuthority[],
): Promise<void> {
  for (let index = 0; index < ancestors.length; index += 1) {
    await assertDirectoryAuthority(
      ancestors[index]!,
      index > 0 ? ancestors[index - 1] : undefined,
    );
  }
  const info = await lstat(path, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!info) return;
  for (let index = 0; index < ancestors.length; index += 1) {
    await assertDirectoryAuthority(
      ancestors[index]!,
      index > 0 ? ancestors[index - 1] : undefined,
    );
  }
  const confirmed = await lstat(path, { bigint: true });
  if (
    !sameFileSnapshot(info, confirmed)
    || confirmed.isDirectory() !== info.isDirectory()
    || confirmed.isSymbolicLink() !== info.isSymbolicLink()
  ) {
    throw new Error("Gemini session cleanup observed a changing artifact.");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await unlink(path);
    return;
  }
  await rm(path, { recursive: true, force: false });
}

async function pathExists(
  path: string,
  budget: GeminiSessionCleanupScanBudget,
): Promise<boolean> {
  budget.observeFilesystemProbes(1);
  return await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function unattestedArtifactsExist(
  geminiHome: DirectoryAuthority,
  tempRoot: DirectoryAuthority,
  sessionIds: ReadonlySet<string> | readonly string[],
  budget: GeminiSessionCleanupScanBudget,
): Promise<boolean> {
  const wanted = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
  await assertDirectoryAuthority(geminiHome);
  await assertDirectoryAuthority(tempRoot, geminiHome);
  const entries = await readdir(tempRoot.path, { withFileTypes: true });
  if (entries.length > MAX_PROJECT_DIRECTORIES) {
    throw new Error("Gemini session cleanup exceeded its project-directory bound.");
  }
  budget.observeDirectoryEntries(entries.length);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const project = await directoryAuthority(
      join(tempRoot.path, entry.name),
      tempRoot,
    );
    const chats = await childDirectoryAuthority(project, "chats");
    const logs = await childDirectoryAuthority(project, "logs");
    const toolOutputs = await childDirectoryAuthority(project, "tool-outputs");
    if ((await matchingAttestedChatIds(chats, wanted, budget)).size > 0) {
      return true;
    }
    for (const sessionId of wanted) {
      for (const artifact of [
        ...(logs.authority
          ? [join(logs.authority.path, `session-${sessionId}.jsonl`)]
          : []),
        ...(toolOutputs.authority
          ? [join(toolOutputs.authority.path, `session-${sessionId}`)]
          : []),
        join(project.path, sessionId),
        ...(chats.authority
          ? [join(chats.authority.path, sessionId)]
          : []),
      ]) {
        if (await pathExists(artifact, budget)) return true;
      }
    }
    await assertDirectoryChain(geminiHome, tempRoot, project);
    await assertOptionalDirectoryAuthority(chats, project);
    await assertOptionalDirectoryAuthority(logs, project);
    await assertOptionalDirectoryAuthority(toolOutputs, project);
  }
  await assertDirectoryAuthority(geminiHome);
  await assertDirectoryAuthority(tempRoot, geminiHome);
  return false;
}

function validateSessionId(value: string): string {
  if (
    value.length < 8
    || value.length > MAX_SESSION_ID_CHARS
    || !/^[A-Za-z0-9_-]+$/u.test(value)
    || RESERVED_PROJECT_ARTIFACT_NAMES.has(value.toLowerCase())
  ) throw new Error("Gemini session cleanup received an invalid session identity.");
  return value;
}
