import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import { RuntimeStore } from "../../src/server/database";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { createConversationCommandHandler, type ConversationCommandDependencies } from "../../src/server/runtime/commands/conversation-commands";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import { PROVIDER_HANDOFF_FILES_LABEL } from "../../src/server/persistence/provider-handoff-files";
import type { ServerEvent, TurnGitArtifactFile } from "../../src/shared/contracts";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime } from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

async function finish(runtime: TurnControllerTestRuntime, label: string, conversationId = runtime.conversationId) {
  const queued = runtime.controller.queue({ conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  if (conversationId === runtime.conversationId) {
    for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
      type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: null, nativeTurnId: label,
      persistedHeadId: phase === "settled" ? label : null, phase });
  }
  runtime.provider.resolve({ text: `${label} answer`, sessionId: conversationId === runtime.conversationId ? "source-native" : "child-native" });
  await flushTurnControllerTestPromises();
  return queued.turn;
}

function dependencies(runtime: TurnControllerTestRuntime, execute: (request: NativeConversationRequest) => Promise<NativeConversationResult>) {
  return { store: runtime.store, turns: runtime.controller,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    providers: { resolveModelRoute: runtime.provider.resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
      nativeConversation: vi.fn(execute) } };
}

function completed(request: NativeConversationRequest, effect: "native-revert" | "resume-cursor",
  backing: Extract<NativeConversationResult, { status: "completed" }>["backing"]): NativeConversationResult {
  return { operationId: request.operationId, identity: request.source.identity, status: "completed", effect, backing };
}

const cursor = { kind: "resume-cursor" as const, nativeConversationId: "source-native", resumeSessionAt: "first" };

let requestSequence = 0;

function rollbackSource(conversationId: string, turnId: string | null, commandId = `rollback-request-${++requestSequence}`) {
  return { actorId: "human", commandId,
    command: { type: "conversation.rollback", requestId: commandId, payload: { conversationId, turnId } } };
}

function rollback(runtime: TurnControllerTestRuntime, deps: ReturnType<typeof dependencies>, turnId: string | null,
  conversationId = runtime.conversationId, source = rollbackSource(conversationId, turnId)) {
  return rollbackConversationHistory(deps, { conversationId, turnId, source }, new AbortController().signal);
}

function send(runtime: TurnControllerTestRuntime, content: string, conversationId = runtime.conversationId) {
  const queued = runtime.controller.queue({ conversationId, content });
  runtime.controller.start(queued.turn.id);
  return queued.turn;
}

function recordChangedFile(runtime: TurnControllerTestRuntime, turnId: string, path: string) {
  const file: TurnGitArtifactFile = { path, previousPath: null, status: "modified", insertions: 3, deletions: 1,
    binary: false, untracked: false, staged: false, unstaged: true, indexStatus: ".", worktreeStatus: "M" };
  const createdAt = new Date().toISOString();
  runtime.store.createTurnGitArtifact({ turnId, status: "pending", createdAt });
  runtime.store.completeTurnGitArtifact(turnId, { files: [file], insertions: 3, deletions: 1,
    status: "ready", completeness: "complete", updatedAt: createdAt });
}

describe("deferred native history rollback", () => {
  it("persists intent before a native revert, fences the chat, then resumes only the retained native history", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const second = await finish(runtime, "second");
      const third = await finish(runtime, "third");
      let release!: (value: NativeConversationResult) => void;
      let request!: NativeConversationRequest;
      const deps = dependencies(runtime, (value) => { request = value; return new Promise((resolve) => { release = resolve; }); });
      const pending = rollback(runtime, deps, first.id);
      await vi.waitFor(() => expect(deps.providers.nativeConversation).toHaveBeenCalledOnce());
      expect(request).toMatchObject({ kind: "rollback", boundary: { kind: "turn", nativeTurnId: "first" },
        source: { nativeConversationId: "source-native", expectedHeadId: "third",
          identity: { conversationId: runtime.conversationId, projectId: runtime.store.conversation(runtime.conversationId).projectId } } });
      expect(runtime.store.orchestration.nativeControls.get(request.operationId)).toMatchObject({ state: "running",
        rollback: { retainedTurnId: first.id, rolledBackTurnIds: [second.id, third.id] } });
      expect(runtime.store.orchestration.effects.get(`native-control:${request.operationId}`)).toMatchObject({ kind: "native.rollback", state: "running" });
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId, content: "Race" })).toThrow("being prepared");
      expect(runtime.store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(true);
      expect(() => runtime.store.updateConversation(runtime.conversationId, { model: "gpt-next" })).toThrow("cleanup-pending");
      release(completed(request, "native-revert", { nativeConversationId: "source-native", headId: "first", persistedHeadId: "first" }));
      await expect(pending).resolves.toMatchObject({ transfer: "native", rolledBackTurns: 2, retainedTurnId: first.id });
      expect(runtime.store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(false);
      expect([first, second, third].map(({ id }) => runtime.store.orchestration.history.rolledBack(id))).toEqual([false, true, true]);
      const instance = request.source.identity.providerInstanceId;
      expect(runtime.store.orchestration.history.physicalHead({ threadId: runtime.conversationId, providerInstanceId: instance,
        workspaceKey: runtime.workspace, nativeConversationId: "source-native" })).toBe("first");
      const parent = runtime.store.conversation(runtime.conversationId);
      const forkInput = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: third.id };
      expect(() => runtime.store.orchestration.forks.create(forkInput, { actorId: "human", commandId: "fork-old", command: { ...forkInput } }))
        .toThrow("rolled back");
      send(runtime, "Continue after rollback");
      expect(runtime.provider.input?.sessionId).toBe("source-native");
      expect(runtime.provider.input?.nativeContinuation).toBeUndefined();
      expect(runtime.provider.input?.prompt).not.toContain("second answer");
      runtime.provider.resolve({ text: "Continued", sessionId: "source-native" });
      await flushTurnControllerTestPromises();
      const before = runtime.store.orchestration.history.cursor(runtime.conversationId);
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.history.cursor(runtime.conversationId)).toEqual(before);
      expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(true);
    } finally { runtime.store.close(); }
  });

  it("keeps the physical head separate from a deferred cursor and carries the cursor into exactly the next matching turn", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const second = await finish(runtime, "second");
      await finish(runtime, "third");
      const deps = dependencies(runtime, async (request) => completed(request, "resume-cursor",
        { nativeConversationId: "source-native", headId: "first", persistedHeadId: "third", continuation: cursor }));
      await expect(rollback(runtime, deps, first.id)).resolves.toMatchObject({ transfer: "native" });
      const state = runtime.store.orchestration.history.cursor(runtime.conversationId)!;
      expect(state).toMatchObject({ physicalHeadId: "third", effectiveHeadId: "first", continuation: cursor, continuationState: "pending" });
      expect(runtime.store.orchestration.history.physicalHead({ threadId: runtime.conversationId, providerInstanceId: state.providerInstanceId!,
        workspaceKey: runtime.workspace, nativeConversationId: "source-native" })).toBe("third");
      await expect(rollback(runtime, deps, second.id)).rejects.toThrow("already rolled back");
      await expect(rollback(runtime, deps, first.id)).resolves.toMatchObject({ transfer: "unchanged", rolledBackTurns: 0 });
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
      const next = send(runtime, "Resume at cursor");
      expect(runtime.provider.input).toMatchObject({ sessionId: "source-native", nativeContinuation: cursor });
      expect(runtime.store.orchestration.history.cursor(runtime.conversationId)).toMatchObject({ continuationState: "dispatched", runId: next.runId });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Resumed" });
      expect(runtime.store.orchestration.history.cursor(runtime.conversationId)?.continuationState).toBe("consumed");
      runtime.provider.resolve({ text: "Resumed", sessionId: "source-native" });
      await flushTurnControllerTestPromises();
      send(runtime, "Plain follow-up");
      expect(runtime.provider.input?.sessionId).toBe("source-native");
      expect(runtime.provider.input?.nativeContinuation).toBeUndefined();
      runtime.provider.resolve({ text: "Done", sessionId: "source-native" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it("treats an unacknowledged dispatched cursor as uncertain and continues from portable retained history", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      await finish(runtime, "second");
      const deps = dependencies(runtime, async (request) => completed(request, "resume-cursor",
        { nativeConversationId: "source-native", headId: "first", persistedHeadId: "second", continuation: cursor }));
      await rollback(runtime, deps, first.id);
      send(runtime, "Ambiguous resume");
      expect(runtime.provider.input?.nativeContinuation).toEqual(cursor);
      runtime.provider.resolve({ status: "failed" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.history.cursor(runtime.conversationId)?.continuationState).toBe("uncertain");
      send(runtime, "Fresh after ambiguity");
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.nativeContinuation).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("first answer");
      expect(runtime.provider.input?.prompt).not.toContain("second answer");
      runtime.provider.resolve({ text: "Fresh", sessionId: "replacement-native" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it("falls back to portable history honestly, retires stale backings and keeps inherited fork history", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      await finish(runtime, "second");
      const deps = dependencies(runtime, async (request) => ({ operationId: request.operationId, identity: request.source.identity,
        status: "unsupported", reason: "native-history-control-unavailable" }));
      await expect(rollback(runtime, deps, first.id)).resolves.toMatchObject({ transfer: "portable", reason: "unsupported" });
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBeNull();
      const fourth = send(runtime, "fourth request");
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("first answer");
      expect(runtime.provider.input?.prompt).not.toContain("second answer");
      runtime.provider.resolve({ text: "fourth answer", sessionId: "renewed-native" });
      await flushTurnControllerTestPromises();
      const parent = runtime.store.conversation(runtime.conversationId);
      const input = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: fourth.id, activate: false };
      const child = runtime.store.orchestration.forks.create(input, { actorId: "human", commandId: "fork-after", command: { ...input } });
      const inherited = runtime.store.orchestration.forks.history(child.id, 0, 100).parts.map(({ text }) => text).join("\n");
      expect(inherited).toContain("first answer");
      expect(inherited).toContain("fourth answer");
      expect(inherited).not.toContain("second answer");
      await finish(runtime, "child-one", child.id);
      await expect(rollback(runtime, deps, null, child.id)).resolves.toMatchObject({ transfer: "portable", reason: "native-start-unavailable" });
      send(runtime, "child after reset", child.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("fourth answer");
      expect(runtime.provider.input?.prompt).not.toContain("child-one answer");
      runtime.provider.resolve({ text: "Child done" });
      await flushTurnControllerTestPromises();
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
    } finally { runtime.store.close(); }
  });

  it("carries retained turns' file changes as per-turn items and leaves rolled-back ones out of fresh-session and provider-switch handoffs", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      recordChangedFile(runtime, first.id, "src/retained.ts");
      const second = await finish(runtime, "second");
      recordChangedFile(runtime, second.id, "src/rolled-back.ts");
      const deps = dependencies(runtime, async (request) => ({ operationId: request.operationId, identity: request.source.identity,
        status: "unsupported", reason: "native-history-control-unavailable" }));
      await expect(rollback(runtime, deps, first.id)).resolves.toMatchObject({ transfer: "portable", reason: "unsupported" });
      send(runtime, "fresh request");
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).not.toContain(PROVIDER_HANDOFF_FILES_LABEL);
      expect(runtime.provider.input?.prompt).toContain("File change (modified): src/retained.ts");
      expect(runtime.provider.input?.prompt).not.toContain("src/rolled-back.ts");
      runtime.provider.resolve({ text: "fresh answer", sessionId: "renewed-native" });
      await flushTurnControllerTestPromises();
      await createConversationCommandHandler({ ...deps, backendProfileController: { isExternalSelection: () => false,
        validateSelection: (selection: unknown) => selection, supportsNativeFastModeControl: () => false } } as unknown as ConversationCommandDependencies)({} as never, {
        type: "conversation.update", requestId: "22222222-2222-4222-8222-222222222222",
        payload: { conversationId: runtime.conversationId,
          modelSelection: modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "claude" })) } });
      send(runtime, "switched request");
      expect(runtime.provider.input?.providerId).toBe("claude");
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).not.toContain(PROVIDER_HANDOFF_FILES_LABEL);
      expect(runtime.provider.input?.prompt).toContain("File change (modified): src/retained.ts");
      expect(runtime.provider.input?.prompt).not.toContain("src/rolled-back.ts");
      runtime.provider.resolve({ text: "switched answer", sessionId: "claude-native" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it("keeps an ambiguous native rollback fenced through restart until exact cleanup evidence applies it portably", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const first = await finish(runtime, "first");
    const second = await finish(runtime, "second");
    let request!: NativeConversationRequest;
    const deps = dependencies(runtime, async (value) => { request = value; throw new Error("Connection lost after dispatch"); });
    await expect(rollback(runtime, deps, first.id)).rejects.toThrow("Connection lost");
    expect(runtime.store.orchestration.nativeControls.get(request.operationId)?.state).toBe("uncertain");
    expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(false);
    await expect(rollback(runtime, deps, first.id)).rejects.toThrow("wait for cleanup");
    runtime.store.close();
    const store = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      const control = store.orchestration.nativeControls.get(request.operationId)!;
      expect(store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(true);
      store.orchestration.nativeControls.reconcileCleanup({ confirmedRuntimeGenerationIds: new Set(["unrelated"]),
        currentSystemBootId: "boot", priorBootCleanupConfirmed: false });
      expect(store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(true);
      store.orchestration.nativeControls.reconcileCleanup({ confirmedRuntimeGenerationIds: new Set([control.runtimeId]),
        currentSystemBootId: "boot", priorBootCleanupConfirmed: false });
      expect(store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(false);
      expect(store.orchestration.history.rolledBack(second.id)).toBe(true);
      expect(store.orchestration.history.cursor(runtime.conversationId)).toMatchObject({ transfer: "portable", reason: "cleanup-confirmed" });
      expect(store.conversation(runtime.conversationId).providerSessionId).toBeNull();
      expect(store.orchestration.effects.claim(`native-control:${control.id}`)).toBeNull();
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
    } finally { store.close(); }
  });

  it("replays the original rollback outcome for a repeated request instead of rolling back newer work", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const second = await finish(runtime, "second");
      const deps = dependencies(runtime, async (request) => completed(request, "native-revert",
        { nativeConversationId: "source-native", headId: "first", persistedHeadId: "first" }));
      const source = rollbackSource(runtime.conversationId, first.id, "lost-ack-request");
      const original = await rollback(runtime, deps, first.id, runtime.conversationId, source);
      expect(original).toMatchObject({ transfer: "native", rolledBackTurns: 1, retainedTurnId: first.id });
      const later = await finish(runtime, "later");
      await expect(rollback(runtime, deps, first.id, runtime.conversationId, source)).resolves.toEqual(original);
      expect(runtime.store.orchestration.history.rolledBack(later.id)).toBe(false);
      expect(runtime.store.orchestration.history.rolledBack(second.id)).toBe(true);
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
      const unchangedSource = rollbackSource(runtime.conversationId, later.id, "unchanged-request");
      const unchanged = await rollback(runtime, deps, later.id, runtime.conversationId, unchangedSource);
      expect(unchanged).toMatchObject({ transfer: "unchanged", rolledBackTurns: 0 });
      await finish(runtime, "after-unchanged");
      await expect(rollback(runtime, deps, later.id, runtime.conversationId, unchangedSource)).resolves.toEqual(unchanged);
      await expect(rollbackConversationHistory(deps, { conversationId: runtime.conversationId, turnId: second.id,
        source: { ...source, command: { ...source.command, payload: { conversationId: runtime.conversationId, turnId: second.id } } } },
      new AbortController().signal)).rejects.toThrow("command-conflict");
    } finally { runtime.store.close(); }
  });

  it("replays an uncertain rollback as pending cleanup across restart, then as its portable outcome without a native repeat", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const first = await finish(runtime, "first");
    await finish(runtime, "second");
    const deps = dependencies(runtime, async () => { throw new Error("Connection lost after dispatch"); });
    const source = rollbackSource(runtime.conversationId, first.id, "uncertain-request");
    await expect(rollback(runtime, deps, first.id, runtime.conversationId, source)).rejects.toThrow("Connection lost");
    await expect(rollback(runtime, deps, first.id, runtime.conversationId, source)).rejects.toThrow("cleanup must be confirmed");
    runtime.store.close();
    const store = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      const replayDeps = { ...deps, store };
      await expect(rollbackConversationHistory(replayDeps, { conversationId: runtime.conversationId, turnId: first.id, source },
        new AbortController().signal)).rejects.toThrow("cleanup must be confirmed");
      const control = store.orchestration.events.projection("native-control-current", runtime.conversationId)!.value as { operationId: string };
      const runtimeId = store.orchestration.nativeControls.get(control.operationId)!.runtimeId;
      store.orchestration.nativeControls.reconcileCleanup({ confirmedRuntimeGenerationIds: new Set([runtimeId]),
        currentSystemBootId: "boot", priorBootCleanupConfirmed: false });
      await expect(rollbackConversationHistory(replayDeps, { conversationId: runtime.conversationId, turnId: first.id, source },
        new AbortController().signal)).resolves.toMatchObject({ transfer: "portable", reason: "cleanup-confirmed", rolledBackTurns: 1 });
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
    } finally { store.close(); }
  });

  it("orders concurrent rollback commands for one chat through the production command handler", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      await finish(runtime, "second");
      const deps = dependencies(runtime, async (request) => completed(request, "native-revert",
        { nativeConversationId: "source-native", headId: "first", persistedHeadId: "first" }));
      const sent: ServerEvent[] = [];
      const handler = createConversationCommandHandler({ store: runtime.store, creation: {}, runtimeSync: { broadcast: () => undefined },
        rollbackHistory: (input: Parameters<typeof rollbackConversationHistory>[1]) =>
          rollbackConversationHistory(deps, input, new AbortController().signal),
        broadcastSnapshot: () => undefined, send: (_socket: WebSocket, event: ServerEvent) => { sent.push(event); },
      } as unknown as ConversationCommandDependencies);
      const command = (requestId: string) => ({ type: "conversation.rollback" as const, requestId,
        payload: { conversationId: runtime.conversationId, turnId: first.id } });
      const socket = {} as WebSocket;
      await Promise.all([handler(socket, command("rollback-a")), handler(socket, command("rollback-b"))]);
      expect(sent.map((event) => event.type === "request.result" ? [event.requestId, (event.result as { transfer: string }).transfer] : event.type))
        .toEqual([["rollback-a", "native"], ["rollback-b", "unchanged"]]);
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
    } finally { runtime.store.close(); }
  });
});
