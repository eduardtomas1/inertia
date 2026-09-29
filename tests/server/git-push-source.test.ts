import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ before: (_root: string, _args: readonly string[]) => {} }));
vi.mock("../../src/server/git/runner", async (original) => {
  const actual = await original<typeof import("../../src/server/git/runner")>();
  return {
    ...actual,
    runGit: (...args: Parameters<typeof actual.runGit>) => {
      race.before(args[0], args[1]);
      return actual.runGit(...args);
    },
  };
});
import { pushCurrentBranch } from "../../src/server/git/remotes";

const roots: string[] = [];
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
afterEach(() => {
  race.before = () => {};
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

it.each(["checkout", "advance"])("pins the pushed commit and upstream across concurrent %s movement", async (movement) => {
  const root = mkdtempSync(join(tmpdir(), "inertia-push-source-"));
  const remote = mkdtempSync(join(tmpdir(), "inertia-push-target-"));
  roots.push(root, remote);
  git(root, "init", "-b", "reviewed");
  git(root, "config", "user.name", "Inertia Test");
  git(root, "config", "user.email", "test@inertia.local");
  writeFileSync(join(root, "base.txt"), "reviewed\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "reviewed");
  const reviewed = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-c", "other");
  writeFileSync(join(root, "other.txt"), "unrelated\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-m", "unrelated");
  const other = git(root, "rev-parse", "HEAD");
  git(root, "switch", "reviewed");
  git(remote, "init", "--bare");
  git(root, "remote", "add", "origin", remote);
  let moved = false;
  race.before = (cwd, args) => {
    if (cwd !== realpathSync(root) || args[0] !== "remote" || args.length !== 1) return;
    git(root, "switch", "other");
    if (movement === "advance") git(root, "update-ref", "refs/heads/reviewed", other);
    moved = true;
  };
  await pushCurrentBranch(root);
  expect(moved).toBe(true);
  expect(git(remote, "rev-parse", "refs/heads/reviewed")).toBe(reviewed);
  expect(git(root, "branch", "--show-current")).toBe("other");
  expect(git(root, "config", "branch.reviewed.remote")).toBe("origin");
  expect(git(root, "config", "branch.reviewed.merge")).toBe("refs/heads/reviewed");
  expect(() => git(root, "config", "branch.other.remote")).toThrow();
});

it("keeps a triangular upstream when pushing to a separate push remote", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-push-triangular-"));
  const upstream = mkdtempSync(join(tmpdir(), "inertia-push-upstream-"));
  const fork = mkdtempSync(join(tmpdir(), "inertia-push-fork-"));
  roots.push(root, upstream, fork);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Inertia Test");
  git(root, "config", "user.email", "test@inertia.local");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "base");
  git(upstream, "init", "--bare");
  git(fork, "init", "--bare");
  git(root, "remote", "add", "upstream", upstream);
  git(root, "remote", "add", "fork", fork);
  git(root, "push", "upstream", "main");
  git(root, "fetch", "upstream");
  git(root, "switch", "-c", "feature", "--track", "upstream/main");
  git(root, "config", "branch.feature.pushRemote", "fork");
  writeFileSync(join(root, "feature.txt"), "feature\n");
  git(root, "add", "feature.txt");
  git(root, "commit", "-m", "feature");
  const feature = git(root, "rev-parse", "HEAD");

  await pushCurrentBranch(root);

  expect(git(fork, "rev-parse", "refs/heads/feature")).toBe(feature);
  expect(() => git(upstream, "rev-parse", "--verify", "refs/heads/feature")).toThrow();
  expect(git(root, "config", "branch.feature.remote")).toBe("upstream");
  expect(git(root, "config", "branch.feature.merge")).toBe("refs/heads/main");
  expect(git(root, "config", "branch.feature.pushRemote")).toBe("fork");
  expect(git(root, "rev-parse", "--abbrev-ref", "feature@{upstream}")).toBe("upstream/main");
});
