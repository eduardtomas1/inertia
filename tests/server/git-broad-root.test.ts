import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fixture.home || actual.homedir() };
});
vi.mock("../../src/server/git/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/git/runner")>();
  return { ...actual, runGitInspection: vi.fn() };
});
import { repositoryRoot } from "../../src/server/git/paths";
import { runGitInspection } from "../../src/server/git/runner";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { discoverWorkspaceGitRepositories } from "../../src/server/workspace-git";

const roots: string[] = [];
function home(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-broad-git-root-")));
  roots.push(root);
  fixture.home = root;
  mkdirSync(join(root, ".git"));
  return root;
}
afterEach(() => {
  fixture.home = "";
  vi.mocked(runGitInspection).mockReset();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Git status and identity at broad roots", () => {
  it("avoids Git processes for root/home status and identity requests", async () => {
    const root = home();
    for (const path of [parse(root).root, root]) {
      await expect(repositoryRoot(path)).rejects.toMatchObject({ code: "not-repository" });
      await expect(inspectProjectIdentity(path)).resolves.toMatchObject({ repositoryRoot: null, repositoryIdentity: null });
    }
    expect(runGitInspection).not.toHaveBeenCalled();
  });

  it("does not inspect a home-root repository inherited by a non-project subfolder", async () => {
    const root = home();
    const child = join(root, "Downloads");
    mkdirSync(child);
    vi.mocked(runGitInspection).mockResolvedValue({ stdout: Buffer.from(root), stderr: Buffer.alloc(0), truncated: false });
    await expect(repositoryRoot(child)).rejects.toMatchObject({ code: "not-repository" });
    await expect(inspectProjectIdentity(child)).resolves.toMatchObject({ repositoryIdentity: null });
    expect(runGitInspection).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runGitInspection).mock.calls.every((call) => call[1].join(" ") === "rev-parse --show-toplevel")).toBe(true);
  });

  it("recognizes a canonical home folder when HOME names a symlink", async () => {
    const root = home();
    const target = join(root, "actual-home");
    const alias = join(root, "home-alias");
    mkdirSync(join(target, ".git"), { recursive: true });
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    fixture.home = alias;
    const canonical = realpathSync.native(target);
    await expect(repositoryRoot(canonical)).rejects.toMatchObject({ code: "not-repository" });
    await expect(inspectProjectIdentity(canonical)).resolves.toMatchObject({ repositoryIdentity: null });
    await expect(discoverWorkspaceGitRepositories(canonical)).resolves.toMatchObject({
      scannedDirectories: 0, repositories: [], truncated: true,
    });
    expect(runGitInspection).not.toHaveBeenCalled();
  });

  it("still resolves a real project nested beneath a home folder", async () => {
    const root = home();
    const child = join(root, "Projects", "actual-project");
    mkdirSync(child, { recursive: true });
    vi.mocked(runGitInspection).mockResolvedValue({ stdout: Buffer.from(child), stderr: Buffer.alloc(0), truncated: false });
    await expect(repositoryRoot(child)).resolves.toBe(child);
  });
});
