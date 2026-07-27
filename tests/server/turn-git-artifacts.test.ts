import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCheckpoint } from "../../src/server/checkpoints";
import { RuntimeStore } from "../../src/server/database";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";
import { removePortableFixture } from "../helpers/portable-provider-fixture";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  }).trim();
}

function workspace(): {
  root: string;
  data: string;
  repository: string;
  store: RuntimeStore;
  conversationId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "inertia-turn-artifacts-"));
  const data = join(root, "data");
  const repository = join(root, "repository");
  mkdirSync(data);
  mkdirSync(repository);
  git(repository, ["init"]);
  writeFileSync(join(repository, "tracked.txt"), "before\n");
  git(repository, ["add", "tracked.txt"]);
  git(repository, [
    "-c",
    "user.name=Inertia Test",
    "-c",
    "user.email=test@inertia.local",
    "commit",
    "-m",
    "Initial",
  ]);
  const store = new RuntimeStore(join(data, "inertia.sqlite"), repository);
  const project = store.createProject("Artifact test", repository);
  const conversation = store.createConversation(project.id, "Artifact chat");
  roots.push(root);
  return { root, data, repository, store, conversationId: conversation.id };
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

async function checkpointFor(
  store: RuntimeStore,
  repository: string,
  data: string,
  conversationId: string,
  turnIndex: number,
) {
  const captured = await createCheckpoint(
    repository,
    join(data, "checkpoint-indexes"),
    conversationId,
  );
  return store.addCheckpoint({
    conversationId,
    ref: captured.ref,
    label: `Before turn ${turnIndex}`,
    turnIndex,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

describe("turn Git artifacts", () => {
  it("persists exact historical metadata and a content-addressed patch across restart", async () => {
    const runtime = workspace();
    const turn = beginTurn(runtime.store, runtime.conversationId, "turn-one");
    const checkpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      1,
    );
    runtime.store.associateCheckpointWithTurn(
      checkpoint.id,
      runtime.conversationId,
      turn.runId,
      turn.id,
    );
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);
    await manager.captureBefore({ turn, checkpointId: checkpoint.id });

    writeFileSync(join(runtime.repository, "tracked.txt"), "before\nafter\n");
    writeFileSync(join(runtime.repository, "new-file.ts"), "export const answer = 42;\n");
    const answer = runtime.store.createMessage(
      runtime.conversationId,
      "Done.",
      "assistant",
      [],
      turn.id,
    );
    await manager.captureAfter({
      turn,
      checkpointId: checkpoint.id,
      terminalAssistantMessageId: answer.id,
    });
    runtime.store.settleAgentTurn(turn.id, {
      status: "completed",
      terminalAssistantMessageId: answer.id,
      checkpointId: checkpoint.id,
    });

    const artifact = runtime.store.turnGitArtifact(turn.id);
    expect(artifact).toMatchObject({
      turnId: turn.id,
      runId: turn.runId,
      beforeCheckpointId: checkpoint.id,
      status: "ready",
      completeness: "complete",
      patchState: "available",
      terminalAssistantMessageId: answer.id,
      insertions: 2,
      deletions: 0,
    });
    expect(artifact?.repositoryIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifact?.worktreeIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifact?.beforeFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifact?.afterFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(artifact?.files.map(({ path }) => path)).toEqual([
      "new-file.ts",
      "tracked.txt",
    ]);
    expect(runtime.store.snapshot().turnGitArtifacts).toHaveLength(1);
    runtime.store.close();

    const reopened = new RuntimeStore(
      join(runtime.data, "inertia.sqlite"),
      runtime.repository,
    );
    const reopenedManager = new TurnGitArtifactManager(reopened, runtime.data);
    const diff = await reopenedManager.turnDiff(turn.id, "tracked.txt");
    expect(diff.title).toContain("turn-one");
    expect(diff.patch).toContain("+after");
    expect(diff.patch).toContain("new-file.ts");
    reopened.close();
  });

  it("compares two turn-owned post snapshots without reading current workspace changes", async () => {
    const runtime = workspace();
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);

    const first = beginTurn(runtime.store, runtime.conversationId, "turn-first");
    const firstCheckpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      1,
    );
    runtime.store.associateCheckpointWithTurn(
      firstCheckpoint.id,
      runtime.conversationId,
      first.runId,
      first.id,
    );
    await manager.captureBefore({ turn: first, checkpointId: firstCheckpoint.id });
    writeFileSync(join(runtime.repository, "tracked.txt"), "first\n");
    await manager.captureAfter({ turn: first, checkpointId: firstCheckpoint.id });
    runtime.store.settleAgentTurn(first.id, {
      status: "completed",
      checkpointId: firstCheckpoint.id,
    });

    const second = beginTurn(runtime.store, runtime.conversationId, "turn-second");
    const secondCheckpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      2,
    );
    runtime.store.associateCheckpointWithTurn(
      secondCheckpoint.id,
      runtime.conversationId,
      second.runId,
      second.id,
    );
    await manager.captureBefore({ turn: second, checkpointId: secondCheckpoint.id });
    writeFileSync(join(runtime.repository, "tracked.txt"), "second\n");
    await manager.captureAfter({ turn: second, checkpointId: secondCheckpoint.id });
    runtime.store.settleAgentTurn(second.id, {
      status: "completed",
      checkpointId: secondCheckpoint.id,
    });

    writeFileSync(join(runtime.repository, "tracked.txt"), "unrelated-current-state\n");
    const comparison = await manager.compare(first.id, second.id, "tracked.txt");
    expect(comparison.patch).toContain("-first");
    expect(comparison.patch).toContain("+second");
    expect(comparison.patch).not.toContain("unrelated-current-state");
    runtime.store.close();
  });

  it("recovers pending terminal captures after restart and reports non-repositories honestly", async () => {
    const runtime = workspace();
    const turn = beginTurn(runtime.store, runtime.conversationId, "turn-restart");
    const checkpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      1,
    );
    runtime.store.associateCheckpointWithTurn(
      checkpoint.id,
      runtime.conversationId,
      turn.runId,
      turn.id,
    );
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);
    await manager.captureBefore({ turn, checkpointId: checkpoint.id });
    writeFileSync(join(runtime.repository, "tracked.txt"), "restart result\n");
    runtime.store.settleAgentTurn(turn.id, {
      status: "interrupted",
      checkpointId: checkpoint.id,
      terminalReason: "runtime-crash",
    });
    runtime.store.close();

    const reopened = new RuntimeStore(
      join(runtime.data, "inertia.sqlite"),
      runtime.repository,
    );
    const recovered = new TurnGitArtifactManager(reopened, runtime.data);
    await recovered.reconcile();
    expect(reopened.turnGitArtifact(turn.id)).toMatchObject({
      status: "ready",
      completeness: "complete",
    });
    reopened.close();

    const plainRoot = mkdtempSync(join(tmpdir(), "inertia-turn-artifacts-plain-"));
    const data = join(plainRoot, "data");
    const plain = join(plainRoot, "plain");
    mkdirSync(data);
    mkdirSync(plain);
    roots.push(plainRoot);
    const store = new RuntimeStore(join(data, "inertia.sqlite"), plain);
    const project = store.createProject("Plain", plain);
    const conversation = store.createConversation(project.id, "No Git");
    const plainTurn = beginTurn(store, conversation.id, "turn-no-git");
    const plainManager = new TurnGitArtifactManager(store, data);
    await plainManager.captureBefore({ turn: plainTurn, checkpointId: null });
    expect(store.turnGitArtifact(plainTurn.id)).toMatchObject({
      status: "unavailable",
      completeness: "unavailable",
      repositoryIdentity: null,
      absenceReason: "not-repository",
      files: [],
    });
    store.close();
  });

  it("bounds stalled finalization, deduplicates callers, and rejects late replacement", async () => {
    const runtime = workspace();
    const turn = beginTurn(runtime.store, runtime.conversationId, "turn-timeout");
    const checkpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      1,
    );
    runtime.store.associateCheckpointWithTurn(
      checkpoint.id,
      runtime.conversationId,
      turn.runId,
      turn.id,
    );
    const manager = new TurnGitArtifactManager(
      runtime.store,
      runtime.data,
      () => new Date(),
      { finalizationTimeoutMs: 5 },
    );
    await manager.captureBefore({ turn, checkpointId: checkpoint.id });
    const answer = runtime.store.createMessage(
      runtime.conversationId,
      "The provider is already done.",
      "assistant",
      [],
      turn.id,
    );
    const terminal = runtime.store.settleAgentTurn(turn.id, {
      status: "completed",
      terminalAssistantMessageId: answer.id,
      checkpointId: checkpoint.id,
    }).turn;
    let resolveCapture!: () => void;
    const capture = vi.spyOn(manager, "captureAfter").mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveCapture = resolve;
      }),
    );

    const first = manager.finalize({
      turn: terminal,
      checkpointId: checkpoint.id,
      terminalAssistantMessageId: answer.id,
    });
    const second = manager.finalize({
      turn: terminal,
      checkpointId: checkpoint.id,
      terminalAssistantMessageId: answer.id,
    });
    expect(second).toBe(first);
    await first;

    expect(capture).toHaveBeenCalledTimes(1);
    expect(runtime.store.turnGitArtifact(turn.id)).toMatchObject({
      status: "failed",
      completeness: "partial",
      patchState: "failed",
      terminalAssistantMessageId: answer.id,
      failureReason: "Capturing turn changes timed out.",
    });

    resolveCapture();
    await Promise.resolve();
    expect(runtime.store.turnGitArtifact(turn.id)?.status).toBe("failed");
    runtime.store.close();
  });

  it("does not scan nested Openbravo module repositories when the selected root is not Git", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-openbravo-artifacts-"));
    const data = join(root, "data");
    const selectedRoot = join(root, "openbravo");
    const firstModule = join(selectedRoot, "modules", "org.openbravo.client.application");
    const secondModule = join(selectedRoot, "modules", "org.openbravo.service.integration");
    mkdirSync(data);
    mkdirSync(firstModule, { recursive: true });
    mkdirSync(secondModule, { recursive: true });
    for (const [module, filename] of [
      [firstModule, "Application.java"],
      [secondModule, "Integration.java"],
    ] as const) {
      git(module, ["init"]);
      writeFileSync(join(module, filename), "class Before {}\n");
      git(module, ["add", filename]);
      git(module, [
        "-c",
        "user.name=Inertia Test",
        "-c",
        "user.email=test@inertia.local",
        "commit",
        "-m",
        "Initial",
      ]);
      writeFileSync(join(module, filename), "class Changed {}\n");
    }
    roots.push(root);

    const store = new RuntimeStore(join(data, "inertia.sqlite"), selectedRoot);
    const project = store.createProject("Openbravo", selectedRoot);
    const conversation = store.createConversation(project.id, "Nested modules");
    const turn = beginTurn(store, conversation.id, "turn-openbravo-root");
    const manager = new TurnGitArtifactManager(store, data);

    await manager.captureBefore({ turn, checkpointId: null });
    await manager.captureAfter({ turn, checkpointId: null });

    expect(store.turnGitArtifact(turn.id)).toMatchObject({
      status: "unavailable",
      completeness: "unavailable",
      repositoryIdentity: null,
      worktreeIdentity: null,
      absenceReason: "not-repository",
      files: [],
      insertions: 0,
      deletions: 0,
    });
    expect(git(firstModule, ["status", "--short"])).toContain("Application.java");
    expect(git(secondModule, ["status", "--short"])).toContain("Integration.java");
    store.close();
  });

  it("keeps a true Git-root pre-capture failure visible instead of classifying it as absence", async () => {
    const runtime = workspace();
    const turn = beginTurn(runtime.store, runtime.conversationId, "turn-capture-failure");
    const checkpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      1,
    );
    git(runtime.repository, ["update-ref", "-d", checkpoint.ref]);
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);

    await manager.captureBefore({ turn, checkpointId: checkpoint.id });

    expect(runtime.store.turnGitArtifact(turn.id)).toMatchObject({
      status: "unavailable",
      completeness: "unavailable",
      absenceReason: null,
      repositoryIdentity: null,
    });
    expect(runtime.store.turnGitArtifact(turn.id)?.failureReason)
      .not.toBe("This workspace is not a Git repository.");
    runtime.store.close();
  });

  it("bounds oversized patches and rejects tampered or out-of-artifact reads", async () => {
    const runtime = workspace();
    const turn = beginTurn(runtime.store, runtime.conversationId, "turn-bounded");
    const checkpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      1,
    );
    runtime.store.associateCheckpointWithTurn(
      checkpoint.id,
      runtime.conversationId,
      turn.runId,
      turn.id,
    );
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);
    await manager.captureBefore({ turn, checkpointId: checkpoint.id });
    writeFileSync(join(runtime.repository, "large.txt"), `${"bounded-data-".repeat(190_000)}\n`);
    await manager.captureAfter({ turn, checkpointId: checkpoint.id });

    const artifact = runtime.store.turnGitArtifact(turn.id);
    expect(artifact).toMatchObject({
      status: "partial",
      completeness: "truncated",
      patchState: "truncated",
      files: [expect.objectContaining({ path: "large.txt" })],
    });
    await expect(manager.turnDiff(turn.id, "../outside")).rejects.toThrow(
      "does not belong to this turn artifact",
    );
    const digest = artifact?.patchDigest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    writeFileSync(
      join(runtime.data, "turn-git-artifacts", `${digest}.gz`),
      "not a valid compressed patch",
    );
    await expect(manager.turnDiff(turn.id)).rejects.toThrow(
      "could not be read safely",
    );
    runtime.store.close();
  });

  it("distinguishes a bounded file summary from a truncated stored patch", async () => {
    const runtime = workspace();
    const turn = beginTurn(runtime.store, runtime.conversationId, "turn-many-files");
    const checkpoint = await checkpointFor(
      runtime.store,
      runtime.repository,
      runtime.data,
      runtime.conversationId,
      1,
    );
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);
    await manager.captureBefore({ turn, checkpointId: checkpoint.id });
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(
        join(runtime.repository, `bounded-${String(index).padStart(3, "0")}.txt`),
        `file ${index}\n`,
      );
    }

    await manager.captureAfter({ turn, checkpointId: checkpoint.id });

    expect(runtime.store.turnGitArtifact(turn.id)).toMatchObject({
      status: "partial",
      completeness: "truncated",
      patchState: "available",
      insertions: 201,
      deletions: 0,
      failureReason: "The historical file list or change totals reached their capture limit.",
    });
    expect(runtime.store.turnGitArtifact(turn.id)?.files).toHaveLength(200);
    runtime.store.close();
  });
});
