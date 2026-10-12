import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { mayBeInsideGitRepository } from "../../src/server/git/paths";

const roots: string[] = [];

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-repository-presence-"));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  roots.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("repository presence", () => {
  it("finds the repository of a nested project folder", async () => {
    const repository = root();
    execFileSync("git", ["init", "--quiet", repository]);
    const nested = join(repository, "packages", "app");
    mkdirSync(nested, { recursive: true });

    await expect(mayBeInsideGitRepository(nested)).resolves.toBe(true);
  });

  it("finds a linked worktree through its .git file", async () => {
    const worktree = join(root(), "worktree");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/worktree\n");

    await expect(mayBeInsideGitRepository(join(worktree, "src"))).resolves.toBe(true);
  });

  it("defers to Git for a folder that may itself be a repository directory", async () => {
    const bare = root();
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");

    await expect(mayBeInsideGitRepository(bare)).resolves.toBe(true);
  });

  it("follows a linked project folder to the repository that holds it", async () => {
    const repository = root();
    execFileSync("git", ["init", "--quiet", repository]);
    mkdirSync(join(repository, "app"));
    const link = join(root(), "linked-app");
    symlinkSync(join(repository, "app"), link, "junction");

    await expect(mayBeInsideGitRepository(link)).resolves.toBe(true);
  });

  it("reports a plain folder without starting Git", async () => {
    const folder = join(root(), "notes", "drafts");
    mkdirSync(folder, { recursive: true });

    await expect(mayBeInsideGitRepository(folder)).resolves.toBe(false);
  });

  it("defers to Git when the folder cannot be resolved", async () => {
    await expect(mayBeInsideGitRepository(join(root(), "missing"))).resolves.toBe(true);
  });

  it("defers to Git when the inspection deadline has passed", async () => {
    const folder = root();

    await expect(mayBeInsideGitRepository(folder, { deadlineAt: Date.now() - 1 })).resolves.toBe(true);
  });
});
