import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { ProjectIdentityRefresher } from "../../src/server/project-identity-refresh";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";

it("keeps chats without a project working when an ancestor of the data folder becomes a Git repository", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-scratch-identity-")));
  const data = join(root, "data");
  mkdirSync(data);
  const store = new RuntimeStore(join(data, "inertia.sqlite"), data);
  try {
    const project = await new ScratchWorkspace(store, data).ensureProject();
    const chat = await new ScratchWorkspace(store, data).createConversation(project.id, "Before git init", {});
    execFileSync("git", ["init", "--quiet", root]);
    const refresher = new ProjectIdentityRefresher({ apply: (projectId, identity) => {
      try { store.updateProject(projectId, identity); } catch { return; }
    } });
    await refresher.refreshAll(store.shellSnapshot().projects.map(({ id, path }) => ({ id, path })));
    expect(store.project(project.id)).toMatchObject({ workspaceKind: "scratch", repositoryRoot: null, repositoryIdentity: null });
    expect(store.conversationPath(chat.id)).toBe(chat.worktreePath);
    expect(() => store.updateProject(project.id, {
      repositoryIdentity: `git:${join(root, ".git")}`,
      repositoryRoot: root,
      repositoryRelativePath: "data/scratch",
    })).toThrow("The folder for chats without a project cannot become a Git repository.");
    await expect(new ScratchWorkspace(store, data).ensureProject()).rejects.toThrow("outside a Git repository");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
