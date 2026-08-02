import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorktree,
  createWorktreeWithOwnershipReceipt,
  inspectBranchCleanupOutcome,
  inspectOwnedWorktreeCleanupState,
  inspectRegisteredWorktreeOwnership,
  removeWorktree,
} from "../../src/server/git";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia cleanup git "));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Inertia Tests");
  git(root, "config", "user.email", "tests@inertia.invalid");
  git(root, "commit", "--allow-empty", "-q", "-m", "Initial");
  return root;
}

function ownedPath(root: string, name: string): string {
  const path = join(root, "nested worktrees", name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("launch-owned Git cleanup", () => {
  it("acknowledges add success before post-create status inspection", async () => {
    const root = repository();
    const path = ownedPath(root, "receipt owned path");
    const branch = "inertia/receipt-owned";
    const phases: string[] = [];
    let receipt: Awaited<ReturnType<
      typeof inspectRegisteredWorktreeOwnership
    >> | null = null;

    await createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => phases.push("before-add"),
      notAdded: () => phases.push("not-added"),
      added: (ownership) => {
        phases.push("added");
        receipt = ownership;
      },
    });

    expect(phases).toEqual(["before-add", "added"]);
    expect(receipt).toEqual({
      path: realpathSync(path),
      branch,
      head: git(root, "rev-parse", branch),
    });
  });

  it("proves an exact registered worktree path, branch, and HEAD", async () => {
    const root = repository();
    const path = ownedPath(root, "exact owned path");
    const branch = "inertia/exact-owned";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });

    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toEqual({
        path: realpathSync(path),
        branch,
        head: git(root, "rev-parse", branch),
      });
    await expect(inspectRegisteredWorktreeOwnership(
      root,
      path,
      "inertia/different-branch",
    )).rejects.toMatchObject({ code: "conflict" });
    await expect(inspectRegisteredWorktreeOwnership(
      root,
      join(root, "nested worktrees", "unregistered path"),
      branch,
    )).rejects.toMatchObject({ code: "not-found" });
  });

  it("retains an exact unchanged owned worktree without mutation", async () => {
    const root = repository();
    const path = ownedPath(root, "unchanged owned path");
    const branch = "inertia/unchanged-owned";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });
    const ownership = await inspectRegisteredWorktreeOwnership(
      root,
      path,
      branch,
    );
    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
    )).resolves.toEqual({ state: "owned", ownership });
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toEqual(ownership);
    expect(git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`))
      .toBe(`refs/heads/${branch}`);
  });

  it("treats an absent exact branch as absent while preserving descendants", async () => {
    const root = repository();
    const branch = "inertia/absent-parent";
    const descendant = `${branch}/user-topic`;
    git(root, "branch", branch, "main");
    const expectedHead = git(root, "rev-parse", branch);
    git(root, "branch", "-D", branch);
    git(root, "branch", descendant, "main");

    await expect(inspectBranchCleanupOutcome(root, branch, expectedHead))
      .resolves.toBe("absent");
    expect(git(root, "rev-parse", descendant)).toBe(expectedHead);
    expect(git(
      root,
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${branch}`,
    )).toBe(`refs/heads/${descendant}`);
  });

  it("leaves a pre-existing branch intact when worktree creation collides", async () => {
    const root = repository();
    const path = ownedPath(root, "colliding owned path");
    const branch = "inertia/pre-existing";
    git(root, "branch", branch, "main");
    const originalHead = git(root, "rev-parse", branch);

    await expect(createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    })).rejects.toBeDefined();
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .rejects.toMatchObject({ code: "not-found" });
    expect(git(root, "rev-parse", branch)).toBe(originalHead);
  });

  it("does not acknowledge or alter a pre-existing registered path and branch", async () => {
    const root = repository();
    const path = ownedPath(root, "pre-existing registered path");
    const branch = "inertia/pre-existing-worktree";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });
    const originalHead = git(root, "rev-parse", branch);
    const hooks: string[] = [];

    await expect(createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => hooks.push("before-add"),
      notAdded: () => hooks.push("not-added"),
      added: () => hooks.push("added"),
    })).rejects.toBeDefined();

    expect(hooks).toEqual([]);
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toMatchObject({ head: originalHead });
    expect(git(root, "rev-parse", branch)).toBe(originalHead);
  });

  it("does not infer ownership from matching state after an ambiguous add failure", async () => {
    const root = repository();
    const path = ownedPath(root, "ambiguous matching path");
    const branch = "inertia/ambiguous-match";
    const phases: string[] = [];

    await expect(createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => {
        phases.push("before-add");
        git(root, "worktree", "add", "-q", "-b", branch, path, "main");
      },
      notAdded: () => phases.push("not-added"),
      added: () => phases.push("added"),
    })).rejects.toBeDefined();

    expect(phases).toEqual(["before-add"]);
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toMatchObject({
        branch,
        head: git(root, "rev-parse", branch),
      });
  });

  it("refuses to remove a replacement registered at the launch path", async () => {
    const root = repository();
    const path = ownedPath(root, "replaced registered path");
    const branch = "inertia/original-owned";
    const receipts: Array<{
      branch: string;
      head: string;
      path: string;
    }> = [];
    await createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => undefined,
      notAdded: () => undefined,
      added: (ownership) => {
        receipts.push(ownership);
      },
    });
    const receipt = receipts[0];
    if (!receipt) throw new Error("The owned worktree receipt was not recorded.");
    await removeWorktree(root, path, false);
    const replacementBranch = "user/replacement";
    await createWorktree(root, path, {
      branch: replacementBranch,
      createBranch: true,
      startPoint: "main",
    });

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      receipt.head,
    )).resolves.toEqual({ state: "conflict" });
    await expect(inspectRegisteredWorktreeOwnership(
      root,
      path,
      replacementBranch,
    )).resolves.toBeDefined();
    expect(git(root, "rev-parse", replacementBranch)).toBe(
      git(root, "rev-parse", "main"),
    );
    expect(git(root, "rev-parse", branch)).toBe(receipt.head);
  });

  it("preserves an owned branch whose worktree moved to another path", async () => {
    const root = repository();
    const path = ownedPath(root, "original move path");
    const movedPath = ownedPath(root, "user moved path");
    const branch = "inertia/moved-worktree";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });
    const ownership = await inspectRegisteredWorktreeOwnership(
      root,
      path,
      branch,
    );
    git(root, "worktree", "move", path, movedPath);
    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
    )).resolves.toEqual({ state: "conflict" });
    await expect(inspectRegisteredWorktreeOwnership(root, movedPath, branch))
      .resolves.toMatchObject({ head: ownership.head });
    expect(git(root, "rev-parse", branch)).toBe(ownership.head);
  });

  it("detects a branch and HEAD switch after an earlier owned inspection", async () => {
    const root = repository();
    const path = ownedPath(root, "changed during removal path");
    const branch = "inertia/change-after-claim";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });
    const ownership = await inspectRegisteredWorktreeOwnership(
      root,
      path,
      branch,
    );
    const replacementBranch = "user/changed-after-claim";
    let changedHead = "";

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
    )).resolves.toMatchObject({ state: "owned" });
    git(path, "switch", "-q", "-c", replacementBranch);
    git(
      path,
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "Change worktree identity after inspection",
    );
    changedHead = git(path, "rev-parse", "HEAD");
    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
    )).resolves.toEqual({ state: "conflict" });
    await expect(inspectRegisteredWorktreeOwnership(
      root,
      path,
      replacementBranch,
    )).resolves.toMatchObject({
      branch: replacementBranch,
      head: changedHead,
    });
    expect(changedHead).not.toBe(ownership.head);
    expect(git(root, "rev-parse", branch)).toBe(ownership.head);
  });

  it("retains a launch ref checked out again after confirmed removal", async () => {
    const root = repository();
    const path = ownedPath(root, "reattached launch path");
    const branch = "inertia/reattached-owned";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });
    const ownership = await inspectRegisteredWorktreeOwnership(
      root,
      path,
      branch,
    );
    await removeWorktree(root, path, false);
    git(root, "worktree", "add", "--", path, branch);

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
    )).resolves.toMatchObject({ state: "owned" });
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toMatchObject({ head: ownership.head });
  });

  it("preserves a branch whose ref moved after the ownership receipt", async () => {
    const root = repository();
    const path = ownedPath(root, "moved owned path");
    const branch = "inertia/moved-owned";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });
    const ownership = await inspectRegisteredWorktreeOwnership(
      root,
      path,
      branch,
    );
    await removeWorktree(root, path, false);
    git(root, "commit", "--allow-empty", "-q", "-m", "Move protected ref");
    const movedHead = git(root, "rev-parse", "HEAD");
    git(root, "branch", "-f", branch, movedHead);

    await expect(inspectBranchCleanupOutcome(root, branch, ownership.head))
      .resolves.toBe("retained");
    expect(git(root, "rev-parse", branch)).toBe(movedHead);
  });

  it("retains a ref moved to a commit already merged into the current HEAD", async () => {
    const root = repository();
    const path = ownedPath(root, "merged moved owned path");
    const branch = "inertia/merged-moved-owned";
    await createWorktree(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    });
    const ownership = await inspectRegisteredWorktreeOwnership(
      root,
      path,
      branch,
    );
    await removeWorktree(root, path, false);
    git(root, "commit", "--allow-empty", "-q", "-m", "Advance merged main");
    const movedHead = git(root, "rev-parse", "main");
    git(root, "branch", "-f", branch, movedHead);

    await expect(inspectBranchCleanupOutcome(root, branch, ownership.head))
      .resolves.toBe("retained");
    expect(git(root, "rev-parse", branch)).toBe(movedHead);
  });
});
