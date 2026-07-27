import { NETWORK_TIMEOUT_MS } from "./constants";
import {
  repositoryRoot,
  validatedPaths,
} from "./paths";
import { runGit } from "./runner";
import { getRepositoryStatus } from "./status";
import {
  GitError,
  type GitCommitResult,
} from "./types";

export async function commitChanges(
  repositoryPath: string,
  message: string,
  paths?: readonly string[],
): Promise<GitCommitResult> {
  const root = await repositoryRoot(repositoryPath);
  if (
    typeof message !== "string"
    || message.trim().length === 0
    || message.length > 10_000
    || message.includes("\0")
  ) {
    throw new GitError(
      "invalid-input",
      "Enter a commit message between 1 and 10,000 characters.",
    );
  }
  if (paths && paths.length === 0) {
    throw new GitError(
      "invalid-input",
      "Select at least one path to commit.",
    );
  }
  const selected = paths ? await validatedPaths(root, paths) : null;
  await runGit(root, ["add", "-A", "--", ...(selected ?? [])], {
    failureMessage: "Unable to stage the selected changes.",
  });
  await runGit(
    root,
    ["commit", "-m", message, ...(selected ? ["--", ...selected] : [])],
    {
      timeoutMs: NETWORK_TIMEOUT_MS,
      failureMessage: "Unable to create the commit.",
    },
  );
  const commitResult = await runGit(root, ["rev-parse", "HEAD"], {
    maxOutputBytes: 256,
    failureMessage:
      "The commit was created, but its identifier could not be read.",
  });
  return {
    commit: commitResult.stdout.toString("utf8").trim(),
    status: await getRepositoryStatus(root),
  };
}
