import type { GitPathInspectionOptions } from "./paths";
import { runGitInspection } from "./runner";
import { GitError, isGitProcessTreeTerminationFailure } from "./types";

function refspecMatch(pattern: string, ref: string): string | null {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === ref ? "" : null;
  if (parts.length !== 2) return null;
  const [prefix = "", suffix = ""] = parts;
  return ref.length >= prefix.length + suffix.length && ref.startsWith(prefix) && ref.endsWith(suffix)
    ? ref.slice(prefix.length, ref.length - suffix.length)
    : null;
}

/** Git can create a branch before rejecting ambiguous --track configuration. */
export async function requireUnambiguousBranchTracking(
  root: string,
  remote: string,
  remoteBranch: string,
  localBranch: string,
  options: GitPathInspectionOptions,
): Promise<void> {
  const failure = new GitError("invalid-input", "Remote fetch mappings do not identify one tracking branch. Configure tracking in the terminal, then refresh branches.");
  const config = await runGitInspection(root, ["config", "--null", "--get-regexp", "^remote\\..*\\.fetch$"], {
    ...options,
    maxOutputBytes: 64 * 1024,
    failureMessage: "Unable to inspect remote tracking configuration.",
  }).catch((error: unknown) => {
    if (error instanceof GitError && error.code === "operation-failed" && !isGitProcessTreeTerminationFailure(error)) throw failure;
    throw error;
  });
  const matches = new Set<string>();
  const excluded: Array<{ remote: string; source: string }> = [];
  for (const record of config.stdout.toString("utf8").split("\0")) {
    const separator = record.indexOf("\n");
    const name = /^remote\.(.+)\.fetch$/u.exec(record.slice(0, separator))?.[1];
    if (separator < 0 || !name) continue;
    const value = record.slice(separator + 1).replace(/^\+/u, "");
    if (value.startsWith("^")) {
      excluded.push({ remote: name, source: value.slice(1) });
      continue;
    }
    const [source, destination] = value.split(":");
    if (!source || !destination) continue;
    const capture = refspecMatch(destination, `refs/remotes/${remoteBranch}`);
    if (capture !== null) matches.add(`${name}\0${source.replace("*", capture)}`);
  }
  const expectedSource = `refs/heads/${localBranch}`;
  if (matches.size !== 1 || !matches.has(`${remote}\0${expectedSource}`)
    || excluded.some((entry) => entry.remote === remote && refspecMatch(entry.source, expectedSource) !== null)) {
    throw failure;
  }
}
