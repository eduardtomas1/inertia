import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutableSelection } from "../../src/server/git/executable";

const applePath = { PATH: "/provider-bin:/usr/bin:/bin" };
const selectedGit = "/Applications/Selected Xcode.app/Contents/Developer/usr/bin/git";
function resolver(platform: NodeJS.Platform = "darwin", files: Record<string, string> = {}) {
  const readExecutable = vi.fn(async (path: string) => files[path] ?? null);
  return { selection: new GitExecutableSelection(platform, readExecutable), readExecutable };
}

describe("Apple Git executable selection", () => {
  afterEach(() => { vi.useRealTimers(); });
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

  it.each(["linux", "win32"] as const)("leaves %s executable selection unchanged", async platform => {
    const { selection, readExecutable } = resolver(platform);
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
