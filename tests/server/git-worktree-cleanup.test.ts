import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
  parseWorktreeFilesystemReceipt,
  removeWorktree,
  serializeWorktreeFilesystemReceipt,
  type RegisteredWorktreeIdentity,
  worktreeFilesystemIdentitiesEqual,
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

function expectSamePath(actual: string, expected: string): void {
  const actualIdentity = statSync(actual, { bigint: true });
  const expectedIdentity = statSync(expected, { bigint: true });
  expect(actualIdentity.isDirectory()).toBe(true);
  expect(expectedIdentity.isDirectory()).toBe(true);
  expect({ device: actualIdentity.dev, inode: actualIdentity.ino }).toEqual({
    device: expectedIdentity.dev,
    inode: expectedIdentity.ino,
  });
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
    const receipts: RegisteredWorktreeIdentity[] = [];

    await createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => phases.push("before-add"),
      notAdded: () => phases.push("not-added"),
      added: (ownership) => {
        phases.push("added");
        receipts.push(ownership);
      },
    });

    expect(phases).toEqual(["before-add", "added"]);
    expect(receipts[0]).toMatchObject({
      branch,
      head: git(root, "rev-parse", branch),
      worktreeId: expect.any(String),
      repositoryIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u),
      ownershipToken: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    const receipt = receipts[0];
    if (!receipt) throw new Error("The linked-worktree receipt was not recorded.");
    expectSamePath(receipt.path, path);
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

    const inspected = await inspectRegisteredWorktreeOwnership(
      root,
      path,
      branch,
    );
    expect(inspected).toMatchObject({
      branch,
      head: git(root, "rev-parse", branch),
    });
    expectSamePath(inspected.path, path);
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
    const cleanup = await inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
    );
    expect(cleanup).toMatchObject({
      state: "registered",
      identity: { branch, head: ownership.head },
    });
    if (cleanup.state !== "registered") throw new Error("Worktree was not retained.");
    expectSamePath(cleanup.identity.path, path);
    const inspected = await inspectRegisteredWorktreeOwnership(root, path, branch);
    expect(inspected).toMatchObject({ branch, head: ownership.head });
    expectSamePath(inspected.path, path);
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
      receipt.filesystemReceipt,
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
    const inspection = await inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
    );
    expect(inspection).toMatchObject({
      state: "registered",
      identity: { branch, head: ownership.head },
    });
    if (inspection.state !== "registered") throw new Error("Worktree was not retained.");
    expectSamePath(inspection.identity.path, movedPath);
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
    const inspection = await inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
    );
    expect(inspection).toMatchObject({
      state: "registered",
      identity: {
        worktreeId: ownership.worktreeId,
        branch: switchedBranch,
        head: switchedHead,
      },
    });
    if (inspection.state !== "registered") throw new Error("Worktree was not retained.");
    expectSamePath(inspection.identity.path, movedPath);
  });

  it("allows stock move, remove, and prune without mutating Git metadata", async () => {
    const root = repository();
    const path = ownedPath(root, "receipt lifecycle path");
    const movedPath = ownedPath(root, "receipt moved path");
    const branch = "inertia/receipt-lifecycle";
    const ownership = await createOwnedWorktree(root, path, branch);
    expect(existsSync(join(adminDirectory(path), "inertia-duo-owner"))).toBe(false);

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
      ownership.filesystemReceipt,
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
      ownership.filesystemReceipt,
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
      ownership.filesystemReceipt,
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
      ownership.filesystemReceipt,
    )).resolves.toEqual({ state: "conflict" });
    await expect(inspectRegisteredWorktreeOwnership(root, path, branch))
      .resolves.toMatchObject({ head: ownership.head });
  });

  it("round-trips a bounded decimal-string filesystem receipt", async () => {
    const root = repository();
    const path = ownedPath(root, "filesystem receipt path");
    const branch = "inertia/filesystem-receipt";
    const ownership = await createOwnedWorktree(root, path, branch);
    const serialized = serializeWorktreeFilesystemReceipt(
      ownership.filesystemReceipt,
    );
    expect(Buffer.byteLength(serialized)).toBeLessThan(1_024);
    expect(parseWorktreeFilesystemReceipt(serialized)).toEqual({
      version: 1,
      worktreesDirectory: expect.objectContaining({
        device: expect.stringMatching(/^[1-9][0-9]*$/u),
        inode: expect.stringMatching(/^[1-9][0-9]*$/u),
        timestampNs: expect.stringMatching(/^[1-9][0-9]*$/u),
      }),
      adminDirectory: expect.objectContaining({
        device: expect.stringMatching(/^[1-9][0-9]*$/u),
        inode: expect.stringMatching(/^[1-9][0-9]*$/u),
        timestampNs: expect.stringMatching(/^[1-9][0-9]*$/u),
      }),
    });
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(path);
    const parsed = parseWorktreeFilesystemReceipt(serialized);
    if (!parsed) throw new Error("The filesystem receipt did not round-trip.");
    const reordered = JSON.stringify({
      adminDirectory: {
        timestampNs: parsed.adminDirectory.timestampNs,
        timestampKind: parsed.adminDirectory.timestampKind,
        inode: parsed.adminDirectory.inode,
        device: parsed.adminDirectory.device,
      },
      worktreesDirectory: {
        timestampNs: parsed.worktreesDirectory.timestampNs,
        timestampKind: parsed.worktreesDirectory.timestampKind,
        inode: parsed.worktreesDirectory.inode,
        device: parsed.worktreesDirectory.device,
      },
      version: 1,
    });
    const canonical = parseWorktreeFilesystemReceipt(reordered);
    expect(canonical).toEqual(parsed);
    if (!canonical) throw new Error("The reordered receipt was rejected.");
    expect(serializeWorktreeFilesystemReceipt(canonical)).toBe(serialized);
    expect(worktreeFilesystemIdentitiesEqual(
      parsed.adminDirectory,
      ownership.filesystemReceipt.adminDirectory,
    )).toBe(true);
    expect(worktreeFilesystemIdentitiesEqual(
      { ...parsed.adminDirectory, inode: `${BigInt(parsed.adminDirectory.inode) + 1n}` },
      ownership.filesystemReceipt.adminDirectory,
    )).toBe(false);
    for (const invalid of [
      "{}",
      JSON.stringify({ ...ownership.filesystemReceipt, version: 2 }),
      JSON.stringify({
        ...ownership.filesystemReceipt,
        adminDirectory: {
          ...ownership.filesystemReceipt.adminDirectory,
          inode: "0",
        },
      }),
      JSON.stringify({
        ...ownership.filesystemReceipt,
        adminDirectory: {
          ...ownership.filesystemReceipt.adminDirectory,
          device: "1".repeat(33),
        },
      }),
      JSON.stringify({
        ...ownership.filesystemReceipt,
        adminDirectory: {
          ...ownership.filesystemReceipt.adminDirectory,
          timestampNs: "-1",
        },
      }),
      JSON.stringify({
        ...ownership.filesystemReceipt,
        adminDirectory: {
          ...ownership.filesystemReceipt.adminDirectory,
          timestampNs: "01",
        },
      }),
      JSON.stringify({
        ...ownership.filesystemReceipt,
        unexpected: "top-level",
      }),
      JSON.stringify({
        ...ownership.filesystemReceipt,
        adminDirectory: {
          ...ownership.filesystemReceipt.adminDirectory,
          unexpected: "nested",
        },
      }),
      serialized.replace(
        '{"version":1,',
        '{"version":1,"__proto__":{"polluted":true},',
      ),
      serialized.replace(
        '"adminDirectory":{',
        '"adminDirectory":{"constructor":{"prototype":{"polluted":true}},',
      ),
    ]) expect(parseWorktreeFilesystemReceipt(invalid)).toBeNull();
  });

  it("fails closed when the administrative parent is swapped before identity capture", async () => {
    const root = repository();
    const path = ownedPath(root, "parent swap path");
    const branch = "inertia/parent-swap";
    let added = false;
    let externalDirectory = "";

    await expect(createWorktreeWithOwnershipReceipt(root, path, {
      branch,
      createBranch: true,
      startPoint: "main",
    }, {
      beforeAdd: () => undefined,
      notAdded: () => undefined,
      added: () => {
        added = true;
      },
    }, {
      beforeFilesystemIdentityCapture: (admin) => {
        const parent = dirname(admin);
        const relocated = `${parent}-relocated`;
        externalDirectory = `${parent}-external`;
        renameSync(parent, relocated);
        mkdirSync(externalDirectory);
        symlinkSync(
          externalDirectory,
          parent,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    })).rejects.toMatchObject({ code: "conflict" });

    expect(added).toBe(false);
    expect(existsSync(join(externalDirectory, "inertia-duo-owner"))).toBe(false);
    expect(existsSync(externalDirectory)).toBe(true);
  });

  it("caps a Git metadata read when the file grows after its first stat", async () => {
    const root = repository();
    const path = ownedPath(root, "growing gitdir path");
    const branch = "inertia/growing-gitdir";
    const ownership = await createOwnedWorktree(root, path, branch);
    const gitdirPath = join(adminDirectory(path), "gitdir");
    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
      {
        afterIdentityFileStat: (identityPath) => {
          if (identityPath === gitdirPath) {
            writeFileSync(identityPath, "x".repeat(2 * 1024 * 1024), "utf8");
          }
        },
      },
    )).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(gitdirPath).byteLength).toBe(2 * 1024 * 1024);
  });

  it("rejects a parent swap between metadata stat and fixed-buffer read", async () => {
    const root = repository();
    const path = ownedPath(root, "metadata parent swap path");
    const branch = "inertia/metadata-parent-swap";
    const ownership = await createOwnedWorktree(root, path, branch);
    const admin = adminDirectory(path);
    const gitdirPath = join(admin, "gitdir");
    const originalGitdir = readFileSync(gitdirPath, "utf8");
    let swapped = false;

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
      {
        afterIdentityFileStat: () => {
          if (swapped) return;
          swapped = true;
          const parent = dirname(admin);
          const relocated = `${parent}-metadata-relocated`;
          const external = `${parent}-metadata-external`;
          renameSync(parent, relocated);
          mkdirSync(join(external, ownership.worktreeId), { recursive: true });
          writeFileSync(
            join(external, ownership.worktreeId, "gitdir"),
            originalGitdir,
            "utf8",
          );
          symlinkSync(
            external,
            parent,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      },
    )).rejects.toMatchObject({ code: "conflict" });
    expect(swapped).toBe(true);
    expect(existsSync(join(dirname(admin), "inertia-duo-owner"))).toBe(false);
  });

  it("rejects replacement of an exact administrative ID", async () => {
    const root = repository();
    const path = ownedPath(root, "admin replacement path");
    const branch = "inertia/admin-replacement";
    const ownership = await createOwnedWorktree(root, path, branch);
    const admin = adminDirectory(path);
    const original = `${admin}-original`;
    renameSync(admin, original);
    mkdirSync(admin);

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
    )).resolves.toEqual({ state: "conflict" });
    expect(existsSync(original)).toBe(true);
    expect(existsSync(admin)).toBe(true);
  });

  it("confirms absence when the canonical worktrees parent is gone", async () => {
    const root = repository();
    const path = ownedPath(root, "missing parent path");
    const branch = "inertia/missing-parent";
    const ownership = await createOwnedWorktree(root, path, branch);
    const parent = dirname(adminDirectory(path));
    renameSync(parent, `${parent}-unavailable`);

    await expect(inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
    )).resolves.toEqual({ state: "absent" });
    expect(existsSync(path)).toBe(true);
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
      symlinkSync(
        relocated,
        original,
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(inspectOwnedWorktreeCleanupState(
        root,
        path,
        branch,
        ownership.head,
        ownership.worktreeId,
        ownership.repositoryIdentity,
        ownership.ownershipToken,
        ownership.filesystemReceipt,
      )).rejects.toMatchObject({ code: "conflict" });
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(relocated, "inertia-duo-owner"))).toBe(false);
    },
  );

  it("round-trips platform-valid metacharacters as literal worktree identity data", async () => {
    const root = repository();
    const path = ownedPath(
      root,
      process.platform === "win32"
        ? "literal $() `ticks` second line"
        : "literal $() `ticks`\nsecond line",
    );
    const branch = "inertia/literal-metachar-path";
    const ownership = await createOwnedWorktree(root, path, branch);

    const inspection = await inspectOwnedWorktreeCleanupState(
      root,
      path,
      branch,
      ownership.head,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
    );
    expect(inspection).toMatchObject({
      state: "registered",
      identity: { branch, head: ownership.head },
    });
    if (inspection.state !== "registered") throw new Error("Worktree was not retained.");
    expectSamePath(inspection.identity.path, path);
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
