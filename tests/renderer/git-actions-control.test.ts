import { describe, expect, it } from "vitest";

import type { ChangedFile, GitStatusSnapshot } from "../../src/shared/contracts";
import {
  buildMenuItems,
  gitMenuWarning,
  isDefaultBranchName,
  resolveQuickAction,
} from "../../src/renderer/src/utils/gitActionsControl";

const modified: ChangedFile = {
  path: "src/app.ts",
  status: "modified",
  insertions: 1,
  deletions: 0,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
};

function status(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    isRepository: true,
    root: "/workspace/inertia",
    branch: "feature/header",
    upstream: "origin/feature/header",
    ahead: 0,
    behind: 0,
    hasRemote: true,
    pullRequest: {
      available: true,
      remoteName: "origin",
      forge: "github",
      unavailableReason: null,
    },
    files: [],
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

describe("Git quick action derivation", () => {
  it("explains busy and unavailable states instead of guessing", () => {
    expect(resolveQuickAction(status(), true)).toEqual({
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git action in progress.",
    });
    expect(resolveQuickAction(null, false)).toMatchObject({
      disabled: true,
      hint: "Git status is unavailable.",
    });
    expect(resolveQuickAction(status({ isRepository: false }), false)).toMatchObject({
      disabled: true,
    });
    expect(resolveQuickAction(status({ truncated: true, files: [modified] }), false)).toMatchObject({
      label: "Commit",
      disabled: true,
      hint: "Repository status is incomplete. Refresh before changing it.",
    });
  });

  it("offers Create branch on a detached HEAD", () => {
    expect(resolveQuickAction(status({ branch: null, files: [modified] }), false)).toMatchObject({
      label: "Create branch",
      disabled: false,
      kind: "create_branch",
    });
  });

  it("commits local changes first and blocks conflicted commits", () => {
    expect(resolveQuickAction(status({ files: [modified], ahead: 2 }), false)).toEqual({
      label: "Commit",
      disabled: false,
      kind: "commit",
    });
    expect(resolveQuickAction(status({
      files: [{ ...modified, status: "unmerged" }],
    }), false)).toMatchObject({
      label: "Commit",
      disabled: true,
      hint: "Resolve merge conflicts before committing.",
    });
  });

  it("pushes and opens a pull request from a feature branch", () => {
    expect(resolveQuickAction(status({ ahead: 2 }), false)).toMatchObject({
      label: "Push & create PR",
      kind: "push_pull_request",
      disabled: false,
    });
    expect(resolveQuickAction(status({ upstream: null }), false)).toMatchObject({
      label: "Push & create PR",
      kind: "push_pull_request",
    });
  });

  it("pushes default branches and forges without pull requests plainly", () => {
    expect(resolveQuickAction(status({ branch: "main", ahead: 1 }), false)).toMatchObject({
      label: "Push",
      kind: "push",
    });
    expect(resolveQuickAction(status({ branch: "main", upstream: null }), false)).toMatchObject({
      label: "Publish branch",
      kind: "push",
    });
    expect(resolveQuickAction(status({
      ahead: 1,
      pullRequest: {
        available: false,
        remoteName: "origin",
        forge: null,
        unavailableReason: "unsupported-forge",
      },
    }), false)).toMatchObject({ label: "Push", kind: "push" });
  });

  it("keeps push disabled without an unambiguous remote and explains why", () => {
    expect(resolveQuickAction(status({
      ahead: 1,
      pullRequest: {
        available: false,
        remoteName: null,
        forge: null,
        unavailableReason: "ambiguous-remote",
      },
    }), false)).toMatchObject({
      label: "Push",
      disabled: true,
      hint: "Configure one unambiguous push remote before publishing.",
    });
  });

  it("pulls when behind, and refuses to guess when diverged", () => {
    expect(resolveQuickAction(status({ behind: 3 }), false)).toEqual({
      label: "Pull",
      disabled: false,
      kind: "pull",
    });
    expect(resolveQuickAction(status({ behind: 3, ahead: 1 }), false)).toMatchObject({
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
    });
  });

  it("stays hoverable and disabled when the branch is up to date", () => {
    expect(resolveQuickAction(status(), false)).toEqual({
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. Nothing to commit or push.",
    });
  });

  it("recognizes conventional default branch names only", () => {
    expect(isDefaultBranchName("main")).toBe(true);
    expect(isDefaultBranchName("master")).toBe(true);
    expect(isDefaultBranchName("feature/main")).toBe(false);
    expect(isDefaultBranchName(null)).toBe(false);
  });
});

describe("Git menu items", () => {
  it("orders commit, push and pull request before sync actions", () => {
    expect(buildMenuItems(status({ ahead: 1 }), false).map(({ id }) => id)).toEqual([
      "commit",
      "push",
      "pull-request",
      "pull",
      "fetch",
    ]);
    expect(buildMenuItems(null, false)).toEqual([]);
  });

  it("explains every disabled item while a Git action runs", () => {
    const items = buildMenuItems(status({ files: [modified] }), true);
    expect(items.every(({ disabled }) => disabled)).toBe(true);
    expect(new Set(items.map(({ detail }) => detail))).toEqual(new Set(["Git action in progress."]));
  });

  it("warns about detached and behind checkouts", () => {
    expect(gitMenuWarning(status({ branch: null }))).toMatch(/Detached HEAD/u);
    expect(gitMenuWarning(status({ behind: 2 }))).toBe("Behind upstream. Pull first.");
    expect(gitMenuWarning(status())).toBeNull();
  });
});
