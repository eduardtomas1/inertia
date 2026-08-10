import { describe, expect, it } from "vitest";

import type { GitStatusSnapshot } from "../../src/shared/contracts";
import {
  headerGitActions,
} from "../../src/renderer/src/utils/headerGitActions";
import { primaryHeaderGitAction } from "../../src/renderer/src/utils/primaryHeaderGitAction";

function status(
  overrides: Partial<GitStatusSnapshot> = {},
): GitStatusSnapshot {
  return {
    isRepository: true,
    root: "/workspace/inertia",
    branch: "feature/git-ui",
    upstream: "origin/feature/git-ui",
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

describe("header Git action hierarchy", () => {
  it("prioritizes committing a dirty checkout", () => {
    const current = status({
      files: [{
        path: "src/app.ts",
        status: "modified",
        insertions: 1,
        deletions: 0,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: ".",
        worktreeStatus: "M",
      }],
    });
    const actions = headerGitActions(current);

    expect(primaryHeaderGitAction(current)?.id).toBe("commit");
    expect(actions.find((action) => action.id === "pull")).toMatchObject({
      disabled: true,
      detail: "Commit or discard local changes before pulling.",
    });
  });

  it("prioritizes pulling a clean checkout that is behind", () => {
    const current = status({ behind: 3 });

    expect(primaryHeaderGitAction(current)).toMatchObject({
      id: "pull",
      label: "Pull 3",
    });
  });

  it("prioritizes pushing a clean checkout that is ahead", () => {
    const current = status({ ahead: 2 });
    const actions = headerGitActions(current);

    expect(primaryHeaderGitAction(current)).toMatchObject({
      id: "push",
      label: "Push 2",
    });
    expect(actions.find((action) => action.id === "pull-request")).toMatchObject({
      disabled: true,
      detail: "Push this branch before creating a pull request.",
    });
  });

  it("keeps a routing-capable pull request secondary on an up-to-date branch", () => {
    const current = status();
    const actions = headerGitActions(current);

    expect(primaryHeaderGitAction(current)).toBeNull();
    expect(actions.find((action) => action.id === "pull-request")).toMatchObject({
      disabled: false,
    });
  });

  it("surfaces divergence before lower-priority dirty or publish guidance", () => {
    const current = status({
      ahead: 2,
      behind: 1,
      files: [{
        path: "src/app.ts",
        status: "modified",
        insertions: 1,
        deletions: 0,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: ".",
        worktreeStatus: "M",
      }],
    });
    const actions = headerGitActions(current);

    expect(actions.filter((action) => action.id !== "commit")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "pull", detail: "This branch has diverged; reconcile it in the terminal." }),
        expect.objectContaining({ id: "push", detail: "This branch has diverged; reconcile it in the terminal." }),
        expect.objectContaining({ id: "pull-request", detail: "Reconcile this diverged branch before creating a pull request." }),
      ]),
    );
  });

  it("does not offer publish when no unambiguous push remote is selected", () => {
    const current = status({
      upstream: null,
      pullRequest: {
        available: false,
        remoteName: null,
        forge: null,
        unavailableReason: "ambiguous-remote",
      },
    });
    const actions = headerGitActions(current);

    expect(primaryHeaderGitAction(current)).toBeNull();
    expect(actions.find((action) => action.id === "push")).toMatchObject({
      disabled: true,
      detail: "Configure one unambiguous push remote before publishing.",
    });
  });

  it("explains unavailable pull requests instead of advertising them", () => {
    const current = status({
      upstream: null,
      hasRemote: false,
      pullRequest: {
        available: false,
        remoteName: null,
        forge: null,
        unavailableReason: "no-remotes",
      },
    });
    const actions = headerGitActions(current);

    expect(primaryHeaderGitAction(current)).toBeNull();
    expect(actions.find((action) => action.id === "pull-request")).toMatchObject({
      disabled: true,
      detail: "Add a Git remote first.",
    });
  });
});
