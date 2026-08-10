import type { GitStatusSnapshot } from "@shared/contracts";

import type { HeaderGitAction } from "./headerGitActions";

export function primaryHeaderGitAction(
  status: GitStatusSnapshot | null,
): HeaderGitAction | null {
  if (!status?.isRepository) return null;
  if (status.files.length > 0) {
    return {
      id: "commit",
      label: "Commit",
      detail: "",
      disabled: false,
    };
  }
  const diverged = status.ahead > 0 && status.behind > 0;
  if (status.upstream && status.behind > 0 && !diverged) {
    return {
      id: "pull",
      label: `Pull ${status.behind}`,
      detail: "",
      disabled: false,
    };
  }
  if (
    status.branch
    && status.hasRemote
    && status.pullRequest?.remoteName
    && status.pullRequest.unavailableReason !== "missing-remote"
    && !diverged
    && (status.ahead > 0 || !status.upstream)
  ) {
    return {
      id: "push",
      label: status.upstream ? `Push ${status.ahead}` : "Publish branch",
      detail: "",
      disabled: false,
    };
  }
  return null;
}
