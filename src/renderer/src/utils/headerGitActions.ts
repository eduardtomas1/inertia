import type {
  GitPullRequestUnavailableReason,
  GitStatusSnapshot,
} from "@shared/contracts";

export type HeaderGitActionId = "commit" | "fetch" | "pull" | "push" | "pull-request";

export type HeaderGitAction = {
  id: HeaderGitActionId;
  label: string;
  detail: string;
  disabled: boolean;
};

function pullRequestUnavailableDetail(
  reason: GitPullRequestUnavailableReason | null | undefined,
): string {
  if (reason === "no-branch") return "Check out a branch first.";
  if (reason === "no-remotes") return "Add a Git remote first.";
  if (reason === "ambiguous-remote") return "Choose one unambiguous upstream remote.";
  if (reason === "missing-remote") return "The branch upstream remote is missing.";
  if (reason === "unsupported-url") return "The selected remote URL is not supported.";
  if (reason === "unsupported-forge") return "The selected Git forge is not supported yet.";
  if (reason === "ambiguous-url") return "The remote URL does not identify one repository.";
  return "Pull request creation is unavailable for this checkout.";
}

export function headerGitActions(
  status: GitStatusSnapshot | null,
  busy = false,
): HeaderGitAction[] {
  if (!status?.isRepository) return [];
  const changedFiles = status.files.length;
  const dirty = changedFiles > 0;
  const incomplete = status.truncated === true;
  const conflicts = status.files.some((file) => file.status === "unmerged");
  const diverged = status.ahead > 0 && status.behind > 0;
  const canPull = Boolean(status.upstream)
    && status.behind > 0
    && !dirty
    && !incomplete
    && !diverged;
  const canPush = Boolean(status.branch)
    && status.hasRemote
    && Boolean(status.pullRequest?.remoteName)
    && status.pullRequest?.unavailableReason !== "missing-remote"
    && !incomplete
    && status.behind === 0
    && (status.ahead > 0 || !status.upstream);
  const canOpenPullRequest = status.pullRequest?.available === true
    && Boolean(status.upstream)
    && status.ahead === 0
    && !diverged;

  return [
    {
      id: "commit",
      label: "Commit",
      detail: incomplete ? "Repository status is incomplete. Refresh before committing."
        : conflicts ? "Resolve merge conflicts before committing."
        : dirty
        ? `Review and commit ${changedFiles} changed ${changedFiles === 1 ? "file" : "files"}.`
        : "There are no local changes to commit.",
      disabled: busy || !dirty || incomplete || conflicts,
    },
    {
      id: "fetch",
      label: "Fetch",
      detail: status.hasRemote
        ? "Refresh remote branches and incoming commits. Keep local changes."
        : "Add a Git remote before fetching.",
      disabled: busy || !status.hasRemote,
    },
    {
      id: "pull",
      label: status.behind > 0 ? `Pull ${status.behind}` : "Pull",
      detail: incomplete ? "Repository status is incomplete. Refresh before pulling."
        : !status.upstream
        ? "This branch has no upstream."
        : diverged
          ? "This branch has diverged; reconcile it in the terminal."
          : dirty
            ? "Commit or stash local changes before pulling."
          : status.behind > 0
            ? `Receive ${status.behind} upstream ${status.behind === 1 ? "commit" : "commits"}.`
            : "No incoming commits in the last local check. Fetch to check the remote.",
      disabled: busy || !canPull,
    },
    {
      id: "push",
      label: status.upstream
        ? status.ahead > 0 ? `Push ${status.ahead}` : "Push"
        : "Publish branch",
      detail: !status.branch
        ? "Check out a local branch first."
        : !status.hasRemote
          ? "Add a Git remote first."
          : !status.pullRequest?.remoteName
            ? "Configure one unambiguous push remote before publishing."
            : status.pullRequest.unavailableReason === "missing-remote"
              ? "The configured push remote is missing."
              : diverged
                ? "This branch has diverged; reconcile it in the terminal."
                : incomplete
                  ? "Repository status is incomplete. Refresh before pushing."
                  : status.behind > 0
                    ? "Pull incoming commits before pushing."
                  : status.upstream && status.ahead === 0
                    ? "There are no local commits to push."
                    : status.upstream
                      ? `Send ${status.ahead} local ${status.ahead === 1 ? "commit" : "commits"}.`
                      : "Push this branch and configure its upstream.",
      disabled: busy || !canPush,
    },
    {
      id: "pull-request",
      label: "Pull request",
      detail: canOpenPullRequest
        ? `Create or open a pull request through ${status.pullRequest?.forge ?? "the selected forge"}.`
        : diverged
          ? "Reconcile this diverged branch before creating a pull request."
          : status.pullRequest?.available !== true
            ? pullRequestUnavailableDetail(status.pullRequest?.unavailableReason)
          : status.ahead > 0 || !status.upstream
            ? "Push this branch before creating a pull request."
            : "Pull request creation is unavailable for this checkout.",
      disabled: busy || !canOpenPullRequest,
    },
  ];
}

export function gitSyncSummary(status: GitStatusSnapshot): string {
  if (status.truncated) return "Incomplete status";
  if (!status.branch) return "Detached HEAD";
  if (!status.hasRemote) return "Local repository";
  if (!status.upstream) return "No upstream";
  if (status.ahead > 0 && status.behind > 0) return "Branches have diverged";
  if (status.behind > 0) return `${status.behind} incoming ${status.behind === 1 ? "commit" : "commits"}`;
  if (status.ahead > 0) return `${status.ahead} outgoing ${status.ahead === 1 ? "commit" : "commits"}`;
  return "Up to date with last fetch";
}
