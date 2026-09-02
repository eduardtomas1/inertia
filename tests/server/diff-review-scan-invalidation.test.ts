import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRepositoryStatus,
  getUnifiedDiff,
  inspectDiffSelection,
} from "../../src/server/git";
import { repositoryMetadataMarkerIdentity } from "../../src/server/git/paths";
import {
  gitScanCoordinator,
  validatedGitScanIdentity,
  type GitScanExecution,
} from "../../src/server/git/scan-coordinator";
import {
  createDiffReviewCommandHandler,
  type DiffReviewCommandDependencies,
} from "../../src/server/runtime/commands/diff-review-commands";
import { WorkspaceRunController } from "../../src/server/runtime/workspace-run-controller";
import { clientCommandSchema } from "../../src/shared/contracts";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const projectId = "11111111-1111-4111-8111-111111111111";
const undoAuthorityRef = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-diff-scan-invalidation-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "tests@inertia.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Inertia Tests"], {
    cwd: root,
  });
  writeFileSync(join(root, "README.md"), "before\n");
  execFileSync("git", ["add", "--", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "Initial"], { cwd: root });
  return root;
}

async function holdStaleStatusScan(root: string) {
  const identity = validatedGitScanIdentity(
    root,
    await repositoryMetadataMarkerIdentity(root),
  );
  const invalidation = gitScanCoordinator.currentInvalidation(identity);
  const stale = await getRepositoryStatus(root);
  const authorityGeneration = `test:${randomUUID()}`;
  let markStarted!: () => void;
  let releaseExecution!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const active = gitScanCoordinator.request({
    authorityGeneration,
    identity,
    invalidation,
    optionsKey: "repository-status:v1",
    scope: "workspace",
  }, async () => {
    markStarted();
    await released;
    return stale;
  });
  await started;
  let didRelease = false;
  return {
    authorityGeneration,
    identity,
    invalidation,
    release: async () => {
      if (didRelease) return;
      didRelease = true;
      releaseExecution();
      await active;
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("selective reversal Git scan invalidation", () => {
  it("queues fresh scans behind active stale work for both revert and undo", async () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "after\n");
    const secureFiles = new SecureFileTestBroker();
    const secureRoot = await secureFiles.authorizeRoot(root);
    const structured = parseUnifiedDiff((await getUnifiedDiff(root)).text);
    const file = structured.files[0]!;
    const hunk = file.hunks[0]!;
    const selection = {
      fingerprint: structured.fingerprint,
      filePath: file.path,
      hunkId: hunk.id,
      lineIds: hunk.lines
        .filter(({ kind }) => kind === "addition" || kind === "deletion")
        .map(({ id }) => id),
    };
    const plan = await inspectDiffSelection(
      root,
      selection,
      secureFiles,
      secureRoot,
    );
    const activityStore = {
      conversation: vi.fn(),
      createWorkspaceRun: vi.fn(() => ({ id: randomUUID() })),
      updateWorkspaceRun: vi.fn(),
      conversationWork: {
        reserveCheckout: vi.fn(() => true),
        release: vi.fn(),
      },
    };
    const workspaceRuns = new WorkspaceRunController(
      activityStore as never,
      {} as never,
      vi.fn(),
      () => false,
      vi.fn(),
    );
    const send = vi.fn();
    const socket = {} as WebSocket;
    const handler = createDiffReviewCommandHandler({
      store: {
        hasActiveWorkspaceRunForConversation: vi.fn(() => false),
      },
      workspaceRuns,
      secureFiles,
      secureFileAuthorities: {
        resolve: vi.fn(async () => secureRoot),
        issue: vi.fn(async () => undoAuthorityRef),
      },
      workspacePath: vi.fn(() => root),
      broadcastSnapshot: vi.fn(),
      send,
    } as unknown as DiffReviewCommandDependencies);

    const revertHold = await holdStaleStatusScan(root);
    try {
      await expect(handler(socket, clientCommandSchema.parse({
        type: "git.selection.revert",
        requestId: randomUUID(),
        payload: {
          projectId,
          ...selection,
          authorityRef: randomUUID(),
          expected: plan.validation,
        },
      }))).resolves.toBe("handled");
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("before\n");
      expect(gitScanCoordinator.currentInvalidation(revertHold.identity))
        .toBe(revertHold.invalidation + 2);

      const freshExecution = vi.fn(
        async (_execution: GitScanExecution) => await getRepositoryStatus(root),
      );
      const fresh = gitScanCoordinator.request({
        authorityGeneration: revertHold.authorityGeneration,
        identity: revertHold.identity,
        invalidation: revertHold.invalidation + 2,
        optionsKey: "repository-status:v1",
        scope: "workspace",
      }, freshExecution);
      await Promise.resolve();
      expect(freshExecution).not.toHaveBeenCalled();
      await revertHold.release();
      await expect(fresh).resolves.toMatchObject({ clean: true, files: [] });
    } finally {
      await revertHold.release();
    }

    const reverted = send.mock.calls.find(([, event]) =>
      event.type === "request.result"
      && event.result.kind === "git.reversal")?.[1];
    if (
      !reverted
      || reverted.type !== "request.result"
      || reverted.result.kind !== "git.reversal"
    ) throw new Error("Expected a selective reversal result.");

    const undoHold = await holdStaleStatusScan(root);
    try {
      await expect(handler(socket, clientCommandSchema.parse({
        type: "git.selection.undo",
        requestId: randomUUID(),
        payload: {
          projectId,
          operationId: reverted.result.operation.id,
          authorityRef: reverted.result.operation.authorityRef,
        },
      }))).resolves.toBe("handled");
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("after\n");
      expect(gitScanCoordinator.currentInvalidation(undoHold.identity))
        .toBe(undoHold.invalidation + 2);

      const freshExecution = vi.fn(
        async (_execution: GitScanExecution) => await getRepositoryStatus(root),
      );
      const fresh = gitScanCoordinator.request({
        authorityGeneration: undoHold.authorityGeneration,
        identity: undoHold.identity,
        invalidation: undoHold.invalidation + 2,
        optionsKey: "repository-status:v1",
        scope: "workspace",
      }, freshExecution);
      await Promise.resolve();
      expect(freshExecution).not.toHaveBeenCalled();
      await undoHold.release();
      await expect(fresh).resolves.toMatchObject({
        clean: false,
        files: [expect.objectContaining({ path: "README.md" })],
      });
    } finally {
      await undoHold.release();
    }
  });
});
