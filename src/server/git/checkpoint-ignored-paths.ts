import { CheckpointError } from "../checkpoints";
import { runGit } from "./runner";

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
    "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
  ], options);
  if (ignored.stdout.length === 0) return;
  const target = await runGit(repositoryPath, [
    "ls-tree", "-r", "--name-only", "-z", ref,
  ], options);
  const targetPaths = new Set(target.stdout.toString("utf8").split("\0").filter(Boolean));
  for (const path of ignored.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      if (targetPaths.has(parts.slice(0, length).join("/"))) {
        throw new CheckpointError(
          "Move ignored files that overlap this checkpoint before restoring it. Ignored files are not included in recovery checkpoints.",
        );
      }
    }
  }
}
