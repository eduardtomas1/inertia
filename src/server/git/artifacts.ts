import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { TurnGitArtifactFile } from "../../shared/contracts";
import {
  DEFAULT_OUTPUT_BYTES,
  MAX_DIFF_BYTES,
  MAX_PATH_LENGTH,
} from "./constants";
import {
  repositoryRoot,
  validatedPaths,
} from "./paths";
import {
  boundedInteger,
  runGit,
  runGitInspection,
  utf8Prefix,
} from "./runner";
import {
  getRepositoryStatus,
  parseNumstat,
} from "./status";
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
): Promise<string> {
  const result = await runGitInspection(root, [...args], {
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
    return await realpath(isAbsolute(value) ? value : resolve(root, value));
  } catch {
    throw new GitError(
      "operation-failed",
      "The repository identity is unavailable.",
    );
  }
}

/**
 * Captures a path-safe identity and full-state fingerprint. The fingerprint
 * includes the durable snapshot tree, HEAD, index tree and porcelain state;
 * absolute paths are hashed and never projected to renderer snapshots.
 */
export async function captureGitArtifactState(
  repositoryPath: string,
  snapshotRef: string,
): Promise<GitArtifactState> {
  const root = await repositoryRoot(repositoryPath);
  const ref = validateArtifactRef(snapshotRef);
  const [
    status,
    commonDirectory,
    gitDirectory,
    snapshotOid,
    head,
    indexTree,
    porcelain,
  ] = await Promise.all([
    getRepositoryStatus(root),
    canonicalGitDirectory(
      root,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ).catch(() =>
      canonicalGitDirectory(root, ["rev-parse", "--git-common-dir"])),
    canonicalGitDirectory(
      root,
      ["rev-parse", "--path-format=absolute", "--git-dir"],
    ).catch(() => canonicalGitDirectory(root, ["rev-parse", "--git-dir"])),
    runGitInspection(root, ["rev-parse", "--verify", `${ref}^{commit}`], {
      maxOutputBytes: 256,
      failureMessage: "The historical Git snapshot is unavailable.",
    }).then(({ stdout }) => stdout.toString("utf8").trim()),
    runGitInspection(root, ["rev-parse", "--verify", "HEAD"], {
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the current commit.",
    }).then(({ stdout }) => stdout.toString("utf8").trim()).catch(() => ""),
    runGit(root, ["write-tree"], {
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the Git index.",
    }).then(({ stdout }) => stdout.toString("utf8").trim()).catch(() => ""),
    runGitInspection(
      root,
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      {
        maxOutputBytes: DEFAULT_OUTPUT_BYTES,
        truncateOutput: true,
        failureMessage: "Unable to fingerprint the repository state.",
      },
    ),
  ]);
  const repositoryIdentity = createHash("sha256")
    .update(commonDirectory)
    .digest("hex");
  const worktreeIdentity = createHash("sha256")
    .update(`${root}\0${gitDirectory}`)
    .digest("hex");
  return {
    root,
    branch: status.branch,
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
  await Promise.all(
    [beforeRef, afterRef].map((ref) =>
      runGitInspection(root, ["rev-parse", "--verify", `${ref}^{commit}`], {
        deadlineAt: options.deadlineAt,
        maxOutputBytes: 256,
        failureMessage: "A historical Git snapshot is unavailable.",
      })),
  );
  const [names, stats, patch] = await Promise.all([
    runGitInspection(
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
        maxOutputBytes: DEFAULT_OUTPUT_BYTES,
        truncateOutput: true,
        failureMessage: "Unable to inspect historical changed files.",
      },
    ),
    runGitInspection(
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
        maxOutputBytes: DEFAULT_OUTPUT_BYTES,
        truncateOutput: true,
        failureMessage: "Unable to inspect historical change totals.",
      },
    ),
    runGitInspection(
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
        maxOutputBytes: maxBytes,
        truncateOutput: true,
        failureMessage: "Unable to generate the historical Git diff.",
      },
    ),
  ]);
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
