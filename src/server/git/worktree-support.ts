import { runGit } from "./runner";
import { GitError } from "./types";

/** NUL-delimited worktree records are required to preserve hostile pathnames. */
export async function requireGitWorktreeSupport(root: string): Promise<void> {
  const { stdout } = await runGit(root, ["--version"], {
    maxOutputBytes: 1_024,
    failureMessage: "Unable to check Git worktree support.",
  });
  const version = /^git version (\d+)\.(\d+)(?:\.|\s|$)/u.exec(stdout.toString("utf8"));
  const major = Number(version?.[1]);
  const minor = Number(version?.[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)
    || major < 2 || (major === 2 && minor < 36)) {
    throw new GitError("git-unavailable", "Worktree management requires Git 2.36 or newer. Upgrade Git, then try again.");
  }
}
