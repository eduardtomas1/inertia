import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git/types";
import { runGitInspection } from "../../src/server/git/runner";
import { isWithinScratchRoot, ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";

const hooks = vi.hoisted(() => ({
  beforeFolderMkdir: null as null | ((path: string) => void),
  aliases: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mkdirSync = ((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    if (hooks.beforeFolderMkdir && /[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(basename(String(path)))) {
      const hook = hooks.beforeFolderMkdir;
      hooks.beforeFolderMkdir = null;
      hook(String(path));
    }
    return actual.mkdirSync(path, options as fs.MakeDirectoryOptions & { recursive: true });
  }) as typeof actual.mkdirSync;
  const native = ((path: fs.PathLike, options?: never) => (
    hooks.aliases.has(String(path)) ? String(path) : actual.realpathSync.native(path, options)
  )) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(
    ((path: fs.PathLike, options?: never) => actual.realpathSync(path, options)) as typeof actual.realpathSync,
    { native },
  );
  const statSync = ((path: fs.PathLike, options?: never) => (
    actual.statSync(hooks.aliases.get(String(path)) ?? path, options)
  )) as typeof actual.statSync;
  const overrides = { mkdirSync, realpathSync, statSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  runGitInspection: vi.fn(),
}));

let directory: string;
let store: RuntimeStore;

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "inertia-scratch-containment-")));
  store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  vi.mocked(runGitInspection).mockReset().mockRejectedValue(new GitError("not-repository", "No Git repository"));
  hooks.beforeFolderMkdir = null;
  hooks.aliases.clear();
});

afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("managed folder containment", () => {
  it("creates the managed folder privately and turns hostile titles into plain folder names", async () => {
    const scratch = new ScratchWorkspace(store, directory);
    const project = await scratch.ensureProject();
    if (process.platform !== "win32") expect(fs.statSync(project.path).mode & 0o777).toBe(0o700);
    const titles = ["CON", "nul.txt", "COM1 ", "..", "a/b\\c", "trailing. . .", "Cafe\u0301 \u00e9t\u00e9", "\u65e5\u672c\u8a9e", "x".repeat(400)];
    for (const title of titles) {
      const chat = await scratch.createConversation(project.id, title, {});
      const name = basename(chat.worktreePath!);
      expect(chat.worktreePath!.slice(0, project.path.length)).toBe(project.path);
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,48}-[0-9a-f-]{36}$/u);
    }
  });

  it("refuses a case-only identity collision without touching the first chat folder", async () => {
    const scratch = new ScratchWorkspace(store, directory);
    const project = await scratch.ensureProject();
    const upper = await scratch.createConversation(project.id, "Same", { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" });
    fs.writeFileSync(join(upper.worktreePath!, "keep.txt"), "keep");
    const lower = scratch.createConversation(project.id, "Same", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    if (fs.existsSync(join(project.path, basename(upper.worktreePath!).toLowerCase()))) await expect(lower).rejects.toThrow(/EEXIST/u);
    else await expect(lower).resolves.toBeTruthy();
    expect(fs.readFileSync(join(upper.worktreePath!, "keep.txt"), "utf8")).toBe("keep");
  });

  it("refuses a symlink already sitting where a chat folder would go", async () => {
    const scratch = new ScratchWorkspace(store, directory);
    const project = await scratch.ensureProject();
    const outside = join(directory, "outside");
    fs.mkdirSync(outside);
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const day = new Date().toISOString().slice(0, 10);
    fs.symlinkSync(outside, join(project.path, `${day}-chat-${id}`), "junction");
    await expect(scratch.createConversation(project.id, "", { id })).rejects.toThrow(/EEXIST/u);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(store.shellSnapshot().conversations).toEqual([]);
  });

  it("refuses a managed folder replaced by a symlink", async () => {
    const scratch = new ScratchWorkspace(store, directory);
    const project = await scratch.ensureProject();
    const outside = join(directory, "outside");
    fs.mkdirSync(outside);
    fs.renameSync(project.path, `${project.path}-old`);
    fs.symlinkSync(outside, project.path, "junction");
    await expect(scratch.createConversation(project.id, "x", {})).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("without Git, refuses a .git file or a dangling .git symlink in a parent folder", async () => {
    vi.mocked(runGitInspection).mockRejectedValue(new GitError("git-unavailable", "missing"));
    const markers = [
      (parent: string) => fs.writeFileSync(join(parent, ".git"), "gitdir: /nowhere\n"),
      (parent: string) => fs.symlinkSync(join(parent, "missing"), join(parent, ".git")),
    ];
    for (const make of markers) {
      const parent = fs.mkdtempSync(join(directory, "parent-"));
      make(parent);
      const data = join(parent, "data");
      fs.mkdirSync(data);
      const nested = new RuntimeStore(join(data, "inertia.sqlite"), data);
      try {
        await expect(new ScratchWorkspace(nested, data).ensureProject()).rejects.toThrow("outside a Git repository");
      } finally {
        nested.close();
      }
    }
    await expect(new ScratchWorkspace(store, directory).ensureProject()).resolves.toMatchObject({ workspaceKind: "scratch" });
  });

  it("recognises a differently cased spelling of the managed folder", async () => {
    const project = await new ScratchWorkspace(store, directory).ensureProject();
    const upper = join(directory, "SCRATCH");
    expect(isWithinScratchRoot(directory, project.path)).toBe(true);
    if (!fs.existsSync(upper)) return;
    expect(isWithinScratchRoot(directory, upper)).toBe(true);
    const chat = await new ScratchWorkspace(store, directory).createConversation(project.id, "Cased", {});
    expect(isWithinScratchRoot(directory, join(upper, basename(chat.worktreePath!).toUpperCase()))).toBe(true);
  });

  it("recognises a spelling that keeps its form, such as a Windows short name, by folder identity", async () => {
    const project = await new ScratchWorkspace(store, directory).ensureProject();
    const chat = await new ScratchWorkspace(store, directory).createConversation(project.id, "Short", {});
    const shortRoot = join(directory, "SCRATC~1");
    const shortChat = join(shortRoot, "2026-1~1");
    hooks.aliases.set(shortRoot, project.path);
    hooks.aliases.set(shortChat, chat.worktreePath!);
    expect(isWithinScratchRoot(directory, shortRoot)).toBe(true);
    expect(isWithinScratchRoot(directory, shortChat)).toBe(true);
    expect(isWithinScratchRoot(directory, directory)).toBe(false);
  });

  it("removes the empty folder it created when the managed folder is swapped for a symlink during creation", async () => {
    const scratch = new ScratchWorkspace(store, directory);
    const project = await scratch.ensureProject();
    const outside = join(directory, "outside");
    fs.mkdirSync(outside);
    hooks.beforeFolderMkdir = () => {
      fs.renameSync(project.path, `${project.path}-old`);
      fs.symlinkSync(outside, project.path, "junction");
    };
    await expect(scratch.createConversation(project.id, "race", {})).rejects.toThrow();
    expect(store.shellSnapshot().conversations).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
