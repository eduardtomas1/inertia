import { describe, expect, it } from "vitest";

import { composerCheckoutBranch } from "../../src/renderer/src/components/composer/ComposerToolbar";

describe("composer checkout branch", () => {
  it("prefers live Git state for the project checkout", () => {
    expect(composerCheckoutBranch({
      branch: "stored-branch",
      worktreePath: null,
    }, "live-branch")).toBe("live-branch");
    expect(composerCheckoutBranch({
      branch: "stored-branch",
      worktreePath: null,
    }, null)).toBe("stored-branch");
  });

  it("keeps the isolated conversation branch authoritative", () => {
    expect(composerCheckoutBranch({
      branch: "isolated-branch",
      worktreePath: "/workspace/.worktrees/isolated",
    }, "project-branch")).toBe("isolated-branch");
    expect(composerCheckoutBranch({
      branch: null,
      worktreePath: "/workspace/.worktrees/detached",
    }, null)).toBe("Detached HEAD");
  });
});
