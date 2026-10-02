import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git/types";
import { runGitInspection } from "../../src/server/git/runner";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";
import { clientCommandSchema } from "../../src/shared/contracts";

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  runGitInspection: vi.fn(),
}));

let directory: string;
let store: RuntimeStore;
let scratch: ScratchWorkspace;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "inertia-scratch-"));
  store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  scratch = new ScratchWorkspace(store, directory);
  vi.mocked(runGitInspection).mockReset().mockRejectedValue(new GitError("not-repository", "No Git repository"));
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

describe("chats without a project", () => {
  it("lazily creates one container without changing the selected project", async () => {
    const userFolder = join(directory, "user-project");
    mkdirSync(userFolder);
    const selected = store.createProject("User project", userFolder);
    const [first, second] = await Promise.all([scratch.ensureProject(), scratch.ensureProject()]);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ name: "No project", workspaceKind: "scratch", path: join(directory, "scratch"), repositoryRoot: null });
    expect(store.shellSnapshot().activeProjectId).toBe(selected.id);
    expect(store.shellSnapshot().projects).toHaveLength(2);
    expect(readdirSync(first.path)).toEqual([]);
  });

  it("gives each chat a distinct persistent folder that survives a restart", async () => {
    const project = await scratch.ensureProject();
    const first = await scratch.createConversation(project.id, "Plan a trip", {});
    const second = await scratch.createConversation(project.id, "Plan a trip", {});
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(dirname(first.worktreePath!)).toBe(project.path);
    expect(first.branch).toBeNull();
    expect(first.worktreePath).toMatch(/\d{4}-\d{2}-\d{2}-plan-a-trip-[0-9a-f-]+$/u);
    writeFileSync(join(first.worktreePath!, "notes.txt"), "keep these notes");
    expect(store.conversationPath(first.id)).toBe(first.worktreePath);
    store.close();
    store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    expect(store.project(project.id).workspaceKind).toBe("scratch");
    expect(store.conversationPath(first.id)).toBe(first.worktreePath);
    expect(readFileSync(join(first.worktreePath!, "notes.txt"), "utf8")).toBe("keep these notes");
    expect(store.conversationPath(second.id)).toBe(second.worktreePath);
  });

  it("rejects an inherited Git repository and lookup failures", async () => {
    vi.mocked(runGitInspection).mockResolvedValue({} as Awaited<ReturnType<typeof runGitInspection>>);
    await expect(scratch.ensureProject()).rejects.toThrow("outside a Git repository");
    expect(store.shellSnapshot().projects).toEqual([]);
    vi.mocked(runGitInspection).mockRejectedValue(new Error("Git unavailable"));
    await expect(scratch.ensureProject()).rejects.toThrow("Git unavailable");
    expect(store.shellSnapshot().projects).toEqual([]);
  });

  it("rejects a scratch symlink without touching its destination", async () => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(directory, "scratch"), "junction");
    await expect(scratch.ensureProject()).rejects.toThrow("cannot be verified");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not renew authority when the managed root or a chat folder is replaced", async () => {
    const project = await scratch.ensureProject();
    const chat = await scratch.createConversation(project.id, "New chat", {});
    renameSync(chat.worktreePath!, `${chat.worktreePath}-old`);
    mkdirSync(chat.worktreePath!);
    expect(() => store.conversationPath(chat.id)).toThrow("authorization expired");
    renameSync(project.path, `${project.path}-old`);
    mkdirSync(project.path);
    await expect(scratch.ensureProject()).rejects.toThrow("authorization expired");
  });

  it("rebinds the managed folder to a moved data directory after verifying the new folder", async () => {
    const project = await scratch.ensureProject();
    const moved = join(directory, "moved");
    mkdirSync(moved);
    const outside = join(directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(moved, "scratch"), "junction");
    await expect(new ScratchWorkspace(store, moved).ensureProject()).rejects.toThrow("cannot be verified");
    expect(store.project(project.id).path).toBe(project.path);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(moved, "scratch"));
    renameSync(project.path, join(moved, "scratch"));
    const relocated = await new ScratchWorkspace(store, moved).ensureProject();
    expect(relocated).toMatchObject({ id: project.id, workspaceKind: "scratch", path: join(moved, "scratch") });
    expect(store.projectPath(project.id)).toBe(join(moved, "scratch"));
    const chat = await new ScratchWorkspace(store, moved).createConversation(project.id, "After the move", {});
    expect(dirname(chat.worktreePath!)).toBe(join(moved, "scratch"));
    expect(store.shellSnapshot().projects.filter(({ workspaceKind }) => workspaceKind === "scratch")).toHaveLength(1);
    const userFolder = join(directory, "user-project");
    mkdirSync(userFolder);
    const userProject = store.createProject("User project", userFolder);
    expect(() => store.updateProject(userProject.id, { path: moved })).toThrow("Only the folder for chats without a project can move.");
    expect(store.projectPath(userProject.id)).toBe(userFolder);
  });

  it("bounds folder names and rejects identity traversal or duplicate identities", async () => {
    const project = await scratch.ensureProject();
    await expect(scratch.createConversation(project.id, "../escape", { id: "../../outside" })).rejects.toThrow("identity is invalid");
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const chat = await scratch.createConversation(project.id, "../" + "x".repeat(120), { id });
    expect(dirname(chat.worktreePath!)).toBe(project.path);
    writeFileSync(join(chat.worktreePath!, "keep.txt"), "retained");
    await expect(scratch.createConversation(project.id, "../" + "x".repeat(120), { id })).rejects.toThrow();
    expect(readFileSync(join(chat.worktreePath!, "keep.txt"), "utf8")).toBe("retained");
  });

  it("does not let the client choose a scratch location or mark an imported project as managed", () => {
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(clientCommandSchema.safeParse({ type: "project.ensure-scratch", requestId, payload: {} }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ type: "project.ensure-scratch", requestId, payload: { path: "/tmp" } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ type: "project.create", requestId, payload: { name: "Fake", path: "/tmp", workspaceKind: "scratch" } }).success).toBe(false);
  });
});
