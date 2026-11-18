import { describe, expect, it } from "vitest";

import { composerCheckoutBranch } from "../../src/renderer/src/components/composer/ComposerToolbar";
import { chatCheckoutBranch } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";

describe("composer checkout branch", () => {
  it("prefers live Git state for the project checkout", () => {
    expect(composerCheckoutBranch({
      branch: "stored-branch",
      worktreePath: null,
    }, "live-branch")).toBe("live-branch");
    expect(composerCheckoutBranch({
      branch: "stored-branch",
      worktreePath: null,
    }, null)).toBe("Detached HEAD");
    expect(composerCheckoutBranch({
      branch: null,
      worktreePath: null,
    }, null)).toBe("Detached HEAD");
  });

  it("falls back to the stored branch and never claims a detached checkout while Git status is unknown", () => {
    expect(composerCheckoutBranch({
      branch: "stored-branch",
      worktreePath: null,
    }, undefined)).toBe("stored-branch");
    expect(composerCheckoutBranch({
      branch: null,
      worktreePath: null,
    }, undefined)).toBeNull();
    expect(composerCheckoutBranch({
      branch: null,
      worktreePath: "/workspace/.worktrees/detached",
    }, undefined)).toBeNull();
  });

  it("keeps the isolated conversation branch authoritative", () => {
    expect(composerCheckoutBranch({
      branch: "isolated-branch",
      worktreePath: "/workspace/.worktrees/isolated",
    }, "project-branch")).toBe("isolated-branch");
    expect(composerCheckoutBranch({
      branch: "isolated-branch",
      worktreePath: "/workspace/.worktrees/isolated",
    }, undefined)).toBe("isolated-branch");
    expect(composerCheckoutBranch({
      branch: null,
      worktreePath: "/workspace/.worktrees/detached",
    }, null)).toBe("Detached HEAD");
  });

  it("reports the live branch only once a repository status is known", () => {
    expect(chatCheckoutBranch(null)).toBeUndefined();
    expect(chatCheckoutBranch({ isRepository: false, branch: null })).toBeUndefined();
    expect(chatCheckoutBranch({ isRepository: true, branch: null })).toBeNull();
    expect(chatCheckoutBranch({ isRepository: true, branch: "main" })).toBe("main");
  });
});
