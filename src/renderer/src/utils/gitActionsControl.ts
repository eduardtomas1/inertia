import type { GitStatusSnapshot } from "@shared/contracts";

import {
  headerGitActions,
  pushRemoteConfigured,
  type HeaderGitAction,
  type HeaderGitActionId,
} from "./headerGitActions";

export type GitQuickActionKind =
  | "commit"
  | "push"
  | "push_pull_request"
  | "pull"
  | "create_branch"
  | "show_hint";

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: GitQuickActionKind;
  hint?: string;
}

export type GitActionMenuItem = HeaderGitAction;

const DEFAULT_BRANCH_NAMES = new Set(["main", "master", "trunk", "develop", "default"]);

export function isDefaultBranchName(branch: string | null): boolean {
  return branch !== null && DEFAULT_BRANCH_NAMES.has(branch);
}

function actionDetail(
  status: GitStatusSnapshot,
  id: HeaderGitActionId,
): string {
  return headerGitActions(status).find((action) => action.id === id)?.detail
    ?? "This action is currently unavailable.";
}

function pushQuickAction(status: GitStatusSnapshot, label: string): GitQuickAction {
  if (!isDefaultBranchName(status.branch) && status.pullRequest?.available === true) {
    return { label: "Push & create PR", disabled: false, kind: "push_pull_request" };
  }
  return { label, disabled: false, kind: "push" };
}

export function resolveQuickAction(
  status: GitStatusSnapshot | null,
  isBusy: boolean,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }
  if (!status?.isRepository) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git status is unavailable." };
  }
  if (status.truncated) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Repository status is incomplete. Refresh before changing it.",
    };
  }

  const hasBranch = status.branch !== null;
  const hasChanges = status.files.length > 0;
  const hasUpstream = Boolean(status.upstream);
  const isAhead = status.ahead > 0;
  const isBehind = status.behind > 0;
  const isDiverged = isAhead && isBehind;

  if (!hasBranch) {
    return {
      label: "Create branch",
      disabled: false,
      kind: "create_branch",
      hint: "Detached HEAD: create and check out a branch before pushing or opening a pull request.",
    };
  }

  if (hasChanges) {
    if (status.files.some((file) => file.status === "unmerged")) {
      return {
        label: "Commit",
        disabled: true,
        kind: "show_hint",
        hint: "Resolve merge conflicts before committing.",
      };
    }
    return { label: "Commit", disabled: false, kind: "commit" };
  }

  if (!hasUpstream) {
    if (!pushRemoteConfigured(status)) {
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: actionDetail(status, "push"),
      };
    }
    return pushQuickAction(status, "Publish branch");
  }

  if (isDiverged) {
    return {
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase or merge in the terminal first.",
    };
  }

  if (isBehind) {
    return { label: "Pull", disabled: false, kind: "pull" };
  }

  if (isAhead) {
    if (!pushRemoteConfigured(status)) {
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: actionDetail(status, "push"),
      };
    }
    return pushQuickAction(status, "Push");
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. Nothing to commit or push.",
  };
}

const MENU_ORDER: readonly HeaderGitActionId[] = [
  "commit",
  "push",
  "pull-request",
  "pull",
  "fetch",
];

export function buildMenuItems(
  status: GitStatusSnapshot | null,
  isBusy: boolean,
): GitActionMenuItem[] {
  const actions = headerGitActions(status, isBusy);
  return MENU_ORDER.flatMap((id) => {
    const action = actions.find((candidate) => candidate.id === id);
    if (!action) return [];
    return [{
      ...action,
      detail: action.disabled && isBusy ? "Git action in progress." : action.detail,
    }];
  });
}

export function gitMenuWarning(status: GitStatusSnapshot | null): string | null {
  if (!status?.isRepository) return null;
  if (status.branch === null) {
    return "Detached HEAD: create and check out a branch to enable push and pull request actions.";
  }
  if (status.files.length === 0 && status.behind > 0 && status.ahead === 0) {
    return "Behind upstream. Pull first.";
  }
  return null;
}
