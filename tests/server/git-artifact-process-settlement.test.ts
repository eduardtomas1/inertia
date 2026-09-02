import { beforeEach, describe, expect, it, vi } from "vitest";

const gitPaths = vi.hoisted(() => ({
  canonicalDirectoryPath: vi.fn(),
  repositoryRoot: vi.fn(),
}));
const gitRunner = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitInspection: vi.fn(),
}));
const gitStatus = vi.hoisted(() => ({
  getRepositoryStatus: vi.fn(),
}));

vi.mock("../../src/server/git/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/paths")>(),
  ...gitPaths,
}));
vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  ...gitRunner,
}));
vi.mock("../../src/server/git/status", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/status")>(),
  ...gitStatus,
}));

import { captureGitArtifactState } from "../../src/server/git/artifacts";
import { GitError } from "../../src/server/git/types";

const snapshotRef =
  "refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

const processResult = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  truncated: false,
});

function defaultInspection(
  _root: string,
  args: readonly string[],
): Promise<ReturnType<typeof processResult>> {
  const text = args.join(" ");
  if (text.includes("--git-common-dir")) {
    return Promise.resolve(processResult("/repository/.git\n"));
  }
  if (text.includes("--git-dir")) {
    return Promise.resolve(processResult("/repository/.git\n"));
  }
  if (text.includes(`${snapshotRef}^{commit}`)) {
    return Promise.resolve(processResult("a".repeat(40)));
  }
  if (text.includes("--verify HEAD")) {
    return Promise.resolve(processResult("b".repeat(40)));
  }
  return Promise.resolve(processResult("# branch.head main\0"));
}

describe("Git artifact process settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitPaths.repositoryRoot.mockResolvedValue("/repository");
    gitPaths.canonicalDirectoryPath.mockImplementation(
      async (path: string) => path,
    );
    gitStatus.getRepositoryStatus.mockResolvedValue({ branch: "main" });
    gitRunner.runGit.mockResolvedValue(processResult("c".repeat(40)));
    gitRunner.runGitInspection.mockImplementation(defaultInspection);
  });

  it("waits for every sibling cleanup after a mandatory probe fails", async () => {
    const primaryFailure = new GitError(
      "operation-failed",
      "The repository status failed.",
    );
    let settleSibling!: () => void;
    const sibling = new Promise<ReturnType<typeof processResult>>((resolve) => {
      settleSibling = () => resolve(processResult("# branch.head main\0"));
    });
    gitStatus.getRepositoryStatus.mockRejectedValueOnce(primaryFailure);
    gitRunner.runGitInspection.mockImplementation((root, args) =>
      args[0] === "status" ? sibling : defaultInspection(root, args));

    let settled = false;
    const capture = captureGitArtifactState("/repository", snapshotRef)
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    settleSibling();
    await expect(capture).rejects.toBe(primaryFailure);
  });

  it("prioritizes failed process-tree cleanup over sibling cancellation", async () => {
    const cancellation = new GitError(
      "timeout",
      "Git inspection was cancelled.",
    );
    const cleanupFailure = new GitError(
      "operation-failed",
      "Git stopped responding, and its process tree could not be confirmed stopped.",
    );
    gitStatus.getRepositoryStatus.mockRejectedValueOnce(cancellation);
    gitRunner.runGitInspection.mockImplementation((root, args) =>
      args[0] === "status"
        ? Promise.reject(cleanupFailure)
        : defaultInspection(root, args));

    await expect(captureGitArtifactState("/repository", snapshotRef))
      .rejects.toBe(cleanupFailure);
  });

  it("does not swallow an optional HEAD timeout", async () => {
    const timeout = new GitError(
      "timeout",
      "Git took too long to complete the operation.",
    );
    gitRunner.runGitInspection.mockImplementation((root, args) =>
      args.includes("HEAD")
        ? Promise.reject(timeout)
        : defaultInspection(root, args));

    await expect(captureGitArtifactState("/repository", snapshotRef))
      .rejects.toBe(timeout);
  });

  it("does not swallow an optional index-tree timeout", async () => {
    const timeout = new GitError(
      "timeout",
      "Git took too long to complete the operation.",
    );
    gitRunner.runGit.mockRejectedValueOnce(timeout);

    await expect(captureGitArtifactState("/repository", snapshotRef))
      .rejects.toBe(timeout);
  });

  it("does not retry compatibility syntax after timeout", async () => {
    const timeout = new GitError(
      "timeout",
      "Git took too long to complete the operation.",
    );
    gitRunner.runGitInspection.mockImplementation((root, args) => {
      if (args.includes("--path-format=absolute")
        && args.includes("--git-common-dir")) {
        return Promise.reject(timeout);
      }
      return defaultInspection(root, args);
    });

    await expect(captureGitArtifactState("/repository", snapshotRef))
      .rejects.toBe(timeout);
    expect(gitRunner.runGitInspection.mock.calls.some(([, args]) =>
      args.includes("--git-common-dir")
      && !args.includes("--path-format=absolute"))).toBe(false);
  });

  it("does not retry compatibility syntax after failed cleanup", async () => {
    const cleanupFailure = new GitError(
      "operation-failed",
      "Git stopped responding, and its process tree could not be confirmed stopped.",
    );
    gitRunner.runGitInspection.mockImplementation((root, args) => {
      if (args.includes("--path-format=absolute")
        && args.includes("--git-common-dir")) {
        return Promise.reject(cleanupFailure);
      }
      return defaultInspection(root, args);
    });

    await expect(captureGitArtifactState("/repository", snapshotRef))
      .rejects.toBe(cleanupFailure);
    expect(gitRunner.runGitInspection.mock.calls.some(([, args]) =>
      args.includes("--git-common-dir")
      && !args.includes("--path-format=absolute"))).toBe(false);
  });
});
