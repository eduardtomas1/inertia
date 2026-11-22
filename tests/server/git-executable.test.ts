import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutableSelection } from "../../src/server/git/executable";

const applePath = { PATH: "/provider-bin:/usr/bin:/bin" };
const selectedGit = "/Applications/Selected Xcode.app/Contents/Developer/usr/bin/git";
function resolver(platform: NodeJS.Platform = "darwin", files: Record<string, string> = {}) {
  const readExecutable = vi.fn(async (path: string) => files[path] ?? null);
  return { selection: new GitExecutableSelection(platform, readExecutable), readExecutable };
}

describe("Apple Git executable selection", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it("uses one bounded caller-owned lookup for concurrent preparation and caches its exact executable", async () => {
    const { selection } = resolver("darwin", {
      "/usr/bin/git": "/usr/bin/git", [selectedGit]: selectedGit,
    });
    const locate = vi.fn(async () => selectedGit + "\n");
    await Promise.all(Array.from({ length: 4 }, () => selection.prepare(applePath, locate)));
    expect(locate).toHaveBeenCalledExactlyOnceWith();
    expect(selection.command(applePath)).toBe(selectedGit);
    expect(selection.command({ PATH: "/custom/bin:/usr/bin" })).toBe("git");
    expect(selection.command({})).toBe("git");
  });

  it("preserves a custom Git before the Apple shim in PATH", async () => {
    const { selection, readExecutable } = resolver("darwin", {
      "/provider-bin/git": "/custom/git", "/usr/bin/git": "/usr/bin/git",
    });
    const locate = vi.fn(async () => selectedGit);
    await selection.prepare(applePath, locate);
    expect(locate).not.toHaveBeenCalled();
    expect(readExecutable).toHaveBeenCalledExactlyOnceWith("/provider-bin/git");
    expect(selection.command(applePath)).toBe("git");
  });

  it("leaves linux executable selection unchanged", async () => {
    const { selection, readExecutable } = resolver("linux");
    const locate = vi.fn(async () => selectedGit);
    await selection.prepare(applePath, locate);
    expect(selection.command(applePath)).toBe("git");
    expect(readExecutable).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
  });

  it.each(["", ":/usr/bin", "./bin:/usr/bin", "/usr/bin:", Array(129).fill("/bin").join(":"), "/" + "x".repeat(16_384)])(
    "retains cwd-sensitive or excessive PATH selection without scanning", async PATH => {
      const { selection, readExecutable } = resolver();
      await selection.prepare({ PATH }, async () => selectedGit);
      expect(readExecutable).not.toHaveBeenCalled();
      expect(selection.command({ PATH })).toBe("git");
    },
  );

  it.each(["relative/git", "/git\n/private-output", "/git\0private-output", "/usr/bin/git", "/missing/git"])(
    "does not replace Git with an invalid or unavailable lookup result", async located => {
      const { selection } = resolver("darwin", { "/usr/bin/git": "/usr/bin/git" });
      await selection.prepare(applePath, async () => located);
      expect(selection.command(applePath)).toBe("git");
    },
  );

  it("leaves cleanup failure classification to the owned caller and does not retry a failed lookup", async () => {
    const { selection } = resolver("darwin", { "/usr/bin/git": "/usr/bin/git" });
    const failure = new Error("unconfirmed cleanup");
    const locate = vi.fn(async () => { throw failure; });
    await expect(selection.prepare(applePath, locate)).rejects.toBe(failure);
    await expect(selection.prepare(applePath, locate)).rejects.toBe(failure);
    expect(locate).toHaveBeenCalledOnce();
    expect(selection.command(applePath)).toBe("git");
  });

  it("ends a stalled PATH scan and never launches a helper from its late result", async () => {
    vi.useFakeTimers();
    let finishRead!: (path: string) => void;
    const selection = new GitExecutableSelection("darwin", () => new Promise(resolve => { finishRead = resolve; }));
    const locate = vi.fn(async () => selectedGit);
    const preparing = selection.prepare(applePath, locate);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(preparing).resolves.toBeUndefined();
    finishRead("/usr/bin/git");
    await vi.advanceTimersByTimeAsync(0);
    expect(locate).not.toHaveBeenCalled();
    expect(selection.command(applePath)).toBe("git");
  });

  it("rejects an overdue filesystem result before the delayed timer callback runs", async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    let finishRead!: (path: string) => void;
    const read = vi.fn<(path: string) => Promise<string | null>>()
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }))
      .mockResolvedValue(selectedGit);
    const selection = new GitExecutableSelection("darwin", read);
    const locate = vi.fn(async () => selectedGit);
    const preparing = selection.prepare(applePath, locate);
    // Simulate a busy event loop: the clock has advanced, but the overdue
    // timeout callback has not run before this promise continuation.
    elapsed = 1_001;
    vi.setSystemTime(Date.now() + elapsed);
    finishRead("/usr/bin/git");
    await preparing;
    expect(locate).not.toHaveBeenCalled();
    expect(selection.command(applePath)).toBe("git");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the filesystem budget across entries and cannot promote late validation", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (path: string) => {
      await new Promise(resolve => setTimeout(resolve, 400));
      return path === "/provider-bin/git" ? null : path;
    });
    const selection = new GitExecutableSelection("darwin", read);
    const locate = vi.fn(async () => selectedGit);
    const preparing = selection.prepare(applePath, locate);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(preparing).resolves.toBeUndefined();
    expect(locate).toHaveBeenCalledOnce();
    expect(selection.command(applePath)).toBe("git");
    await vi.advanceTimersByTimeAsync(400);
    expect(selection.command(applePath)).toBe("git");
  });

  it("waits for owned helper cleanup even when it outlasts the filesystem budget", async () => {
    vi.useFakeTimers();
    const { selection } = resolver("darwin", { "/usr/bin/git": "/usr/bin/git", [selectedGit]: selectedGit });
    let rejectHelper!: (error: Error) => void;
    const cleanupFailure = new Error("owned helper cleanup unconfirmed");
    const preparing = selection.prepare(applePath, () => new Promise((_resolve, reject) => { rejectHelper = reject; }))
      .catch((error: unknown) => error);
    let finished = false;
    void preparing.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finished).toBe(false);
    rejectHelper(cleanupFailure);
    await expect(preparing).resolves.toBe(cleanupFailure);
  });
});

describe("Windows Git executable selection", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const installed = "C:\\Program Files\\Git\\cmd\\git.exe";

  it("selects Git from fully qualified PATH entries only, in libuv extension order", async () => {
    const Path = ";.;bin;\\rooted;\"C:\\Program Files\\Git\\cmd\";C:\\Tools;\\\\server\\share\\bin";
    const { selection, readExecutable } = resolver("win32", { [installed]: installed });
    const locate = vi.fn(async () => selectedGit);
    await selection.prepare({ Path }, locate);
    expect(readExecutable.mock.calls.map(([path]) => path)).toEqual([
      "C:\\Program Files\\Git\\cmd\\git.com",
      installed,
    ]);
    expect(locate).not.toHaveBeenCalled();
    expect(selection.command({ PATH: Path })).toBe(installed);
    expect(selection.command({ Path })).toBe(installed);
    expect(selection.command({ PATH: "C:\\Other" })).toBe("git");
    expect(selection.command({})).toBe("git");
  });

  it("checks later fully qualified entries, including UNC directories, when earlier ones lack Git", async () => {
    const unc = "\\\\server\\share\\bin\\git.exe";
    const PATH = "C:\\Tools;\\\\server\\share\\bin";
    const { selection, readExecutable } = resolver("win32", { [unc]: unc });
    await selection.prepare({ PATH }, async () => selectedGit);
    expect(readExecutable).toHaveBeenCalledTimes(4);
    expect(selection.command({ PATH })).toBe(unc);
  });

  it.each(["", ";.;bin;\\rooted", "C:\\Tools", Array(129).fill("C:\\Tools").join(";"), "C:\\" + "x".repeat(16_384)])(
    "keeps the guarded bare command when no fully qualified Git is selected", async PATH => {
      const { selection } = resolver("win32");
      await selection.prepare({ PATH }, async () => selectedGit);
      expect(selection.command({ PATH })).toBe("git");
    },
  );

  it("keeps the PATH-entry Git path instead of a resolved link target", async () => {
    const links = "C:\\Users\\Dev\\AppData\\Local\\Microsoft\\WinGet\\Links";
    const PATH = `${links};C:\\Tools`;
    const { selection } = resolver("win32", {
      [`${links}\\git.exe`]: "C:\\Users\\Dev\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Git.Git_2.47\\cmd\\git.exe",
    });
    await selection.prepare({ PATH }, async () => selectedGit);
    expect(selection.command({ PATH })).toBe(`${links}\\git.exe`);
  });

  it("ends a stalled Windows PATH scan within the shared filesystem budget", async () => {
    vi.useFakeTimers();
    const selection = new GitExecutableSelection("win32", () => new Promise(() => {}));
    const PATH = "C:\\Tools";
    const preparing = selection.prepare({ PATH }, async () => selectedGit);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(preparing).resolves.toBeUndefined();
    expect(selection.command({ PATH })).toBe("git");
  });
});

describe.runIf(process.platform === "win32")("Windows Git executable selection on the filesystem", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function installation(root: string, version: string): string {
    const directory = join(root, "apps", "git", version, "cmd");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "git.exe"), "");
    return join(root, "apps", "git", version);
  }

  it("keeps a junctioned installation path working after the versioned folder is replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-git-junction-"));
    roots.push(root);
    const current = join(root, "apps", "git", "current");
    symlinkSync(installation(root, "2.46.0"), current, "junction");
    const PATH = join(current, "cmd");
    const selection = new GitExecutableSelection("win32");
    await selection.prepare({ PATH }, async () => "");
    expect(selection.command({ PATH })).toBe(join(current, "cmd", "git.exe"));

    rmSync(current);
    rmSync(join(root, "apps", "git", "2.46.0"), { recursive: true });
    symlinkSync(installation(root, "2.47.0"), current, "junction");
    expect(selection.command({ PATH })).toBe(join(current, "cmd", "git.exe"));
    expect(statSync(selection.command({ PATH })).isFile()).toBe(true);
  });

  it("keeps a symlinked Git path and skips a link to a directory", async (context) => {
    const root = mkdtempSync(join(tmpdir(), "inertia-git-symlink-"));
    roots.push(root);
    const links = join(root, "Links");
    const directoryLinks = join(root, "DirectoryLinks");
    mkdirSync(links);
    mkdirSync(directoryLinks);
    const target = join(installation(root, "2.47.0"), "cmd");
    try {
      symlinkSync(join(target, "git.exe"), join(links, "git.exe"), "file");
      symlinkSync(target, join(directoryLinks, "git.exe"), "dir");
    } catch {
      context.skip();
    }
    const PATH = `${directoryLinks};${links}`;
    const selection = new GitExecutableSelection("win32");
    await selection.prepare({ PATH }, async () => "");
    expect(selection.command({ PATH })).toBe(join(links, "git.exe"));
  });
});
