import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git/types";
import { runGitInspection } from "../../src/server/git/runner";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  runGitInspection: vi.fn(),
}));

type Archive = {
  version: number;
  projects: Array<{ name: string; workspaceKind?: string; conversations: Array<Record<string, unknown>> }>;
};

const directories: string[] = [];
const stores: RuntimeStore[] = [];

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "inertia-scratch-recovery-")));
  directories.push(directory);
  return directory;
}

function openStore(dataDirectory: string): RuntimeStore {
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), dataDirectory, { recoverInterruptedRuns: false });
  stores.push(store);
  return store;
}

function scratchProjects(store: RuntimeStore) {
  return store.shellSnapshot().projects.filter(({ workspaceKind }) => workspaceKind === "scratch");
}

function chatsIn(store: RuntimeStore, projectId: string) {
  return store.shellSnapshot().conversations.filter((conversation) => conversation.projectId === projectId);
}

async function sourceArchive(): Promise<string> {
  const dataDirectory = temporaryDirectory();
  const store = openStore(dataDirectory);
  const userFolder = join(dataDirectory, "user-project");
  mkdirSync(userFolder);
  const userProject = store.createProject("No project", userFolder);
  store.createConversation(userProject.id, "Project chat");
  const workspace = new ScratchWorkspace(store, dataDirectory);
  const scratch = await workspace.ensureProject();
  for (const title of ["Weekend", "Packing"]) {
    const chat = await workspace.createConversation(scratch.id, title, {});
    store.createMessage(chat.id, `${title} notes`, "user", [], null, "2026-10-02T00:00:00.000Z");
  }
  return store.exportRecoveryData();
}

beforeEach(() => {
  vi.mocked(runGitInspection).mockReset().mockRejectedValue(new GitError("not-repository", "No Git repository"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("recovering chats without a project", () => {
  it("exports the managed folder kind but never a user project's name as the kind", async () => {
    const archive = JSON.parse(await sourceArchive()) as Archive;
    expect(archive.version).toBe(3);
    const marked = archive.projects.filter(({ workspaceKind }) => workspaceKind === "scratch");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.conversations.map(({ title }) => title).sort()).toEqual(["Packing", "Weekend"]);
    expect(archive.projects.find(({ workspaceKind }) => workspaceKind === undefined)!.name).toBe("No project");
    expect(JSON.stringify(archive)).not.toContain("worktreePath");
  });

  it("merges imported chats into the existing managed folder, each in its own new folder", async () => {
    const serialized = await sourceArchive();
    const dataDirectory = temporaryDirectory();
    const store = openStore(dataDirectory);
    const workspace = new ScratchWorkspace(store, dataDirectory);
    const existing = await workspace.ensureProject();
    const kept = await workspace.createConversation(existing.id, "Already here", {});
    await store.importRecoveryData(serialized, temporaryDirectory());
    expect(scratchProjects(store).map(({ id }) => id)).toEqual([existing.id]);
    const imported = chatsIn(store, existing.id).filter(({ id }) => id !== kept.id);
    expect(imported.map(({ title }) => title).sort()).toEqual(["Packing", "Weekend"]);
    for (const chat of imported) {
      expect(chat.worktreePath).toBeNull();
      expect(() => store.conversationPath(chat.id)).toThrow("does not have its own folder yet");
    }
    await workspace.reconcile();
    const folders = chatsIn(store, existing.id).filter(({ id }) => id !== kept.id).map(({ id, worktreePath }) => {
      expect(dirname(worktreePath!)).toBe(existing.path);
      expect(basename(worktreePath!).endsWith(id)).toBe(true);
      expect(store.conversationPath(id)).toBe(worktreePath);
      return worktreePath;
    });
    expect(new Set([...folders, kept.worktreePath]).size).toBe(3);
    const userProjects = store.shellSnapshot().projects.filter(({ name, workspaceKind }) => name === "No project" && workspaceKind === undefined);
    expect(userProjects).toHaveLength(1);
    expect(chatsIn(store, userProjects[0]!.id).map(({ title }) => title)).toEqual(["Project chat"]);
    await workspace.reconcile();
    expect(chatsIn(store, existing.id).map(({ worktreePath }) => worktreePath).sort()).toEqual([...folders, kept.worktreePath].sort());
  });

  it("creates the managed folder for imported chats in a profile that never had one", async () => {
    const serialized = await sourceArchive();
    const dataDirectory = temporaryDirectory();
    const store = openStore(dataDirectory);
    await store.importRecoveryData(serialized, temporaryDirectory());
    expect(readdirSync(dataDirectory)).not.toContain("scratch");
    const [scratch] = scratchProjects(store);
    expect(scratch).toMatchObject({ name: "No project", path: join(dataDirectory, "scratch") });
    await new ScratchWorkspace(store, dataDirectory).reconcile();
    expect(scratchProjects(store).map(({ id }) => id)).toEqual([scratch!.id]);
    expect(store.projectPath(scratch!.id)).toBe(join(dataDirectory, "scratch"));
    const chats = chatsIn(store, scratch!.id);
    expect(chats).toHaveLength(2);
    for (const chat of chats) expect(store.conversationPath(chat.id)).toBe(chat.worktreePath);
    expect(store.conversationDetail(chats[0]!.id)?.messages).toHaveLength(1);
  });

  it("resumes folder setup after an interruption and adopts only an empty folder it would have created", async () => {
    const serialized = await sourceArchive();
    const dataDirectory = temporaryDirectory();
    const store = openStore(dataDirectory);
    const workspace = new ScratchWorkspace(store, dataDirectory);
    const scratch = await workspace.ensureProject();
    await store.importRecoveryData(serialized, temporaryDirectory());
    const [first, second] = chatsIn(store, scratch.id);
    const today = new Date().toISOString().slice(0, 10);
    const leftover = join(scratch.path, `${today}-${first!.title.toLowerCase()}-${first!.id}`);
    mkdirSync(leftover);
    const occupied = join(scratch.path, `${today}-${second!.title.toLowerCase()}-${second!.id}`);
    mkdirSync(occupied);
    writeFileSync(join(occupied, "someone-else.txt"), "not ours");
    await workspace.reconcile();
    expect(store.conversation(first!.id).worktreePath).toBe(leftover);
    expect(store.conversation(second!.id).worktreePath).toBeNull();
    expect(() => store.conversationPath(second!.id)).toThrow("does not have its own folder yet");
    expect(readdirSync(occupied)).toEqual(["someone-else.txt"]);
  });

  it("imports older archives exactly as before", async () => {
    const archive = JSON.parse(await sourceArchive()) as Archive;
    archive.version = 2;
    for (const project of archive.projects) delete project.workspaceKind;
    const dataDirectory = temporaryDirectory();
    const store = openStore(dataDirectory);
    const authorizedRoot = temporaryDirectory();
    await store.importRecoveryData(JSON.stringify(archive), authorizedRoot);
    expect(scratchProjects(store)).toEqual([]);
    const recovered = store.shellSnapshot().projects;
    expect(recovered.map(({ name }) => name)).toEqual(["No project", "No project"]);
    for (const project of recovered) expect(dirname(dirname(project.path))).toBe(authorizedRoot);
    const scratch = await new ScratchWorkspace(store, dataDirectory).ensureProject();
    expect(scratchProjects(store).map(({ id }) => id)).toEqual([scratch.id]);
    expect(store.shellSnapshot().projects.filter(({ path }) => path === scratch.path)).toHaveLength(1);
  });

  it("refuses a recovery folder at or inside the managed folder", async () => {
    const serialized = await sourceArchive();
    const dataDirectory = temporaryDirectory();
    const store = openStore(dataDirectory);
    const scratch = await new ScratchWorkspace(store, dataDirectory).ensureProject();
    const inside = join(scratch.path, "recover-here");
    mkdirSync(inside);
    for (const target of [scratch.path, inside]) {
      await expect(store.importRecoveryData(serialized, target)).rejects.toThrow("Choose a recovery folder outside");
    }
    expect(readdirSync(inside)).toEqual([]);
    expect(store.shellSnapshot().conversations).toEqual([]);
  });
});
