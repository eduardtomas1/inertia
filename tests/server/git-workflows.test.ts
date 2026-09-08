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
    git(local, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
    git(remote, "tag", "remote-only", "refs/heads/main");
    writeFileSync(join(local, "tracked.txt"), "staged\n");
    git(local, "add", "tracked.txt");
    writeFileSync(join(local, "tracked.txt"), "unstaged\n");
    writeFileSync(join(local, "untracked.txt"), "keep\n");
    writeFileSync(join(local, ".git", "FETCH_HEAD"), "retained\n");
    const index = readFileSync(join(local, ".git", "index"));
    await fetchRepository(local);
    expect(git(local, "rev-parse", "refs/remotes/origin/feature/remote")).toBe(git(remote, "rev-parse", "main"));
    expect(git(local, "branch", "--list", "feature/remote")).toBe("");
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/remotes/unrelated")).toBe("");
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

  it("fetches a sole remote into an unborn checkout without creating a local branch or changing files", async () => {
    const { root, remote } = fixture();
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    git(fresh, "init", "-b", "unborn");
    git(fresh, "remote", "add", "team", remote);
    git(fresh, "config", "--unset-all", "remote.team.fetch");
    writeFileSync(join(fresh, "draft.txt"), "unfinished new project\n");
    await fetchRepository(fresh);
    expect(git(fresh, "rev-parse", "refs/remotes/team/main")).toBe(git(remote, "rev-parse", "main"));
    expect(git(fresh, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
    expect(git(fresh, "symbolic-ref", "HEAD")).toBe("refs/heads/unborn");
    expect(readFileSync(join(fresh, "draft.txt"), "utf8")).toBe("unfinished new project\n");
  });

  it("refuses ambiguous remote selection without contacting a remote", async () => {
    const { local, remote } = fixture();
    git(local, "remote", "remove", "origin");
    git(local, "remote", "add", "one", remote);
    git(local, "remote", "add", "two", remote);
    await expect(fetchRepository(local)).rejects.toThrow("Several remotes");
  });

  it("does not fall back to origin when the branch's configured upstream remote is missing", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "should-not-fetch", "main");
    git(local, "config", "branch.main.remote", "missing");
    await expect(fetchRepository(local)).rejects.toThrow("upstream remote is missing");
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/should-not-fetch")).toBe("");
  });

  it("refuses overlapping remote namespaces before replacing another remote's tracking refs", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "team/private", "main");
    git(local, "commit", "--allow-empty", "-m", "Private remote tip");
    git(local, "update-ref", "refs/remotes/origin/team/private", "HEAD");
    const protectedTip = git(local, "rev-parse", "refs/remotes/origin/team/private");
    // Represent an existing configuration, including on Git versions whose
    // `remote add` prevents creating a new overlapping name.
    git(local, "config", "remote.origin/team.url", remote);
    git(local, "config", "remote.origin/team.fetch", "+refs/heads/*:refs/remotes/origin/team/*");
    await expect(fetchRepository(local)).rejects.toThrow("tracking namespaces overlap");
    expect(git(local, "rev-parse", "refs/remotes/origin/team/private")).toBe(protectedTip);
  });

  it.each([
    ["origin", "Origin"],
    ["origin", "Origin/team"],
    ["team/upstream", "TEAM"],
  ])("refuses case-folded remote namespaces %s and %s before fetching", async (selected, other) => {
    const { local, remote } = fixture();
    if (selected !== "origin") git(local, "remote", "rename", "origin", selected);
    git(remote, "branch", "should-not-fetch", "main");
    git(local, "config", `remote.${other}.url`, remote);
    git(local, "config", `remote.${other}.fetch`, `+refs/heads/*:refs/remotes/${other}/*`);
    const refs = git(local, "for-each-ref", "--format=%(refname) %(objectname)");
    const config = readFileSync(join(local, ".git", "config"));
    writeFileSync(join(local, "tracked.txt"), "retained work\n");

    await expect(fetchRepository(local)).rejects.toThrow("tracking namespaces overlap");

    expect(git(local, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
    expect(readFileSync(join(local, ".git", "config"))).toEqual(config);
    expect(readFileSync(join(local, "tracked.txt"), "utf8")).toBe("retained work\n");
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

  it.each(["missing", "unrelated"])("tracks a fetched branch with %s head mappings and supports a later pull", async (mapping) => {
    const { local, remote } = fixture();
    git(remote, "branch", "topic", "main");
    if (mapping === "missing") git(local, "config", "--unset-all", "remote.origin.fetch");
    else git(local, "config", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
    await fetchRepository(local);
    const result = await switchBranch(local, "origin/topic", { remote: true });
    expect(result.status.branch).toBe("topic");
    expect(result.status.upstream).toBe("origin/topic");
    expect(git(local, "config", "branch.topic.remote")).toBe("origin");
    expect(git(local, "config", "branch.topic.merge")).toBe("refs/heads/topic");
    const mappings = git(local, "config", "--get-all", "remote.origin.fetch").split("\n");
    expect(mappings).toContain("+refs/heads/*:refs/remotes/origin/*");
    if (mapping === "unrelated") expect(mappings).toContain("+refs/tags/*:refs/tags/*");
    const tip = git(remote, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit-tree", "refs/heads/topic^{tree}", "-p", "refs/heads/topic", "-m", "Advance topic");
    git(remote, "update-ref", "refs/heads/topic", tip);
    await fetchRepository(local);
    expect((await pullRepository(local)).status.behind).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(tip);
  });

  it.each([
    "+refs/heads/*:refs/heads/*",
    "+refs/heads/*:refs/remotes/unrelated/*",
    "+refs/tags/*:refs/remotes/origin/*",
  ])("preserves an incompatible mapping without exposing untrackable refs: %s", async (mapping) => {
    const { local, remote } = fixture();
    git(remote, "branch", "topic", "main");
    git(local, "config", "remote.origin.fetch", mapping);
    const config = readFileSync(join(local, ".git", "config"));
    await expect(fetchRepository(local)).rejects.toThrow("remote-tracking mapping");
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/topic")).toBe("");
    expect(readFileSync(join(local, ".git", "config"))).toEqual(config);
    expect(git(local, "branch", "--show-current")).toBe("main");
  });

  it("fails a fallback tracking config lock before creating or switching a branch", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "topic", "main");
    git(local, "config", "--unset-all", "remote.origin.fetch");
    await fetchRepository(local);
    const config = readFileSync(join(local, ".git", "config"));
    writeFileSync(join(local, ".git", "config.lock"), "owned by another config writer\n");
    await expect(switchBranch(local, "origin/topic", { remote: true })).rejects.toThrow();
    expect(git(local, "branch", "--list", "topic")).toBe("");
    expect(git(local, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(local, ".git", "config"))).toEqual(config);
  });

  it("rejects an excluded fallback branch before adding tracking configuration", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "topic", "main");
    await fetchRepository(local);
    git(local, "config", "remote.origin.fetch", "^refs/heads/topic");
    const config = readFileSync(join(local, ".git", "config"));
    await expect(switchBranch(local, "origin/topic", { remote: true })).rejects.toThrow("fetch mappings");
    expect(git(local, "branch", "--list", "topic")).toBe("");
    expect(readFileSync(join(local, ".git", "config"))).toEqual(config);
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

  it("tracks the unique source branch of a renamed fetch mapping", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "server", "main");
    git(local, "config", "remote.origin.fetch", "+refs/heads/server:refs/remotes/origin/client");
    git(local, "fetch", "origin");
    const result = await switchBranch(local, "origin/client", { remote: true });
    expect(result.status.branch).toBe("client");
    expect(result.status.upstream).toBe("origin/client");
    expect(git(local, "config", "branch.client.merge")).toBe("refs/heads/server");
    expect(git(local, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "server"));
  });

  it("rejects multiple upstream destinations before creating a tracking branch", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "server", "main");
    git(local, "config", "remote.origin.fetch", "+refs/heads/server:refs/remotes/origin/first");
    git(local, "config", "--add", "remote.origin.fetch", "+refs/heads/server:refs/remotes/origin/second");
    await fetchRepository(local);
    await expect(switchBranch(local, "origin/second", { remote: true })).rejects.toThrow("fetch mappings");
    expect(git(local, "branch", "--list", "second")).toBe("");
    expect(git(local, "branch", "--show-current")).toBe("main");
  });

  it("refreshes a safely renamed tracking destination when its remote source advances", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "server", "main");
    git(local, "config", "remote.origin.fetch", "+refs/heads/server:refs/remotes/origin/client");
    git(local, "fetch", "origin");
    const serverTip = git(remote, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit-tree", "refs/heads/server^{tree}", "-p", "refs/heads/server", "-m", "New server tip");
    git(remote, "update-ref", "refs/heads/server", serverTip);
    const head = git(local, "rev-parse", "HEAD");
    await fetchRepository(local);
    expect(git(local, "rev-parse", "refs/remotes/origin/client")).toBe(serverTip);
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/server")).toBe("");
  });

  it("honors excluded source branches within a safe tracking refspec", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "public", "main");
    git(remote, "branch", "private", "main");
    git(local, "config", "--add", "remote.origin.fetch", "^refs/heads/private");
    git(local, "config", "--add", "remote.origin.fetch", "");
    await fetchRepository(local);
    expect(git(local, "rev-parse", "refs/remotes/origin/public")).toBe(git(remote, "rev-parse", "main"));
    expect(git(local, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/private")).toBe("");
  });

  it("rejects an excluded renamed source before creating the local tracking branch", async () => {
    const { local, remote } = fixture();
    git(remote, "branch", "server", "main");
    git(local, "config", "remote.origin.fetch", "+refs/heads/server:refs/remotes/origin/client");
    git(local, "fetch", "origin");
    git(local, "config", "--add", "remote.origin.fetch", "^refs/heads/server");
    await expect(switchBranch(local, "origin/client", { remote: true })).rejects.toThrow("fetch mappings");
    expect(git(local, "branch", "--list", "client")).toBe("");
    expect(git(local, "branch", "--show-current")).toBe("main");
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

  it("fast-forwards a clean checkout and refuses divergence despite configured rebase", async () => {
    const { root, local, remote } = fixture();
    const peer = join(root, "peer");
    git(root, "clone", "--branch", "main", remote, peer);
    git(peer, "config", "user.name", "Git Workflow Test");
    git(peer, "config", "user.email", "git@example.invalid");
    git(local, "config", "pull.rebase", "true");
    git(local, "config", "rebase.autoStash", "true");
    writeFileSync(join(peer, "incoming.txt"), "incoming\n");
    git(peer, "add", "incoming.txt");
    git(peer, "commit", "-m", "Incoming change");
    git(peer, "push");
    const result = await pullRepository(local);
    expect(result.status).toMatchObject({ ahead: 0, behind: 0, clean: true });
    expect(git(local, "rev-parse", "HEAD")).toBe(git(peer, "rev-parse", "HEAD"));
    expect(readFileSync(join(local, "incoming.txt"), "utf8")).toBe("incoming\n");

    writeFileSync(join(local, "local.txt"), "local\n");
    git(local, "add", "local.txt");
    git(local, "commit", "-m", "Local change");
    const localHead = git(local, "rev-parse", "HEAD");
    writeFileSync(join(peer, "incoming.txt"), "another incoming\n");
    git(peer, "add", "incoming.txt");
    git(peer, "commit", "-m", "Another incoming change");
    git(peer, "push");
    await fetchRepository(local);
    await expect(pullRepository(local)).rejects.toThrow("diverged");
    expect(git(local, "rev-parse", "HEAD")).toBe(localHead);
    expect(readFileSync(join(local, "incoming.txt"), "utf8")).toBe("incoming\n");
    expect(git(local, "stash", "list")).toBe("");
  });

  it("supports remote names containing slashes and rejects overlapping tracking namespaces", async () => {
    const { local, remote } = fixture();
    git(local, "remote", "rename", "origin", "team/upstream");
    git(remote, "branch", "topic/remote", "main");
    await fetchRepository(local);
    const result = await switchBranch(local, "team/upstream/topic/remote", { remote: true });
    expect(result.status.branch).toBe("topic/remote");
    expect(result.status.upstream).toBe("team/upstream/topic/remote");
    git(local, "switch", "main");
    git(remote, "branch", "topic/ambiguous", "main");
    await fetchRepository(local);
    // New Git versions reject this overlap in `remote add`; existing/manual
    // configurations can still contain it and must fail before branch creation.
    git(local, "config", "remote.team.url", join(remote, "missing"));
    git(local, "config", "remote.team.fetch", "+refs/heads/*:refs/remotes/team/*");
    await expect(switchBranch(local, "team/upstream/topic/ambiguous", { remote: true }))
      .rejects.toThrow("fetch mappings");
    expect(git(local, "branch", "--list", "topic/ambiguous")).toBe("");
  });

  it("bounds a large branch listing instead of silently showing partial results", async () => {
    const { local } = fixture();
    const head = git(local, "rev-parse", "HEAD");
    execFileSync("git", ["update-ref", "--stdin"], {
      cwd: local, timeout: 10_000, maxBuffer: 1024 * 1024,
      input: Array.from({ length: 1000 }, (_, index) => `create refs/heads/topic-${index} ${head}\n`).join(""),
    });
    await expect(listBranches(local)).rejects.toMatchObject({ code: "output-limit" });
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
