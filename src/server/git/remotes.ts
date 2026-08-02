import {
  NETWORK_TIMEOUT_MS,
} from "./constants";
import {
  repositoryRoot,
  validateName,
} from "./paths";
import {
  inspectGitRemoteRouting,
  type GitRemoteRoutingInspection,
} from "./remote-routing";
import { runGit } from "./runner";
import { getRepositoryStatus } from "./status";
import {
  GitError,
  type GitMutationResult,
} from "./types";

export async function pullRepository(
  repositoryPath: string,
): Promise<GitMutationResult> {
  const root = await repositoryRoot(repositoryPath);
  await runGit(root, ["pull", "--ff-only", "--no-rebase"], {
    timeoutMs: NETWORK_TIMEOUT_MS,
    failureMessage: "Unable to pull changes from the remote repository.",
  });
  return { status: await getRepositoryStatus(root) };
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
