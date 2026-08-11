import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, expect, it, vi } from "vitest";

const gitRunner = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitInspection: vi.fn(),
}));

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  ...gitRunner,
}));

import { repositoryMetadataMarkerIdentity } from "../../src/server/git/paths";
import { GitError } from "../../src/server/git/types";

beforeEach(() => {
  vi.clearAllMocks();
});

it("settles both metadata probes before rejecting one malformed marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-git-marker-settlement-"));
  let rejectCommonDirectory!: (error: Error) => void;
  let commonDirectoryCalls = 0;
  gitRunner.runGitInspection.mockImplementation((
    _cwd: string,
    args: readonly string[],
  ) => {
    if (args.includes("--git-dir")) {
      return Promise.reject(new Error("git-dir marker is malformed"));
    }
    commonDirectoryCalls += 1;
    if (commonDirectoryCalls === 1) {
      return new Promise((_resolve, reject) => {
        rejectCommonDirectory = reject;
      });
    }
    return Promise.reject(new Error("common-dir marker is malformed"));
  });

  let settled = false;
  const outcome = repositoryMetadataMarkerIdentity(root).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );

  try {
    await vi.waitFor(() => {
      expect(commonDirectoryCalls).toBe(1);
    });
    expect(settled).toBe(false);

    rejectCommonDirectory(new Error("first common-dir probe finished"));
    await expect(outcome).resolves.toMatchObject({
      message: "git-dir marker is malformed",
    });
    expect(commonDirectoryCalls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves a failed metadata-probe cleanup after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-git-marker-cancel-"));
  const controller = new AbortController();
  const cleanupFailure = new GitError(
    "operation-failed",
    "Git stopped responding, and its process tree could not be confirmed stopped.",
  );
  gitRunner.runGitInspection.mockImplementation(() => {
    controller.abort();
    return Promise.reject(cleanupFailure);
  });

  try {
    await expect(repositoryMetadataMarkerIdentity(root, {
      signal: controller.signal,
    })).rejects.toBe(cleanupFailure);
    expect(gitRunner.runGitInspection).toHaveBeenCalledTimes(2);
    expect(gitRunner.runGitInspection.mock.calls.every(([, args]) => (
      (args as readonly string[]).includes("--path-format=absolute")
    ))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("prioritizes failed process-tree cleanup across metadata probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "inertia-git-marker-priority-"));
  const cancellation = new GitError(
    "timeout",
    "Git inspection was cancelled.",
  );
  const cleanupFailure = new GitError(
    "operation-failed",
    "Git stopped responding, and its process tree could not be confirmed stopped.",
  );
  gitRunner.runGitInspection.mockImplementation((
    _cwd: string,
    args: readonly string[],
  ) => Promise.reject(args.includes("--git-dir")
    ? cancellation
    : cleanupFailure));

  try {
    await expect(repositoryMetadataMarkerIdentity(root))
      .rejects.toBe(cleanupFailure);
    expect(gitRunner.runGitInspection).toHaveBeenCalledTimes(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
