import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("does not spawn ref cleanup after an unconfirmed update-ref process-tree cleanup", async () => {
    const repository = mkdtempSync(join(tmpdir(), "inertia-checkpoint-repo-"));
    const indexes = mkdtempSync(join(tmpdir(), "inertia-checkpoint-indexes-"));
    roots.push(repository, indexes);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(repository, "file.txt"), "one\n");
    git("add", "file.txt");
    git("commit", "-q", "-m", "initial");
    const actual = await vi.importActual<typeof import("../../src/server/git/runner")>("../../src/server/git/runner");
    const cleanupFailure = new GitError(
      "operation-failed",
      "Git stopped responding, and its process tree could not be confirmed stopped.",
    );
    const updateRefCalls: string[][] = [];
    gitRunner.runGit.mockImplementation((...parameters: Parameters<typeof actual.runGit>) => {
      const args = parameters[1] as string[];
      if (args.includes("update-ref")) {
        updateRefCalls.push(args);
        return Promise.reject(cleanupFailure);
      }
      return actual.runGit(...parameters);
    });

    await expect(createCheckpoint(
      repository,
      indexes,
      "11111111-1111-4111-8111-111111111111",
    )).rejects.toBe(cleanupFailure);
    expect(updateRefCalls).toHaveLength(1);
  });
});
