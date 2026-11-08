// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { prepareForkSession } from "../../src/server/runtime/fork-session-service";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime } from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

async function finish(runtime: TurnControllerTestRuntime, label: string) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
    type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: "tree-root", nativeTurnId: label,
    persistedHeadId: phase === "settled" ? label : null, phase });
  runtime.provider.resolve({ text: `${label} answer`, sessionId: "source-native" });
  await flushTurnControllerTestPromises();
  return queued.turn;
}

function fork(runtime: TurnControllerTestRuntime, turnId: string, commandId = "fork-native") {
  const parent = runtime.store.conversation(runtime.conversationId);
  const input = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: turnId, activate: false };
  return runtime.store.orchestration.forks.create(input, { actorId: "human", commandId, command: { ...input } });
}

function completed(request: NativeConversationRequest): NativeConversationResult {
  return { operationId: request.operationId, identity: request.source.identity,
    targetConversationId: request.kind === "fork" ? request.targetConversationId : undefined,
    status: "completed", effect: "native-fork",
    backing: { nativeConversationId: "fork-native", nativeSessionId: "tree-root", headId: "first", persistedHeadId: "first" } };
}

function dependencies(runtime: TurnControllerTestRuntime, execute: (request: NativeConversationRequest) => Promise<NativeConversationResult>) {
  return { store: runtime.store, turns: runtime.controller,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    providers: { resolveModelRoute: runtime.provider.resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
      nativeConversation: vi.fn(execute) } };
}

describe("lazy native fork admission", () => {
  it("locks exact identities, forks the selected old turn against the latest physical head, then resumes without duplicate history", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      await finish(runtime, "later");
      const child = fork(runtime, first.id);
      let release!: (value: NativeConversationResult) => void;
      let request!: NativeConversationRequest;
      const deps = dependencies(runtime, (value) => { request = value; return new Promise((resolve) => { release = resolve; }); });
      const pending = prepareForkSession(deps, child.id, new AbortController().signal);
      await vi.waitFor(() => expect(deps.providers.nativeConversation).toHaveBeenCalledOnce());
      expect(request).toMatchObject({ kind: "fork", targetConversationId: child.id,
        source: { identity: { conversationId: runtime.conversationId, projectId: child.projectId },
          nativeConversationId: "source-native", nativeSessionId: "tree-root", expectedHeadId: "later" },
        boundary: { kind: "turn", nativeTurnId: "first" } });
      const control = runtime.store.orchestration.nativeControls.get(request.operationId)!;
      const effect = runtime.store.orchestration.effects.get(`native-control:${request.operationId}`);
      expect(effect?.state).toBe("running");
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(true);
      expect(runtime.store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(true);
      expect(() => runtime.store.updateConversation(child.id, { model: "gpt-next" })).toThrow("cleanup-pending");
      expect(() => runtime.store.deleteConversation(runtime.conversationId)).toThrow("cleanup-pending");
      expect(() => runtime.controller.queue({ conversationId: child.id, content: "Race" })).toThrow("cleanup-pending");
      release(completed(request));
      await pending;
      expect(runtime.store.orchestration.nativeControls.get(control.id)?.state).toBe("completed");
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("native");
      expect(runtime.store.conversation(child.id).providerSessionId).toBe("fork-native");
      await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
      const send = runtime.controller.queue({ conversationId: child.id, content: "Continue native fork" });
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input?.sessionId).toBe("fork-native");
      expect(runtime.provider.input?.prompt).not.toContain("first answer");
      runtime.provider.resolve({ text: "Fork response", sessionId: "fork-native" });
      await flushTurnControllerTestPromises();
      const backing = runtime.store.orchestration.backings.find({ threadId: child.id, providerId: "codex",
        workspaceKey: runtime.workspace, identity: control.continuationIdentity });
      const inheritedIds = runtime.store.orchestration.forks.history(child.id).parts.filter(({ part }) => part === 0).map(({ id }) => id);
      expect(backing?.coveredItemIds).toEqual(expect.arrayContaining(inheritedIds));
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.nativeControls.get(control.id)?.state).toBe("completed");
    } finally { runtime.store.close(); }
  });

  it("uses portable history for a different provider or unsupported native control", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const child = fork(runtime, first.id);
      const deps = dependencies(runtime, async (request) => ({ operationId: request.operationId, identity: request.source.identity,
        targetConversationId: request.kind === "fork" ? request.targetConversationId : undefined, status: "unsupported", reason: "fixture" }));
      await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("portable");
      expect(runtime.store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(false);
      const other = fork(runtime, first.id, "cross-provider");
      runtime.store.updateConversation(other.id, { providerId: "claude", modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "sonnet" }) });
      await prepareForkSession(deps, other.id, new AbortController().signal);
      expect(runtime.store.orchestration.forks.get(other.id)?.transfer).toBe("portable");
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
      const send = runtime.controller.queue({ conversationId: child.id, content: "Continue" });
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("first answer");
      runtime.provider.resolve({ text: "Done" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it.each([
    { busy: "an active run", reason: "native-source-unavailable" },
    { busy: "a held admission lease", reason: "native-source-busy" },
    { busy: "a terminal-resume reservation", reason: "native-source-busy" },
  ])("prepares a fork portably while its source has $busy", async ({ busy, reason }) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const source = runtime.conversationId;
      const child = fork(runtime, first.id);
      const deps = dependencies(runtime, async (request) => completed(request));
      let release = async () => {};
      if (busy === "an active run") {
        const later = runtime.controller.queue({ conversationId: source, content: "later request" });
        runtime.controller.start(later.turn.id);
        expect(runtime.provider.isRunning(source)).toBe(true);
        release = async () => {
          runtime.provider.resolve({ text: "later answer", sessionId: "source-native" });
          await flushTurnControllerTestPromises();
        };
      } else if (busy === "a held admission lease") {
        const lease = await runtime.controller.acquireTurnAdmission(source, 100);
        expect(lease).not.toBeNull();
        release = async () => { lease!.release(); };
      } else {
        expect(deps.providerTerminalResumes.acquire(source)).toBe(true);
        release = async () => {
          expect(deps.providerTerminalResumes.isActive(source)).toBe(true);
          deps.providerTerminalResumes.release(source);
        };
      }
      await prepareForkSession(deps, child.id, new AbortController().signal);
      await release();
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("portable");
      const selected = runtime.store.orchestration.events.readEvents({ projectId: child.projectId, threadId: child.id, limit: 500 })
        .filter((event) => event.type === "fork.portable-selected").map((event) => event.payload);
      expect(selected).toEqual([{ reason }]);
      expect(runtime.store.orchestration.nativeControls.locked(source)).toBe(false);
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(false);
      const admission = await runtime.controller.acquireTurnAdmission(source, 100);
      expect(admission).not.toBeNull();
      admission!.release();
      await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
      const send = runtime.controller.queue({ conversationId: child.id, content: "Continue" });
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("first answer");
      runtime.provider.resolve({ text: "Done" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)("forks a %s source turn natively only when it completed", async (status) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: `${status} request` });
      runtime.controller.start(queued.turn.id);
      for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
        type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: "tree-root", nativeTurnId: status,
        persistedHeadId: phase === "settled" ? status : null, phase });
      if (status === "interrupted") {
        await expect(runtime.controller.interruptForUpdate([runtime.conversationId], "Inertia")).resolves.toBe(true);
      } else {
        runtime.provider.resolve({ text: `${status} answer`, sessionId: "source-native",
          ...(status === "completed" ? {} : { status }) });
      }
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(queued.turn.id).status).toBe(status);
      const child = fork(runtime, queued.turn.id);
      expect(runtime.store.orchestration.forks.get(child.id)?.nativeBoundary).toMatchObject({ phase: "settled", nativeTurnId: status });
      const deps = dependencies(runtime, async (request) => completed(request));
      await prepareForkSession(deps, child.id, new AbortController().signal);
      const selected = runtime.store.orchestration.events.readEvents({ projectId: child.projectId, threadId: child.id, limit: 500 })
        .filter((event) => event.type === "fork.portable-selected").map((event) => event.payload);
      if (status === "completed") {
        expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
        expect(selected).toEqual([]);
        expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("native");
        return;
      }
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
      expect(selected).toEqual([{ reason: "native-source-unsuccessful" }]);
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("portable");
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(false);
      const send = runtime.controller.queue({ conversationId: child.id, content: "Continue" });
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain(`${status} request`);
      runtime.provider.resolve({ text: "Done" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it("refuses a successful-looking native reply with the wrong target identity", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const child = fork(runtime, first.id);
      const deps = dependencies(runtime, async (request) => ({ ...completed(request), targetConversationId: runtime.conversationId }));
      await expect(prepareForkSession(deps, child.id, new AbortController().signal)).rejects.toThrow("scope-conflict");
      expect(runtime.store.conversation(child.id).providerSessionId).toBeNull();
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(true);
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("pending");
    } finally { runtime.store.close(); }
  });

  it("keeps ambiguous cleanup fenced across restart, rejects stale release evidence, and never replays a claimed fork", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const first = await finish(runtime, "first");
    const child = fork(runtime, first.id);
    let request!: NativeConversationRequest;
    const deps = dependencies(runtime, async (value) => { request = value; throw new Error("Connection lost after dispatch"); });
    await expect(prepareForkSession(deps, child.id, new AbortController().signal)).rejects.toThrow("Connection lost");
    const control = runtime.store.orchestration.nativeControls.get(request.operationId)!;
    expect(control.state).toBe("uncertain");
    await expect(prepareForkSession(deps, child.id, new AbortController().signal)).rejects.toThrow("cleanup must be confirmed");
    runtime.store.close();
    const store = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      store.orchestration.events.rebuildProjections();
      expect(store.orchestration.nativeControls.locked(child.id)).toBe(true);
      expect(() => store.orchestration.nativeControls.confirmCleanup(control.id, "wrong-runtime")).toThrow("scope-conflict");
      store.orchestration.nativeControls.confirmCleanup(control.id, control.runtimeId);
      expect(store.orchestration.forks.get(child.id)?.transfer).toBe("portable");
      expect(store.orchestration.nativeControls.locked(runtime.conversationId)).toBe(false);
      expect(store.orchestration.effects.claim(`native-control:${control.id}`)).toBeNull();
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
    } finally { store.close(); }
  });

  it("retires an in-flight native effect after a crash and releases its fences only for the exact supervisor cleanup receipt", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const first = await finish(runtime, "first");
    const original = fork(runtime, first.id);
    const deps = dependencies(runtime, async (request) => completed(request));
    await prepareForkSession(deps, original.id, new AbortController().signal);
    const previous = runtime.store.orchestration.nativeControls.forkBacking(original.id)!;
    const child = fork(runtime, first.id, "crash-fork");
    const effect = runtime.store.orchestration.nativeControls.start({
      id: "crashed-operation", threadId: child.id, projectId: child.projectId,
      request: { ...previous.request, kind: "fork", operationId: "crashed-operation", targetConversationId: child.id },
      sourceWorkspaceKey: previous.sourceWorkspaceKey, targetWorkspaceKey: previous.targetWorkspaceKey,
      selection: previous.selection, continuationIdentity: previous.continuationIdentity,
    });
    expect(effect.state).toBe("running");
    runtime.store.close();
    const store = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(store.orchestration.effects.get(effect.id)?.state).toBe("retired");
      expect(store.orchestration.nativeControls.get("crashed-operation")).toMatchObject({ state: "uncertain", reason: "runtime-lost" });
      store.orchestration.nativeControls.reconcileCleanup({ confirmedRuntimeGenerationIds: new Set(["unrelated-generation"]),
        currentSystemBootId: "current-boot", priorBootCleanupConfirmed: false });
      expect(store.orchestration.nativeControls.locked(child.id)).toBe(true);
      store.orchestration.nativeControls.reconcileCleanup({ confirmedRuntimeGenerationIds: new Set([effect.runtimeId]),
        currentSystemBootId: "current-boot", priorBootCleanupConfirmed: false });
      expect(store.orchestration.nativeControls.locked(child.id)).toBe(false);
      expect(store.orchestration.forks.get(child.id)?.transfer).toBe("portable");
      expect(store.orchestration.effects.claim(effect.id)).toBeNull();
    } finally { store.close(); }
  });
});
