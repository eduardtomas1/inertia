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
  deleteBranchIfUnchanged,
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

  it("deletes only the exact unchanged branch and is idempotent when absent", async () => {
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
    await removeWorktree(root, path, false);

    await expect(deleteBranchIfUnchanged(root, branch, ownership.head))
      .resolves.toBeUndefined();
    expect(git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`))
      .toBe("");
    await expect(deleteBranchIfUnchanged(root, branch, ownership.head))
      .resolves.toBeUndefined();
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

    await expect(deleteBranchIfUnchanged(root, branch, ownership.head))
      .rejects.toMatchObject({ code: "conflict" });
    expect(git(root, "rev-parse", branch)).toBe(movedHead);
  });
});
