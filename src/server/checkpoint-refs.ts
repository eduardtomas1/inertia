import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  canonicalDirectoryPath,
  isContained,
  repositoryRoot,
} from "./git/paths";
import { runGit as runBoundedGit } from "./git/runner";
import { GitError, isGitProcessTreeTerminationFailure } from "./git/types";
import { normalizeIdentityPath } from "./project-identity";

export class CheckpointError extends Error {}

export interface CheckpointOperationOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface CheckpointRepositoryOptions extends CheckpointOperationOptions {
  allowedRoot?: string;
}

export interface ListCheckpointRefsOptions extends CheckpointRepositoryOptions {
  conversationId?: string;
  pageSize?: number;
}

export interface DeleteCheckpointRefsOptions extends CheckpointRepositoryOptions {
  batchSize?: number;
}

export const INERTIA_CHECKPOINT_REF_PREFIX = "refs/inertia/checkpoints/";
const CHECKPOINT_REF_PATTERN = /^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u;
const CONVERSATION_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const CHECKPOINT_FAILURE = "Git could not create the checkpoint.";
const DEFAULT_REF_LIST_PAGE_SIZE = 1_000;
const MAX_REF_LIST_PAGE_SIZE = 2_000;
const DEFAULT_REF_DELETE_BATCH_SIZE = 500;
const MAX_REF_DELETE_BATCH_SIZE = 1_000;
const MAX_REF_LIST_SUBDIVISION_DEPTH = 8;
const REF_LIST_CONCURRENCY = 4;
const HEX_NIBBLES = [
  "0", "1", "2", "3", "4", "5", "6", "7",
  "8", "9", "a", "b", "c", "d", "e", "f",
] as const;

function refGitArguments(args: readonly string[]): string[] {
  return ["--no-pager", "-c", "core.fsmonitor=false", ...args];
}

async function runRefGit(
  cwd: string,
  args: readonly string[],
  input?: Buffer,
  maxOutputBytes = 1024 * 1024,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  try {
    const result = await runBoundedGit(cwd, args, {
      deadlineAt,
      signal,
      input,
      maxOutputBytes,
      timeoutMs: 20_000,
      failureMessage: CHECKPOINT_FAILURE,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (isGitProcessTreeTerminationFailure(error)) throw error;
    if (error instanceof GitError) {
      if (error.code === "timeout") {
        throw new CheckpointError("Checkpoint operation timed out.");
      }
      if (error.code === "output-limit") {
        throw new CheckpointError("The checkpoint contains too many file paths.");
      }
      if (error.code === "not-repository") {
        throw new CheckpointError("not-repository");
      }
    }
    throw new CheckpointError(CHECKPOINT_FAILURE);
  }
}

export function isValidCheckpointRef(ref: string): boolean {
  return CHECKPOINT_REF_PATTERN.test(ref);
}

export function checkpointConversationIdFromRef(ref: string): string | null {
  if (!CHECKPOINT_REF_PATTERN.test(ref)) return null;
  return ref.slice(INERTIA_CHECKPOINT_REF_PREFIX.length, INERTIA_CHECKPOINT_REF_PREFIX.length + 36);
}

function isContainedCanonicalPath(root: string, target: string): boolean {
  if (process.platform === "win32") {
    const normalizedRoot = normalizeIdentityPath(root, "win32");
    const normalizedTarget = normalizeIdentityPath(target, "win32");
    return normalizedTarget === normalizedRoot
      || normalizedTarget.startsWith(`${normalizedRoot}/`);
  }
  return isContained(root, target);
}

export async function resolveCheckpointRepository(
  repositoryPath: string,
  options: CheckpointRepositoryOptions = {},
): Promise<string> {
  try {
    const canonicalPath = await canonicalDirectoryPath(repositoryPath, options);
    if (options.allowedRoot !== undefined) {
      const canonicalAllowedRoot = await canonicalDirectoryPath(options.allowedRoot, options);
      if (!isContainedCanonicalPath(canonicalAllowedRoot, canonicalPath)) {
        throw new CheckpointError("The checkpoint repository path escapes its allowed root.");
      }
    }
    const gitRoot = await repositoryRoot(canonicalPath, options);
    if (!isContainedCanonicalPath(gitRoot, canonicalPath)) {
      throw new CheckpointError("The checkpoint repository path is outside its Git repository.");
    }
    return gitRoot;
  } catch (error) {
    if (isGitProcessTreeTerminationFailure(error) || error instanceof CheckpointError) {
      throw error;
    }
    if (error instanceof GitError) {
      if (error.code === "timeout") {
        throw new CheckpointError("Checkpoint operation timed out.");
      }
      if (error.code === "not-repository") {
        throw new CheckpointError("not-repository");
      }
      if (error.code === "not-found") {
        throw new CheckpointError("not-found");
      }
    }
    throw new CheckpointError(CHECKPOINT_FAILURE);
  }
}

export async function resolveCheckpointCommonGitDir(
  repositoryPath: string,
  options: CheckpointRepositoryOptions = {},
): Promise<{ gitRoot: string; commonGitDir: string }> {
  const gitRoot = await resolveCheckpointRepository(repositoryPath, options);
  let reported: string;
  try {
    reported = (
      await runRefGit(
        gitRoot,
        refGitArguments(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        undefined,
        16 * 1024,
        options.deadlineAt,
        options.signal,
      )
    ).stdout.toString("utf8").trim();
  } catch (error) {
    if (isGitProcessTreeTerminationFailure(error)) throw error;
    const relativeCommonDir = (
      await runRefGit(
        gitRoot,
        refGitArguments(["rev-parse", "--git-common-dir"]),
        undefined,
        16 * 1024,
        options.deadlineAt,
        options.signal,
      )
    ).stdout.toString("utf8").trim();
    reported = isAbsolute(relativeCommonDir)
      ? relativeCommonDir
      : resolve(gitRoot, relativeCommonDir);
  }
  try {
    const canonicalCommonDir = await canonicalDirectoryPath(reported, options);
    return {
      gitRoot,
      commonGitDir: normalizeIdentityPath(canonicalCommonDir),
    };
  } catch (error) {
    if (isGitProcessTreeTerminationFailure(error)) throw error;
    if (error instanceof GitError && error.code === "timeout") {
      throw new CheckpointError("Checkpoint operation timed out.");
    }
    throw new CheckpointError(CHECKPOINT_FAILURE);
  }
}

function parseListedCheckpointRefs(output: Buffer, requiredPrefix: string): string[] {
  return output
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((ref) => ref.startsWith(requiredPrefix) && CHECKPOINT_REF_PATTERN.test(ref));
}

async function queryBoundedCheckpointRefs(
  gitRoot: string,
  pattern: string,
  requiredPrefix: string,
  count: number,
  descending: boolean,
  options: CheckpointOperationOptions,
): Promise<{ refs: string[]; overflowed: boolean }> {
  const args = [
    "for-each-ref",
    `--count=${count}`,
    ...(descending ? ["--sort=-refname"] : []),
    "--format=%(refname)",
    pattern,
  ];
  try {
    const result = await runRefGit(
      gitRoot,
      refGitArguments(args),
      undefined,
      1024 * 1024,
      options.deadlineAt,
      options.signal,
    );
    const refs = parseListedCheckpointRefs(result.stdout, requiredPrefix);
    return { refs, overflowed: refs.length >= count };
  } catch (error) {
    if (
      error instanceof CheckpointError
      && error.message === "The checkpoint contains too many file paths."
    ) {
      return { refs: [], overflowed: true };
    }
    throw error;
  }
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const chunk = items.slice(offset, offset + concurrency);
    const settled = await Promise.all(chunk.map(mapper));
    results.push(...settled);
  }
  return results;
}

async function listConversationCheckpointRefs(
  gitRoot: string,
  conversationId: string,
  pageSize: number,
  options: CheckpointOperationOptions,
  checkpointSubPrefix = "",
  depth = 0,
): Promise<string[]> {
  const prefix = `${INERTIA_CHECKPOINT_REF_PREFIX}${conversationId}/`;
  const pattern = checkpointSubPrefix.length === 0
    ? prefix
    : `${prefix}${checkpointSubPrefix}*`;
  const queried = await queryBoundedCheckpointRefs(
    gitRoot,
    pattern,
    prefix,
    pageSize + 1,
    false,
    options,
  );
  if (!queried.overflowed) return queried.refs;
  if (depth >= MAX_REF_LIST_SUBDIVISION_DEPTH) {
    throw new CheckpointError("Checkpoint ref listing exceeded its safe subdivision depth.");
  }
  const nestedGroups = await mapBounded(HEX_NIBBLES, REF_LIST_CONCURRENCY, async (nibble) => {
    const nextPrefix = checkpointSubPrefix.length === 8
      ? `${checkpointSubPrefix}-${nibble}`
      : `${checkpointSubPrefix}${nibble}`;
    return await listConversationCheckpointRefs(
      gitRoot,
      conversationId,
      pageSize,
      options,
      nextPrefix,
      depth + 1,
    );
  });
  return nestedGroups.flat();
}

async function listRepositoryCheckpointRefs(
  gitRoot: string,
  pageSize: number,
  options: CheckpointOperationOptions,
  conversationSubPrefix = "",
  depth = 0,
): Promise<string[]> {
  const pattern = conversationSubPrefix.length === 0
    ? INERTIA_CHECKPOINT_REF_PREFIX
    : `${INERTIA_CHECKPOINT_REF_PREFIX}${conversationSubPrefix}*/*`;
  const queried = await queryBoundedCheckpointRefs(
    gitRoot,
    pattern,
    INERTIA_CHECKPOINT_REF_PREFIX,
    pageSize + 1,
    false,
    options,
  );
  if (!queried.overflowed) return queried.refs;
  if (queried.refs.length > 0) {
    const firstConversationId = checkpointConversationIdFromRef(queried.refs[0]!);
    const tail = await queryBoundedCheckpointRefs(
      gitRoot,
      pattern,
      INERTIA_CHECKPOINT_REF_PREFIX,
      1,
      true,
      options,
    );
    const lastConversationId = tail.refs[0]
      ? checkpointConversationIdFromRef(tail.refs[0])
      : null;
    if (firstConversationId && firstConversationId === lastConversationId) {
      return await listConversationCheckpointRefs(
        gitRoot,
        firstConversationId,
        pageSize,
        options,
      );
    }
  }
  if (depth >= MAX_REF_LIST_SUBDIVISION_DEPTH) {
    throw new CheckpointError("Checkpoint ref listing exceeded its safe subdivision depth.");
  }
  const nestedGroups = await mapBounded(HEX_NIBBLES, REF_LIST_CONCURRENCY, async (nibble) => {
    const nextPrefix = conversationSubPrefix.length === 8
      ? `${conversationSubPrefix}-${nibble}`
      : `${conversationSubPrefix}${nibble}`;
    return await listRepositoryCheckpointRefs(
      gitRoot,
      pageSize,
      options,
      nextPrefix,
      depth + 1,
    );
  });
  return nestedGroups.flat();
}

export async function listCheckpointRefs(
  repositoryPath: string,
  options: ListCheckpointRefsOptions = {},
): Promise<string[]> {
  if (
    options.conversationId !== undefined
    && !CONVERSATION_ID_PATTERN.test(options.conversationId)
  ) {
    throw new CheckpointError("The checkpoint namespace is invalid.");
  }
  const gitRoot = await resolveCheckpointRepository(repositoryPath, options);
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? DEFAULT_REF_LIST_PAGE_SIZE, MAX_REF_LIST_PAGE_SIZE),
  );
  if (options.conversationId !== undefined) {
    return await listConversationCheckpointRefs(
      gitRoot,
      options.conversationId,
      pageSize,
      options,
    );
  }
  return await listRepositoryCheckpointRefs(gitRoot, pageSize, options);
}

async function runBatchedRefDeletes(
  gitRoot: string,
  refs: readonly string[],
  options: DeleteCheckpointRefsOptions,
): Promise<number> {
  if (refs.length === 0) return 0;
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_REF_DELETE_BATCH_SIZE, MAX_REF_DELETE_BATCH_SIZE),
  );
  const hooksDirectory = await mkdtemp(join(tmpdir(), "inertia-checkpoint-hooks-"));
  let deleted = 0;
  try {
    for (let offset = 0; offset < refs.length; offset += batchSize) {
      const batch = refs.slice(offset, offset + batchSize);
      await runRefGit(
        gitRoot,
        refGitArguments(["-c", `core.hooksPath=${hooksDirectory}`, "update-ref", "--stdin"]),
        Buffer.from(`option no-deref\n${batch.map((ref) => `delete ${ref}\n`).join("")}`, "utf8"),
        1024 * 1024,
        options.deadlineAt,
        options.signal,
      );
      deleted += batch.length;
    }
    return deleted;
  } finally {
    await rm(hooksDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function deleteCheckpointRefs(
  repositoryPath: string,
  refs: readonly string[],
  options: DeleteCheckpointRefsOptions = {},
): Promise<number> {
  const uniqueRefs: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!CHECKPOINT_REF_PATTERN.test(ref)) {
      throw new CheckpointError("The checkpoint reference is invalid.");
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    uniqueRefs.push(ref);
  }
  if (uniqueRefs.length === 0) return 0;
  const gitRoot = await resolveCheckpointRepository(repositoryPath, options);
  return await runBatchedRefDeletes(gitRoot, uniqueRefs, options);
}

export async function deleteCheckpointsForConversations(
  repositoryPath: string,
  conversationIds: readonly string[],
  options: DeleteCheckpointRefsOptions = {},
): Promise<number> {
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const conversationId of conversationIds) {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      throw new CheckpointError("The checkpoint namespace is invalid.");
    }
    if (seen.has(conversationId)) continue;
    seen.add(conversationId);
    uniqueIds.push(conversationId);
  }
  if (uniqueIds.length === 0) return 0;
  const gitRoot = await resolveCheckpointRepository(repositoryPath, options);
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_REF_DELETE_BATCH_SIZE, MAX_REF_DELETE_BATCH_SIZE),
  );
  const hooksDirectory = await mkdtemp(join(tmpdir(), "inertia-checkpoint-hooks-"));
  let totalDeleted = 0;
  try {
    for (const conversationId of uniqueIds) {
      const prefix = `${INERTIA_CHECKPOINT_REF_PREFIX}${conversationId}/`;
      let previousFirstRef: string | null = null;
      for (;;) {
        const listed = await queryBoundedCheckpointRefs(
          gitRoot,
          prefix,
          prefix,
          batchSize,
          false,
          options,
        );
        if (listed.refs.length === 0) break;
        if (listed.refs[0] === previousFirstRef) {
          throw new CheckpointError("Checkpoint ref deletion made no progress.");
        }
        previousFirstRef = listed.refs[0]!;
        await runRefGit(
          gitRoot,
          refGitArguments(["-c", `core.hooksPath=${hooksDirectory}`, "update-ref", "--stdin"]),
          Buffer.from(`option no-deref\n${listed.refs.map((ref) => `delete ${ref}\n`).join("")}`, "utf8"),
          1024 * 1024,
          options.deadlineAt,
          options.signal,
        );
        totalDeleted += listed.refs.length;
        if (listed.refs.length < batchSize) break;
      }
    }
    return totalDeleted;
  } finally {
    await rm(hooksDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function deleteCheckpoints(
  repositoryPath: string,
  conversationId: string,
  options: DeleteCheckpointRefsOptions = {},
): Promise<number> {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new CheckpointError("The checkpoint namespace is invalid.");
  }
  return await deleteCheckpointsForConversations(repositoryPath, [conversationId], options);
}
