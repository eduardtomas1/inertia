import {
  NETWORK_TIMEOUT_MS,
} from "./constants";
import {
  repositoryRoot,
  validateName,
  validateBranch,
  type GitPathInspectionOptions,
} from "./paths";
import {
  inspectGitRemoteRouting,
  type GitRemoteRoutingInspection,
} from "./remote-routing";
import { runGit, runGitInspection } from "./runner";
import { requireCleanCheckout } from "./branches";
import { readConfiguredFetchRefspecs, scopedTrackingFetchRefspecs } from "./fetch-refspecs";
import { getRepositoryStatus } from "./status";
import {
  GitError,
  type GitMutationResult,
} from "./types";

export async function pullRepository(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<GitMutationResult> {
  options = { ...options, deadlineAt: options.deadlineAt ?? Date.now() + NETWORK_TIMEOUT_MS + 60_000 };
  const root = await repositoryRoot(repositoryPath, options);
  const status = await getRepositoryStatus(root, options);
  if (!status.branch) throw new GitError("invalid-input", "Check out a local branch before pulling.");
  if (!status.upstream) throw new GitError("invalid-input", "This branch has no upstream. Publish it or configure tracking before pulling.");
  requireCleanCheckout(status, "pulling");
  if (status.ahead > 0 && status.behind > 0) {
    throw new GitError("conflict", "This branch has diverged from its upstream. Reconcile it in the terminal before pulling.");
  }
  await runGit(root, ["pull", "--ff-only", "--no-rebase", "--no-autostash", "--no-recurse-submodules"], {
    ...options,
    timeoutMs: NETWORK_TIMEOUT_MS,
    failureMessage: "Unable to pull changes from the remote repository.",
  });
  return { status: await getRepositoryStatus(root, options) };
}

/** Refresh one tracking remote without touching the index, checkout, tags or FETCH_HEAD. */
export async function fetchRepository(
  repositoryPath: string,
  options: GitPathInspectionOptions = {},
): Promise<GitMutationResult> {
  options = { ...options, deadlineAt: options.deadlineAt ?? Date.now() + NETWORK_TIMEOUT_MS + 60_000 };
  const root = await repositoryRoot(repositoryPath, options);
  const remotes = await runGitInspection(root, ["remote"], {
    ...options,
    maxOutputBytes: 16 * 1024,
    failureMessage: "Unable to inspect repository remotes.",
  });
  const names = remotes.stdout.toString("utf8").split("\n").filter(Boolean);
  if (names.length === 0) throw new GitError("not-found", "Add a Git remote before fetching.");
  const status = await getRepositoryStatus(root, options);
  let trackedRemote = "";
  if (status.branch) {
    // The upstream atom becomes empty when its configured remote is missing.
    // Keep that intent so a broken upstream cannot silently fetch from origin.
    const routing = await runGitInspection(root, [
      "config", "--null", "--default", "", "--get", `branch.${status.branch}.remote`,
    ], { ...options, maxOutputBytes: 16 * 1024, failureMessage: "Unable to inspect the upstream remote." });
    trackedRemote = routing.stdout.toString("utf8").split("\0")[0] ?? "";
  }
  const remote = trackedRemote && trackedRemote !== "." ? trackedRemote
    : names.includes("origin") ? "origin" : names.length === 1 ? names[0]! : null;
  if (!remote) throw new GitError("invalid-input", "Several remotes are configured. Set an upstream for this branch or fetch a remote in the terminal.");
  if (!names.includes(remote)) throw new GitError("not-found", "The upstream remote is missing. Update branch tracking before fetching.");
  // Reject names that can alias on case-insensitive filesystems, even when
  // this checkout currently lives on a case-sensitive volume.
  const namespace = remote.toLowerCase();
  if (names.some((name) => {
    if (name === remote) return false;
    const other = name.toLowerCase();
    return other === namespace || other.startsWith(`${namespace}/`) || namespace.startsWith(`${other}/`);
  })) {
    throw new GitError("invalid-input", "Remote tracking namespaces overlap. Rename the conflicting remotes in the terminal before fetching.");
  }
  validateName(remote, "The remote name");
  await validateBranch(root, `${remote}/inertia-fetch-probe`, options);
  const configured = await readConfiguredFetchRefspecs(root, remote, options);
  const { refspecs } = scopedTrackingFetchRefspecs(remote, configured);
  await runGit(root, [
    "fetch", "--no-recurse-submodules", "--no-auto-maintenance", "--no-tags",
    "--no-prune", "--no-prune-tags", "--no-write-fetch-head", "--refmap=", "--", remote,
    ...refspecs,
  ], {
    ...options,
    timeoutMs: NETWORK_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    failureMessage: "Unable to fetch remote branches. Check connectivity and Git authentication, then retry.",
  });
  return { status: await getRepositoryStatus(root, options) };
}

export async function pushCurrentBranch(
  repositoryPath: string,
  remoteName?: string,
): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  const status = await getRepositoryStatus(root);
  if (!status.branch) {
    throw new GitError(
      "invalid-input",
      "Check out a local branch before pushing.",
    );
  }
  const configuredRemote = status.pullRequest.remoteName;
  const selectedRemote = remoteName ?? configuredRemote;
  if (!selectedRemote) {
    throw remoteSelectionError(status.pullRequest.unavailableReason);
  }
  const remote = validateName(
    selectedRemote,
    "The remote name",
  );
  const remoteResult = await runGit(root, ["remote"], {
    failureMessage: "Unable to inspect repository remotes.",
  });
  if (!remoteResult.stdout.toString("utf8").split("\n").includes(remote)) {
    throw new GitError(
      "not-found",
      "The selected Git remote does not exist.",
    );
  }
  await runGit(
    root,
    ["push", "--set-upstream", remote, `HEAD:refs/heads/${status.branch}`],
    {
      timeoutMs: NETWORK_TIMEOUT_MS,
      failureMessage: "Unable to push the current branch.",
    },
  );
  return { status: await getRepositoryStatus(root) };
}

function remoteSelectionError(
  reason: GitRemoteRoutingInspection["pullRequest"]["unavailableReason"],
): GitError {
  if (reason === "no-branch") {
    return new GitError(
      "invalid-input",
      "Check out a branch before selecting a remote.",
    );
  }
  if (reason === "no-remotes") {
    return new GitError(
      "not-found",
      "Add a Git remote before pushing or opening a pull request.",
    );
  }
  if (reason === "ambiguous-remote") {
    return new GitError(
      "invalid-input",
      "Configure a push remote for this branch before continuing.",
    );
  }
  if (reason === "missing-remote") {
    return new GitError(
      "not-found",
      "The configured push remote does not exist.",
    );
  }
  if (reason === "ambiguous-url") {
    return new GitError(
      "invalid-input",
      "The selected Git remote has multiple push destinations.",
    );
  }
  if (reason === "unsupported-url") {
    return new GitError(
      "operation-failed",
      "The selected Git remote does not have a supported web repository URL.",
    );
  }
  return new GitError(
    "operation-failed",
    "Pull request links are supported for GitHub, GitLab, and Bitbucket remotes.",
  );
}

export async function getPullRequestCreateUrl(
  repositoryPath: string,
): Promise<string> {
  const root = await repositoryRoot(repositoryPath);
  const status = await getRepositoryStatus(root);
  if (!status.branch) {
    throw new GitError(
      "invalid-input",
      "Check out a branch before opening a pull request.",
    );
  }
  const routing = await inspectGitRemoteRouting(root, status.branch);
  if (!routing.target) {
    throw remoteSelectionError(routing.pullRequest.unavailableReason);
  }
  const { baseUrl: base, forge } = routing.target;
  const branch = encodeURIComponent(status.branch);
  if (forge === "github") {
    return `${base}/compare/${branch}?expand=1`;
  }
  if (forge === "gitlab") {
    return `${base}/-/merge_requests/new?merge_request[source_branch]=${branch}`;
  }
  if (forge === "bitbucket") {
    return `${base}/pull-requests/new?source=${branch}`;
  }
  throw remoteSelectionError("unsupported-forge");
}
