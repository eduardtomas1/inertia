import { validateBranch, type GitPathInspectionOptions } from "./paths";
import { runGitInspection } from "./runner";
import { scopedTrackingFetchRefspecs } from "./fetch-refspecs";
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
  options: GitPathInspectionOptions,
): Promise<string | null> {
  const failure = new GitError("invalid-input", "Remote fetch mappings do not identify one tracking branch. Configure tracking in the terminal, then refresh branches.");
  const inspection = { ...options, maxOutputBytes: 64 * 1024,
    failureMessage: "Unable to inspect remote tracking configuration." };
  const config = await runGitInspection(root, ["config", "--null", "--get-regexp", "^remote\\..*\\.fetch$"], inspection)
    .then((result) => result.stdout.toString("utf8"))
    .catch(async (error: unknown) => {
      if (!(error instanceof GitError) || error.code !== "operation-failed" || isGitProcessTreeTerminationFailure(error)) throw error;
      // An absent key makes --get-regexp fail. Inspect names only to prove
      // absence without reading unrelated configuration values or hiding errors.
      const keys = await runGitInspection(root, ["config", "--null", "--name-only", "--list"], inspection);
      if (keys.stdout.toString("utf8").split("\0").some((key) => /^remote\..*\.fetch$/u.test(key))) throw error;
      return "";
    });
  const records: Array<{ remote: string; value: string }> = [];
  for (const record of config.split("\0")) {
    const separator = record.indexOf("\n");
    const name = /^remote\.(.+)\.fetch$/u.exec(record.slice(0, separator))?.[1];
    if (separator >= 0 && name) records.push({ remote: name, value: record.slice(separator + 1) });
  }
  const { fallback } = scopedTrackingFetchRefspecs(remote, records.filter((entry) => entry.remote === remote).map((entry) => entry.value));
  if (fallback) records.push({ remote, value: fallback });
  const matches = new Set<string>();
  const excluded: Array<{ remote: string; source: string }> = [];
  for (const record of records) {
    const name = record.remote;
    const value = record.value.replace(/^\+/u, "");
    if (value.startsWith("^")) {
      excluded.push({ remote: name, source: value.slice(1) });
      continue;
    }
    const [source, destination] = value.split(":");
    if (!source || !destination) continue;
    const capture = refspecMatch(destination, `refs/remotes/${remoteBranch}`);
    if (capture !== null) matches.add(`${name}\0${source.replace("*", capture)}`);
  }
  const [matchedRemote, source = ""] = [...matches][0]?.split("\0") ?? [];
  if (matches.size !== 1 || matchedRemote !== remote || !source.startsWith("refs/heads/")
    || excluded.some((entry) => entry.remote === remote && refspecMatch(entry.source, source) !== null)) {
    throw failure;
  }
  const destinations = new Set<string>();
  for (const record of records) {
    if (record.remote !== remote || record.value.startsWith("^")) continue;
    const [sourcePattern = "", destination] = record.value.replace(/^\+/u, "").split(":");
    const capture = refspecMatch(sourcePattern, source);
    if (destination && capture !== null) destinations.add(destination.replace("*", capture));
  }
  if (destinations.size !== 1 || !destinations.has(`refs/remotes/${remoteBranch}`)) throw failure;
  await validateBranch(root, source.slice("refs/heads/".length), options);
  return fallback;
}
