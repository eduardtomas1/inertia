import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBranches } from "../../src/server/git/branches";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
}

function fixture(selectable: number, aliases: number): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-git-branch-limit-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Git Branch Limit Test");
  git(root, "config", "user.email", "git@example.invalid");
  git(root, "commit", "--allow-empty", "-m", "Initial");
  const head = git(root, "rev-parse", "HEAD");
  execFileSync("git", ["update-ref", "--stdin"], {
    cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024,
    input: Array.from({ length: selectable - 1 }, (_, index) =>
      `create refs/remotes/origin/topic-${String(index).padStart(4, "0")} ${head}\n`).join(""),
  });
  for (let index = 0; index < aliases; index += 1) {
    git(root, "symbolic-ref", `refs/remotes/origin/HEAD${index ? `-${index}` : ""}`, "refs/remotes/origin/topic-0000");
  }
  return root;
}

describe("Git selectable branch limit", () => {
  it.each([0, 1, 20])("returns all 1,000 selectable branches with %i symbolic aliases", async (aliases) => {
    const result = await listBranches(fixture(1000, aliases));
    expect(result.current).toBe("main");
    expect(result.local.map((branch) => branch.name)).toEqual(["main"]);
    expect(result.remote.map((branch) => branch.name)).toEqual(
      Array.from({ length: 999 }, (_, index) => `origin/topic-${String(index).padStart(4, "0")}`),
    );
  });

  it.each([0, 1, 20])("rejects 1,001 selectable branches with %i symbolic aliases", async (aliases) => {
    await expect(listBranches(fixture(1001, aliases))).rejects.toMatchObject({ code: "output-limit" });
  });
});
