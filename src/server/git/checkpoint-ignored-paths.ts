import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { CheckpointError } from "../checkpoints";
import { runGit } from "./runner";

function overlapError(): CheckpointError {
  return new CheckpointError(
    "Move ignored files that overlap this checkpoint before restoring it. Ignored files are not included in recovery checkpoints.",
  );
}

function nulPaths(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean);
}

async function occupiesIgnoredDirectory(
  repositoryPath: string,
  directory: string,
  target: string,
  deadlineAt: number,
): Promise<boolean> {
  const parts = target.slice(directory.length + 1).split("/");
  let current = directory;
  for (const [index, part] of parts.entries()) {
    if (Date.now() >= deadlineAt) {
      throw new CheckpointError("Checkpoint operation timed out.");
    }
    current = `${current}/${part}`;
    try {
      const entry = await lstat(join(repositoryPath, current));
      if (index === parts.length - 1 || !entry.isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new CheckpointError(
        "Unable to check ignored files before checkpoint restore.",
      );
    }
  }
  return false;
}

/** Ignored files are intentionally excluded from recovery snapshots. */
export async function assertCheckpointPreservesIgnoredFiles(
  repositoryPath: string,
  ref: string,
  deadlineAt: number,
): Promise<void> {
  const options = {
    deadlineAt,
    maxOutputBytes: 16 * 1024 * 1024,
    failureMessage: "Unable to check ignored files before checkpoint restore.",
  };
  const ignored = await runGit(repositoryPath, [
    "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z",
  ], options);
  if (ignored.stdout.length === 0) return;
  const ignoredFiles = new Set<string>();
  const ignoredDirectories = new Set<string>();
  for (const path of nulPaths(ignored.stdout)) {
    if (path.endsWith("/")) ignoredDirectories.add(path.slice(0, -1));
    else ignoredFiles.add(path);
  }
  const target = await runGit(repositoryPath, [
    "ls-tree", "--full-tree", "-r", "--name-only", "-z", ref,
  ], options);
  const targetPaths = new Set(nulPaths(target.stdout));
  for (const path of [...ignoredFiles, ...ignoredDirectories]) {
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      if (targetPaths.has(parts.slice(0, length).join("/"))) throw overlapError();
    }
  }
  for (const path of targetPaths) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const ancestor = parts.slice(0, length).join("/");
      if (ignoredFiles.has(ancestor)) throw overlapError();
      if (ignoredDirectories.has(ancestor)) {
        if (await occupiesIgnoredDirectory(
          repositoryPath,
          ancestor,
          path,
          deadlineAt,
        )) throw overlapError();
        break;
      }
    }
  }
}
