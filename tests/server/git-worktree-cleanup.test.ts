import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorktree,
  createWorktreeWithOwnershipReceipt,
  inspectBranchCleanupOutcome,
  inspectOwnedWorktreeCleanupState,
  inspectRegisteredWorktreeOwnership,
  removeWorktree,
  type RegisteredWorktreeIdentity,
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

function adminDirectory(path: string): string {
  return realpathSync(git(
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ));
}

async function createOwnedWorktree(
  root: string,
  path: string,
  branch: string,
): Promise<RegisteredWorktreeIdentity> {
  let receipt: RegisteredWorktreeIdentity | null = null;
  await createWorktreeWithOwnershipReceipt(root, path, {
    branch,
    createBranch: true,
    startPoint: "main",
  }, {
    beforeAdd: () => undefined,
    notAdded: () => undefined,
    added: (ownership) => {
      receipt = ownership;
    },
  });
  if (!receipt) throw new Error("The linked-worktree receipt was not recorded.");
  return receipt;
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
    let receipt: RegisteredWorktreeIdentity | null = null;

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
    expect(receipt).toMatchObject({
      path: realpathSync(path),
      branch,
      head: git(root, "rev-parse", branch),
      worktreeId: expect.any(String),
      repositoryIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u),
      ownershipToken: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    const commonDirectory = realpathSync(git(
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ));
    expect(dirname(adminDirectory(path))).toBe(join(commonDirectory, "worktrees"));
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
    const ownership = await createOwnedWorktree(root, path, branch);
    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toEqual({ state: "registered", identity: ownership });
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toEqual({ path: realpathSync(path), branch, head: ownership.head });
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
    const receipts: RegisteredWorktreeIdentity[] = [];
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
      receipt.worktreeId,
      receipt.repositoryIdentity,
      receipt.ownershipToken,
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
    const ownership = await createOwnedWorktree(root, path, branch);
    git(root, "worktree", "move", path, movedPath);
    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toMatchObject({
      state: "registered",
      identity: { path: realpathSync(movedPath), branch, head: ownership.head },
    });
    await expect(inspectRegisteredWorktreeOwnership(root, movedPath, branch))
      .resolves.toMatchObject({ head: ownership.head });
    expect(git(root, "rev-parse", branch)).toBe(ownership.head);
  });

  it("finds the durable admin identity after move, branch switch, and generated-ref deletion", async () => {
    const root = repository();
    const path = ownedPath(root, "planned identity path");
    const movedPath = ownedPath(root, "moved and switched path");
    const branch = "inertia/moved-switched-owned";
    const switchedBranch = "user/moved-switched";
    const ownership = await createOwnedWorktree(root, path, branch);

    git(root, "worktree", "move", path, movedPath);
    git(movedPath, "switch", "-q", "-c", switchedBranch);
    git(
      movedPath,
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "Switch after moving the launch checkout",
    );
    const switchedHead = git(movedPath, "rev-parse", "HEAD");
    git(root, "branch", "-D", branch);

    expect(existsSync(path)).toBe(false);
    expect(() => git(root, "show-ref", "--verify", `refs/heads/${branch}`))
      .toThrow();
    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toMatchObject({
      state: "registered",
      identity: {
        worktreeId: ownership.worktreeId,
        path: realpathSync(movedPath),
        branch: switchedBranch,
        head: switchedHead,
      },
    });
  });

  it("allows stock move, remove, and prune while the ownership marker exists", async () => {
    const root = repository();
    const path = ownedPath(root, "marker lifecycle path");
    const movedPath = ownedPath(root, "marker moved path");
    const branch = "inertia/marker-lifecycle";
    const ownership = await createOwnedWorktree(root, path, branch);
    expect(readFileSync(
      join(adminDirectory(path), "inertia-duo-owner"),
      "utf8",
    )).toContain(ownership.ownershipToken);

    git(root, "worktree", "move", path, movedPath);
    await removeWorktree(root, movedPath, false);
    git(root, "branch", "-D", branch);
    git(root, "worktree", "prune");

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toEqual({ state: "absent" });
  });

  it("detects a branch and HEAD switch after an earlier owned inspection", async () => {
    const root = repository();
    const path = ownedPath(root, "changed during removal path");
    const branch = "inertia/change-after-claim";
    const ownership = await createOwnedWorktree(root, path, branch);
    const replacementBranch = "user/changed-after-claim";
    let changedHead = "";

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toMatchObject({ state: "registered" });
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
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toMatchObject({
      state: "registered",
      identity: { branch: replacementBranch, head: changedHead },
    });
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

  it("rejects admin-ID reuse after the launch registration was removed", async () => {
    const root = repository();
    const path = ownedPath(root, "reattached launch path");
    const branch = "inertia/reattached-owned";
    const ownership = await createOwnedWorktree(root, path, branch);
    await removeWorktree(root, path, false);
    git(root, "worktree", "add", "--", path, branch);
    expect(basename(git(
      path,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ))).toBe(ownership.worktreeId);

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toEqual({ state: "conflict" });
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toMatchObject({ head: ownership.head });
  });

  it("preserves the exclusive bounded marker when duplicate creation is refused", async () => {
    const root = repository();
    const path = ownedPath(root, "exclusive marker path");
    const branch = "inertia/exclusive-marker";
    await createOwnedWorktree(root, path, branch);
    const markerPath = join(adminDirectory(path), "inertia-duo-owner");
    const before = readFileSync(markerPath, "utf8");
    expect(Buffer.byteLength(before)).toBeLessThan(512);
    expect(JSON.parse(before)).toEqual({
      version: 1,
      ownershipToken: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      repositoryIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u),
      worktreeId: basename(adminDirectory(path)),
      createdPathHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      branch,
      head: git(root, "rev-parse", branch),
    });
    expect(before).not.toContain(root);
    expect(before).not.toContain(path);

    await expect(createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => undefined,
      notAdded: () => undefined,
      added: () => undefined,
    })).rejects.toBeDefined();
    expect(readFileSync(markerPath, "utf8")).toBe(before);
  });

  it("exclusively creates the marker and never overwrites an existing file", async () => {
    const root = repository();
    const path = ownedPath(root, "marker collision path");
    const branch = "inertia/marker-collision";
    const existing = "pre-existing marker data\n";
    let added = false;
    let rejectedBeforeMutation = false;

    await expect(createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => undefined,
      notAdded: () => {
        rejectedBeforeMutation = true;
      },
      added: () => {
        added = true;
      },
    }, {
      beforeOwnershipMarkerWrite: (admin) => {
        writeFileSync(join(admin, "inertia-duo-owner"), existing, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      },
    })).rejects.toMatchObject({ code: "EEXIST" });

    expect(added).toBe(false);
    expect(rejectedBeforeMutation).toBe(false);
    expect(readFileSync(
      join(adminDirectory(path), "inertia-duo-owner"),
      "utf8",
    )).toBe(existing);
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toMatchObject({ branch });
  });

  it.each([
    {
      name: "malformed",
      replace(markerPath: string): void {
        writeFileSync(markerPath, "not-json", "utf8");
      },
      outcome: "conflict" as const,
    },
    {
      name: "valid-but-replaced",
      replace(markerPath: string): void {
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
          ownershipToken: string;
        };
        marker.ownershipToken = "00000000-0000-4000-8000-000000000000";
        writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, "utf8");
      },
      outcome: "conflict" as const,
    },
    {
      name: "oversized",
      replace(markerPath: string): void {
        writeFileSync(markerPath, "x".repeat(20 * 1024), "utf8");
      },
      outcome: "rejected" as const,
    },
    {
      name: "symlinked",
      replace(markerPath: string): void {
        const target = `${markerPath}.target`;
        writeFileSync(target, "{}", "utf8");
        rmSync(markerPath);
        symlinkSync(target, markerPath);
      },
      outcome: "rejected" as const,
    },
  ])("fails closed for a $name ownership marker", async ({ replace, outcome }) => {
    const root = repository();
    const path = ownedPath(root, `unsafe marker ${outcome}`);
    const branch = `inertia/unsafe-marker-${outcome}`;
    const ownership = await createOwnedWorktree(root, path, branch);
    replace(join(adminDirectory(path), "inertia-duo-owner"));
    const inspection = inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    );
    if (outcome === "conflict") {
      await expect(inspection).resolves.toEqual({ state: "conflict" });
    } else {
      await expect(inspection).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toBeDefined();
  });

  it.each(["admin", "common-worktrees"] as const)(
    "rejects a symlinked $name administrative directory without following it",
    async (target) => {
      const root = repository();
      const path = ownedPath(root, `symlinked ${target} path`);
      const branch = `inertia/symlinked-${target}`;
      const ownership = await createOwnedWorktree(root, path, branch);
      const admin = adminDirectory(path);
      const original = target === "admin" ? admin : dirname(admin);
      const relocated = `${original}-relocated`;
      renameSync(original, relocated);
      symlinkSync(relocated, original, "dir");

      await expect(inspectOwnedWorktreeCleanupState(
        root,
        path,
        branch,
        ownership.head,
        ownership.worktreeId,
        ownership.repositoryIdentity,
        ownership.ownershipToken,
      )).resolves.toEqual({ state: "conflict" });
      expect(existsSync(path)).toBe(true);
      const retainedMarker = target === "admin"
        ? join(relocated, "inertia-duo-owner")
        : join(relocated, ownership.worktreeId, "inertia-duo-owner");
      expect(readFileSync(retainedMarker, "utf8"))
        .toContain(ownership.ownershipToken);
    },
  );

  it("round-trips metacharacters and newlines as literal worktree identity data", async () => {
    const root = repository();
    const path = ownedPath(root, "literal $() `ticks`\nsecond line");
    const branch = "inertia/literal-metachar-path";
    const ownership = await createOwnedWorktree(root, path, branch);

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
    )).resolves.toMatchObject({
      state: "registered",
      identity: { path: realpathSync(path), branch, head: ownership.head },
    });
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
