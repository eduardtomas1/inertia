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
