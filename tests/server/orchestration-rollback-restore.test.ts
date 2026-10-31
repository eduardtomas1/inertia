// @inertia-test-suite portable
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointError, restoreCheckpoint } from "../../src/server/checkpoints";
import { RuntimeStore } from "../../src/server/database";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import { restoreConversationCheckpoint } from "../../src/server/runtime/checkpoint-restoration";
import { prepareForkSession } from "../../src/server/runtime/fork-session-service";
import { rollbackConversationHistory, type HistoryRollbackDependencies } from "../../src/server/runtime/history-rollback-service";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";
import { clientCommandSchema } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { conversationRollbackResultSchema } from "../../src/shared/orchestration-history";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  turnControllerTestIdentity, type TurnControllerTestRuntime } from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

const wait = { timeout: 20_000, interval: 20 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function gitRuntime(): Promise<TurnControllerTestRuntime> {
  let manager!: TurnGitArtifactManager;
  const runtime = await createTurnControllerTestRuntime({
    createTurnCheckpoint: (turn, signal) => manager.createTurnCheckpoint(turn, signal),
    captureGitBefore: (input) => manager.captureBefore(input),
    captureGitArtifacts: (input) => manager.finalize(input),
  });
  manager = new TurnGitArtifactManager(runtime.store, join(runtime.directory, "data"));
  git(runtime.workspace, "init", "-b", "main");
  git(runtime.workspace, "config", "core.autocrlf", "false");
  git(runtime.workspace, "config", "user.name", "Inertia Test");
  git(runtime.workspace, "config", "user.email", "test@inertia.local");
  writeFileSync(join(runtime.workspace, "notes.txt"), "base notes\n");
  writeFileSync(join(runtime.workspace, "base.txt"), "base\n");
  git(runtime.workspace, "add", "notes.txt", "base.txt");
  git(runtime.workspace, "commit", "-m", "base");
  return runtime;
}

function read(runtime: TurnControllerTestRuntime, name: string): string {
  return readFileSync(join(runtime.workspace, name), "utf8").replaceAll("\r\n", "\n");
}

async function finish(runtime: TurnControllerTestRuntime, label: string, files: Record<string, string>,
  conversationId = runtime.conversationId, artifacts = true) {
  const runs = runtime.provider.runCount;
  const queued = runtime.controller.queue({ conversationId, content: `${label} request`, turnCheckpoint: artifacts });
  runtime.controller.start(queued.turn.id);
  await vi.waitFor(() => expect(runtime.provider.runCount).toBe(runs + 1), wait);
  if (conversationId === runtime.conversationId) {
    for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
      type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: null, nativeTurnId: label,
      persistedHeadId: phase === "settled" ? label : null, phase });
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(runtime.workspace, name), content);
  runtime.provider.resolve({ text: `${label} answer`, sessionId: conversationId === runtime.conversationId ? "source-native" : `${label}-native` });
  await vi.waitFor(() => expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed"), wait);
  if (artifacts) await vi.waitFor(() => expect(runtime.store.turnGitArtifact(queued.turn.id)?.status).toBe("ready"), wait);
  return queued.turn;
}

type NativeExecute = (request: NativeConversationRequest) => Promise<NativeConversationResult>;

function dependencies(runtime: TurnControllerTestRuntime, execute: NativeExecute,
  restoreCheckpoint?: HistoryRollbackDependencies["restoreCheckpoint"]) {
  return { store: runtime.store, turns: runtime.controller,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    providers: { resolveModelRoute: runtime.provider.resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
      nativeConversation: vi.fn(execute) }, ...(restoreCheckpoint ? { restoreCheckpoint } : {}) };
}

const unsupported: NativeExecute = async (request) => ({ operationId: request.operationId, identity: request.source.identity,
  status: "unsupported", reason: "native-history-control-unavailable" });

function source(conversationId: string, turnId: string | null, restoreFiles = true) {
  const requestId = randomUUID();
  return { actorId: "human", commandId: requestId,
    command: { type: "conversation.rollback", requestId, payload: { conversationId, turnId, restoreFiles } } };
}

function rollback(deps: ReturnType<typeof dependencies>, conversationId: string, turnId: string | null,
  request = source(conversationId, turnId)) {
  return rollbackConversationHistory(deps, { conversationId, turnId, restoreFiles: request.command.payload.restoreFiles,
    source: request }, new AbortController().signal);
}

function filesRecord(store: RuntimeStore, rollbackId: string | null) {
  return rollbackId ? store.orchestration.events.projection("rollback-files", rollbackId)?.value ?? null : null;
}

describe("chat rollback with file restore", () => {
  it("restores the rolled-back turns' files after a portable rollback and replays the same outcome after a rebuild", async () => {
    const runtime = await gitRuntime();
    try {
      const first = await finish(runtime, "first", { "notes.txt": "retained\n" });
      const second = await finish(runtime, "second", { "notes.txt": "rolled back\n", "created.txt": "new\n" });
      await finish(runtime, "third", { "base.txt": "changed base\n" });
      const deps = dependencies(runtime, unsupported);
      const checkpoints = runtime.store.checkpointCount(runtime.conversationId);
      const request = source(runtime.conversationId, first.id);
      const wire = { ...request.command, payload: { conversationId: randomUUID(), turnId: randomUUID(), restoreFiles: true } };
      expect(clientCommandSchema.safeParse(wire).success).toBe(true);
      expect(clientCommandSchema.safeParse({ ...wire, payload: { ...wire.payload, restoreFiles: "yes" } }).success).toBe(false);
      const result = await rollback(deps, runtime.conversationId, first.id, request);
      expect(conversationRollbackResultSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({ transfer: "portable", rolledBackTurns: 2, retainedTurnId: first.id,
        files: { outcome: "restored" } });
      expect(result.files.message).toBe("Restored 3 files changed by the rolled-back turns. A recovery checkpoint was saved first."
        + " Removed 1 file they created.");
      expect(read(runtime, "notes.txt")).toBe("retained\n");
      expect(read(runtime, "base.txt")).toBe("base\n");
      expect(existsSync(join(runtime.workspace, "created.txt"))).toBe(false);
      expect(runtime.store.checkpointCount(runtime.conversationId)).toBe(checkpoints + 1);
      expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(true);
      const record = filesRecord(runtime.store, result.rollbackId) as { recoveryCheckpointId: string };
      expect(record).toMatchObject({ state: "restored", message: result.files.message });
      expect(runtime.store.checkpoint(record.recoveryCheckpointId)).toMatchObject({ turnId: first.id, label: "Before file restore" });
      writeFileSync(join(runtime.workspace, "notes.txt"), "edited after restore\n");
      await expect(rollback(deps, runtime.conversationId, first.id, request)).resolves.toEqual(result);
      runtime.store.orchestration.events.rebuildProjections();
      await expect(rollback(deps, runtime.conversationId, first.id, request)).resolves.toEqual(result);
      expect(read(runtime, "notes.txt")).toBe("edited after restore\n");
      const plain = source(runtime.conversationId, first.id, false);
      await expect(rollback(deps, runtime.conversationId, first.id, plain)).resolves.toMatchObject({ transfer: "unchanged",
        files: { outcome: "unchanged", message: null } });
    } finally { runtime.store.close(); }
  }, 120_000);

  it("removes files the rolled-back turns created only while unchanged, keeps edited and unrecorded ones, and stays reversible", async () => {
    const runtime = await gitRuntime();
    try {
      const first = await finish(runtime, "first", { "notes.txt": "retained\n" });
      await finish(runtime, "second", { "notes.txt": "rolled back\n", "made.txt": "made\n", "edited.txt": "agent\n" });
      writeFileSync(join(runtime.workspace, "manual.txt"), "mine\n");
      await finish(runtime, "third", { "manual.txt": "mine plus agent\n" });
      writeFileSync(join(runtime.workspace, "edited.txt"), "agent plus user\n");
      const result = await rollback(dependencies(runtime, unsupported), runtime.conversationId, first.id);
      expect(result.files).toEqual({ outcome: "restored", message: "Restored 4 files changed by the rolled-back turns."
        + " A recovery checkpoint was saved first. Removed 1 file they created."
        + " Kept 2 files that changed afterwards or that they did not create: edited.txt, manual.txt." });
      expect(read(runtime, "notes.txt")).toBe("retained\n");
      expect(existsSync(join(runtime.workspace, "made.txt"))).toBe(false);
      expect(read(runtime, "edited.txt")).toBe("agent plus user\n");
      expect(read(runtime, "manual.txt")).toBe("mine plus agent\n");
      const { recoveryCheckpointId } = filesRecord(runtime.store, result.rollbackId) as { recoveryCheckpointId: string };
      const recovery = runtime.store.checkpoint(recoveryCheckpointId);
      expect(recovery).toMatchObject({ turnId: first.id, label: "Before file restore" });
      await restoreCheckpoint(runtime.workspace, recovery.ref, runtime.conversationId);
      expect(read(runtime, "made.txt")).toBe("made\n");
      expect(read(runtime, "notes.txt")).toBe("rolled back\n");
    } finally { runtime.store.close(); }
  }, 120_000);

  it("attributes the checkpoint restore recovery point to the chat's latest checkpointed turn", async () => {
    const runtime = await gitRuntime();
    try {
      await finish(runtime, "first", { "notes.txt": "first\n" });
      const second = await finish(runtime, "second", { "notes.txt": "second\n" });
      const settled = runtime.store.agentTurn(second.id);
      expect(settled.checkpointId).not.toBeNull();
      const saved: string[] = [];
      const recovery = await restoreConversationCheckpoint(runtime.store, runtime.store.checkpoint(settled.checkpointId!),
        ({ id }) => { saved.push(id); });
      expect(saved).toEqual([recovery.id]);
      expect(runtime.store.checkpoint(recovery.id)).toMatchObject({ turnId: second.id, label: "Before checkpoint restore" });
      expect(read(runtime, "notes.txt")).toBe("first\n");
      const unattributed = await restoreConversationCheckpoint(runtime.store, runtime.store.checkpoint(settled.checkpointId!),
        () => undefined, { turnId: null, label: "Before file restore" });
      expect(unattributed.turnId).toBeNull();
    } finally { runtime.store.close(); }
  }, 120_000);

  it("restores files only after a completed native rollback", async () => {
    const runtime = await gitRuntime();
    try {
      const first = await finish(runtime, "first", { "notes.txt": "retained\n" });
      await finish(runtime, "second", { "notes.txt": "rolled back\n" });
      let restoredBeforeNative = true;
      const deps = dependencies(runtime, async (request) => {
        restoredBeforeNative = read(runtime, "notes.txt") === "retained\n";
        return { operationId: request.operationId, identity: request.source.identity, status: "completed",
          effect: "native-revert", backing: { nativeConversationId: "source-native", headId: "first", persistedHeadId: "first" } };
      });
      const result = await rollback(deps, runtime.conversationId, first.id);
      expect(restoredBeforeNative).toBe(false);
      expect(result).toMatchObject({ transfer: "native", rolledBackTurns: 1, files: { outcome: "restored" } });
      expect(read(runtime, "notes.txt")).toBe("retained\n");
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
    } finally { runtime.store.close(); }
  }, 120_000);

  it("restores every file change after the chat start when rolling back to the start", async () => {
    const runtime = await gitRuntime();
    try {
      await finish(runtime, "first", { "notes.txt": "first\n" });
      await finish(runtime, "second", { "base.txt": "second\n" });
      const result = await rollback(dependencies(runtime, unsupported), runtime.conversationId, null);
      expect(result).toMatchObject({ transfer: "portable", retainedTurnId: null, rolledBackTurns: 2,
        files: { outcome: "restored" } });
      expect(read(runtime, "notes.txt")).toBe("base notes\n");
      expect(read(runtime, "base.txt")).toBe("base\n");
    } finally { runtime.store.close(); }
  }, 120_000);

  it("refuses the file restore when another chat changed the workspace, keeping the context rollback", async () => {
    const runtime = await gitRuntime();
    try {
      const first = await finish(runtime, "first", { "notes.txt": "retained\n" });
      const second = await finish(runtime, "second", { "notes.txt": "rolled back\n" });
      const parent = runtime.store.conversation(runtime.conversationId);
      const other = runtime.store.createConversation(parent.projectId, "Other chat",
        { providerId: "codex", model: "gpt-test", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised" });
      await finish(runtime, "other", { "other.txt": "other chat\n" }, other.id);
      const result = await rollback(dependencies(runtime, unsupported), runtime.conversationId, first.id);
      expect(result).toMatchObject({ transfer: "portable", rolledBackTurns: 1, files: { outcome: "refused" } });
      expect(result.files.message).toContain("Another chat worked in this workspace");
      expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(true);
      expect(read(runtime, "notes.txt")).toBe("rolled back\n");
      expect(read(runtime, "other.txt")).toBe("other chat\n");
      expect(filesRecord(runtime.store, result.rollbackId)).toMatchObject({ state: "refused" });
    } finally { runtime.store.close(); }
  }, 120_000);

  it("refuses the file restore when files outside the rolled-back turns changed and reports turns without file changes", async () => {
    const runtime = await gitRuntime();
    try {
      const first = await finish(runtime, "first", { "notes.txt": "retained\n" });
      const second = await finish(runtime, "second", { "notes.txt": "rolled back\n" });
      writeFileSync(join(runtime.workspace, "base.txt"), "manual edit\n");
      const deps = dependencies(runtime, unsupported);
      const result = await rollback(deps, runtime.conversationId, first.id);
      expect(result).toMatchObject({ transfer: "portable", files: { outcome: "refused" } });
      expect(result.files.message).toContain("base.txt");
      expect(read(runtime, "notes.txt")).toBe("rolled back\n");
      expect(read(runtime, "base.txt")).toBe("manual edit\n");
      expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(true);
      await finish(runtime, "quiet", {});
      await expect(rollback(deps, runtime.conversationId, first.id)).resolves.toMatchObject({ transfer: "portable",
        files: { outcome: "unchanged", message: "The rolled-back turns recorded no file changes." } });
    } finally { runtime.store.close(); }
  }, 120_000);

  it("records a failed restore durably after the context rollback applied, across a restart", async () => {
    const runtime = await gitRuntime();
    const first = await finish(runtime, "first", { "notes.txt": "retained\n" });
    const second = await finish(runtime, "second", { "notes.txt": "rolled back\n" });
    const restore = vi.fn<NonNullable<HistoryRollbackDependencies["restoreCheckpoint"]>>(async (store, checkpoint, persisted, attribution) => {
      persisted(store.addCheckpoint({ conversationId: checkpoint.conversationId, turnId: attribution!.turnId, ref: checkpoint.ref,
        label: attribution!.label, turnIndex: 99, filesChanged: 0, insertions: 0, deletions: 0 }));
      throw new CheckpointError("Git could not restore the checkpoint.");
    });
    const deps = dependencies(runtime, unsupported, restore);
    const request = source(runtime.conversationId, first.id);
    const result = await rollback(deps, runtime.conversationId, first.id, request);
    expect(result).toMatchObject({ transfer: "portable", rolledBackTurns: 1, files: { outcome: "failed" } });
    expect(result.files.message).toContain("recovery checkpoint");
    expect(result.files.message).toContain("Git could not restore the checkpoint.");
    expect(restore).toHaveBeenCalledOnce();
    expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(true);
    expect(read(runtime, "notes.txt")).toBe("rolled back\n");
    runtime.store.close();
    const store = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(filesRecord(store, result.rollbackId)).toMatchObject({ state: "failed", message: result.files.message,
        recoveryCheckpointId: expect.any(String) });
      store.orchestration.events.rebuildProjections();
      await expect(rollbackConversationHistory({ ...deps, store }, { conversationId: runtime.conversationId, turnId: first.id,
        restoreFiles: true, source: request }, new AbortController().signal)).resolves.toEqual(result);
      expect(restore).toHaveBeenCalledOnce();
    } finally { store.close(); }
  }, 120_000);

  it("never attempts a file restore for an uncertain native rollback, even after cleanup applies it portably", async () => {
    const runtime = await gitRuntime();
    const first = await finish(runtime, "first", { "notes.txt": "retained\n" });
    const second = await finish(runtime, "second", { "notes.txt": "rolled back\n" });
    const restore = vi.fn<NonNullable<HistoryRollbackDependencies["restoreCheckpoint"]>>(async (_store, checkpoint) => checkpoint);
    let operationId = "";
    const deps = dependencies(runtime, async (request) => { operationId = request.operationId; throw new Error("Connection lost after dispatch"); },
      restore);
    const request = source(runtime.conversationId, first.id);
    await expect(rollback(deps, runtime.conversationId, first.id, request)).rejects.toThrow("Connection lost");
    expect(runtime.store.orchestration.nativeControls.get(operationId)?.state).toBe("uncertain");
    expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(false);
    expect(filesRecord(runtime.store, operationId)).toBeNull();
    runtime.store.close();
    const store = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      const runtimeId = store.orchestration.nativeControls.get(operationId)!.runtimeId;
      store.orchestration.nativeControls.reconcileCleanup({ confirmedRuntimeGenerationIds: new Set([runtimeId]),
        currentSystemBootId: "boot", priorBootCleanupConfirmed: false });
      const replayed = await rollbackConversationHistory({ ...deps, store }, { conversationId: runtime.conversationId,
        turnId: first.id, restoreFiles: true, source: request }, new AbortController().signal);
      expect(replayed).toMatchObject({ transfer: "portable", reason: "cleanup-confirmed", files: { outcome: "unchanged" } });
      expect(replayed.files.message).toContain("not restored");
      expect(store.orchestration.history.rolledBack(second.id)).toBe(true);
      expect(restore).not.toHaveBeenCalled();
      expect(read(runtime, "notes.txt")).toBe("rolled back\n");
      expect(filesRecord(store, operationId)).toBeNull();
    } finally { store.close(); }
  }, 120_000);

  it("refuses to roll back a chat whose Duo still needs attention and leaves the paired chat untouched once settled", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const projectId = runtime.store.conversation(runtime.conversationId).projectId;
      const launchId = randomUUID();
      const ids = [randomUUID(), randomUUID()] as const;
      runtime.store.createPairedLaunch(launchId, [0, 1].map((ordinal) => ({ ordinal: ordinal as 0 | 1, projectId,
        plannedConversationId: ids[ordinal]!, plannedWorktreePath: null, plannedBranch: null, ownsWorktree: false })) as never);
      const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", alias: "GPT Test", reasoningEffort: "high" });
      const plan = (id: string, title: string) => ({ projectId, title, options: { id, providerId: "codex" as const,
        modelSelection: selection, interactionMode: "build" as const, accessMode: "supervised" as const, worktreePath: null, activate: false } });
      const [duo, paired] = runtime.store.createDuoConversations(launchId, [plan(ids[0], "Duo left"), plan(ids[1], "Duo right")], null).sides;
      const deps = dependencies(runtime, unsupported);
      await expect(rollback(deps, duo.id, null, source(duo.id, null, false))).rejects.toThrow("belongs to a Duo");
      runtime.store.failPairedLaunch(launchId, "failed", "The Duo stopped.");
      await finish(runtime, "duo", {}, duo.id, false);
      const before = runtime.store.conversation(paired.id);
      await expect(rollback(deps, duo.id, null, source(duo.id, null, false))).resolves.toMatchObject({ transfer: "portable",
        rolledBackTurns: 1, files: { outcome: "unchanged", message: null } });
      expect(runtime.store.conversation(paired.id)).toEqual(before);
      expect(runtime.store.orchestration.history.cursor(paired.id)).toBeNull();
    } finally { runtime.store.close(); }
  }, 60_000);
});

describe("runtime command identities", () => {
  it("prepares two forks of one busy source portably in the same runtime and still replays both fork receipts", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first", {}, runtime.conversationId, false);
      const parent = runtime.store.conversation(runtime.conversationId);
      const input = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: first.id, activate: false };
      const create = (commandId: string) => runtime.store.orchestration.forks.create(input, { actorId: "human", commandId, command: { ...input } });
      const forks = [create("fork-busy-a"), create("fork-busy-b")];
      expect(runtime.store.orchestration.events.revision(forks[0]!.id)).toBe(runtime.store.orchestration.events.revision(forks[1]!.id));
      const deps = dependencies(runtime, unsupported);
      const lease = await runtime.controller.acquireTurnAdmission(parent.id, 100);
      expect(lease).not.toBeNull();
      try {
        for (const child of forks) await prepareForkSession(deps, child.id, new AbortController().signal);
      } finally { lease!.release(); }
      for (const child of forks) {
        expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("portable");
        const selected = runtime.store.orchestration.events.readEvents({ projectId: child.projectId, threadId: child.id, limit: 500 })
          .filter((event) => event.type === "fork.portable-selected").map((event) => event.payload);
        expect(selected).toEqual([{ reason: "native-source-busy" }]);
      }
      expect(create("fork-busy-a").id).toBe(forks[0]!.id);
      expect(create("fork-busy-b").id).toBe(forks[1]!.id);
      for (const child of forks) await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
    } finally { runtime.store.close(); }
  }, 60_000);
});
