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
import { runGit, runGitInspection } from "./runner";
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

async function requireDirectory(path: string): Promise<string> {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > MAX_PATH_LENGTH
    || path.includes("\0")
  ) {
    throw new GitError("invalid-input", "The repository path is invalid.");
  }
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    return canonical;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError("not-found", "The repository folder could not be found.");
  }
}

export async function repositoryRoot(repositoryPath: string): Promise<string> {
  const directory = await requireDirectory(repositoryPath);
  const result = await runGitInspection(
    directory,
    ["rev-parse", "--show-toplevel"],
    {
      maxOutputBytes: MAX_PATH_LENGTH,
      failureMessage: "Unable to inspect this Git repository.",
    },
  );
  const reported = result.stdout.toString("utf8").trim();
  if (!isAbsolute(reported)) {
    throw new GitError(
      "not-repository",
      "The selected folder is not a Git repository.",
    );
  }
  try {
    return await realpath(reported);
  } catch {
    throw new GitError(
      "not-repository",
      "The selected folder is not a Git repository.",
    );
  }
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
): Promise<string[]> {
  if (paths.length === 0 || paths.length > MAX_DIFF_FILES) {
    throw new GitError(
      "invalid-input",
      "Select between 1 and 100 repository files.",
    );
  }
  const unique = new Set<string>();
  for (const input of paths) {
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
        try {
          const info = await lstat(ancestor);
          if (info.isSymbolicLink()) {
            throw new GitError(
              "invalid-input",
              "A selected file uses an unsafe symbolic link.",
            );
          }
          break;
        } catch (ancestorError) {
          if (ancestorError instanceof GitError) throw ancestorError;
          ancestor = resolve(ancestor, "..");
        }
      }
    }
    unique.add(relative(root, absolute).split(sep).join("/"));
  }
  return [...unique];
}
