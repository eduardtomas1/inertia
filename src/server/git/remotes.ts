import {
  MAX_PATH_LENGTH,
  NETWORK_TIMEOUT_MS,
} from "./constants";
import { listBranches } from "./branches";
import {
  repositoryRoot,
  validateName,
} from "./paths";
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
  const branches = await listBranches(root);
  if (!branches.current) {
    throw new GitError(
      "invalid-input",
      "Check out a local branch before pushing.",
    );
  }
  const current = branches.local.find((branch) => branch.current);
  const configuredRemote = current?.upstream?.split("/", 1)[0];
  const remote = validateName(
    remoteName ?? configuredRemote ?? "origin",
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
    ["push", "--set-upstream", remote, `HEAD:refs/heads/${branches.current}`],
    {
      timeoutMs: NETWORK_TIMEOUT_MS,
      failureMessage: "Unable to push the current branch.",
    },
  );
  return { status: await getRepositoryStatus(root) };
}

function remoteWebBase(remote: string): URL {
  const trimmed = remote.trim().replace(/\.git$/u, "");
  const scp = /^git@([^:]+):(.+)$/u.exec(trimmed);
  const candidate = scp
    ? `https://${scp[1]}/${scp[2]}`
    : trimmed.replace(/^ssh:\/\/git@/u, "https://");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new GitError(
      "operation-failed",
      "The origin remote is not a supported web repository URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GitError(
      "operation-failed",
      "The origin remote is not a supported web repository URL.",
    );
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
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
  const remote = await runGit(
    root,
    ["remote", "get-url", "origin"],
    {
      maxOutputBytes: MAX_PATH_LENGTH,
      failureMessage: "The repository does not have an origin remote.",
    },
  );
  const base = remoteWebBase(remote.stdout.toString("utf8"));
  const branch = encodeURIComponent(status.branch);
  const host = base.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) {
    return `${base.toString().replace(/\/$/u, "")}/compare/${branch}?expand=1`;
  }
  if (host.includes("gitlab")) {
    return `${base.toString().replace(/\/$/u, "")}/-/merge_requests/new?merge_request[source_branch]=${branch}`;
  }
  if (host.includes("bitbucket")) {
    return `${base.toString().replace(/\/$/u, "")}/pull-requests/new?source=${branch}`;
  }
  throw new GitError(
    "operation-failed",
    "Pull request links are supported for GitHub, GitLab, and Bitbucket remotes.",
  );
}
