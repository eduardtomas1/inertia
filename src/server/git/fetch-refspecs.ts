import type { GitPathInspectionOptions } from "./paths";
import { runGitInspection } from "./runner";
import { GitError, isGitProcessTreeTerminationFailure } from "./types";

export async function readConfiguredFetchRefspecs(
  root: string,
  remote: string,
  options: GitPathInspectionOptions,
): Promise<string[]> {
  const key = `remote.${remote}.fetch`;
  const inspection = { ...options, maxOutputBytes: 16 * 1024,
    failureMessage: "Unable to inspect the remote fetch mappings." };
  let configured: string[];
  try {
    configured = (await runGitInspection(root, ["config", "--null", "--get-all", key], inspection))
      .stdout.toString("utf8").split("\0").filter(Boolean);
  } catch (error) {
    if (!(error instanceof GitError) || error.code !== "operation-failed" || isGitProcessTreeTerminationFailure(error)) throw error;
    // --get-all exits unsuccessfully for an absent key. Confirm its absence
    // using --get's default; malformed config and cleanup failures still fail.
    const absent = await runGitInspection(root, ["config", "--null", "--default", "", "--get", key], inspection);
    if (absent.stdout.toString("utf8").split("\0")[0]) throw error;
    configured = [];
  }
  return configured;
}

export function scopedTrackingFetchRefspecs(remote: string, configured: readonly string[]): {
  refspecs: string[];
  fallback: string | null;
} {
  const namespace = `refs/remotes/${remote}/`;
  const safe: string[] = [];
  for (const value of configured) {
    if (value.startsWith("^")) continue;
    const [source = "", destination = "", extra] = value.replace(/^\+/u, "").split(":");
    const head = source.startsWith("refs/heads/");
    const tracking = destination.startsWith(namespace);
    // Git resolves a branch's upstream through the first matching source
    // mapping. Appending our mapping to a mirror/foreign mapping can silently
    // track a local branch or a different remote instead of the selected ref.
    if ((head || tracking) && (!head || !tracking || extra !== undefined)) {
      throw new GitError("invalid-input", "The remote fetch mappings are incompatible with branch tracking. Configure a remote-tracking mapping for this remote in the terminal, then retry.");
    }
    if (head && tracking) safe.push(value);
  }
  const fallback = safe.length ? null : `+refs/heads/*:${namespace}*`;
  return {
    // Negative patterns can match heads without a refs/heads/ prefix. They
    // only exclude sources; preserve them for Git's own refspec validation.
    refspecs: [...(fallback ? [fallback] : safe), ...configured.filter((value) => value.startsWith("^"))],
    fallback,
  };
}
