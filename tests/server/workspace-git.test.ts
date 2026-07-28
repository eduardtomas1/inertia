import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverWorkspaceGitRepositories,
  resolveWorkspaceGitRepository,
  workspaceGitFilePath,
} from "../../src/server/workspace-git";
import { getUnifiedDiff } from "../../src/server/git";

const roots: string[] = [];

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `inertia-${name}-`));
  roots.push(root);
  return root;
}

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

function initializeRepository(path: string, trackedFile?: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "config", "user.email", "tests@inertia.invalid");
  git(path, "config", "user.name", "Inertia Tests");
  if (trackedFile) {
    const absolute = join(path, trackedFile);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "before\n");
    git(path, "add", "--", trackedFile);
    git(path, "commit", "-q", "-m", "Initial");
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace Git repository discovery", () => {
  it("finds a dirty root and distinct dirty Openbravo module repositories", async () => {
    const root = temporaryRoot("openbravo-root");
    initializeRepository(root, "README.md");
    const alpha = join(root, "modules", "org.openbravo.alpha");
    const beta = join(root, "modules", "org.openbravo.beta");
    initializeRepository(alpha, "src/Main.java");
    initializeRepository(beta, "src/Main.java");
    writeFileSync(join(root, "README.md"), "after\n");
    writeFileSync(join(alpha, "src/Main.java"), "alpha after\n");
    writeFileSync(join(beta, "src/Main.java"), "beta after\n");

    const snapshot = await discoverWorkspaceGitRepositories(root);

    expect(snapshot.partial).toBe(false);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.repositories.map((repository) => repository.repositoryPath)).toEqual([
      ".",
      "modules/org.openbravo.alpha",
      "modules/org.openbravo.beta",
    ]);
    expect(snapshot.repositories.map((repository) => repository.files[0]?.path)).toEqual([
      "README.md",
      "src/Main.java",
      "src/Main.java",
    ]);
    expect(snapshot.repositories.map((repository) => repository.files.length)).toEqual([3, 1, 1]);
    expect(snapshot.files).toBe(5);
  });

  it("supports a project with nested repositories and no root repository", async () => {
    const root = temporaryRoot("openbravo-modules");
    const core = join(root, "modules_core", "org.openbravo.client.application");
    const custom = join(root, "modules", "com.example.custom");
    initializeRepository(core);
    initializeRepository(custom);
    writeFileSync(join(core, "Application.java"), "class Application {}\n");
    writeFileSync(join(custom, "Application.java"), "class CustomApplication {}\n");

    const snapshot = await discoverWorkspaceGitRepositories(root);

    expect(snapshot.repositories.map((repository) => repository.repositoryPath)).toEqual([
      "modules/com.example.custom",
      "modules_core/org.openbravo.client.application",
    ]);
    expect(snapshot.repositories.every((repository) => repository.files[0]?.path === "Application.java")).toBe(true);
    expect(snapshot.files).toBe(2);
  });

  it("recognizes a Git worktree marker file as its own repository root", async () => {
    const source = temporaryRoot("worktree-source");
    initializeRepository(source, "tracked.txt");
    const workspace = temporaryRoot("worktree-project");
    const worktree = join(workspace, "modules", "worktree-module");
    mkdirSync(dirname(worktree), { recursive: true });
    git(source, "worktree", "add", "-q", "-b", "module-worktree", worktree);
    writeFileSync(join(worktree, "tracked.txt"), "worktree change\n");

    const snapshot = await discoverWorkspaceGitRepositories(workspace);

    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]).toMatchObject({
      repositoryPath: "modules/worktree-module",
      state: "ready",
      branch: "module-worktree",
    });
  });

  it("never follows directory symlinks outside the project", async () => {
    const root = temporaryRoot("symlink-root");
    const outside = temporaryRoot("symlink-outside");
    initializeRepository(outside);
    writeFileSync(join(outside, "outside.txt"), "outside\n");
    mkdirSync(join(root, "modules"), { recursive: true });
    symlinkSync(
      outside,
      join(root, "modules", "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const snapshot = await discoverWorkspaceGitRepositories(root);

    expect(snapshot.repositories).toEqual([]);
    expect(snapshot.skippedDirectories).toBeGreaterThan(0);
    await expect(resolveWorkspaceGitRepository(root, "modules/escaped")).rejects.toThrow(/symbolic link/u);
  });

  it("skips generated dependency trees without hiding legitimate module repositories", async () => {
    const root = temporaryRoot("ignored");
    initializeRepository(join(root, "node_modules", "dependency"));
    initializeRepository(join(root, "vendor", "library"));
    initializeRepository(join(root, "build", "generated-repository"));
    initializeRepository(join(root, "modules", "legitimate-module"));

    const snapshot = await discoverWorkspaceGitRepositories(root);

    expect(snapshot.repositories.map((repository) => repository.repositoryPath)).toEqual([
      "modules/legitimate-module",
    ]);
    expect(snapshot.skippedDirectories).toBeGreaterThanOrEqual(3);
  });

  it("reports depth, directory-work and repository-count truncation truthfully", async () => {
    const root = temporaryRoot("limits");
    initializeRepository(join(root, "a", "deep", "repository"));
    initializeRepository(join(root, "modules", "alpha"));
    initializeRepository(join(root, "modules", "beta"));

    const depthLimited = await discoverWorkspaceGitRepositories(root, { maxDepth: 1 });
    expect(depthLimited.truncated).toBe(true);
    expect(depthLimited.partial).toBe(true);
    expect(depthLimited.repositories).toEqual([]);

    const directoryLimited = await discoverWorkspaceGitRepositories(root, { maxDirectories: 1 });
    expect(directoryLimited.truncated).toBe(true);
    expect(directoryLimited.scannedDirectories).toBe(1);

    const repositoryLimited = await discoverWorkspaceGitRepositories(root, { maxRepositories: 1 });
    expect(repositoryLimited.truncated).toBe(true);
    expect(repositoryLimited.repositories).toHaveLength(1);
    expect(repositoryLimited.repositories[0].repositoryPath).toBe("modules/alpha");
  });

  it("finishes traversing a workspace after the repository display limit is reached", async () => {
    const root = temporaryRoot("many-repositories");
    for (let index = 0; index < 70; index += 1) {
      initializeRepository(
        join(root, "modules", `repository-${String(index).padStart(2, "0")}`),
      );
    }

    const snapshot = await discoverWorkspaceGitRepositories(root, {
      maxRepositories: 64,
      maxDirectories: 1_000,
    });

    expect(snapshot.repositories).toHaveLength(64);
    expect(snapshot.discoveredRepositories).toBe(70);
    expect(snapshot.repositoryLimit).toBe(64);
    expect(snapshot.scannedDirectories).toBe(72);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.repositories.at(-1)?.repositoryPath).toBe(
      "modules/repository-63",
    );
  });

  it("loads the complete diff for one small change in a root-less nested repository", async () => {
    const root = temporaryRoot("single-nested-diff");
    const nested = join(root, "modules", "org.openbravo.small");
    initializeRepository(nested, "src/Main.java");
    writeFileSync(join(nested, "src/Main.java"), "class Main { int value = 2; }\n");

    const snapshot = await discoverWorkspaceGitRepositories(root);
    const repository = await resolveWorkspaceGitRepository(
      root,
      "modules/org.openbravo.small",
    );
    const diff = await getUnifiedDiff(repository.root, {
      paths: ["src/Main.java"],
    });

    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]?.files).toEqual([
      expect.objectContaining({ path: "src/Main.java" }),
    ]);
    expect(diff.truncated).toBe(false);
    expect(diff.filesIncluded).toBe(1);
    expect(diff.totalFiles).toBe(1);
    expect(diff.text).toContain("diff --git a/src/Main.java b/src/Main.java");
    expect(diff.text).toContain("+class Main { int value = 2; }");
  });

  it("keeps malformed repository markers visible as per-repository errors", async () => {
    const root = temporaryRoot("broken-marker");
    const broken = join(root, "modules", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "gitdir: ../../does-not-exist\n");

    const snapshot = await discoverWorkspaceGitRepositories(root);

    expect(snapshot.partial).toBe(true);
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]).toMatchObject({
      repositoryPath: "modules/broken",
      state: "error",
    });
    expect(snapshot.repositories[0].error).toBeTruthy();
  });

  it("re-resolves the selected repository and composes workspace file paths without flattening identity", async () => {
    const root = temporaryRoot("resolution");
    const alpha = join(root, "modules", "alpha");
    const beta = join(root, "modules", "beta");
    initializeRepository(alpha, "src/Main.java");
    initializeRepository(beta, "src/Main.java");
    writeFileSync(join(alpha, "src/Main.java"), "alpha after\n");
    writeFileSync(join(beta, "src/Main.java"), "beta after\n");

    const resolved = await resolveWorkspaceGitRepository(root, "modules/alpha");
    const alphaDiff = await getUnifiedDiff(resolved.root);

    expect(resolve(resolved.root)).toBe(resolve(git(alpha, "rev-parse", "--show-toplevel")));
    expect(alphaDiff.text).toContain("alpha after");
    expect(alphaDiff.text).not.toContain("beta after");
    expect(workspaceGitFilePath("modules/alpha", "src/Main.java")).toBe("modules/alpha/src/Main.java");
    expect(workspaceGitFilePath("modules/beta", "src/Main.java")).toBe("modules/beta/src/Main.java");
    expect(() => workspaceGitFilePath("modules/alpha", "../outside.txt")).toThrow(/file path/u);
    await expect(resolveWorkspaceGitRepository(root, "../outside")).rejects.toThrow(/repository path/u);
    await expect(resolveWorkspaceGitRepository(root, "modules\\alpha")).rejects.toThrow(/repository path/u);
  });
});
