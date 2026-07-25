import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { resolveAuthoritativeProjectPath } from "../../src/server/project-path";
import { resolveWorkspacePathForOpen } from "../../src/server/workspace";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("authoritative project-path resolution", () => {
  it("opens ordinary files and directories under project and worktree roots", async () => {
    const directory = await temporaryDirectory("inertia-project-path-");
    const projectRoot = join(directory, "project");
    const worktreeRoot = join(directory, "worktree");
    await Promise.all([mkdir(join(projectRoot, "src"), { recursive: true }), mkdir(join(worktreeRoot, "src"), { recursive: true })]);
    await Promise.all([
      writeFile(join(projectRoot, "src", "project.ts"), "project"),
      writeFile(join(worktreeRoot, "src", "worktree.ts"), "worktree"),
    ]);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), projectRoot);
    try {
      const project = store.createProject("Project", projectRoot);
      const conversation = store.createConversation(project.id, "Worktree", { worktreePath: worktreeRoot });
      const canonicalProjectRoot = await realpath(projectRoot);
      const canonicalWorktreeRoot = await realpath(worktreeRoot);
      await expect(resolveAuthoritativeProjectPath(store, {
        projectId: project.id,
        relativePath: "src/project.ts",
        action: "open-externally",
      })).resolves.toMatchObject({
        absolute: resolve(canonicalProjectRoot, "src/project.ts"),
        relativePath: "src/project.ts",
        kind: "file",
      });
      await expect(resolveAuthoritativeProjectPath(store, {
        projectId: project.id,
        conversationId: conversation.id,
        relativePath: "src/worktree.ts",
        action: "reveal",
      })).resolves.toMatchObject({
        absolute: resolve(canonicalWorktreeRoot, "src/worktree.ts"),
        relativePath: "src/worktree.ts",
        kind: "file",
      });
      await expect(resolveAuthoritativeProjectPath(store, {
        projectId: project.id,
        conversationId: conversation.id,
        relativePath: ".",
        action: "open-externally",
      })).resolves.toMatchObject({
        absolute: canonicalWorktreeRoot,
        relativePath: ".",
        kind: "directory",
      });
    } finally {
      store.close();
    }
  });

  it("rejects traversal, portable absolute paths, null bytes, and missing targets", async () => {
    const directory = await temporaryDirectory("inertia-project-path-invalid-");
    const root = join(directory, "project");
    await mkdir(root);
    await writeFile(join(directory, "secret.txt"), "secret");

    for (const relativePath of ["../secret.txt", "nested/../../secret.txt", "/etc/passwd", "C:\\Windows\\system.ini", "C:system.ini", "bad\0path"]) {
      await expect(resolveWorkspacePathForOpen(root, relativePath)).rejects.toMatchObject({ code: "invalid-input" });
    }
    await expect(resolveWorkspacePathForOpen(root, "missing.txt")).rejects.toMatchObject({ code: "not-found" });
  });

  it("allows contained symlinks after canonicalization but rejects symlink escapes", async () => {
    const directory = await temporaryDirectory("inertia-project-path-link-");
    const root = join(directory, "project");
    const inside = join(root, "inside");
    const outside = join(directory, "outside");
    await Promise.all([mkdir(inside, { recursive: true }), mkdir(outside)]);
    await Promise.all([
      writeFile(join(inside, "safe.txt"), "safe"),
      writeFile(join(outside, "secret.txt"), "secret"),
    ]);
    await symlink(inside, join(root, "safe-link"), process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const canonicalInside = await realpath(inside);

    await expect(resolveWorkspacePathForOpen(root, "safe-link/safe.txt")).resolves.toMatchObject({
      absolute: resolve(canonicalInside, "safe.txt"),
      relativePath: "inside/safe.txt",
      kind: "file",
    });
    await expect(resolveWorkspacePathForOpen(root, "escape/secret.txt")).rejects.toMatchObject({ code: "outside-workspace" });
  });

  it("rejects a conversation that belongs to another authoritative project", async () => {
    const directory = await temporaryDirectory("inertia-project-path-scope-");
    const firstRoot = join(directory, "first");
    const secondRoot = join(directory, "second");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), firstRoot);
    try {
      const first = store.createProject("First", firstRoot);
      const second = store.createProject("Second", secondRoot);
      const conversation = store.createConversation(first.id, "First thread");
      await expect(resolveAuthoritativeProjectPath(store, {
        projectId: second.id,
        conversationId: conversation.id,
        relativePath: ".",
        action: "open-externally",
      })).rejects.toThrow("does not belong");
    } finally {
      store.close();
    }
  });
});
