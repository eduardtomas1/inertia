import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { TurnGitArtifactFile } from "../../shared/contracts";
import {
  DEFAULT_OUTPUT_BYTES,
  MAX_DIFF_BYTES,
  MAX_PATH_LENGTH,
} from "./constants";
import {
  canonicalDirectoryPath,
  repositoryRoot,
  type GitPathInspectionOptions,
  validatedPaths,
} from "./paths";
import {
  boundedInteger,
  isGitProcessTreeTerminationFailure,
  runGit,
  runGitInspection,
  settleGitInspections,
  utf8Prefix,
} from "./runner";
import { parseNumstat } from "./status";
import {
  GitError,
  type GitArtifactState,
  type GitDiffOptions,
  type GitSnapshotComparison,
} from "./types";

function validateArtifactRef(ref: string): string {
  if (
    typeof ref !== "string"
    || ref.length > 500
    || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(
      ref,
    )
  ) {
    throw new GitError(
      "invalid-input",
      "The historical Git reference is invalid.",
    );
  }
  return ref;
}

async function canonicalGitDirectory(
  root: string,
  args: readonly string[],
  options: GitPathInspectionOptions = {},
): Promise<string> {
  const result = await runGitInspection(root, [...args], {
    deadlineAt: options.deadlineAt,
    signal: options.signal,
    maxOutputBytes: MAX_PATH_LENGTH,
    failureMessage: "Unable to inspect the repository identity.",
  });
  const value = result.stdout.toString("utf8").trim();
  if (!value || value.includes("\0")) {
    throw new GitError(
      "operation-failed",
      "Git returned an invalid repository identity.",
    );
  }
  try {
    return await canonicalDirectoryPath(
      isAbsolute(value) ? value : resolve(root, value),
      options,
    );
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      "operation-failed",
      "The repository identity is unavailable.",
    );
  }
}

function requiresCaptureFailure(error: unknown): boolean {
  return error instanceof GitError
    && (
      error.code === "timeout"
      || isGitProcessTreeTerminationFailure(error)
    );
}

async function withCompatibilityFallback<T>(
  primary: Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary;
  } catch (error) {
    if (requiresCaptureFailure(error)) throw error;
    return await fallback();
  }
}

async function optionalCaptureValue<T>(
  operation: Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (requiresCaptureFailure(error)) throw error;
    return fallback;
  }
}

function branchFromPorcelainStatus(status: Buffer): string | null {
  for (const field of status.toString("utf8").split("\0")) {
    if (!field.startsWith("# branch.head ")) continue;
    const branch = field.slice(14);
    return branch && branch !== "(detached)" && branch !== "(unknown)"
      ? branch
      : null;
  }
  return null;
}

/**
 * Captures a path-safe identity and full-state fingerprint. The fingerprint
 * includes the durable snapshot tree, HEAD, index tree and porcelain state;
 * absolute paths are hashed and never projected to renderer snapshots.
 */
export async function captureGitArtifactState(
  repositoryPath: string,
  snapshotRef: string,
  options: GitPathInspectionOptions = {},
): Promise<GitArtifactState> {
  const root = await repositoryRoot(repositoryPath, options);
  const ref = validateArtifactRef(snapshotRef);
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const captureOptions = { ...options, signal: controller.signal };
  let firstFailure: unknown;
  let hasFailure = false;
  const track = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch (error) {
      if (!hasFailure) {
        hasFailure = true;
        firstFailure = error;
      }
      cancel();
      throw error;
    }
  };
  try {
    const results = await Promise.allSettled([
      track(withCompatibilityFallback(
        canonicalGitDirectory(
          root,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          captureOptions,
        ),
        async () => await canonicalGitDirectory(
          root,
          ["rev-parse", "--git-common-dir"],
          captureOptions,
        ),
      )),
      track(withCompatibilityFallback(
        canonicalGitDirectory(
          root,
          ["rev-parse", "--path-format=absolute", "--git-dir"],
          captureOptions,
        ),
        async () => await canonicalGitDirectory(
          root,
          ["rev-parse", "--git-dir"],
          captureOptions,
        ),
      )),
      track(runGitInspection(
        root,
        ["rev-parse", "--verify", `${ref}^{commit}`],
        {
          deadlineAt: captureOptions.deadlineAt,
          signal: captureOptions.signal,
          maxOutputBytes: 256,
          failureMessage: "The historical Git snapshot is unavailable.",
        },
      ).then(({ stdout }) => stdout.toString("utf8").trim())),
      track(optionalCaptureValue(runGitInspection(
        root,
        ["rev-parse", "--verify", "HEAD"],
        {
          deadlineAt: captureOptions.deadlineAt,
          signal: captureOptions.signal,
          maxOutputBytes: 256,
          failureMessage: "Unable to inspect the current commit.",
        },
      ).then(({ stdout }) => stdout.toString("utf8").trim()), "")),
      track(optionalCaptureValue(runGit(root, ["write-tree"], {
        deadlineAt: captureOptions.deadlineAt,
        signal: captureOptions.signal,
        maxOutputBytes: 256,
        failureMessage: "Unable to inspect the Git index.",
      }).then(({ stdout }) => stdout.toString("utf8").trim()), "")),
      track(runGitInspection(
        root,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        {
          deadlineAt: captureOptions.deadlineAt,
          signal: captureOptions.signal,
          maxOutputBytes: DEFAULT_OUTPUT_BYTES,
          truncateOutput: true,
          failureMessage: "Unable to fingerprint the repository state.",
        },
      )),
    ] as const);
    const terminationFailure = results.find((result) =>
      result.status === "rejected"
      && isGitProcessTreeTerminationFailure(result.reason));
    if (terminationFailure?.status === "rejected") {
      throw terminationFailure.reason;
    }
    if (hasFailure) throw firstFailure;
    const [
      commonDirectory,
      gitDirectory,
      snapshotOid,
      head,
      indexTree,
      porcelain,
    ] = results.map((result) => (
      (result as PromiseFulfilledResult<unknown>).value
    )) as [
      string,
      string,
      string,
      string,
      string,
      Awaited<ReturnType<typeof runGitInspection>>,
    ];
    const repositoryIdentity = createHash("sha256")
      .update(commonDirectory)
      .digest("hex");
    const worktreeIdentity = createHash("sha256")
      .update(`${root}\0${gitDirectory}`)
      .digest("hex");
    return {
      root,
      branch: branchFromPorcelainStatus(porcelain.stdout),
      repositoryIdentity,
      worktreeIdentity,
      fingerprint: createHash("sha256")
        .update([
          snapshotOid,
          head,
          indexTree,
          porcelain.stdout.toString("base64"),
          repositoryIdentity,
          worktreeIdentity,
        ].join("\0"))
        .digest("hex"),
    };
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}

function artifactStatus(value: string): TurnGitArtifactFile["status"] {
  if (value.startsWith("R")) return "renamed";
  if (value.startsWith("C")) return "copied";
  if (value === "A") return "added";
  if (value === "D") return "deleted";
  if (value === "T") return "type-changed";
  if (value === "U") return "unmerged";
  if (value === "M") return "modified";
  return "unknown";
}

function parseSnapshotNames(buffer: Buffer): Array<{
  path: string;
  previousPath: string | null;
  status: TurnGitArtifactFile["status"];
}> {
  const fields = buffer.toString("utf8").split("\0");
  const files: Array<{
    path: string;
    previousPath: string | null;
    status: TurnGitArtifactFile["status"];
  }> = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? "";
    if (!code) continue;
    const renamed = code.startsWith("R") || code.startsWith("C");
    const previousPath = renamed ? fields[index++] ?? "" : null;
    const path = fields[index++] ?? "";
    if (!path || (renamed && !previousPath)) continue;
    files.push({ path, previousPath, status: artifactStatus(code) });
  }
  return files;
}

export async function compareGitSnapshots(
  repositoryPath: string,
  beforeReference: string,
  afterReference: string,
  options: Pick<
    GitDiffOptions,
    "deadlineAt" | "maxBytes" | "paths" | "signal"
  > = {},
): Promise<GitSnapshotComparison> {
  const root = await repositoryRoot(repositoryPath, {
    deadlineAt: options.deadlineAt,
    signal: options.signal,
  });
  const beforeRef = validateArtifactRef(beforeReference);
  const afterRef = validateArtifactRef(afterReference);
  const paths = options.paths
    ? await validatedPaths(root, options.paths, {
        deadlineAt: options.deadlineAt,
        signal: options.signal,
      })
    : [];
  const pathArgs = paths.length > 0 ? ["--", ...paths] : ["--"];
  const maxBytes = boundedInteger(
    options.maxBytes,
    MAX_DIFF_BYTES,
    MAX_DIFF_BYTES,
  );
  for (const ref of [beforeRef, afterRef]) {
    await runGitInspection(root, ["rev-parse", "--verify", `${ref}^{commit}`], {
      deadlineAt: options.deadlineAt,
      signal: options.signal,
      maxOutputBytes: 256,
      failureMessage: "A historical Git snapshot is unavailable.",
    });
  }
  const signal = options.signal ?? new AbortController().signal;
  const [names, stats, patch] = await settleGitInspections(
    signal,
    (inspectionSignal) => runGitInspection(
      root,
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        beforeRef,
        afterRef,
        ...pathArgs,
      ],
      {
        deadlineAt: options.deadlineAt,
        signal: inspectionSignal,
        maxOutputBytes: DEFAULT_OUTPUT_BYTES,
        truncateOutput: true,
        failureMessage: "Unable to inspect historical changed files.",
      },
    ),
    (inspectionSignal) => runGitInspection(
      root,
      [
        "diff",
        "--numstat",
        "-z",
        "--find-renames",
        beforeRef,
        afterRef,
        ...pathArgs,
      ],
      {
        deadlineAt: options.deadlineAt,
        signal: inspectionSignal,
        maxOutputBytes: DEFAULT_OUTPUT_BYTES,
        truncateOutput: true,
        failureMessage: "Unable to inspect historical change totals.",
      },
    ),
    (inspectionSignal) => runGitInspection(
      root,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        "--unified=3",
        beforeRef,
        afterRef,
        ...pathArgs,
      ],
      {
        deadlineAt: options.deadlineAt,
        signal: inspectionSignal,
        maxOutputBytes: maxBytes,
        truncateOutput: true,
        failureMessage: "Unable to generate the historical Git diff.",
      },
    ),
  );
  const statByPath = parseNumstat(stats.stdout);
  const allFiles = parseSnapshotNames(names.stdout).map(
    (file): TurnGitArtifactFile => {
      const stat = statByPath.get(file.path)
        ?? (file.previousPath ? statByPath.get(file.previousPath) : undefined);
      return {
        ...file,
        insertions: stat?.insertions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
        untracked: false,
        staged: false,
        unstaged: false,
        indexStatus: ".",
        worktreeStatus: ".",
      };
    },
  );
  const files = allFiles.slice(0, 200);
  const summaryTruncated = names.truncated
    || stats.truncated
    || allFiles.length > files.length;
  const patchTruncated = patch.truncated;
  return {
    patch: utf8Prefix(patch.stdout, maxBytes),
    files,
    insertions: allFiles.reduce(
      (total, file) => total + file.insertions,
      0,
    ),
    deletions: allFiles.reduce(
      (total, file) => total + file.deletions,
      0,
    ),
    summaryTruncated,
    patchTruncated,
    truncated: summaryTruncated || patchTruncated,
  };
}
