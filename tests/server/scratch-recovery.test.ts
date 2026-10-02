import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git/types";
import { runGitInspection } from "../../src/server/git/runner";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  runGitInspection: vi.fn(),
}));

const directories: string[] = [];
const stores: RuntimeStore[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-scratch-recovery-"));
  directories.push(directory);
  return directory;
}

function openStore(dataDirectory: string): RuntimeStore {
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), dataDirectory, { recoverInterruptedRuns: false });
  stores.push(store);
  return store;
}

function closeStore(store: RuntimeStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

function scratchProjects(store: RuntimeStore) {
  return store.shellSnapshot().projects.filter(({ workspaceKind }) => workspaceKind === "scratch");
}

async function sourceArchive(dataDirectory: string) {
  const store = openStore(dataDirectory);
  const userFolder = join(dataDirectory, "user-project");
  mkdirSync(userFolder);
  const userProject = store.createProject("User project", userFolder);
  store.createConversation(userProject.id, "Project chat");
  const scratch = await new ScratchWorkspace(store, dataDirectory).ensureProject();
  const chat = await new ScratchWorkspace(store, dataDirectory).createConversation(scratch.id, "Plan a trip", {});
  store.createMessage(chat.id, "Plan a relaxed trip.", "user", [], null, "2026-10-02T00:00:00.000Z");
  writeFileSync(join(chat.worktreePath!, "notes.txt"), "keep these notes");
  const serialized = store.exportRecoveryData();
  closeStore(store);
  return { serialized, folder: chat.worktreePath! };
}

function discardDatabase(dataDirectory: string): void {
  for (const name of readdirSync(dataDirectory).filter((entry) => entry.startsWith("inertia.sqlite"))) {
    rmSync(join(dataDirectory, name), { force: true });
  }
}

beforeEach(() => {
  vi.mocked(runGitInspection).mockReset().mockRejectedValue(new GitError("not-repository", "No Git repository"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("recovering chats without a project", () => {
  it("round-trips the managed folder kind and each chat's folder without creating folders", async () => {
    const dataDirectory = temporaryDirectory();
    const { serialized, folder } = await sourceArchive(dataDirectory);
    expect(JSON.parse(serialized)).toMatchObject({ version: 3 });
    discardDatabase(dataDirectory);
    const store = openStore(dataDirectory);
    const authorizedRoot = temporaryDirectory();
    await store.importRecoveryData(serialized, authorizedRoot);
    const [scratch] = scratchProjects(store);
    expect(scratchProjects(store)).toHaveLength(1);
    expect(scratch).toMatchObject({ name: "No project", path: join(dataDirectory, "scratch") });
    const chat = store.shellSnapshot().conversations.find(({ title }) => title === "Plan a trip")!;
    expect(chat).toMatchObject({ projectId: scratch!.id, worktreePath: folder, branch: null });
    expect(store.conversationPath(chat.id)).toBe(folder);
    expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("keep these notes");
    expect(store.conversationDetail(chat.id)?.messages.map(({ content }) => content)).toEqual(["Plan a relaxed trip."]);
    const [recovered] = readdirSync(authorizedRoot);
    expect(readdirSync(join(authorizedRoot, recovered!))).toEqual(["project-00001"]);
    expect((await new ScratchWorkspace(store, dataDirectory).ensureProject()).id).toBe(scratch!.id);
    expect(scratchProjects(store)).toHaveLength(1);
  });

  it("attaches imported chats to an existing managed folder and never shares a chat folder", async () => {
    const dataDirectory = temporaryDirectory();
    const { serialized, folder } = await sourceArchive(dataDirectory);
    const store = openStore(dataDirectory);
    const [existing] = scratchProjects(store);
    const original = store.shellSnapshot().conversations.find(({ worktreePath }) => worktreePath === folder)!;
    await store.importRecoveryData(serialized, temporaryDirectory());
    expect(scratchProjects(store).map(({ id }) => id)).toEqual([existing!.id]);
    const copies = store.shellSnapshot().conversations.filter(({ worktreePath }) => worktreePath === folder);
    expect(copies).toHaveLength(2);
    const copy = copies.find(({ id }) => id !== original.id)!;
    expect(copy.projectId).toBe(existing!.id);
    expect(store.conversationPath(original.id)).toBe(folder);
    expect(() => store.conversationPath(copy.id)).toThrow(`This chat's folder (${folder}) is missing or was replaced`);
  });

  it("keeps a chat from another device readable and sets up the managed folder on the next chat", async () => {
    const { serialized, folder } = await sourceArchive(temporaryDirectory());
    const dataDirectory = temporaryDirectory();
    const store = openStore(dataDirectory);
    await store.importRecoveryData(serialized, temporaryDirectory());
    expect(existsSync(join(dataDirectory, "scratch"))).toBe(false);
    const [scratch] = scratchProjects(store);
    const chat = store.shellSnapshot().conversations.find(({ title }) => title === "Plan a trip")!;
    expect(chat).toMatchObject({ projectId: scratch!.id, worktreePath: folder });
    expect(() => store.conversationPath(chat.id)).toThrow("can be read but not continued");
    expect(store.conversationDetail(chat.id)?.messages.map(({ content }) => content)).toEqual(["Plan a relaxed trip."]);
    const workspace = new ScratchWorkspace(store, dataDirectory);
    expect((await workspace.ensureProject()).id).toBe(scratch!.id);
    const next = await workspace.createConversation(scratch!.id, "Next", {});
    expect(dirname(next.worktreePath!)).toBe(join(dataDirectory, "scratch"));
    expect(scratchProjects(store)).toHaveLength(1);
  });

  it("does not authorize an imported chat folder outside the managed folder", async () => {
    const dataDirectory = temporaryDirectory();
    const { serialized } = await sourceArchive(dataDirectory);
    const outside = join(temporaryDirectory(), "private");
    mkdirSync(outside);
    const archive = JSON.parse(serialized) as { projects: Array<{ workspaceKind?: string; conversations: Array<{ worktreePath?: string }> }> };
    archive.projects.find(({ workspaceKind }) => workspaceKind === "scratch")!.conversations[0]!.worktreePath = outside;
    discardDatabase(dataDirectory);
    const store = openStore(dataDirectory);
    await store.importRecoveryData(JSON.stringify(archive), temporaryDirectory());
    const chat = store.shellSnapshot().conversations.find(({ worktreePath }) => worktreePath === outside)!;
    expect(() => store.conversationPath(chat.id)).toThrow("can be read but not continued");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects an archive that gives a project chat its own folder", async () => {
    const dataDirectory = temporaryDirectory();
    const { serialized } = await sourceArchive(dataDirectory);
    const archive = JSON.parse(serialized) as { projects: Array<{ workspaceKind?: string; conversations: Array<{ worktreePath?: string }> }> };
    archive.projects.find(({ workspaceKind }) => workspaceKind === undefined)!.conversations[0]!.worktreePath = dataDirectory;
    const store = openStore(temporaryDirectory());
    const before = store.shellSnapshot().projects.length;
    await expect(store.importRecoveryData(JSON.stringify(archive), temporaryDirectory())).rejects.toThrow("does not match the supported format");
    expect(store.shellSnapshot().projects).toHaveLength(before);
  });

  it("imports an older archive as before and still ends with one managed folder", async () => {
    const dataDirectory = temporaryDirectory();
    const { serialized } = await sourceArchive(dataDirectory);
    const archive = JSON.parse(serialized) as { version: number; projects: Array<{ workspaceKind?: string; conversations: Array<{ worktreePath?: string }> }> };
    archive.version = 2;
    for (const project of archive.projects) {
      delete project.workspaceKind;
      for (const conversation of project.conversations) delete conversation.worktreePath;
    }
    discardDatabase(dataDirectory);
    const store = openStore(dataDirectory);
    const authorizedRoot = temporaryDirectory();
    await store.importRecoveryData(JSON.stringify(archive), authorizedRoot);
    const recovered = store.shellSnapshot().projects.find(({ name }) => name === "No project")!;
    expect(recovered.workspaceKind).toBeUndefined();
    expect(dirname(dirname(recovered.path))).toBe(realpathSync(authorizedRoot));
    const scratch = await new ScratchWorkspace(store, dataDirectory).ensureProject();
    expect(scratchProjects(store).map(({ id }) => id)).toEqual([scratch.id]);
    expect(scratch.path).toBe(join(dataDirectory, "scratch"));
    expect(store.shellSnapshot().projects.filter(({ path }) => path === scratch.path)).toHaveLength(1);
  });
});
