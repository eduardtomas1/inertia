import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktree, createWorktreeWithOwnershipReceipt } from "../../src/server/git/worktrees";
import { requireGitWorktreeSupport } from "../../src/server/git/worktree-support";

const fixture = vi.hoisted(() => ({ version: "", calls: [] as string[][] }));
vi.mock("../../src/server/git/runner", () => ({ runGit: async (_root: string, args: string[]) => {
  fixture.calls.push(args);
  return { stdout: Buffer.from(args[0] === "--version" ? fixture.version : "a".repeat(40)), stderr: Buffer.alloc(0), truncated: false };
} }));
vi.mock("../../src/server/git/paths", async (original) => ({
  ...await original<typeof import("../../src/server/git/paths")>(),
  repositoryRoot: async (root: string) => root,
}));
vi.mock("../../src/server/git/status", () => ({ getRepositoryStatus: async () => ({}) }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); fixture.calls = []; });

describe("Git worktree capability admission", () => {
  it.each(["git version 2.34.1", "git version 2.35.9", "unknown Git"])("rejects %s before either creation path changes Git or records ownership", async (version) => {
    fixture.version = version;
    const root = mkdtempSync(join(tmpdir(), "inertia-git-minimum-")); roots.push(root);
    const hooks = { beforeAdd: vi.fn(), added: vi.fn(), notAdded: vi.fn() };
    await expect(createWorktree(root, join(root, "plain"))).rejects.toThrow("requires Git 2.36");
    await expect(createWorktreeWithOwnershipReceipt(root, join(root, "owned"), {
      branch: "codex/new-worktree", createBranch: true, startPoint: "HEAD",
    }, hooks)).rejects.toThrow("requires Git 2.36");
    expect(fixture.calls).toEqual([["--version"], ["--version"]]);
    expect(hooks.beforeAdd).not.toHaveBeenCalled();
  });

  it.each(["git version 2.36.0", "git version 2.50.1 (Apple Git-155)", "git version 2.49.0.windows.1", "git version 3.0.0"])("accepts the supported release %s", async (version) => {
    fixture.version = version;
    await expect(requireGitWorktreeSupport(process.cwd())).resolves.toBeUndefined();
  });
});
