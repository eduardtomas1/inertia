import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { automaticPull, automaticPullCandidate } from "../../src/server/git/automatic-pull";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-auto-pull-")); roots.push(root);
  const remote = join(root, "upstream"); mkdirSync(remote);
  git(remote, "init", "-b", "trunk");
  git(remote, "config", "user.name", "Test"); git(remote, "config", "user.email", "test@example.invalid");
  writeFileSync(join(remote, "tracked.txt"), "first\n");
  git(remote, "add", "."); git(remote, "commit", "-m", "initial");
  const local = join(root, "checkout"); git(root, "clone", "--origin", "company", remote, local);
  git(local, "config", "user.name", "Test"); git(local, "config", "user.email", "test@example.invalid");
  const before = git(local, "rev-parse", "HEAD");
  writeFileSync(join(remote, "tracked.txt"), "second\n");
  git(remote, "commit", "-am", "remote change");
  return { remote, local, before, tracking: "refs/remotes/company/trunk" };
}
describe("opt-in automatic pull", () => {
  it("discovers a nonstandard default and remote, fetches, and fast-forwards", async () => {
    const f = fixture();
    expect(await automaticPullCandidate(f.local)).toBe(f.tracking);
    expect(await automaticPull(f.local, f.tracking, {}, async () => true)).toBe(true);
    expect(git(f.local, "rev-parse", "HEAD")).toBe(git(f.remote, "rev-parse", "HEAD"));
    expect(readFileSync(join(f.local, "tracked.txt"), "utf8")).toBe("second\n");
    expect(git(f.local, "stash", "list")).toBe("");
  });

  it.each(["dirty", "untracked", "ahead", "feature", "detached", "unknown-default"])("leaves a %s checkout untouched", async (state) => {
    const f = fixture();
    if (state === "dirty") writeFileSync(join(f.local, "tracked.txt"), "precious edit\n");
    if (state === "untracked") writeFileSync(join(f.local, "new.txt"), "precious new file\n");
    if (state === "ahead") git(f.local, "commit", "--allow-empty", "-m", "local work");
    if (state === "feature") git(f.local, "checkout", "-b", "feature", "--track", "company/trunk");
    if (state === "detached") git(f.local, "checkout", "--detach");
    if (state === "unknown-default") git(f.local, "symbolic-ref", "--delete", "refs/remotes/company/HEAD");
    const before = git(f.local, "rev-parse", "HEAD");
    expect(await automaticPullCandidate(f.local)).toBeNull();
    expect(await automaticPull(f.local, f.tracking, {}, async () => true)).toBe(false);
    expect(git(f.local, "rev-parse", "HEAD")).toBe(before);
    if (state === "dirty") expect(readFileSync(join(f.local, "tracked.txt"), "utf8")).toBe("precious edit\n");
    if (state === "untracked") expect(readFileSync(join(f.local, "new.txt"), "utf8")).toBe("precious new file\n");
  });

  it("does not merge if work starts or the setting is disabled while fetching", async () => {
    const f = fixture(); let calls = 0;
    expect(await automaticPull(f.local, f.tracking, {}, async () => ++calls === 1)).toBe(false);
    expect(calls).toBe(2);
    expect(git(f.local, "rev-parse", "HEAD")).toBe(f.before);
    expect(readFileSync(join(f.local, "tracked.txt"), "utf8")).toBe("first\n");
  });

  it("never executes checkout hooks, including a repository-root hook", async () => {
    const f = fixture();
    const hook = "#!/bin/sh\nprintf invoked > .git/automatic-pull-hook-ran\n";
    writeFileSync(join(f.local, ".git", "hooks", "post-merge"), hook, { mode: 0o755 });
    writeFileSync(join(f.local, ".git", "hooks", "reference-transaction"), hook, { mode: 0o755 });
    writeFileSync(join(f.local, "post-merge"), hook, { mode: 0o755 });
    // Keep the root fixture ignored so eligibility still proves a clean checkout.
    writeFileSync(join(f.local, ".git", "info", "exclude"), "post-merge\n");
    expect(await automaticPullCandidate(f.local)).toBe(f.tracking);
    expect(await automaticPull(f.local, f.tracking, {}, async () => true)).toBe(true);
    expect(git(f.local, "rev-parse", "HEAD")).toBe(git(f.remote, "rev-parse", "HEAD"));
    expect(existsSync(join(f.local, ".git", "automatic-pull-hook-ran"))).toBe(false);
  });

  it("rechecks untracked files after fetching and respects cancellation", async () => {
    const f = fixture(); let calls = 0;
    expect(await automaticPull(f.local, f.tracking, {}, async () => {
      if (++calls === 2) writeFileSync(join(f.local, "new.txt"), "preserve\n");
      return true;
    })).toBe(false);
    expect(git(f.local, "rev-parse", "HEAD")).toBe(f.before);
    const controller = new AbortController(); controller.abort();
    await expect(automaticPullCandidate(f.local, { signal: controller.signal })).rejects.toThrow();
    expect(readFileSync(join(f.local, "new.txt"), "utf8")).toBe("preserve\n");
  });
});
