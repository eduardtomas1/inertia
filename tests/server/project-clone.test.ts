import {
  mkdtemp,
  rm,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneProject } from "../../src/server/project-clone";
import { runGit } from "../../src/server/git/runner";
const directories: string[] = [];
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

vi.mock("../../src/server/git/runner", () => ({ runGit: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const source = {
  url: "https://github.com/example/project.git",
  directoryName: "project",
};

describe("project cloning", () => {
  it("reserves a new directory, bounds Git, and returns its canonical path", async () => {
    const parent = await realpath(await temporaryDirectory("inertia-clone-"));
    vi.mocked(runGit).mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      truncated: false,
    });
    const controller = new AbortController();
    await expect(cloneProject(parent, source, controller.signal)).resolves.toBe(
      join(parent, "project"),
    );
    expect(runGit).toHaveBeenCalledWith(
      parent,
      expect.arrayContaining([
        "clone",
        "--no-recurse-submodules",
        "--template=",
        "--",
        source.url,
        join(parent, "project"),
      ]),
      expect.objectContaining({
        timeoutMs: 120_000,
        maxOutputBytes: 262144,
        signal: controller.signal,
      }),
    );
  });
  it("never overwrites an existing destination or a symlink", async () => {
    const parent = await temporaryDirectory("inertia-clone-existing-");
    await mkdir(join(parent, "project"));
    await writeFile(join(parent, "project", "keep.txt"), "precious");
    await expect(cloneProject(parent, source)).rejects.toThrow(
      "Existing folders are never overwritten",
    );
    await symlink(
      join(parent, "project"),
      join(parent, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      cloneProject(parent, { ...source, directoryName: "linked" }),
    ).rejects.toThrow("Existing folders");
    expect(await readFile(join(parent, "project", "keep.txt"), "utf8")).toBe(
      "precious",
    );
    expect(runGit).not.toHaveBeenCalled();
  });
  it.each(["../outside", "C:\\outside", "CON", "repo."])(
    "rejects unsafe destination %s before launching Git",
    async (directoryName) => {
      await expect(
        cloneProject("unused", { ...source, directoryName }),
      ).rejects.toThrow("valid repository URL");
      expect(runGit).not.toHaveBeenCalled();
    },
  );
  it("rejects a destination replaced while Git was running", async () => {
    const parent = await temporaryDirectory("inertia-clone-swap-");
    vi.mocked(runGit).mockImplementation(async () => {
      await rename(join(parent, "project"), join(parent, "moved"));
      await mkdir(join(parent, "project"));
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        truncated: false,
      };
    });
    await expect(cloneProject(parent, source)).rejects.toThrow(
      "destination changed",
    );
  });
  it("preserves files on failure and propagates cancellation without registration", async () => {
    const parent = await temporaryDirectory("inertia-clone-failed-");
    vi.mocked(runGit).mockRejectedValue(new Error("cancelled"));
    await expect(cloneProject(parent, source)).rejects.toThrow("cancelled");
    await expect(cloneProject(parent, source)).rejects.toThrow(
      "Existing folders",
    );
  });
});
