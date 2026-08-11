import { expect, it, vi } from "vitest";

const gitRunner = vi.hoisted(() => ({
  runGitInspection: vi.fn(),
}));

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  ...gitRunner,
}));

import { inspectGitRemoteRouting } from "../../src/server/git/remote-routing";
import { GitError } from "../../src/server/git/types";

it("prioritizes failed cleanup across parallel remote-routing probes", async () => {
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
  ) => Promise.reject(args.includes("remote")
    ? cancellation
    : cleanupFailure));

  await expect(inspectGitRemoteRouting("/repository", "main"))
    .rejects.toBe(cleanupFailure);
});
