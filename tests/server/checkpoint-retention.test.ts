import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import {
  CheckpointError,
  createCheckpoint,
  deleteCheckpointRefs,
  deleteCheckpoints,
  deleteCheckpointsForConversations,
  listCheckpointRefs,
  resolveCheckpointRepository,
} from "../../src/server/checkpoints";
import {
  pruneCheckpointRefs,
  RESTORE_BACKUP_CHECKPOINT_LABEL,
} from "../../src/server/checkpoint-retention";
import { RuntimeStore } from "../../src/server/database";
import { normalizeIdentityPath } from "../../src/server/project-identity";
import { restoreConversationCheckpoint } from "../../src/server/runtime/checkpoint-restoration";
import { createConversationCommandHandler } from "../../src/server/runtime/commands/conversation-commands";
import { createProjectWorkspaceCommandHandler } from "../../src/server/runtime/commands/project-workspace-commands";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";
import type { IncidentObservation } from "../../src/node/application-incidents";
import { removePortableFixture } from "../helpers/portable-provider-fixture";

const roots: string[] = [];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  }).trim();
}

function listAllRefs(cwd: string, prefix?: string): string[] {
  const args = ["for-each-ref", "--format=%(refname)", ...(prefix ? [prefix] : [])];
  const output = git(cwd, args);
  return output ? output.split(/\r?\n/u).filter(Boolean) : [];
}

function createRepoFixture(name = "retention") {
  const root = mkdtempSync(join(tmpdir(), `inertia-${name}-`));
  roots.push(root);
  const data = join(root, "data");
  const repository = join(root, "repository");
  mkdirSync(data);
  mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "core.autocrlf", "false"]);
  git(repository, ["config", "user.name", "Inertia Test"]);
  git(repository, ["config", "user.email", "test@inertia.local"]);
  writeFileSync(join(repository, "tracked.txt"), "base\n");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "-m", "initial"]);
  const store = new RuntimeStore(join(data, "inertia.sqlite"), repository);
  const project = store.createProject("Retention Test", repository);
  const conversation = store.createConversation(project.id, "Primary");
  return { root, data, repository, store, project, conversation };
}

function beginTurn(store: RuntimeStore, conversationId: string, id: string) {
  return store.beginAgentTurn({
    id,
    conversationId,
    runId: `run-${id}`,
    content: `Request ${id}`,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 0,
    association: "authoritative",
  }).turn;
}

async function runSettledTurn(
  store: RuntimeStore,
  manager: TurnGitArtifactManager,
  repository: string,
  conversationId: string,
  turnId: string,
  content: string,
  settle = true,
) {
  const turn = beginTurn(store, conversationId, turnId);
  const captured = await manager.createTurnCheckpoint(turn);
  expect(captured.checkpointId).not.toBeNull();
  await manager.captureBefore({ turn, checkpointId: captured.checkpointId });
  writeFileSync(join(repository, "tracked.txt"), content);
  const answer = store.createMessage(conversationId, `Done ${turnId}`, "assistant", [], turn.id);
  if (settle) {
    store.settleAgentTurn(turn.id, {
      status: "completed",
      terminalAssistantMessageId: answer.id,
      checkpointId: captured.checkpointId,
    });
  }
  await manager.captureAfter({
    turn,
    checkpointId: captured.checkpointId,
    terminalAssistantMessageId: answer.id,
  });
  return { turn, checkpointId: captured.checkpointId! };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

describe("bounded retention for Git checkpoint refs", () => {
  it("keeps the most recent N pre-turn refs, retires stored post-turn refs earlier, and never touches running turns or pending restores", async () => {
    const fixture = createRepoFixture("keep-n");
    let tick = Date.now() - 60_000;
    const manager = new TurnGitArtifactManager(
      fixture.store,
      fixture.data,
      () => new Date((tick += 1_000)),
      {
        retentionPolicy: {
          maxTurnCheckpointsPerConversation: 3,
          maxPostTurnRefsWithPatchPerConversation: 1,
          maxPostTurnRefsWithoutPatchPerConversation: 3,
          maxRestoreBackupsPerConversation: 2,
          maxArchivedCheckpointsPerConversation: 1,
          maxRefsPerRepository: 50,
        },
      },
    );

    try {
      const settledTurns: Array<{ turnId: string; checkpointId: string }> = [];
      for (let index = 1; index <= 5; index += 1) {
        const result = await runSettledTurn(
          fixture.store,
          manager,
          fixture.repository,
          fixture.conversation.id,
          `turn-${index}`,
          `content-${index}\n`,
        );
        settledTurns.push({ turnId: result.turn.id, checkpointId: result.checkpointId });
      }

      const runningTurn = beginTurn(fixture.store, fixture.conversation.id, "turn-running");
      const runningCapture = await manager.createTurnCheckpoint(runningTurn);
      await manager.captureBefore({ turn: runningTurn, checkpointId: runningCapture.checkpointId });

      await manager.prune();

      expect(fixture.store.checkpoint(settledTurns[0]!.checkpointId).expiredAt).toBeTruthy();
      expect(fixture.store.checkpoint(settledTurns[1]!.checkpointId).expiredAt).toBeTruthy();
      expect(fixture.store.checkpoint(settledTurns[2]!.checkpointId).expiredAt).toBeUndefined();
      expect(fixture.store.checkpoint(settledTurns[3]!.checkpointId).expiredAt).toBeUndefined();
      expect(fixture.store.checkpoint(settledTurns[4]!.checkpointId).expiredAt).toBeUndefined();
      expect(fixture.store.checkpoint(runningCapture.checkpointId!).expiredAt).toBeUndefined();

      expect(fixture.store.turnGitArtifactStorage(settledTurns[3]!.turnId).afterRef).toBeNull();
      expect(fixture.store.turnGitArtifact(settledTurns[3]!.turnId)?.afterSnapshotExpired).toBe(true);
      expect(fixture.store.turnGitArtifactStorage(settledTurns[4]!.turnId).afterRef).not.toBeNull();
      expect(fixture.store.turnGitArtifact(settledTurns[4]!.turnId)?.afterSnapshotExpired).toBeUndefined();

      const liveRefs = new Set(listAllRefs(fixture.repository, "refs/inertia/checkpoints/"));
      expect(liveRefs.has(fixture.store.checkpoint(settledTurns[0]!.checkpointId).ref)).toBe(false);
      expect(liveRefs.has(fixture.store.checkpoint(settledTurns[1]!.checkpointId).ref)).toBe(false);
      expect(liveRefs.has(fixture.store.checkpoint(runningCapture.checkpointId!).ref)).toBe(true);

      const secondConversation = fixture.store.createConversation(fixture.project.id, "Restoring");
      const restoringTurn = beginTurn(fixture.store, secondConversation.id, "turn-r1");
      const restoringCapture = await manager.createTurnCheckpoint(restoringTurn);
      fixture.store.settleAgentTurn(restoringTurn.id, {
        status: "completed",
        checkpointId: restoringCapture.checkpointId,
      });
      for (let i = 1; i <= 4; i += 1) {
        const extraTurn = beginTurn(fixture.store, secondConversation.id, `turn-r-extra-${i}`);
        const extraCapture = await manager.createTurnCheckpoint(extraTurn);
        fixture.store.settleAgentTurn(extraTurn.id, {
          status: "completed",
          checkpointId: extraCapture.checkpointId,
        });
      }
      expect(fixture.store.conversationWork.reserve(secondConversation.id)).toBe(true);
      try {
        await manager.prune();
        expect(fixture.store.checkpoint(restoringCapture.checkpointId!).expiredAt).toBeUndefined();
        expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${secondConversation.id}/`)).toHaveLength(5);
      } finally {
        fixture.store.conversationWork.release(secondConversation.id);
      }

      await manager.prune();
      expect(fixture.store.checkpoint(restoringCapture.checkpointId!).expiredAt).toBeTruthy();
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${secondConversation.id}/`)).toHaveLength(3);

      const expiredCheckpoint = fixture.store.checkpoint(settledTurns[0]!.checkpointId);
      await expect(
        restoreConversationCheckpoint(fixture.store, expiredCheckpoint, () => undefined),
      ).rejects.toBeInstanceOf(CheckpointError);
    } finally {
      fixture.store.close();
    }
  }, 45_000);

  it("keeps only the single latest checkpoint for archived conversations", async () => {
    const fixture = createRepoFixture("archived");
    let tick = Date.now() - 60_000;
    const manager = new TurnGitArtifactManager(
      fixture.store,
      fixture.data,
      () => new Date((tick += 1_000)),
      {
        retentionPolicy: {
          maxTurnCheckpointsPerConversation: 10,
          maxPostTurnRefsWithPatchPerConversation: 5,
          maxRestoreBackupsPerConversation: 5,
          maxArchivedCheckpointsPerConversation: 1,
          maxRefsPerRepository: 50,
        },
      },
    );

    try {
      const results = [];
      for (let i = 1; i <= 4; i += 1) {
        results.push(await runSettledTurn(
          fixture.store,
          manager,
          fixture.repository,
          fixture.conversation.id,
          `arch-turn-${i}`,
          `arch-${i}\n`,
        ));
      }
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${fixture.conversation.id}/`).length).toBeGreaterThan(4);

      fixture.store.archiveConversation(fixture.conversation.id, true);
      await manager.prune();

      for (const item of results.slice(0, 3)) {
        expect(fixture.store.checkpoint(item.checkpointId).expiredAt).toBeTruthy();
      }
      expect(fixture.store.checkpoint(results[3]!.checkpointId).expiredAt).toBeUndefined();
      expect(fixture.store.turnGitArtifactStorage(results[3]!.turn.id).afterRef).toBeNull();
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${fixture.conversation.id}/`)).toEqual([
        fixture.store.checkpoint(results[3]!.checkpointId).ref,
      ]);
    } finally {
      fixture.store.close();
    }
  });

  it("bounds restore backup refs per conversation and enforces the repository global cap", async () => {
    const fixture = createRepoFixture("backups-and-cap");
    const manager = new TurnGitArtifactManager(
      fixture.store,
      fixture.data,
      () => new Date(),
      {
        retentionPolicy: {
          maxTurnCheckpointsPerConversation: 10,
          maxPostTurnRefsWithPatchPerConversation: 10,
          maxRestoreBackupsPerConversation: 2,
          maxArchivedCheckpointsPerConversation: 1,
          maxRefsPerRepository: 4,
        },
      },
    );

    try {
      const backups: string[] = [];
      for (let i = 1; i <= 4; i += 1) {
        const created = await createCheckpoint(
          fixture.repository,
          join(fixture.data, "checkpoint-indexes"),
          fixture.conversation.id,
        );
        const saved = fixture.store.addCheckpoint({
          conversationId: fixture.conversation.id,
          ref: created.ref,
          label: RESTORE_BACKUP_CHECKPOINT_LABEL,
          turnIndex: i,
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
        });
        backups.push(saved.id);
      }

      const secondConversation = fixture.store.createConversation(fixture.project.id, "Second");
      for (let i = 1; i <= 4; i += 1) {
        const turn = beginTurn(fixture.store, secondConversation.id, `cap-turn-${i}`);
        const captured = await manager.createTurnCheckpoint(turn);
        fixture.store.settleAgentTurn(turn.id, {
          status: "completed",
          checkpointId: captured.checkpointId,
        });
      }

      await manager.prune();

      expect(fixture.store.checkpoint(backups[0]!).expiredAt).toBeTruthy();
      expect(fixture.store.checkpoint(backups[1]!).expiredAt).toBeTruthy();

      const remaining = listAllRefs(fixture.repository, "refs/inertia/checkpoints/");
      expect(remaining.length).toBeLessThanOrEqual(4);
      expect(listAllRefs(fixture.repository, "refs/heads/")).toEqual(["refs/heads/main"]);
    } finally {
      fixture.store.close();
    }
  });

  it("deletes only Inertia checkpoint refs for removed project conversations and preserves user refs and sibling project refs", async () => {
    const fixture = createRepoFixture("project-remove");
    const siblingProject = fixture.store.createProject("Sibling Project", fixture.repository);
    const siblingConversation = fixture.store.createConversation(siblingProject.id, "Sibling Chat");
    const secondProjectConv = fixture.store.createConversation(fixture.project.id, "Secondary");

    try {
      const head = git(fixture.repository, ["rev-parse", "HEAD"]);
      git(fixture.repository, ["tag", "v1.0.0", head]);
      git(fixture.repository, ["update-ref", "refs/custom/keep", head]);

      const projectRef1 = (await createCheckpoint(
        fixture.repository,
        join(fixture.data, "checkpoint-indexes"),
        fixture.conversation.id,
      )).ref;
      const projectRef2 = (await createCheckpoint(
        fixture.repository,
        join(fixture.data, "checkpoint-indexes"),
        secondProjectConv.id,
      )).ref;
      const siblingRef = (await createCheckpoint(
        fixture.repository,
        join(fixture.data, "checkpoint-indexes"),
        siblingConversation.id,
      )).ref;

      const providerTerminalResumes = new ProviderTerminalResumeRegistry(fixture.store.conversationWork);
      const handler = createProjectWorkspaceCommandHandler({
        store: fixture.store,
        dataDirectory: fixture.data,
        conversationAttachments: { release: async () => undefined } as never,
        workspaceRuns: {} as never,
        turns: { hasActiveCheckout: () => false } as never,
        providers: {} as never,
        providerTerminalResumes,
        terminals: {} as never,
        secureFiles: {} as never,
        secureFileAuthorities: {} as never,
        workspacePath: () => fixture.repository,
        rememberDeletedConversation: () => undefined,
        forgetRemoteTranscript: () => undefined,
        broadcastSnapshot: () => undefined,
        send: () => undefined,
      });

      const outcome = await handler({} as WebSocket, {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: fixture.project.id },
      });
      expect(outcome).toBe("mutation");

      const remainingInertia = listAllRefs(fixture.repository, "refs/inertia/checkpoints/");
      expect(remainingInertia).not.toContain(projectRef1);
      expect(remainingInertia).not.toContain(projectRef2);
      expect(remainingInertia).toEqual([siblingRef]);
      expect(listAllRefs(fixture.repository, "refs/heads/")).toEqual(["refs/heads/main"]);
      expect(listAllRefs(fixture.repository, "refs/tags/")).toEqual(["refs/tags/v1.0.0"]);
      expect(listAllRefs(fixture.repository, "refs/custom/")).toEqual(["refs/custom/keep"]);
    } finally {
      fixture.store.close();
    }
  });

  it("rejects project.remove before deleting checkpoint refs when an isolated chat worktree blocks removal", async () => {
    const fixture = createRepoFixture("project-remove-blocked");
    try {
      const ref = (await createCheckpoint(
        fixture.repository,
        join(fixture.data, "checkpoint-indexes"),
        fixture.conversation.id,
      )).ref;
      fixture.store.conversationWorktrees.beginCreation(
        fixture.conversation.id,
        join(fixture.root, "wt-owned"),
        "inertia/wt-owned",
        randomUUID(),
      );

      const providerTerminalResumes = new ProviderTerminalResumeRegistry(fixture.store.conversationWork);
      const handler = createProjectWorkspaceCommandHandler({
        store: fixture.store,
        dataDirectory: fixture.data,
        conversationAttachments: { release: async () => undefined } as never,
        workspaceRuns: {} as never,
        turns: { hasActiveCheckout: () => false } as never,
        providers: {} as never,
        providerTerminalResumes,
        terminals: {} as never,
        secureFiles: {} as never,
        secureFileAuthorities: {} as never,
        workspacePath: () => fixture.repository,
        rememberDeletedConversation: () => undefined,
        forgetRemoteTranscript: () => undefined,
        broadcastSnapshot: () => undefined,
        send: () => undefined,
      });

      await expect(handler({} as WebSocket, {
        type: "project.remove",
        requestId: randomUUID(),
        payload: { projectId: fixture.project.id },
      })).rejects.toThrow("Resolve this project's isolated chat worktrees before removing it.");

      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${fixture.conversation.id}/`)).toEqual([ref]);
      expect(fixture.store.project(fixture.project.id).id).toBe(fixture.project.id);
    } finally {
      fixture.store.close();
    }
  });

  it("does not fall back to projectPath during retention pruning when project repository identity is missing or mismatched", async () => {
    const fixture = createRepoFixture("fallback-identity");
    try {
      const missingWorktree = join(fixture.root, "missing-worktree");
      git(fixture.repository, ["worktree", "add", "-b", "wt-temp", missingWorktree]);
      const convMissingId = fixture.store.createConversation(fixture.project.id, "Detached Missing Id", {
        worktreePath: missingWorktree,
      });

      const nestedDir = join(fixture.repository, "nested-subproject");
      mkdirSync(nestedDir);
      const repoRoot = realpathSync(fixture.repository);
      const repoCommonDir = realpathSync(join(fixture.repository, ".git"));
      const mismatchedProject = fixture.store.createProject("Mismatched Repo", nestedDir, {
        repositoryIdentity: `git:${normalizeIdentityPath(repoCommonDir)}`,
        repositoryRoot: normalizeIdentityPath(repoRoot),
        repositoryRelativePath: "nested-subproject",
      });
      const convMismatchedId = fixture.store.createConversation(mismatchedProject.id, "Detached Mismatched Id", {
        worktreePath: missingWorktree,
      });
      git(fixture.repository, ["worktree", "remove", "--force", missingWorktree]);
      rmSync(missingWorktree, { recursive: true, force: true });

      git(nestedDir, ["init", "-b", "main"]);
      git(nestedDir, ["config", "core.autocrlf", "false"]);
      git(nestedDir, ["config", "user.name", "Inertia Test"]);
      git(nestedDir, ["config", "user.email", "test@inertia.local"]);
      writeFileSync(join(nestedDir, "nested.txt"), "nested\n");
      git(nestedDir, ["add", "nested.txt"]);
      git(nestedDir, ["commit", "-m", "nested initial"]);

      const missingRefs: string[] = [];
      const mismatchedRefs: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        const createdA = await createCheckpoint(
          fixture.repository,
          join(fixture.data, "checkpoint-indexes"),
          convMissingId.id,
        );
        fixture.store.addCheckpoint({
          conversationId: convMissingId.id,
          ref: createdA.ref,
          label: `Turn ${i}`,
          turnIndex: i,
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
        });
        missingRefs.push(createdA.ref);

        const createdB = await createCheckpoint(
          nestedDir,
          join(fixture.data, "checkpoint-indexes"),
          convMismatchedId.id,
        );
        fixture.store.addCheckpoint({
          conversationId: convMismatchedId.id,
          ref: createdB.ref,
          label: `Turn ${i}`,
          turnIndex: i,
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
        });
        mismatchedRefs.push(createdB.ref);
      }

      const pruned = await pruneCheckpointRefs(fixture.store, {
        policy: {
          maxTurnCheckpointsPerConversation: 1,
          maxRefsPerRepository: 1,
        },
      });
      expect(pruned.deletedRefCount).toBe(0);
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${convMissingId.id}/`).sort()).toEqual(missingRefs.sort());
      expect(listAllRefs(nestedDir, `refs/inertia/checkpoints/${convMismatchedId.id}/`).sort()).toEqual(mismatchedRefs.sort());
    } finally {
      fixture.store.close();
    }
  });

  it("logs and reports incidents instead of silently swallowing conversation-delete ref cleanup failures", async () => {
    const fixture = createRepoFixture("delete-log");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const incidents: IncidentObservation[] = [];

    try {
      const ref = (await createCheckpoint(
        fixture.repository,
        join(fixture.data, "checkpoint-indexes"),
        fixture.conversation.id,
      )).ref;
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${fixture.conversation.id}/`)).toEqual([ref]);

      writeFileSync(join(fixture.repository, ".git", "packed-refs.lock"), "locked\n");
      git(fixture.repository, ["pack-refs", "--all"]).toString();
    } catch {
    }

    try {
      const lockPath = join(fixture.repository, ".git", "packed-refs.lock");
      writeFileSync(lockPath, "lock\n");
      const ref = (await createCheckpoint(
        fixture.repository,
        join(fixture.data, "checkpoint-indexes"),
        fixture.conversation.id,
      )).ref;
      writeFileSync(join(fixture.repository, ".git", `${ref}.lock`), "lock\n");

      const handler = createConversationCommandHandler({
        store: fixture.store,
        conversationAttachments: { release: async () => undefined } as never,
        providers: {} as never,
        backendProfileController: {} as never,
        workspaceRuns: {} as never,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(fixture.store.conversationWork),
        runtimeSync: { broadcast: () => undefined } as never,
        deletedConversationIds: new Set<string>(),
        dataDirectory: fixture.data,
        rememberDeletedConversation: () => undefined,
        forgetRemoteTranscript: () => undefined,
        broadcastSnapshot: () => undefined,
        publicError: (error) => String(error),
        send: () => undefined,
        reportIncident: (observation) => { incidents.push(observation); },
      });

      const outcome = await handler({} as WebSocket, {
        type: "conversation.delete",
        requestId: randomUUID(),
        payload: { conversationId: fixture.conversation.id },
      });
      expect(outcome).toBe("mutation");
      expect(warnSpy).toHaveBeenCalledWith(
        "Conversation checkpoint ref cleanup failed.",
        expect.objectContaining({
          projectId: fixture.project.id,
          conversationId: fixture.conversation.id,
        }),
      );
      expect(incidents).toEqual([
        expect.objectContaining({
          code: "git.command-failed",
          outcome: "failed",
          context: expect.objectContaining({
            projectId: fixture.project.id,
            conversationId: fixture.conversation.id,
            commandType: "conversation.delete",
          }),
        }),
      ]);
    } finally {
      warnSpy.mockRestore();
      fixture.store.close();
    }
  });

  it("pages listing and batches deletion across thousands of Inertia refs without touching user refs", async () => {
    const fixture = createRepoFixture("thousands");
    try {
      const head = git(fixture.repository, ["rev-parse", "HEAD"]);
      git(fixture.repository, ["tag", "keep-tag", head]);
      const convA = fixture.conversation.id;
      const convB = randomUUID();
      const createdRefsA: string[] = [];
      const createdRefsB: string[] = [];
      const stdinLines: string[] = [];

      for (let i = 0; i < 2_200; i += 1) {
        const ref = `refs/inertia/checkpoints/${convA}/${randomUUID()}`;
        createdRefsA.push(ref);
        stdinLines.push(`create ${ref} ${head}\n`);
      }
      for (let i = 0; i < 400; i += 1) {
        const ref = `refs/inertia/checkpoints/${convB}/${randomUUID()}`;
        createdRefsB.push(ref);
        stdinLines.push(`create ${ref} ${head}\n`);
      }
      git(fixture.repository, ["update-ref", "--stdin"], stdinLines.join(""));

      const listedA = await listCheckpointRefs(fixture.repository, {
        conversationId: convA,
        pageSize: 400,
      });
      expect(listedA).toHaveLength(2_200);

      const listedAll = await listCheckpointRefs(fixture.repository, {
        pageSize: 400,
      });
      expect(listedAll).toHaveLength(2_600);

      const deletedA = await deleteCheckpoints(fixture.repository, convA, { batchSize: 350 });
      expect(deletedA).toBe(2_200);
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${convA}/`)).toEqual([]);
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${convB}/`)).toHaveLength(400);

      const deletedB = await deleteCheckpointsForConversations(fixture.repository, [convB], { batchSize: 150 });
      expect(deletedB).toBe(400);
      expect(listAllRefs(fixture.repository, "refs/inertia/checkpoints/")).toEqual([]);
      expect(listAllRefs(fixture.repository, "refs/heads/")).toEqual(["refs/heads/main"]);
      expect(listAllRefs(fixture.repository, "refs/tags/")).toEqual(["refs/tags/keep-tag"]);
    } finally {
      fixture.store.close();
    }
  }, 60_000);

  it("logs pruning failures, does not block turns, and retries cleanly on the next prune", async () => {
    const fixture = createRepoFixture("retry");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const incidents: IncidentObservation[] = [];
    let shouldFail = true;
    let deleteAttempts = 0;

    const manager = new TurnGitArtifactManager(
      fixture.store,
      fixture.data,
      () => new Date(),
      {
        retentionPolicy: {
          maxTurnCheckpointsPerConversation: 1,
          maxPostTurnRefsWithPatchPerConversation: 1,
          maxRefsPerRepository: 50,
        },
        reportIncident: (observation) => { incidents.push(observation); },
        deleteCheckpointRefs: async (repoPath, refs, options) => {
          deleteAttempts += 1;
          if (shouldFail) {
            throw new CheckpointError("Simulated ref lock failure.");
          }
          return await deleteCheckpointRefs(repoPath, refs, options);
        },
      },
    );

    try {
      const first = await runSettledTurn(
        fixture.store,
        manager,
        fixture.repository,
        fixture.conversation.id,
        "retry-turn-1",
        "one\n",
      );
      const second = await runSettledTurn(
        fixture.store,
        manager,
        fixture.repository,
        fixture.conversation.id,
        "retry-turn-2",
        "two\n",
      );

      expect(fixture.store.turnGitArtifact(second.turn.id)?.status).toBe("ready");
      expect(deleteAttempts).toBeGreaterThanOrEqual(1);
      expect(warnSpy).toHaveBeenCalled();
      expect(incidents.some(({ code }) => code === "git.command-failed")).toBe(true);
      expect(fixture.store.checkpoint(first.checkpointId).expiredAt).toBeUndefined();
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${fixture.conversation.id}/`)).toContain(
        fixture.store.checkpoint(first.checkpointId).ref,
      );

      shouldFail = false;
      const retryResult = await pruneCheckpointRefs(fixture.store, {
        policy: {
          maxTurnCheckpointsPerConversation: 1,
          maxPostTurnRefsWithPatchPerConversation: 1,
          maxRefsPerRepository: 50,
        },
      });
      expect(retryResult.failedRepositoryCount).toBe(0);
      expect(retryResult.expiredCheckpointCount).toBeGreaterThanOrEqual(1);
      expect(fixture.store.checkpoint(first.checkpointId).expiredAt).toBeTruthy();
      expect(listAllRefs(fixture.repository, `refs/inertia/checkpoints/${fixture.conversation.id}/`)).not.toContain(
        fixture.store.checkpoint(first.checkpointId).ref,
      );
    } finally {
      warnSpy.mockRestore();
      fixture.store.close();
    }
  });

  it("enforces repository path realpath containment and rejects non-Inertia ref names", async () => {
    const fixture = createRepoFixture("containment");
    const outsideRoot = mkdtempSync(join(tmpdir(), "inertia-outside-"));
    roots.push(outsideRoot);

    try {
      const resolved = await resolveCheckpointRepository(fixture.repository, {
        allowedRoot: fixture.root,
      });
      expect(resolved.toLowerCase()).toBe(realpathSync(fixture.repository).toLowerCase());

      await expect(
        resolveCheckpointRepository(fixture.repository, { allowedRoot: outsideRoot }),
      ).rejects.toBeInstanceOf(CheckpointError);

      await expect(
        deleteCheckpointRefs(fixture.repository, ["refs/heads/main"]),
      ).rejects.toBeInstanceOf(CheckpointError);
    } finally {
      fixture.store.close();
    }
  });
});
