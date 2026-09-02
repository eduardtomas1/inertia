import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkpointOperations = vi.hoisted(() => ({
  createCheckpoint: vi.fn(),
}));
const artifactOperations = vi.hoisted(() => ({
  captureGitArtifactState: vi.fn(),
  compareGitSnapshots: vi.fn(),
}));

vi.mock("../../src/server/checkpoints", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/checkpoints")>(),
  createCheckpoint: checkpointOperations.createCheckpoint,
}));
vi.mock("../../src/server/git", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git")>(),
  captureGitArtifactState: artifactOperations.captureGitArtifactState,
  compareGitSnapshots: artifactOperations.compareGitSnapshots,
}));

import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";
import { removePortableFixture } from "../helpers/portable-provider-fixture";

const roots: string[] = [];
const beforeRef =
  "refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const afterRef =
  "refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
const repositoryIdentity = "a".repeat(64);
const worktreeIdentity = "b".repeat(64);
const beforeFingerprint = "c".repeat(64);
const afterFingerprint = "d".repeat(64);
const patchDigest = "e".repeat(64);
const terminationFailure = () => new GitError(
  "operation-failed",
  "Git stopped responding, and its process tree could not be confirmed stopped.",
);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "inertia-artifact-shutdown-"));
  const data = join(root, "data");
  const projectPath = join(root, "project");
  mkdirSync(data);
  mkdirSync(projectPath);
  const store = new RuntimeStore(join(data, "inertia.sqlite"), projectPath);
  const project = store.createProject("Artifact shutdown", projectPath);
  const conversation = store.createConversation(project.id, "Artifact shutdown");
  roots.push(root);
  return { data, store, conversation };
}

function turn(store: RuntimeStore, conversationId: string, id: string) {
  return store.beginAgentTurn({
    id,
    conversationId,
    runId: `run-${id}`,
    content: "Test artifact shutdown ownership",
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

function state() {
  return {
    root: "/project",
    branch: "main",
    repositoryIdentity,
    worktreeIdentity,
    fingerprint: afterFingerprint,
  };
}

function comparableArtifact(
  store: RuntimeStore,
  turnId: string,
  ref: string,
  complete = true,
): void {
  store.createTurnGitArtifact({
    turnId,
    repositoryIdentity,
    worktreeIdentity,
    branch: "main",
    beforeRef,
    beforeFingerprint,
    status: "pending",
    completeness: "partial",
  });
  if (!complete) return;
  store.completeTurnGitArtifact(turnId, {
    afterRef: ref,
    afterFingerprint,
    status: "ready",
    completeness: "complete",
    patchState: "available",
    patchDigest,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkpointOperations.createCheckpoint.mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    ref: afterRef,
  });
  artifactOperations.captureGitArtifactState.mockResolvedValue(state());
  artifactOperations.compareGitSnapshots.mockResolvedValue({
    patch: "",
    files: [],
    insertions: 0,
    deletions: 0,
    summaryTruncated: false,
    patchTruncated: false,
    truncated: false,
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

describe("turn Git artifact shutdown settlement", () => {
  it("retains a pre-capture process-tree failure until shutdown", async () => {
    const runtime = workspace();
    const agentTurn = turn(runtime.store, runtime.conversation.id, "pre-capture");
    const checkpoint = runtime.store.addCheckpoint({
      conversationId: runtime.conversation.id,
      ref: beforeRef,
      label: "Before turn",
      turnIndex: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
    const failure = terminationFailure();
    artifactOperations.captureGitArtifactState.mockRejectedValueOnce(failure);
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);

    await manager.captureBefore({ turn: agentTurn, checkpointId: checkpoint.id });
    await expect(manager.settleShutdown()).rejects.toBe(failure);
    expect(runtime.store.turnGitArtifact(agentTurn.id)).toMatchObject({
      status: "unavailable",
      failureReason: failure.message,
    });
    runtime.store.close();
  });

  it("retains a finalization process-tree failure until shutdown", async () => {
    const runtime = workspace();
    const agentTurn = turn(runtime.store, runtime.conversation.id, "finalize");
    comparableArtifact(runtime.store, agentTurn.id, beforeRef, false);
    const failure = terminationFailure();
    artifactOperations.compareGitSnapshots.mockRejectedValueOnce(failure);
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);

    await manager.finalize({ turn: agentTurn, checkpointId: null });
    await expect(manager.settleShutdown()).rejects.toBe(failure);
    expect(runtime.store.turnGitArtifact(agentTurn.id)).toMatchObject({
      status: "partial",
      patchState: "failed",
      failureReason: failure.message,
    });
    runtime.store.close();
  });

  it("cancels an active historical comparison when shutdown begins", async () => {
    const runtime = workspace();
    const earlier = turn(runtime.store, runtime.conversation.id, "earlier");
    const later = turn(runtime.store, runtime.conversation.id, "later");
    comparableArtifact(runtime.store, earlier.id, beforeRef);
    comparableArtifact(runtime.store, later.id, afterRef);
    let comparisonSignal: AbortSignal | undefined;
    artifactOperations.compareGitSnapshots.mockImplementation(
      (_path, _before, _after, options) => new Promise((_resolve, reject) => {
        comparisonSignal = options.signal;
        options.signal?.addEventListener("abort", () => reject(new GitError(
          "timeout",
          "Git inspection was cancelled.",
        )), { once: true });
      }),
    );
    const manager = new TurnGitArtifactManager(runtime.store, runtime.data);

    const comparison = manager.compare(earlier.id, later.id);
    const rejection = expect(comparison).rejects.toThrow(
      "Git inspection was cancelled.",
    );
    await vi.waitFor(() => expect(comparisonSignal).toBeDefined());
    manager.beginShutdown(Date.now() + 1_000);
    await rejection;
    expect(comparisonSignal?.aborted).toBe(true);
    await expect(manager.settleShutdown()).resolves.toBeUndefined();
    runtime.store.close();
  });
});
