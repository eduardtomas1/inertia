import { lstat, realpath, stat } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  MAX_DIFF_FILES,
  MAX_PATH_LENGTH,
} from "./constants";
import {
  gitInspectionSettlementValues,
  isGitProcessTreeTerminationFailure,
  runGit,
  runGitInspection,
} from "./runner";
import { GitError } from "./types";

export function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (
      child !== ".."
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child)
    );
}

export interface GitPathInspectionOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
}

function canonicalPathIdentity(path: string): string {
  return process.platform === "win32"
    ? path.toLocaleLowerCase("en-US")
    : path;
}

function terminalPathOutput(output: Buffer): string {
  const value = output.toString("utf8");
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function requirePathInspectionTime(
  options: GitPathInspectionOptions,
): void {
  if (options.signal?.aborted) {
    throw new GitError("timeout", "Git inspection was cancelled.");
  }
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new GitError(
      "timeout",
      "Git took too long to complete the operation.",
    );
  }
}

async function requireDirectory(
  path: string,
  options: GitPathInspectionOptions,
): Promise<string> {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > MAX_PATH_LENGTH
    || path.includes("\0")
  ) {
    throw new GitError("invalid-input", "The repository path is invalid.");
  }
  try {
    requirePathInspectionTime(options);
    const canonical = await realpath(resolve(path));
    requirePathInspectionTime(options);
    const info = await stat(canonical);
    requirePathInspectionTime(options);
    if (!info.isDirectory()) throw new Error();
    return canonical;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError("not-found", "The repository folder could not be found.");
  }
}

export async function repositoryRoot(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<string> {
  const directory = await requireDirectory(repositoryPath, options);
  requirePathInspectionTime(options);
  const result = await runGitInspection(
    directory,
    ["rev-parse", "--show-toplevel"],
    {
      deadlineAt: options.deadlineAt,
      signal: options.signal,
      maxOutputBytes: MAX_PATH_LENGTH,
      failureMessage: "Unable to inspect this Git repository.",
    },
  );
  const reported = terminalPathOutput(result.stdout);
  if (!isAbsolute(reported)) {
    throw new GitError(
      "not-repository",
      "The selected folder is not a Git repository.",
    );
  }
  try {
    requirePathInspectionTime(options);
    const canonical = await realpath(reported);
    requirePathInspectionTime(options);
    return canonical;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(
      "not-repository",
      "The selected folder is not a Git repository.",
    );
  }
}

/**
 * Captures both the resolved per-worktree Git directory behind a checkout's
 * `.git` marker and the resolved common Git directory that owns shared refs,
 * objects, and configuration. The opaque value stays in the trusted runtime
 * and binds a short-lived authority to the exact metadata graph inspected.
 * This is a boundary receipt rather than an atomic filesystem lock, so
 * callers revalidate it immediately before and after the operation.
 */
export async function repositoryMetadataMarkerIdentity(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<string> {
  const root = await requireDirectory(repositoryPath, options);
  requirePathInspectionTime(options);
  const inspect = async (args: readonly string[]) => await runGitInspection(
    root,
    args,
    {
      deadlineAt: options.deadlineAt,
      signal: options.signal,
      maxOutputBytes: MAX_PATH_LENGTH,
      failureMessage: "Unable to inspect this Git repository identity.",
    },
  );
  const directoryIdentity = async (
    argument: "--git-dir" | "--git-common-dir",
  ): Promise<string> => {
    const result = await inspect([
      "rev-parse",
      "--path-format=absolute",
      argument,
    ]).catch(async (error: unknown) => {
      if (
        options.signal?.aborted
        || isGitProcessTreeTerminationFailure(error)
      ) {
        throw error;
      }
      requirePathInspectionTime(options);
      return await inspect(["rev-parse", argument]);
    });
    const reported = terminalPathOutput(result.stdout);
    if (!reported || reported.includes("\0")) {
      throw new GitError(
        "conflict",
        "The Git repository identity could not be verified.",
      );
    }
    try {
      requirePathInspectionTime(options);
      const metadataPath = await realpath(
        isAbsolute(reported) ? reported : resolve(root, reported),
      );
      requirePathInspectionTime(options);
      const info = await lstat(metadataPath, { bigint: true });
      requirePathInspectionTime(options);
      if (
        !info.isDirectory()
        || info.isSymbolicLink()
        || info.ino <= 0n
        || info.birthtimeNs <= 0n
      ) {
        throw new Error();
      }
      return [
        canonicalPathIdentity(metadataPath),
        info.dev.toString(10),
        info.ino.toString(10),
        info.birthtimeNs.toString(10),
      ].join("\0");
    } catch (error) {
      if (error instanceof GitError) throw error;
      throw new GitError(
        "conflict",
        "The Git repository identity could not be verified.",
      );
    }
  };
  const [gitDirectoryResult, commonDirectoryResult] = await Promise.allSettled([
    directoryIdentity("--git-dir"),
    directoryIdentity("--git-common-dir"),
  ]);
  // Both inspections own Git children. Await both settlements even when one
  // marker probe fails so no sibling process retains a Windows cwd handle
  // after this identity inspection rejects.
  const [gitDirectory, commonDirectory] = gitInspectionSettlementValues([
    gitDirectoryResult,
    commonDirectoryResult,
  ]);
  return ["git-dir", gitDirectory, "git-common-dir", commonDirectory].join("\0");
}

export function validateName(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || value.startsWith("-")
    || value.includes("\0")
    || value.includes("\r")
    || value.includes("\n")
  ) {
    throw new GitError("invalid-input", `${label} is invalid.`);
  }
  return value;
}

export async function validateBranch(
  root: string,
  branch: string,
): Promise<string> {
  const name = validateName(branch, "The branch name");
  await runGit(root, ["check-ref-format", "--branch", name], {
    maxOutputBytes: 1_024,
    failureMessage: "The branch name is invalid.",
  }).catch(() => {
    throw new GitError("invalid-input", "The branch name is invalid.");
  });
  return name;
}

export async function validatedPaths(
  root: string,
  paths: readonly string[],
  options: GitPathInspectionOptions = {},
): Promise<string[]> {
  requirePathInspectionTime(options);
  if (paths.length === 0 || paths.length > MAX_DIFF_FILES) {
    throw new GitError(
      "invalid-input",
      "Select between 1 and 100 repository files.",
    );
  }
  const unique = new Set<string>();
  for (const input of paths) {
    requirePathInspectionTime(options);
    if (
      typeof input !== "string"
      || input.length === 0
      || input.length > MAX_PATH_LENGTH
      || isAbsolute(input)
      || input.startsWith(":")
      || input.includes("\0")
      || input.includes("\r")
      || input.includes("\n")
    ) {
      throw new GitError("invalid-input", "A selected file path is invalid.");
    }
    const absolute = resolve(root, input);
    if (!isContained(root, absolute) || absolute === root) {
      throw new GitError(
        "invalid-input",
        "A selected file is outside the repository.",
      );
    }
    try {
      const canonical = await realpath(absolute);
      requirePathInspectionTime(options);
      if (!isContained(root, canonical)) {
        throw new GitError(
          "invalid-input",
          "A selected file resolves outside the repository.",
        );
      }
    } catch (error) {
      if (error instanceof GitError) throw error;
      let ancestor = absolute;
      while (ancestor !== root) {
        requirePathInspectionTime(options);
        try {
          const info = await lstat(ancestor);
          requirePathInspectionTime(options);
          if (info.isSymbolicLink()) {
            throw new GitError(
              "invalid-input",
              "A selected file uses an unsafe symbolic link.",
            );
          }
          break;
        } catch (ancestorError) {
          if (ancestorError instanceof GitError) throw ancestorError;
          requirePathInspectionTime(options);
          ancestor = resolve(ancestor, "..");
        }
      }
    }
    requirePathInspectionTime(options);
    unique.add(relative(root, absolute).split(sep).join("/"));
  }
  return [...unique];
}
