import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fixture.home || actual.homedir() };
});
vi.mock("../../src/server/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/git")>();
  return { ...actual, getRepositoryStatus: vi.fn() };
});
vi.mock("../../src/server/git/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/git/paths")>();
  return { ...actual, repositoryMetadataMarkerIdentity: vi.fn() };
});

import { getRepositoryStatus, GitError, type GitRepositoryStatus } from "../../src/server/git";
import { repositoryMetadataMarkerIdentity } from "../../src/server/git/paths";
import { GIT_PROCESS_TREE_TERMINATION_FAILURE } from "../../src/server/git/types";
import { discoverWorkspaceGitRepositories } from "../../src/server/workspace-git";
import {
  isBroadWorkspaceRoot,
  readDiscoveryEntries,
  WORKSPACE_GIT_DISCOVERY_BOUNDS as bounds,
} from "../../src/server/workspace-git-discovery-policy";

const roots: string[] = [];
function workspace(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-discovery-bounds-")));
  roots.push(root);
  vi.mocked(repositoryMetadataMarkerIdentity).mockResolvedValue("validated-test-marker");
  vi.mocked(getRepositoryStatus).mockImplementation(async (path) => status(path));
  return root;
}
function status(root: string): GitRepositoryStatus {
  return {
    root, branch: "main", detached: false, upstream: null, ahead: 0, behind: 0,
    hasRemote: false, files: [], insertions: 0, deletions: 0, clean: true, truncated: false,
    pullRequest: { available: false, remoteName: null, forge: null, unavailableReason: "no-remotes" },
  };
}
function repository(root: string, path: string): void {
  mkdirSync(join(root, path, ".git"), { recursive: true });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(getRepositoryStatus).mockReset();
  vi.mocked(repositoryMetadataMarkerIdentity).mockReset();
  fixture.home = "";
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("bounded automatic Git discovery", () => {
  it.each([
    ["linux", "/", "/home/ada", true],
    ["linux", "/home", "/home/ada", true],
    ["linux", "/home/ada", "/home/ada", true],
    ["linux", "/home/ada/project", "/home/ada", false],
    ["linux", "/home/ada-other", "/home/ada", false],
    ["darwin", "/Users", "/Users/ada", true],
    ["darwin", "/Users/ada/project", "/Users/ada", false],
    ["win32", "C:\\", "C:\\Users\\Ada", true],
    ["win32", "D:\\", "C:\\Users\\Ada", true],
    ["win32", "c:\\users\\ADA", "C:\\Users\\Ada", true],
    ["win32", "C:\\Users\\Ada\\Project", "C:\\Users\\Ada", false],
    ["win32", "\\\\server\\share\\", "C:\\Users\\Ada", true],
    ["win32", "\\\\server\\share\\project", "C:\\Users\\Ada", false],
  ] as const)("classifies %s %s without crossing project boundaries", (platform, path, home, broad) => {
    expect(isBroadWorkspaceRoot(path, home, platform)).toBe(broad);
  });

  it("does not enumerate or invoke Git at filesystem and home roots, even with a Git marker", async () => {
    const root = workspace();
    fixture.home = root;
    repository(root, ".");
    repository(root, "projects/nested");
    for (const path of [parse(root).root, root]) {
      const snapshot = await discoverWorkspaceGitRepositories(path);
      expect(snapshot).toMatchObject({ scannedDirectories: 0, repositories: [], partial: true, truncated: true });
      expect(snapshot.issues[0]?.message).toContain("Choose a project folder");
    }
    expect(getRepositoryStatus).not.toHaveBeenCalled();
    expect(repositoryMetadataMarkerIdentity).not.toHaveBeenCalled();
  });

  it("keeps two-level module repositories but does not recurse through a non-project container", async () => {
    const root = workspace();
    repository(root, "modules/core");
    repository(root, "unrelated/large/folder/deep-repo");
    const snapshot = await discoverWorkspaceGitRepositories(root, { maxDepth: 100 });
    expect(snapshot.repositories.map((item) => item.repositoryPath)).toEqual(["modules/core"]);
    expect(snapshot.truncated).toBe(true);
    expect(getRepositoryStatus).toHaveBeenCalledOnce();
  });

  it("limits directory metadata work even when requested limits are excessive", async () => {
    const root = workspace();
    for (let index = 0; index < 300; index += 1) mkdirSync(join(root, `folder-${index}`));
    const snapshot = await discoverWorkspaceGitRepositories(root, { maxDirectories: 1_000_000 });
    expect(snapshot.scannedDirectories).toBe(bounds.maxDirectories);
    expect(snapshot.truncated).toBe(true);
    expect(getRepositoryStatus).not.toHaveBeenCalled();
  });

  it("streams only a bounded prefix of a wide directory, including ordinary files", async () => {
    const root = workspace();
    for (let index = 0; index <= bounds.maxEntries; index += 1) {
      writeFileSync(join(root, `file-${index}`), "");
    }
    const batch = await readDiscoveryEntries(root, bounds.maxEntries);
    expect(batch.entries).toHaveLength(bounds.maxEntries);
    expect(batch.truncated).toBe(true);
    const snapshot = await discoverWorkspaceGitRepositories(root);
    expect(snapshot).toMatchObject({ scannedDirectories: 1, truncated: true, repositories: [] });
    expect(getRepositoryStatus).not.toHaveBeenCalled();
  });

  it("clamps legacy repository settings without losing explicit small limits", async () => {
    const root = workspace();
    for (let index = 0; index < 40; index += 1) repository(root, `repo-${index.toString().padStart(2, "0")}`);
    const snapshot = await discoverWorkspaceGitRepositories(root, { maxRepositories: 1_024 });
    expect(snapshot.repositoryLimit).toBe(bounds.maxRepositories);
    expect(snapshot.repositories).toHaveLength(bounds.maxRepositories);
    expect(snapshot.discoveredRepositories).toBe(40);
    expect(snapshot.truncated).toBe(true);
    const limited = await discoverWorkspaceGitRepositories(root, { maxRepositories: 1 });
    expect(limited.repositories).toHaveLength(1);
  });

  it("admits at most four simultaneous inspections even with excessive requested concurrency", async () => {
    const root = workspace();
    for (let index = 0; index < 8; index += 1) repository(root, `repo-${index}`);
    const releases: Array<() => void> = [];
    let started!: () => void;
    const firstBatch = new Promise<void>((resolve) => { started = resolve; });
    let active = 0;
    let peak = 0;
    vi.mocked(getRepositoryStatus).mockImplementation(async (path) => {
      active += 1;
      peak = Math.max(peak, active);
      if (releases.length < 4) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          if (releases.length === 4) started();
        });
      }
      active -= 1;
      return status(path);
    });
    const pending = discoverWorkspaceGitRepositories(root, { statusConcurrency: 1_000 });
    await firstBatch;
    expect(getRepositoryStatus).toHaveBeenCalledTimes(4);
    releases.forEach((release) => release());
    expect((await pending).repositories).toHaveLength(8);
    expect(peak).toBe(4);
  });

  it("stops starting repository inspections after admission expires and keeps collected results", async () => {
    const root = workspace();
    repository(root, "a-first");
    repository(root, "b-skipped");
    let now = Date.now();
    const startedAt = now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(getRepositoryStatus).mockImplementation(async (path, options) => {
      expect(options?.deadlineAt).toBe(startedAt + bounds.repositoryStatusMs);
      now += bounds.statusAdmissionMs;
      return status(path);
    });
    const snapshot = await discoverWorkspaceGitRepositories(root, { statusConcurrency: 1 });
    expect(getRepositoryStatus).toHaveBeenCalledOnce();
    expect(snapshot.repositories.map((item) => item.repositoryPath)).toEqual(["a-first"]);
    expect(snapshot).toMatchObject({ partial: true, truncated: true, discoveredRepositories: 2 });
  });

  it("retains owned Git metadata inspection until late cleanup failure settles", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const root = workspace();
    repository(root, ".");
    let started!: () => void;
    const metadataStarted = new Promise<void>((resolve) => { started = resolve; });
    let fail!: (error: Error) => void;
    vi.mocked(repositoryMetadataMarkerIdentity).mockImplementationOnce(async () => {
      started();
      return await new Promise<string>((_resolve, reject) => { fail = reject; });
    });
    let settled = false;
    const pending = discoverWorkspaceGitRepositories(root).finally(() => { settled = true; });
    const rejection = expect(pending).rejects.toThrow(GIT_PROCESS_TREE_TERMINATION_FAILURE);
    await metadataStarted;
    await vi.advanceTimersByTimeAsync(bounds.repositoryStatusMs + 1);
    expect(settled).toBe(false);
    fail(new GitError("operation-failed", GIT_PROCESS_TREE_TERMINATION_FAILURE));
    await rejection;
    expect(getRepositoryStatus).not.toHaveBeenCalled();
  });

  it("settles admitted siblings and preserves their cleanup failure before rejecting an aggregate timeout", async () => {
    const root = workspace();
    repository(root, "a-timeout");
    repository(root, "b-cleanup");
    repository(root, "c-never-started");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const deadlineAt = now + 30_000;
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const rejections: Array<(error: Error) => void> = [];
    vi.mocked(repositoryMetadataMarkerIdentity).mockImplementation(async () => {
      return await new Promise<string>((_resolve, reject) => {
        rejections.push(reject);
        if (rejections.length === 2) started();
      });
    });
    let settled = false;
    const pending = discoverWorkspaceGitRepositories(root, { deadlineAt, statusConcurrency: 2 })
      .finally(() => { settled = true; });
    const rejection = expect(pending).rejects.toThrow(GIT_PROCESS_TREE_TERMINATION_FAILURE);
    await admitted;
    now = deadlineAt;
    rejections[0]!(new GitError("timeout", "Git took too long."));
    // Allow the first worker to settle without releasing its owned sibling.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(repositoryMetadataMarkerIdentity).toHaveBeenCalledTimes(2);
    rejections[1]!(new GitError("operation-failed", GIT_PROCESS_TREE_TERMINATION_FAILURE));
    await rejection;
    expect(getRepositoryStatus).not.toHaveBeenCalled();
  });
});
