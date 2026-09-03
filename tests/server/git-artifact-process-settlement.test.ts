import { beforeEach, describe, expect, it, vi } from "vitest";

const gitPaths = vi.hoisted(() => ({
  canonicalDirectoryPath: vi.fn(),
  repositoryRoot: vi.fn(),
}));
const gitRunner = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitInspection: vi.fn(),
}));

vi.mock("../../src/server/git/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/paths")>(),
  ...gitPaths,
}));
vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  ...gitRunner,
}));
import {
  captureGitArtifactState,
  compareGitSnapshots,
} from "../../src/server/git/artifacts";
import { GitError } from "../../src/server/git/types";

const snapshotRef =
  "refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const afterSnapshotRef =
  "refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";

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
    gitRunner.runGitInspection.mockImplementation((root, args) => {
      if (args[0] === "status") return sibling;
      if (args.includes(`${snapshotRef}^{commit}`)) {
        return Promise.reject(primaryFailure);
      }
      return defaultInspection(root, args);
    });

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
    gitRunner.runGitInspection.mockImplementation((root, args) => {
      if (args[0] === "status") return Promise.reject(cleanupFailure);
      if (args.includes(`${snapshotRef}^{commit}`)) {
        return Promise.reject(cancellation);
      }
      return defaultInspection(root, args);
    });

    await expect(captureGitArtifactState("/repository", snapshotRef))
      .rejects.toBe(cleanupFailure);
  });

  it("derives the branch from the captured porcelain frame without a full status scan", async () => {
    gitRunner.runGitInspection.mockImplementation((root, args) =>
      args[0] === "status"
        ? Promise.resolve(processResult(
            "# branch.oid abcdef\0# branch.head feature/artifact\0",
          ))
        : defaultInspection(root, args));

    await expect(captureGitArtifactState("/repository", snapshotRef))
      .resolves.toMatchObject({ branch: "feature/artifact" });

    const commands = gitRunner.runGitInspection.mock.calls.map(
      ([, args]) => args[0],
    );
    expect(commands.filter((command) => command === "status")).toHaveLength(1);
    expect(commands).not.toContain("diff");
    expect(commands).not.toContain("remote");
    expect(commands).not.toContain("for-each-ref");
    expect(gitRunner.runGitInspection).toHaveBeenCalledTimes(5);
    expect(gitRunner.runGit).toHaveBeenCalledTimes(1);
  });

  it("keeps comparison ownership until every cancelled Git child settles", async () => {
    const cancellation = new GitError(
      "timeout",
      "Git inspection was cancelled.",
    );
    let releaseSibling!: () => void;
    let comparisonSignal: AbortSignal | undefined;
    const sibling = new Promise<ReturnType<typeof processResult>>((resolve) => {
      releaseSibling = () => resolve(processResult());
    });
    gitRunner.runGitInspection.mockImplementation((root, args, options) => {
      if (args[0] !== "diff") return defaultInspection(root, args);
      comparisonSignal = options.signal;
      if (args.includes("--name-status")) return Promise.reject(cancellation);
      if (args.includes("--numstat")) return sibling;
      return Promise.resolve(processResult());
    });

    let settled = false;
    const comparison = compareGitSnapshots(
      "/repository",
      snapshotRef,
      afterSnapshotRef,
    ).finally(() => { settled = true; });
    await vi.waitFor(() => expect(comparisonSignal?.aborted).toBe(true));
    expect(settled).toBe(false);

    releaseSibling();
    await expect(comparison).rejects.toBe(cancellation);
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
