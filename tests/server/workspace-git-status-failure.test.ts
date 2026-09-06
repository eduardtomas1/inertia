import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/git")>();
  return { ...actual, getRepositoryStatus: vi.fn(actual.getRepositoryStatus) };
});

import { getRepositoryStatus, GitError } from "../../src/server/git";
import { GIT_PROCESS_TREE_TERMINATION_FAILURE } from "../../src/server/git/types";
import { discoverWorkspaceGitRepositories } from "../../src/server/workspace-git";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const roots: string[] = [];

function workspace(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-workspace-status-failure-")));
  roots.push(root);
  for (const name of ["a-slow", "b-ready"]) {
    const repository = join(root, name);
    mkdirSync(repository);
    execFileSync("git", ["init", "--quiet"], {
      cwd: repository,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
  }
  return root;
}

afterEach(() => {
  vi.mocked(getRepositoryStatus).mockReset();
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace Git repository status failures", () => {
  it("keeps a local Git timeout isolated while later repositories finish within the workspace deadline", async () => {
    const root = workspace();
    const secureFiles = new SecureFileTestBroker();
    const onRepositoryAuthorized = vi.fn();
    vi.mocked(getRepositoryStatus).mockRejectedValueOnce(
      new GitError("timeout", "Git took too long to complete the operation."),
    );

    const snapshot = await discoverWorkspaceGitRepositories(root, {
      deadlineAt: Date.now() + 60_000,
      statusConcurrency: 1,
      secureFiles,
      onRepositoryAuthorized,
    });

    expect(snapshot.repositories).toEqual([
      expect.objectContaining({
        repositoryPath: "a-slow",
        state: "error",
        error: "Git took too long to complete the operation.",
        files: [],
      }),
      expect.objectContaining({ repositoryPath: "b-ready", state: "ready" }),
    ]);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.truncated).toBe(false);
    expect(onRepositoryAuthorized).toHaveBeenCalledExactlyOnceWith(
      "b-ready", expect.objectContaining({ root: join(root, "b-ready") }), expect.any(String),
    );
  });

  it("still rejects an aggregate timeout without authorizing any repository", async () => {
    const root = workspace();
    const deadlineAt = Date.now() + 60_000;
    const onRepositoryAuthorized = vi.fn();
    vi.mocked(getRepositoryStatus).mockImplementationOnce(async () => {
      vi.spyOn(Date, "now").mockReturnValue(deadlineAt);
      throw new GitError("timeout", "Git took too long to complete the operation.");
    });

    await expect(discoverWorkspaceGitRepositories(root, {
      deadlineAt,
      statusConcurrency: 1,
      secureFiles: new SecureFileTestBroker(),
      onRepositoryAuthorized,
    })).rejects.toThrow("Workspace repository discovery took too long.");

    expect(getRepositoryStatus).toHaveBeenCalledOnce();
    expect(onRepositoryAuthorized).not.toHaveBeenCalled();
  });

  it("rejects a process-tree cleanup failure instead of reporting it as an isolated status error", async () => {
    const root = workspace();
    const onRepositoryAuthorized = vi.fn();
    vi.mocked(getRepositoryStatus).mockRejectedValueOnce(
      new GitError("operation-failed", GIT_PROCESS_TREE_TERMINATION_FAILURE),
    );

    await expect(discoverWorkspaceGitRepositories(root, {
      deadlineAt: Date.now() + 60_000,
      statusConcurrency: 1,
      secureFiles: new SecureFileTestBroker(),
      onRepositoryAuthorized,
    })).rejects.toThrow(GIT_PROCESS_TREE_TERMINATION_FAILURE);

    expect(getRepositoryStatus).toHaveBeenCalledOnce();
    expect(onRepositoryAuthorized).not.toHaveBeenCalled();
  });

  it("does not publish authority when final verification settles at the deadline", async () => {
    const root = workspace();
    const secureFiles = new SecureFileTestBroker();
    const deadlineAt = Date.now() + 60_000;
    const onRepositoryAuthorized = vi.fn();
    const verifyRoot = secureFiles.verifyRoot.bind(secureFiles);
    vi.spyOn(secureFiles, "verifyRoot").mockImplementation(async (capability, signal) => {
      await verifyRoot(capability, signal);
      if (capability.root === join(root, "b-ready")) {
        vi.spyOn(Date, "now").mockReturnValue(deadlineAt);
      }
    });

    await expect(discoverWorkspaceGitRepositories(root, {
      deadlineAt,
      statusConcurrency: 1,
      secureFiles,
      onRepositoryAuthorized,
    })).rejects.toThrow("Workspace repository discovery took too long.");

    expect(getRepositoryStatus).toHaveBeenCalledTimes(2);
    expect(onRepositoryAuthorized).not.toHaveBeenCalled();
  });
});
