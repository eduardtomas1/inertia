import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const gitRunner = vi.hoisted(() => ({
  runGit: vi.fn(),
}));

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  ...gitRunner,
}));

import { createCheckpoint } from "../../src/server/checkpoints";
import { GitError } from "../../src/server/git/types";

describe("checkpoint Git process settlement", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    roots.splice(0).forEach((root) => {
      rmSync(root, { force: true, recursive: true });
    });
  });

  it("does not continue after an unconfirmed HEAD process-tree cleanup", async () => {
    const repository = mkdtempSync(join(tmpdir(), "inertia-checkpoint-repo-"));
    const indexes = mkdtempSync(join(tmpdir(), "inertia-checkpoint-indexes-"));
    roots.push(repository, indexes);
    const cleanupFailure = new GitError(
      "operation-failed",
      "Git stopped responding, and its process tree could not be confirmed stopped.",
    );
    gitRunner.runGit.mockRejectedValueOnce(cleanupFailure);

    await expect(createCheckpoint(
      repository,
      indexes,
      "11111111-1111-4111-8111-111111111111",
    )).rejects.toBe(cleanupFailure);
    expect(gitRunner.runGit).toHaveBeenCalledTimes(1);
  });
});
