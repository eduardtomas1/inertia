import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git/types";
import { runGitInspection } from "../../src/server/git/runner";
import { parseDatabaseRecoveryExport } from "../../src/server/persistence/database-export";
import { SCRATCH_PROVISIONING_CHUNK, ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  runGitInspection: vi.fn(),
}));

const directories: string[] = [];
const stores: RuntimeStore[] = [];

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "inertia-scratch-provisioning-")));
  directories.push(path);
  return path;
}

function open(data: string): RuntimeStore {
  const store = new RuntimeStore(join(data, "inertia.sqlite"), data, { recoverInterruptedRuns: false });
  stores.push(store);
  return store;
}

const scratchOf = (store: RuntimeStore) => store.shellSnapshot().projects.filter(({ workspaceKind }) => workspaceKind === "scratch");
const chatsOf = (store: RuntimeStore, projectId: string) => store.shellSnapshot().conversations.filter((chat) => chat.projectId === projectId);

function archive(projects: unknown[], version = 3): string {
  return JSON.stringify({ format: "inertia-recovery-export", version, exportedAt: "2026-10-02T00:00:00.000Z", projects });
}

const conversation = (title: string) => ({
  title, providerId: "codex", model: "", reasoningEffort: "", interactionMode: "build", accessMode: "full",
  messages: [{ role: "user", content: "hi", createdAt: "2026-10-02T00:00:00.000Z", ordinal: 0 }],
});

async function imported(count: number) {
  const data = directory();
  const store = open(data);
  const chats = Array.from({ length: count }, (_, index) => conversation(`Chat ${index}`));
  await store.importRecoveryData(archive([{ name: "No project", path: "/old/scratch", workspaceKind: "scratch", conversations: chats }]), directory());
  return { data, store, project: scratchOf(store)[0]! };
}

beforeEach(() => {
  vi.mocked(runGitInspection).mockReset().mockRejectedValue(new GitError("not-repository", "No Git repository"));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("setting up the managed folder", () => {
  it("recovers from a transient Git failure during the first setup for imported chats", async () => {
    const { data, store, project } = await imported(1);
    vi.mocked(runGitInspection).mockRejectedValueOnce(new GitError("timeout", "Git timed out"));
    await expect(new ScratchWorkspace(store, data).reconcile()).rejects.toThrow("Git timed out");
    expect(existsSync(join(data, "scratch"))).toBe(false);
    await expect(new ScratchWorkspace(store, data).ensureProject()).resolves.toMatchObject({ id: project.id });
    await new ScratchWorkspace(store, data).reconcile();
    const [chat] = chatsOf(store, project.id);
    expect(store.conversationPath(chat!.id)).toBe(chat!.worktreePath);
  });

  it("recovers from a transient Git failure while setting up a deleted managed folder again", async () => {
    const data = directory();
    const store = open(data);
    const project = await new ScratchWorkspace(store, data).ensureProject();
    rmSync(join(data, "scratch"), { recursive: true });
    vi.mocked(runGitInspection).mockRejectedValueOnce(new GitError("timeout", "Git timed out"));
    await expect(new ScratchWorkspace(store, data).ensureProject()).rejects.toThrow("Git timed out");
    await expect(new ScratchWorkspace(store, data).ensureProject()).resolves.toMatchObject({ id: project.id });
    expect(store.projectPath(project.id)).toBe(join(data, "scratch"));
  });

  it("enrolls a recorded managed project whose folder appeared without a receipt", async () => {
    const { data, store, project } = await imported(1);
    mkdirSync(join(data, "scratch"), { mode: 0o700 });
    await expect(new ScratchWorkspace(store, data).ensureProject()).resolves.toMatchObject({ id: project.id });
    expect(store.projectPath(project.id)).toBe(join(data, "scratch"));
  });

  it("serves concurrent setups from separate callers without a stale-receipt failure", async () => {
    const { data, store, project } = await imported(3);
    const results = await Promise.allSettled([
      new ScratchWorkspace(store, data).reconcile(),
      new ScratchWorkspace(store, data).ensureProject(),
      new ScratchWorkspace(store, data).reconcile(),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    const chats = chatsOf(store, project.id);
    expect(chats.every(({ worktreePath }) => worktreePath !== null)).toBe(true);
    expect(readdirSync(join(data, "scratch")).sort()).toEqual(chats.map(({ worktreePath }) => basename(worktreePath!)).sort());
  });
});

describe("giving imported chats their folders", () => {
  it("yields to the event loop between bounded chunks", async () => {
    const total = SCRATCH_PROVISIONING_CHUNK * 2 + 5;
    const { data, store, project } = await imported(total);
    let boundWhenTimerFired = -1;
    const timer = setTimeout(() => {
      boundWhenTimerFired = chatsOf(store, project.id).filter(({ worktreePath }) => worktreePath !== null).length;
    }, 0);
    try {
      await new ScratchWorkspace(store, data).reconcile();
    } finally {
      clearTimeout(timer);
    }
    expect(boundWhenTimerFired).toBeGreaterThan(0);
    expect(boundWhenTimerFired).toBeLessThan(total);
    expect(vi.mocked(runGitInspection)).toHaveBeenCalledTimes(1);
    expect(chatsOf(store, project.id).every(({ worktreePath }) => worktreePath !== null)).toBe(true);
  });

  it("resumes after an interruption between chunks without leaving extra folders", async () => {
    const total = SCRATCH_PROVISIONING_CHUNK + 7;
    const { data, store, project } = await imported(total);
    const bind = store.bindScratchFolder.bind(store);
    let calls = 0;
    store.bindScratchFolder = (conversationId, path) => {
      calls += 1;
      if (calls > SCRATCH_PROVISIONING_CHUNK) throw new Error("Interrupted.");
      return bind(conversationId, path);
    };
    await new ScratchWorkspace(store, data).reconcile();
    expect(chatsOf(store, project.id).filter(({ worktreePath }) => worktreePath !== null)).toHaveLength(SCRATCH_PROVISIONING_CHUNK);
    store.bindScratchFolder = bind;
    await new ScratchWorkspace(store, data).reconcile();
    const chats = chatsOf(store, project.id);
    expect(chats.every(({ worktreePath }) => worktreePath !== null)).toBe(true);
    expect(readdirSync(join(data, "scratch"))).toHaveLength(total);
  });

  it("finds its own earlier empty folder after the chat was renamed", async () => {
    const { data, store, project } = await imported(1);
    await new ScratchWorkspace(store, data).ensureProject();
    const [chat] = chatsOf(store, project.id);
    const leftover = join(data, "scratch", `2026-10-01-chat-0-${chat!.id}`);
    mkdirSync(leftover);
    store.updateConversation(chat!.id, { title: "Renamed" });
    await new ScratchWorkspace(store, data).reconcile();
    expect(readdirSync(join(data, "scratch"))).toEqual([basename(leftover)]);
    expect(store.conversation(chat!.id).worktreePath).toBe(leftover);
  });

  it("never adopts a symlink with the chat's name and never writes through it", async () => {
    const { data, store, project } = await imported(1);
    await new ScratchWorkspace(store, data).ensureProject();
    const [chat] = chatsOf(store, project.id);
    const outside = directory();
    const today = new Date().toISOString().slice(0, 10);
    symlinkSync(outside, join(data, "scratch", `${today}-chat-0-${chat!.id}`), "junction");
    await new ScratchWorkspace(store, data).reconcile();
    expect(store.conversation(chat!.id).worktreePath).toBeNull();
    expect(readdirSync(outside)).toEqual([]);
    expect(() => store.conversationPath(chat!.id)).toThrow("does not have its own folder yet");
  });

  it("is idempotent and resumable after a folder could not be set up", async () => {
    const { data, store, project } = await imported(3);
    await new ScratchWorkspace(store, data).ensureProject();
    const [blocked] = chatsOf(store, project.id);
    const today = new Date().toISOString().slice(0, 10);
    const occupied = join(data, "scratch", `${today}-${blocked!.title.toLowerCase().replace(" ", "-")}-${blocked!.id}`);
    mkdirSync(occupied);
    writeFileSync(join(occupied, "x"), "x");
    await new ScratchWorkspace(store, data).reconcile();
    expect(chatsOf(store, project.id).filter(({ worktreePath }) => worktreePath === null).map(({ id }) => id)).toEqual([blocked!.id]);
    rmSync(occupied, { recursive: true });
    await new ScratchWorkspace(store, data).reconcile();
    await new ScratchWorkspace(store, data).reconcile();
    expect(chatsOf(store, project.id).every(({ worktreePath }) => worktreePath !== null)).toBe(true);
    expect(readdirSync(join(data, "scratch"))).toHaveLength(3);
  });

  it("merges forged and duplicate managed projects into one and never uses the archived path", async () => {
    const data = directory();
    const store = open(data);
    const victim = directory();
    writeFileSync(join(victim, "keep.txt"), "user data");
    await store.importRecoveryData(archive([
      { name: "My code", path: victim, workspaceKind: "scratch", conversations: [conversation("Forged one")] },
      { name: "No project", path: "/elsewhere/scratch", workspaceKind: "scratch", conversations: [conversation("Second")] },
    ]), directory());
    const [project] = scratchOf(store);
    expect(scratchOf(store)).toHaveLength(1);
    expect(project!.path).toBe(join(data, "scratch"));
    await new ScratchWorkspace(store, data).reconcile();
    const chats = chatsOf(store, project!.id);
    expect(chats).toHaveLength(2);
    for (const chat of chats) expect(store.conversationPath(chat.id).startsWith(join(data, "scratch"))).toBe(true);
    expect(chats.every(({ accessMode }) => accessMode === "supervised")).toBe(true);
    expect(readdirSync(victim)).toEqual(["keep.txt"]);
  });

  it("rejects archives that mix up formats or carry folder paths", () => {
    expect(() => parseDatabaseRecoveryExport(archive([{ name: "x", path: "/x", workspaceKind: "scratch", conversations: [] }], 2))).toThrow();
    expect(() => parseDatabaseRecoveryExport(archive([{ name: "x", path: "/x", workspaceKind: "scratch",
      conversations: [{ ...conversation("a"), worktreePath: "/etc" }] }]))).toThrow();
    expect(() => parseDatabaseRecoveryExport(archive([{ name: "x", path: "/x", workspaceKind: "workspace", conversations: [] }]))).toThrow();
    expect(parseDatabaseRecoveryExport(archive([{ name: "No project", path: "/x", conversations: [] }], 2)).projects[0]).not.toHaveProperty("workspaceKind");
  });
});

describe("provisioning while other work runs", () => {
  async function untilSomeBound(store: RuntimeStore, projectId: string): Promise<void> {
    for (let tries = 0; tries < 1_000; tries += 1) {
      await new Promise<void>((resume) => setImmediate(resume));
      if (chatsOf(store, projectId).some(({ worktreePath }) => worktreePath !== null)) return;
    }
  }

  it("keeps going when a pending chat is deleted between batches", async () => {
    const { data, store, project } = await imported(SCRATCH_PROVISIONING_CHUNK * 2 + 50);
    const victim = chatsOf(store, project.id)[SCRATCH_PROVISIONING_CHUNK + 50]!;
    const run = new ScratchWorkspace(store, data).reconcile();
    await untilSomeBound(store, project.id);
    store.deleteConversation(victim.id);
    await expect(run).resolves.toBeUndefined();
    expect(chatsOf(store, project.id).filter(({ worktreePath }) => worktreePath === null)).toEqual([]);
  });

  it("lets a new chat's setup run between provisioning batches", async () => {
    const { data, store, project } = await imported(SCRATCH_PROVISIONING_CHUNK * 3);
    const run = new ScratchWorkspace(store, data).reconcile();
    await untilSomeBound(store, project.id);
    await new ScratchWorkspace(store, data).ensureProject();
    const pendingWhenReady = chatsOf(store, project.id).filter(({ worktreePath }) => worktreePath === null).length;
    await run;
    expect(pendingWhenReady).toBeGreaterThan(0);
    expect(chatsOf(store, project.id).filter(({ worktreePath }) => worktreePath === null)).toEqual([]);
  });

  it("releases the setup queue after a failed setup", async () => {
    const data = directory();
    const store = open(data);
    vi.mocked(runGitInspection).mockRejectedValueOnce(new GitError("timeout", "Git timed out"));
    const [first, second] = await Promise.allSettled([
      new ScratchWorkspace(store, data).ensureProject(),
      new ScratchWorkspace(store, data).ensureProject(),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
  });
});

describe("re-checking the managed folder", () => {
  it("re-enrolls only the data directory's own folder and never a stale recorded path", async () => {
    const data = directory();
    const store = open(data);
    const project = await new ScratchWorkspace(store, data).ensureProject();
    const outside = directory();
    const database = (store as unknown as { database: import("better-sqlite3").Database }).database;
    database.prepare("UPDATE projects SET path = ?, normalized_path = ? WHERE id = ?").run(outside, outside, project.id);
    database.prepare("DELETE FROM project_path_authorities WHERE project_id = ?").run(project.id);
    const rebound = await new ScratchWorkspace(store, data).ensureProject();
    expect(rebound.path).toBe(join(data, "scratch"));
    expect(store.projectPath(project.id)).toBe(join(data, "scratch"));
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlinked managed folder and never removes a folder it did not create", async () => {
    const data = directory();
    const store = open(data);
    const outside = directory();
    symlinkSync(outside, join(data, "scratch"), "junction");
    await expect(new ScratchWorkspace(store, data).ensureProject()).rejects.toThrow("cannot be verified");
    expect(lstatSync(join(data, "scratch")).isSymbolicLink()).toBe(true);
    rmSync(join(data, "scratch"));
    mkdirSync(join(data, "scratch"));
    vi.mocked(runGitInspection).mockRejectedValueOnce(new GitError("timeout", "Git timed out"));
    await expect(new ScratchWorkspace(store, data).ensureProject()).rejects.toThrow("Git timed out");
    expect(existsSync(join(data, "scratch"))).toBe(true);
  });

  it("never removes a symlink swapped in during the Git check", async () => {
    const data = directory();
    const store = open(data);
    const outside = directory();
    vi.mocked(runGitInspection).mockImplementationOnce(async () => {
      rmSync(join(data, "scratch"), { recursive: true });
      symlinkSync(outside, join(data, "scratch"), "junction");
      throw new GitError("timeout", "Git timed out");
    });
    await expect(new ScratchWorkspace(store, data).ensureProject()).rejects.toThrow();
    expect(lstatSync(join(data, "scratch")).isSymbolicLink()).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("adopts an empty leftover only by the exact chat ID at the end of its name", async () => {
    const { data, store, project } = await imported(2);
    await new ScratchWorkspace(store, data).ensureProject();
    const [first, second] = chatsOf(store, project.id);
    const middle = join(data, "scratch", `2026-10-01-x-${first!.id}-tail`);
    const longer = join(data, "scratch", `2026-10-01-x-${second!.id}x`);
    const upper = join(data, "scratch", `2026-10-01-x-${second!.id.toUpperCase()}`);
    for (const path of [middle, longer, upper]) mkdirSync(path);
    await new ScratchWorkspace(store, data).reconcile();
    for (const chat of [first!, second!]) {
      const bound = store.conversation(chat.id).worktreePath!;
      expect([middle, longer, upper]).not.toContain(bound);
      expect(basename(bound).endsWith(chat.id)).toBe(true);
    }
  });
});

describe("moving the data directory", () => {
  async function moved() {
    const oldData = directory();
    const store = open(oldData);
    const workspace = new ScratchWorkspace(store, oldData);
    const project = await workspace.ensureProject();
    const chat = await workspace.createConversation(project.id, "Moved chat", {});
    writeFileSync(join(chat.worktreePath!, "mine.txt"), "original");
    return { oldData, newData: directory(), store, chat };
  }

  it("refuses a symlink carrying the chat's folder name", async () => {
    const { newData, store, chat } = await moved();
    mkdirSync(join(newData, "scratch"), { mode: 0o700 });
    symlinkSync(chat.worktreePath!, join(newData, "scratch", basename(chat.worktreePath!)), "junction");
    await new ScratchWorkspace(store, newData).reconcile();
    expect(store.conversation(chat.id).worktreePath).toBe(chat.worktreePath);
  });

  it("keeps using a still-valid old folder when the new data directory has no managed folder", async () => {
    const { oldData, newData, store, chat } = await moved();
    await new ScratchWorkspace(store, newData).reconcile();
    expect(store.conversationPath(chat.id).startsWith(oldData)).toBe(true);
  });

  it("rebinds a chat to its copy in a copied data directory", async () => {
    const { oldData, newData, store, chat } = await moved();
    cpSync(join(oldData, "scratch"), join(newData, "scratch"), { recursive: true });
    await new ScratchWorkspace(store, newData).reconcile();
    expect(store.conversationPath(chat.id).startsWith(newData)).toBe(true);
    expect(readFileSync(join(store.conversationPath(chat.id), "mine.txt"), "utf8")).toBe("original");
  });
});
