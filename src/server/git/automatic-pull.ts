import { devNull } from "node:os";
import { fetchRepository } from "./remotes";
import { getRepositoryStatus } from "./status";
import { runGit, runGitInspection } from "./runner";
import { GitError, isGitProcessTreeTerminationFailure } from "./types";
import type { GitPathInspectionOptions } from "./paths";

/** No branch-name guesses: only the upstream remote's recorded default branch. */
export async function automaticPullCandidate(root: string, options: GitPathInspectionOptions = {}): Promise<string | null> {
  const status = await getRepositoryStatus(root, options);
  if (!status.clean || status.truncated || !status.branch || !status.upstream || status.ahead !== 0) return null;
  const inspection = { ...options, maxOutputBytes: 8192, failureMessage: "Unable to inspect automatic pull eligibility." };
  const routing = await runGitInspection(root, [
    "for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)", `refs/heads/${status.branch}`,
  ], inspection);
  const [remote, remoteRef, trackingRef] = routing.stdout.toString("utf8").trimEnd().split("\0");
  if (!remote || remote === "." || remoteRef !== `refs/heads/${status.branch}`
    || trackingRef !== `refs/remotes/${remote}/${status.branch}`) return null;
  try {
    const head = await runGitInspection(root, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], inspection);
    return head.stdout.toString("utf8").trim() === trackingRef ? trackingRef : null;
  } catch (error) {
    // Missing remote HEAD means unknown default, not permission to guess main/master.
    if (error instanceof GitError && error.code === "operation-failed" && !isGitProcessTreeTerminationFailure(error)) return null;
    throw error;
  }
}

/** Fetch tracking refs, recheck ownership/cleanliness, and fast-forward only. Never stash or replay. */
export async function automaticPull(root: string, expectedUpstream: string, options: GitPathInspectionOptions,
  verify: () => Promise<boolean>): Promise<boolean> {
  if (!await verify() || await automaticPullCandidate(root, options) !== expectedUpstream) return false;
  await fetchRepository(root, { ...options, disableHooks: true });
  if (!await verify() || await automaticPullCandidate(root, options) !== expectedUpstream) return false;
  const status = await getRepositoryStatus(root, options);
  if (!status.clean || status.truncated || status.ahead || !status.behind) return false;
  await runGit(root, ["-c", `core.hooksPath=${devNull}`, "merge", "--ff-only", "--no-edit", "--no-autostash", "--", expectedUpstream], {
    ...options, maxOutputBytes: 64 * 1024, failureMessage: "Automatic pull could not fast-forward this checkout. Review its Git status before retrying.",
  });
  return true;
}
