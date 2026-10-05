import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  isGitProcessTreeTerminationFailure,
  runGit as runBoundedGit,
} from "./git/runner";
import { GitError } from "./git/types";
import { headCommit } from "./git/status";

export class CheckpointError extends Error {}

type RunResult = { stdout: Buffer; stderr: Buffer };

export interface CheckpointOperationOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
}

const MAX_CHECKPOINT_PATH_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_FAILURE = "Git could not create the checkpoint.";
const RAW_CHECKPOINT_ATTRIBUTES =
  "* -crlf -filter -ident -text -working-tree-encoding -eol\n";
const NUL_BYTE = Buffer.from([0]);

function selectTaggedCheckpointPaths(
  output: Buffer,
  selected: (tag: number) => boolean,
): Buffer {
  const paths: Buffer[] = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (
      end < 0
      || end - offset < 3
      || output[offset + 1] !== 0x20
    ) {
      throw new CheckpointError(
        "Git returned invalid checkpoint path data.",
      );
    }
    if (selected(output[offset]!)) {
      paths.push(output.subarray(offset + 2, end), NUL_BYTE);
    }
    offset = end + 1;
  }
  return Buffer.concat(paths);
}

const isSkippedWorktreeTag = (tag: number): boolean => tag === 0x53;
const isAssumedUnchangedTag = (tag: number): boolean =>
  tag >= 0x61 && tag <= 0x7a;

async function runGit(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  input?: Buffer,
  maxStdoutBytes = 1024 * 1024,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  try {
    const result = await runBoundedGit(cwd, args, {
      deadlineAt,
      signal,
      environment,
      input,
      maxOutputBytes: maxStdoutBytes,
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
        throw new CheckpointError(
          "The checkpoint contains too many file paths.",
        );
      }
      if (error.code === "not-repository") {
        throw new CheckpointError("not-repository");
      }
    }
    throw new CheckpointError(CHECKPOINT_FAILURE);
  }
}

function checkpointGitArguments(
  args: readonly string[],
): string[] {
  return [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    ...args,
  ];
}

function durableCheckpointGitArguments(
  args: readonly string[],
): string[] {
  return checkpointGitArguments([
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=batch",
    ...args,
  ]);
}

async function checkpointEnvironment(
  repositoryPath: string,
  storageDirectory: string,
  checkpointId: string,
  environment: NodeJS.ProcessEnv,
  deadlineAt?: number,
  signal?: AbortSignal,
  isolateNewObjects = false,
): Promise<{
  environment: NodeJS.ProcessEnv;
  metadataDirectory: string;
  globalConfigPath: string;
  hooksDirectory: string;
}> {
  const metadataDirectory = resolve(
    storageDirectory,
    `${checkpointId}.git`,
  );
  const globalConfigPath = resolve(
    storageDirectory,
    `${checkpointId}.config`,
  );
  const hooksDirectory = resolve(
    metadataDirectory,
    "inertia-hooks",
  );
  const isolatedConfiguration: NodeJS.ProcessEnv = { ...environment };
  for (const name of Object.keys(isolatedConfiguration)) {
    if (
      name === "GIT_CONFIG_COUNT"
      || name === "GIT_CONFIG_PARAMETERS"
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)
    ) {
      delete isolatedConfiguration[name];
    }
  }
  isolatedConfiguration.GIT_CONFIG_NOSYSTEM = "1";
  isolatedConfiguration.GIT_CONFIG_GLOBAL = globalConfigPath;
  isolatedConfiguration.GIT_ATTR_NOSYSTEM = "1";
  let configurationOwned = false;
  try {
    await writeFile(globalConfigPath, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    configurationOwned = true;
    const objectStore = (
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "rev-parse",
          "--show-object-format",
          "--path-format=absolute",
          "--git-path",
          "objects",
        ]),
        isolatedConfiguration,
        undefined,
        1024 * 1024,
        deadlineAt,
        signal,
      )
    ).stdout.toString("utf8");
    const formatEnd = objectStore.indexOf("\n");
    const objectFormat = objectStore.slice(0, Math.max(0, formatEnd)).trim();
    const objectDirectory = objectStore.slice(formatEnd + 1)
      .replace(/(?:\r\n|\n)$/u, "");
    if (
      (objectFormat !== "sha1" && objectFormat !== "sha256")
      || !objectDirectory
      || objectDirectory.includes("\0")
    ) {
      throw new CheckpointError(
        "Git could not isolate the checkpoint object store.",
      );
    }
    await runGit(
      storageDirectory,
      [
        "init",
        "--bare",
        "--quiet",
        ...(objectFormat === "sha256"
          ? ["--object-format=sha256"]
          : []),
        metadataDirectory,
      ],
      isolatedConfiguration,
      undefined,
      1024 * 1024,
      deadlineAt,
      signal,
    );
    await mkdir(hooksDirectory, { mode: 0o700 });
    await writeFile(
      resolve(metadataDirectory, "info", "attributes"),
      RAW_CHECKPOINT_ATTRIBUTES,
      { encoding: "utf8", mode: 0o600 },
    );
    return {
      metadataDirectory,
      globalConfigPath,
      hooksDirectory,
      environment: {
        ...isolatedConfiguration,
        GIT_DIR: metadataDirectory,
        GIT_WORK_TREE: resolve(repositoryPath),
        GIT_OBJECT_DIRECTORY: isolateNewObjects
          ? resolve(metadataDirectory, "objects")
          : objectDirectory,
        ...(isolateNewObjects
          ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objectDirectory) }
          : {}),
      },
    };
  } catch (error) {
    if (configurationOwned) {
      await rm(metadataDirectory, { force: true, recursive: true })
        .catch(() => undefined);
      await rm(globalConfigPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

interface RepositoryIndexEntries {
  entries: Buffer;
  skipped: Buffer;
}

async function readRepositoryIndexEntries(
  repositoryPath: string,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<RepositoryIndexEntries> {
  const entries = (
    await runGit(
      repositoryPath,
      checkpointGitArguments(["ls-files", "--stage", "-z"]),
      {},
      undefined,
      MAX_CHECKPOINT_PATH_BYTES,
      deadlineAt,
      signal,
    )
  ).stdout;
  const taggedPaths = (
    await runGit(
      repositoryPath,
      checkpointGitArguments(["ls-files", "--cached", "-t", "-z"]),
      {},
      undefined,
      MAX_CHECKPOINT_PATH_BYTES,
      deadlineAt,
      signal,
    )
  ).stdout;
  return {
    entries,
    skipped: selectTaggedCheckpointPaths(taggedPaths, isSkippedWorktreeTag),
  };
}

async function writeIsolatedIndexEntries(
  repositoryPath: string,
  environment: NodeJS.ProcessEnv,
  index: RepositoryIndexEntries,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(
    repositoryPath,
    ["read-tree", "--empty"],
    environment,
    undefined,
    1024 * 1024,
    deadlineAt,
    signal,
  );
  if (index.entries.length > 0) {
    await runGit(
      repositoryPath,
      ["update-index", "-z", "--index-info"],
      environment,
      index.entries,
      1024 * 1024,
      deadlineAt,
      signal,
    );
  }
  if (index.skipped.length > 0) {
    await runGit(
      repositoryPath,
      checkpointGitArguments([
        "--literal-pathspecs",
        "update-index",
        "--skip-worktree",
        "-z",
        "--stdin",
      ]),
      environment,
      index.skipped,
      1024 * 1024,
      deadlineAt,
      signal,
    );
  }
}

async function repositoryIndexPath(
  repositoryPath: string,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const lines = (
    await runGit(
      repositoryPath,
      checkpointGitArguments([
        "rev-parse",
        "--show-prefix",
        "--path-format=absolute",
        "--git-path",
        "index",
      ]),
      {},
      undefined,
      1024 * 1024,
      deadlineAt,
      signal,
    )
  ).stdout.toString("utf8").replace(/\n$/u, "").split("\n");
  const [prefix, indexPath] = lines;
  return lines.length === 2
    && prefix === ""
    && indexPath
    && isAbsolute(indexPath)
    && !indexPath.includes("\0")
    ? indexPath
    : null;
}

async function reuseRepositoryIndex(
  repositoryPath: string,
  sourcePath: string,
  indexPath: string,
  environment: NodeJS.ProcessEnv,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const source = await stat(sourcePath, { bigint: true });
    const seconds = source.mtimeNs / 1_000_000_000n;
    if (seconds <= 0n) return false;
    await copyFile(sourcePath, indexPath);
    const taggedPaths = (
      await runGit(
        repositoryPath,
        checkpointGitArguments(["ls-files", "-v", "-z"]),
        environment,
        undefined,
        MAX_CHECKPOINT_PATH_BYTES,
        deadlineAt,
        signal,
      )
    ).stdout;
    const assumedUnchanged = selectTaggedCheckpointPaths(
      taggedPaths,
      isAssumedUnchangedTag,
    );
    if (assumedUnchanged.length > 0) {
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "update-index",
          "--no-assume-unchanged",
          "-z",
          "--stdin",
        ]),
        environment,
        assumedUnchanged,
        1024 * 1024,
        deadlineAt,
        signal,
      );
    }
    await utimes(indexPath, Number(seconds), Number(seconds));
    return (await stat(indexPath, { bigint: true })).mtimeNs <= source.mtimeNs;
  } catch (error) {
    if (isGitProcessTreeTerminationFailure(error)) throw error;
    if (
      error instanceof CheckpointError
      && error.message !== CHECKPOINT_FAILURE
    ) throw error;
    return false;
  }
}

/**
 * Produces a raw worktree tree without evaluating repository-provided clean
 * filters or attributes. The temporary Git metadata carries Inertia's
 * all-raw attributes. New review objects stay in the temporary object store;
 * the canonical repository objects are available only through a quoted,
 * read-only alternate path.
 */
export async function captureRawWorktreeTree(
  repositoryPath: string,
  paths: Buffer,
  options: CheckpointOperationOptions & { removedPaths?: Buffer } = {},
): Promise<{ head: string | null; tree: string }> {
  const storageDirectory = await mkdtemp(
    join(tmpdir(), "inertia-commit-review-"),
  );
  const captureId = randomUUID();
  const indexPath = resolve(storageDirectory, `${captureId}.index`);
  const baseEnvironment = { GIT_INDEX_FILE: indexPath };
  let isolated: Awaited<ReturnType<typeof checkpointEnvironment>> | null = null;
  try {
    const head = await headCommit(repositoryPath, {
      deadlineAt: options.deadlineAt,
      signal: options.signal,
    });
    isolated = await checkpointEnvironment(
      repositoryPath,
      storageDirectory,
      captureId,
      baseEnvironment,
      options.deadlineAt,
      options.signal,
      true,
    );
    await runGit(
      repositoryPath,
      checkpointGitArguments(
        head ? ["read-tree", head] : ["read-tree", "--empty"],
      ),
      isolated.environment,
      undefined,
      1024,
      options.deadlineAt,
      options.signal,
    );
    if (options.removedPaths && options.removedPaths.length > 0) {
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "update-index",
          "--force-remove",
          "-z",
          "--stdin",
        ]),
        isolated.environment,
        options.removedPaths,
        1024,
        options.deadlineAt,
        options.signal,
      );
    }
    if (paths.length > 0) {
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "--literal-pathspecs",
          "add",
          "-A",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ]),
        isolated.environment,
        paths,
        1024,
        options.deadlineAt,
        options.signal,
      );
    }
    const tree = (
      await runGit(
        repositoryPath,
        checkpointGitArguments(["write-tree"]),
        isolated.environment,
        undefined,
        1024,
        options.deadlineAt,
        options.signal,
      )
    ).stdout.toString("utf8").trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tree)) {
      throw new CheckpointError("Git returned an invalid reviewed tree.");
    }
    return { head, tree };
  } finally {
    await rm(storageDirectory, { force: true, recursive: true })
      .catch(() => undefined);
  }
}

export async function createCheckpoint(
  repositoryPath: string,
  storageDirectory: string,
  conversationId: string,
  options: CheckpointOperationOptions = {},
): Promise<{ id: string; ref: string }> {
  const checkpointId = randomUUID();
  const ref = `refs/inertia/checkpoints/${conversationId}/${checkpointId}`;
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const indexPath = resolve(storageDirectory, `${checkpointId}.index`);
  const baseEnvironment = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Inertia",
    GIT_AUTHOR_EMAIL: "checkpoint@inertia.local",
    GIT_COMMITTER_NAME: "Inertia",
    GIT_COMMITTER_EMAIL: "checkpoint@inertia.local",
  };
  let isolated: Awaited<ReturnType<typeof checkpointEnvironment>> | null = null;
  try {
    let head: string | null = null;
    try {
      head = (
        await runGit(
          repositoryPath,
          checkpointGitArguments(["rev-parse", "--verify", "HEAD"]),
          {},
          undefined,
          1024 * 1024,
          options.deadlineAt,
          options.signal,
        )
      ).stdout.toString("utf8").trim();
    } catch (error) {
      if (isGitProcessTreeTerminationFailure(error)) throw error;
      // Repositories without a first commit are supported. A spent aggregate
      // deadline is caught by the next bounded checkpoint operation.
    }
    const sourceIndexPath = await repositoryIndexPath(
      repositoryPath,
      options.deadlineAt,
      options.signal,
    );
    const untrackedPaths = (
      await runGit(
        repositoryPath,
        checkpointGitArguments([
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]),
        {},
        undefined,
        MAX_CHECKPOINT_PATH_BYTES,
        options.deadlineAt,
        options.signal,
      )
    ).stdout;
    isolated = await checkpointEnvironment(
      repositoryPath,
      storageDirectory,
      checkpointId,
      baseEnvironment,
      options.deadlineAt,
      options.signal,
    );
    const environment = isolated.environment;
    const reused = sourceIndexPath !== null && await reuseRepositoryIndex(
      repositoryPath,
      sourceIndexPath,
      indexPath,
      environment,
      options.deadlineAt,
      options.signal,
    );
    if (!reused) {
      await rm(indexPath, { force: true });
      await rm(`${indexPath}.lock`, { force: true });
      await writeIsolatedIndexEntries(
        repositoryPath,
        environment,
        await readRepositoryIndexEntries(
          repositoryPath,
          options.deadlineAt,
          options.signal,
        ),
        options.deadlineAt,
        options.signal,
      );
    }
    await runGit(
      repositoryPath,
      durableCheckpointGitArguments(["add", "--update"]),
      environment,
      undefined,
      1024 * 1024,
      options.deadlineAt,
      options.signal,
    );
    if (untrackedPaths.length > 0) {
      await runGit(
        repositoryPath,
        durableCheckpointGitArguments([
          "--literal-pathspecs",
          "add",
          "--force",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ]),
        environment,
        untrackedPaths,
        1024 * 1024,
        options.deadlineAt,
        options.signal,
      );
    }
    const tree = (
      await runGit(
        repositoryPath,
        durableCheckpointGitArguments(["write-tree"]),
        environment,
        undefined,
        1024 * 1024,
        options.deadlineAt,
        options.signal,
      )
    ).stdout.toString("utf8").trim();
    const commitArgs = ["commit-tree", tree, "-m", "Inertia checkpoint"];
    if (head) commitArgs.push("-p", head);
    const commit = (
      await runGit(
        repositoryPath,
        durableCheckpointGitArguments(commitArgs),
        environment,
        undefined,
        1024 * 1024,
        options.deadlineAt,
        options.signal,
      )
    ).stdout.toString("utf8").trim();
    // The isolated metadata directory is temporary. Persist the checkpoint
    // reference through the real repository after the object is created.
    await runGit(
      repositoryPath,
      durableCheckpointGitArguments([
        "-c",
        `core.hooksPath=${isolated.hooksDirectory}`,
        "update-ref",
        ref,
        commit,
      ]),
      baseEnvironment,
      undefined,
      1024 * 1024,
      options.deadlineAt,
      options.signal,
    );
    return { id: checkpointId, ref };
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
    await rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
    if (isolated) {
      await rm(isolated.metadataDirectory, {
        force: true,
        recursive: true,
      }).catch(() => undefined);
      await rm(isolated.globalConfigPath, { force: true })
        .catch(() => undefined);
    }
  }
}

export async function restoreCheckpoint(
  repositoryPath: string,
  ref: string,
  conversationId: string,
  options: CheckpointOperationOptions = {},
): Promise<void> {
  const prefix = `refs/inertia/checkpoints/${conversationId}/`;
  if (!ref.startsWith(prefix) || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(ref)) {
    throw new CheckpointError("The checkpoint reference is invalid.");
  }
  const runRestoreGit = (
    cwd: string,
    args: string[],
    environment: NodeJS.ProcessEnv = {},
    input?: Buffer,
    maxStdoutBytes = 1024 * 1024,
  ): Promise<RunResult> => runGit(
    cwd, args, environment, input, maxStdoutBytes,
    options.deadlineAt, options.signal,
  );
  const restoreId = randomUUID();
  const restoreDirectory = await mkdtemp(
    join(tmpdir(), "inertia-checkpoint-restore-"),
  );
  const indexPath = resolve(restoreDirectory, `${restoreId}.index`);
  const baseEnvironment = {
    GIT_INDEX_FILE: indexPath,
  };
  try {
    const commit = (
      await runRestoreGit(
        repositoryPath,
        checkpointGitArguments([
          "rev-parse",
          "--verify",
          `${ref}^{commit}`,
        ]),
      )
    ).stdout.toString("utf8").trim();
    const index = await readRepositoryIndexEntries(
      repositoryPath,
      options.deadlineAt,
      options.signal,
    );
    const isolated = await checkpointEnvironment(
      repositoryPath,
      restoreDirectory,
      restoreId,
      baseEnvironment,
      options.deadlineAt,
      options.signal,
    );
    await writeIsolatedIndexEntries(
      repositoryPath,
      isolated.environment,
      index,
      options.deadlineAt,
      options.signal,
    );
    await runRestoreGit(
      repositoryPath,
      checkpointGitArguments([
        "restore",
        "--source",
        commit,
        "--worktree",
        "--",
        ".",
      ]),
      isolated.environment,
    );
  } finally {
    await rm(restoreDirectory, {
      force: true,
      recursive: true,
    }).catch(() => undefined);
  }
}

export async function deleteCheckpoint(
  repositoryPath: string,
  ref: string,
  conversationId: string,
): Promise<void> {
  const prefix = `refs/inertia/checkpoints/${conversationId}/`;
  if (
    !ref.startsWith(prefix)
    || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u
      .test(ref)
  ) {
    throw new CheckpointError("The checkpoint reference is invalid.");
  }
  const hooksDirectory = await mkdtemp(
    join(tmpdir(), "inertia-checkpoint-hooks-"),
  );
  try {
    await runGit(
      repositoryPath,
      checkpointGitArguments([
        "-c",
        `core.hooksPath=${hooksDirectory}`,
        "update-ref",
        "-d",
        ref,
      ]),
    );
  } finally {
    await rm(hooksDirectory, {
      force: true,
      recursive: true,
    }).catch(() => undefined);
  }
}

export async function deleteCheckpoints(repositoryPath: string, conversationId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/u.test(conversationId)) throw new CheckpointError("The checkpoint namespace is invalid.");
  const prefix = `refs/inertia/checkpoints/${conversationId}/`;
  const refs = (await runGit(repositoryPath, ["for-each-ref", "--format=%(refname)", prefix])).stdout.toString("utf8").split("\n").map((ref) => ref.trim()).filter((ref) => ref.startsWith(prefix));
  if (refs.length === 0) return;
  const hooksDirectory = await mkdtemp(
    join(tmpdir(), "inertia-checkpoint-hooks-"),
  );
  try {
    await Promise.all(
      refs.map((ref) => runGit(
        repositoryPath,
        checkpointGitArguments([
          "-c",
          `core.hooksPath=${hooksDirectory}`,
          "update-ref",
          "-d",
          ref,
        ]),
      )),
    );
  } finally {
    await rm(hooksDirectory, {
      force: true,
      recursive: true,
    }).catch(() => undefined);
  }
}
