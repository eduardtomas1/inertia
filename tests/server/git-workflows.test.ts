import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchRepository, listBranches, pullRepository, switchBranch } from "../../src/server/git";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
}
function fixture(): { root: string; local: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), "inertia-git-workflows-"));
  roots.push(root);
  const local = join(root, "local");
  const remote = join(root, "remote.git");
  mkdirSync(local);
  git(local, "init", "-b", "main");
  git(local, "config", "user.name", "Git Workflow Test");
  git(local, "config", "user.email", "git@example.invalid");
  git(local, "config", "core.autocrlf", "false");
  writeFileSync(join(local, "tracked.txt"), "base\n");
  git(local, "add", "tracked.txt");
  git(local, "commit", "-m", "Initial");
  git(root, "init", "--bare", remote);
  git(local, "remote", "add", "origin", remote);
  git(local, "push", "-u", "origin", "main");
  return { root, local, remote };
}

describe("Git workflows", () => {
  it("fetches remote branches while preserving dirty files, index, tags and FETCH_HEAD", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "feature/remote", "main");
    git(local, "tag", "local-only");
    git(local, "config", "fetch.prune", "true");
    git(local, "config", "fetch.pruneTags", "true");
    git(local, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    writeFileSync(join(local, "tracked.txt"), "staged\n");
    git(local, "add", "tracked.txt");
    writeFileSync(join(local, "tracked.txt"), "unstaged\n");
    writeFileSync(join(local, "untracked.txt"), "keep\n");
    writeFileSync(join(local, ".git", "FETCH_HEAD"), "retained\n");
    const index = readFileSync(join(local, ".git", "index"));
    await fetchRepository(local);
    expect(git(local, "rev-parse", "refs/remotes/origin/feature/remote")).toBe(git(remote, "rev-parse", "main"));
    expect(git(local, "branch", "--list", "feature/remote")).toBe("");
    expect(git(local, "tag")).toBe("local-only");
    expect(readFileSync(join(local, "tracked.txt"), "utf8")).toBe("unstaged\n");
    expect(readFileSync(join(local, "untracked.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(local, ".git", "FETCH_HEAD"), "utf8")).toBe("retained\n");
    // Status itself may refresh index stat information; the staged content is authoritative.
    expect(git(local, "show", ":tracked.txt")).toBe("staged");
    expect(readFileSync(join(local, ".git", "index"))).toEqual(index);
  });

  it("fetches the tracked remote in a fork workflow, independently of the push remote", async () => {
    const { local, remote } = fixture();
    git(local, "remote", "rename", "origin", "upstream");
    git(local, "remote", "add", "fork", join(remote, "missing"));
    git(local, "config", "branch.main.pushRemote", "fork");
    git(remote, "branch", "feature/upstream", "main");
    await fetchRepository(local);
    expect(git(local, "rev-parse", "refs/remotes/upstream/feature/upstream")).toBe(git(remote, "rev-parse", "main"));
    expect(git(local, "config", "branch.main.remote")).toBe("upstream");
  });

  it("refuses ambiguous remote selection without contacting a remote", async () => {
    const { local, remote } = fixture();
    git(local, "remote", "remove", "origin");
    git(local, "remote", "add", "one", remote);
    git(local, "remote", "add", "two", remote);
    await expect(fetchRepository(local)).rejects.toThrow("Several remotes");
  });

  it("lists local, remote, symbolic and occupied branches without exposing worktree paths", async () => {
    const { root, local } = fixture();
    git(local, "worktree", "add", "-b", "occupied", join(root, "other"));
    git(local, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const result = await listBranches(local);
    expect(result.local.find((branch) => branch.name === "occupied")).toMatchObject({ checkedOut: true, current: false });
    expect(result.remote.map((branch) => branch.name)).toEqual(["origin/main"]);
    expect(JSON.stringify(result)).not.toContain(join(root, "other"));
    await expect(switchBranch(local, "occupied")).rejects.toThrow("another worktree");
  });

  it("checks out an exact remote branch and configures tracking", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "feature/remote", "main");
    await fetchRepository(local);
    const result = await switchBranch(local, "origin/feature/remote", { remote: true });
    expect(result.status.branch).toBe("feature/remote");
    expect(result.status.upstream).toBe("origin/feature/remote");
  });

  it("refuses to overwrite an existing local branch or carry dirty files into another branch", async () => {
    const { local } = fixture();
    git(local, "branch", "other");
    await expect(switchBranch(local, "origin/main", { remote: true })).rejects.toThrow("already exists");
    writeFileSync(join(local, "untracked.txt"), "keep\n");
    await expect(switchBranch(local, "other")).rejects.toThrow("Commit or stash");
    expect(git(local, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(local, "untracked.txt"), "utf8")).toBe("keep\n");
  });

  it("does not implicitly guess a remote branch for a local switch", async () => {
    const { local } = fixture();
    await expect(switchBranch(local, "origin/main")).rejects.toThrow("no longer exists");
    expect(git(local, "branch", "--show-current")).toBe("main");
  });

  it("rejects pull with dirty changes, detached HEAD or missing tracking even if client controls are bypassed", async () => {
    const { local } = fixture();
    writeFileSync(join(local, "untracked.txt"), "keep\n");
    await expect(pullRepository(local)).rejects.toThrow("Commit or stash");
    git(local, "switch", "--detach");
    await expect(pullRepository(local)).rejects.toThrow("local branch");
    git(local, "switch", "-c", "unpublished");
    await expect(pullRepository(local)).rejects.toThrow("no upstream");
  });

  it("honors cancellation and the shared deadline before Git execution", async () => {
    const { local } = fixture();
    const signal = AbortSignal.abort();
    for (const operation of [fetchRepository, pullRepository, listBranches]) {
      await expect(operation(local, { signal })).rejects.toMatchObject({ code: "timeout" });
      await expect(operation(local, { deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ code: "timeout" });
    }
    await expect(switchBranch(local, "main", { signal })).rejects.toMatchObject({ code: "timeout" });
  });
});
