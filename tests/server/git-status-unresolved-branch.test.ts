import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureGitArtifactState, getRepositoryStatus } from "../../src/server/git";
import { GitError } from "../../src/server/git/types";
import {
  createSourceControlCommandHandler,
  type SourceControlCommandDependencies,
} from "../../src/server/runtime/commands/source-control-commands";
import { SecureFileAuthorityRegistry } from "../../src/server/runtime/secure-file-authorities";
import { clientCommandSchema } from "../../src/shared/contracts";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const projectId = "11111111-1111-4111-8111-111111111111";
const unresolvedBranch = "Git could not resolve the current branch.";
const corruptRefContent = "not-an-oid-7f3c2a";
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function committedRepository(): string {
  const repository = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-unresolved-branch-")));
  roots.push(repository);
  git(repository, "init", "-q", "--initial-branch=main");
  git(repository, "config", "user.email", "tests@inertia.invalid");
  git(repository, "config", "user.name", "Inertia Tests");
  writeFileSync(join(repository, "README.md"), "before\n");
  git(repository, "add", "--", "README.md");
  git(repository, "commit", "-q", "-m", "Initial");
  return repository;
}

function corruptBranchRef(repository: string): void {
  const ref = join(repository, ".git", "refs", "heads", "main");
  expect(existsSync(ref)).toBe(true);
  writeFileSync(ref, `${corruptRefContent}\n`);
}

async function expectUnresolvedBranch(operation: Promise<unknown>): Promise<void> {
  const failure = await operation.then(
    () => { throw new Error("Expected the branch read to fail."); },
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(GitError);
  expect(failure).toMatchObject({ code: "operation-failed", message: unresolvedBranch });
  expect((failure as GitError).message).not.toContain(corruptRefContent);
  expect((failure as GitError).message).not.toContain("refs/heads");
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Git status with an unreadable branch ref", () => {
  it("still reports a branch and a detached checkout from intact refs", async () => {
    const repository = committedRepository();
    await expect(getRepositoryStatus(repository)).resolves.toMatchObject({
      branch: "main",
      detached: false,
      clean: true,
    });

    git(repository, "checkout", "-q", "--detach");
    await expect(getRepositoryStatus(repository)).resolves.toMatchObject({
      branch: null,
      detached: true,
      clean: true,
    });
  });

  it("rejects the status read instead of reporting a detached checkout", async () => {
    const repository = committedRepository();
    corruptBranchRef(repository);

    await expectUnresolvedBranch(getRepositoryStatus(repository));
  });

  it("rejects an artifact capture instead of recording a detached checkout", async () => {
    const repository = committedRepository();
    const snapshotRef = `refs/inertia/checkpoints/${randomUUID()}/${randomUUID()}`;
    git(repository, "update-ref", snapshotRef, "HEAD");
    corruptBranchRef(repository);

    await expectUnresolvedBranch(captureGitArtifactState(repository, snapshotRef));
  });

  it("fails git.refresh instead of sending a status snapshot", async () => {
    const repository = committedRepository();
    corruptBranchRef(repository);
    const broker = new SecureFileTestBroker();
    const send = vi.fn();
    const handler = createSourceControlCommandHandler({
      workspacePath: vi.fn(() => repository),
      secureFiles: broker,
      secureFileAuthorities: new SecureFileAuthorityRegistry(broker),
      send,
      broadcastSnapshot: vi.fn(),
    } as unknown as SourceControlCommandDependencies);

    await expectUnresolvedBranch(handler({ readyState: WebSocket.OPEN } as WebSocket, clientCommandSchema.parse({
      type: "git.refresh",
      requestId: randomUUID(),
      payload: { projectId },
    })));
    expect(send).not.toHaveBeenCalled();
  });
});
