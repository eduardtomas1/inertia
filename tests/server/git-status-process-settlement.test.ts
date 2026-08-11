import { beforeEach, describe, expect, it, vi } from "vitest";

const gitPaths = vi.hoisted(() => ({
  repositoryRoot: vi.fn(),
}));
const gitRemoteRouting = vi.hoisted(() => ({
  inspectGitRemoteRouting: vi.fn(),
}));
const gitRunner = vi.hoisted(() => ({
  runGitInspection: vi.fn(),
}));

vi.mock("../../src/server/git/paths", () => gitPaths);
vi.mock("../../src/server/git/remote-routing", () => gitRemoteRouting);
vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  ...gitRunner,
}));

import {
  getRepositoryStatus,
  hasHead,
} from "../../src/server/git/status";
import { GitError } from "../../src/server/git/types";

const processResult = (stdout = Buffer.alloc(0)) => ({
  stdout,
  stderr: Buffer.alloc(0),
  truncated: false,
});

describe("Git status process settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps an ordinary missing-HEAD response for an active inspection", async () => {
    gitRunner.runGitInspection.mockRejectedValueOnce(new GitError(
      "operation-failed",
      "Unable to inspect the current commit.",
    ));

    await expect(hasHead("/repository")).resolves.toBe(false);
  });

  it("preserves failed HEAD cleanup after the inspection is cancelled", async () => {
    const controller = new AbortController();
    const cleanupFailure = new GitError(
      "operation-failed",
      "Git stopped responding, and its process tree could not be confirmed stopped.",
    );
    gitRunner.runGitInspection.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(cleanupFailure);
    });

    await expect(hasHead("/repository", { signal: controller.signal }))
      .rejects.toBe(cleanupFailure);
  });

  it("prioritizes failed cleanup across parallel status probes", async () => {
    const cancellation = new GitError(
      "timeout",
      "Git inspection was cancelled.",
    );
    const cleanupFailure = new GitError(
      "operation-failed",
      "Git stopped responding, and its process tree could not be confirmed stopped.",
    );
    gitPaths.repositoryRoot.mockResolvedValueOnce("/repository");
    gitRunner.runGitInspection
      .mockResolvedValueOnce(processResult(Buffer.from(
        "# branch.head main\0",
      )))
      .mockResolvedValueOnce(processResult(Buffer.from("head\n")))
      .mockRejectedValueOnce(cancellation);
    gitRemoteRouting.inspectGitRemoteRouting.mockRejectedValueOnce(
      cleanupFailure,
    );

    await expect(getRepositoryStatus("/repository"))
      .rejects.toBe(cleanupFailure);
  });
});
