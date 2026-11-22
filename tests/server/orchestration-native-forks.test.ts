// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { prepareForkSession } from "../../src/server/runtime/fork-session-service";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import { providerNativeModelSelection, type KnownHarnessId } from "../../src/shared/model-routing";
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

function dependencies(runtime: TurnControllerTestRuntime, execute: (request: NativeConversationRequest) => Promise<NativeConversationResult>,
  harnessId?: KnownHarnessId) {
  const resolveModelRoute: typeof runtime.provider.resolveModelRoute = (selection) => ({
    ...runtime.provider.resolveModelRoute(selection), ...(harnessId ? { harnessId } : {}) });
  return { store: runtime.store, turns: runtime.controller,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    providers: { resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
      nativeConversation: vi.fn(execute) } };
}

/** An agent's inertia_send_message to `childId`, a chat its running parent turn manages. */
async function agentSend(runtime: TurnControllerTestRuntime, deps: ReturnType<typeof dependencies>, childId: string, content: string) {
  const child = runtime.store.conversation(childId);
  const parent = runtime.store.createConversation(child.projectId, "Managing chat", { accessMode: "supervised", activate: false });
  const turn = runtime.store.beginAgentTurn({ id: `manager-turn-${childId}`, conversationId: parent.id, runId: `manager-run-${childId}`,
    content: "Manage the fork", activateConversation: false, providerId: "codex", harnessId: "codex-app-server",
    backendProfileId: parent.modelSelection.backendProfileId, model: parent.modelSelection.modelId,
    modelAlias: parent.modelSelection.alias, reasoningEffort: parent.modelSelection.reasoningEffort ?? "",
    interactionMode: "build", accessMode: "supervised", providerSessionBefore: null, usageAtStart: null,
    configurationRevision: parent.modelSelection.backendConfigurationRevision, association: "authoritative" }).turn;
  runtime.store.agentThreadManagement.attachManaged({ childConversationId: childId, sourceConversationId: parent.id,
    sourceTurnId: turn.id, sourceRunId: turn.runId, sourceHarnessId: "codex-app-server", now: new Date().toISOString() });
  const manager = new AgentThreadManager({ store: runtime.store, providers: deps.providers as never,
    backendProfileController: { validateSelection: (selection: unknown) => selection, readiness: async () => null } as never,
    creation: {} as never, turns: runtime.controller, providerTerminalResumes: deps.providerTerminalResumes,
    contextRequests: {} as never, providerInfo: () => [{ id: "codex", canRun: true, statusMessage: null }] as never,
    broadcastSnapshot: () => undefined, broadcastConversationShell: () => undefined, broadcast: () => undefined });
  const args = { conversationId: childId, content };
  return await manager.bridgeFor({ conversation: parent, turn })!.invoke({ providerThreadId: "provider-thread",
    providerTurnId: "provider-turn", toolCallId: `send-${childId}`, tool: "inertia_send_message", arguments: args,
    signal: new AbortController().signal, requestApproval: async () => "approve" });
}

function portableReasons(runtime: TurnControllerTestRuntime, threadId: string) {
  return runtime.store.orchestration.events.readEvents({ projectId: runtime.store.conversation(threadId).projectId, threadId, limit: 500 })
    .filter((event) => event.type === "fork.portable-selected").map((event) => event.payload);
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

  // A harness without `fork-while-source-running` keeps forking a busy source portably. With it, only a source
  // busy with a provider run is forked live; one held by other work stays portable.
  it.each([
    { busy: "an active run", harnessId: "codex-cli", reason: "native-source-unavailable" },
    { busy: "a held admission lease", harnessId: "codex-cli", reason: "native-source-busy" },
    { busy: "a terminal-resume reservation", harnessId: "codex-cli", reason: "native-source-busy" },
    { busy: "a held admission lease", harnessId: "codex-app-server", reason: "native-source-busy" },
    { busy: "a terminal-resume reservation", harnessId: "codex-app-server", reason: "native-source-busy" },
  ] as const)("prepares a fork portably while its source has $busy ($harnessId)", async ({ busy, harnessId, reason }) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const source = runtime.conversationId;
      const child = fork(runtime, first.id);
      const deps = dependencies(runtime, async (request) => completed(request), harnessId);
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
      expect(portableReasons(runtime, child.id)).toEqual([{ reason }]);
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

  it.each(["codex", "claude"] as const)("forks a completed %s turn natively while a later source turn runs, without fencing the source", async (providerId) => {
    const runtime = await createTurnControllerTestRuntime({}, providerId === "claude"
      ? { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "sonnet" }) } : {});
    try {
      const first = await finish(runtime, "first");
      await finish(runtime, "later");
      const source = runtime.conversationId;
      const running = runtime.controller.queue({ conversationId: source, content: "running request" });
      runtime.controller.start(running.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "native-boundary", nativeConversationId: "source-native",
        nativeSessionId: "tree-root", nativeTurnId: "running", persistedHeadId: null, phase: "started" });
      expect(runtime.provider.isRunning(source)).toBe(true);
      const child = fork(runtime, first.id);
      let release!: (value: NativeConversationResult) => void;
      let request!: NativeConversationRequest;
      const deps = dependencies(runtime, (value) => { request = value; return new Promise((resolve) => { release = resolve; }); });
      const pending = prepareForkSession(deps, child.id, new AbortController().signal);
      await vi.waitFor(() => expect(deps.providers.nativeConversation).toHaveBeenCalledOnce());
      // The running turn's started boundary is passed over: the fork checks against the last settled head.
      expect(request).toMatchObject({ kind: "fork", targetConversationId: child.id,
        source: { identity: { conversationId: source }, nativeConversationId: "source-native", expectedHeadId: "later", live: true },
        boundary: { kind: "turn", nativeTurnId: "first" } });
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(true);
      expect(runtime.store.orchestration.nativeControls.locked(source)).toBe(false);
      // The exact native conversation stays fenced: a second fork of the same running source goes portable.
      const second = fork(runtime, first.id, "second-live-fork");
      await prepareForkSession(deps, second.id, new AbortController().signal);
      expect(portableReasons(runtime, second.id)).toEqual([{ reason: "native-source-busy" }]);
      expect(deps.providers.nativeConversation).toHaveBeenCalledOnce();
      // The source's run settles its session while the fork reads, as an unfenced chat must allow.
      runtime.provider.resolve({ text: "running answer", sessionId: "source-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(running.turn.id).status).toBe("completed");
      expect(runtime.store.conversation(source).providerSessionId).toBe("source-native");
      release(completed(request));
      await pending;
      expect(runtime.store.orchestration.nativeControls.get(request.operationId)?.state).toBe("completed");
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("native");
      expect(portableReasons(runtime, child.id)).toEqual([]);
      expect(runtime.store.conversation(child.id).providerSessionId).toBe("fork-native");
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(false);
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.nativeControls.get(request.operationId)?.state).toBe("completed");
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(false);
    } finally { runtime.store.close(); }
  });

  // A live fork fences the provider conversation but not the source chat, so a fork prepared after the source went
  // idle must see that fence itself: it goes portable instead of failing the send, also when an agent sends it.
  it.each(["reading", "uncertain after a lost reply"] as const)("prepares another fork portably while a live fork of the same source is %s", async (state) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const source = runtime.conversationId;
      const running = runtime.controller.queue({ conversationId: source, content: "running request" });
      runtime.controller.start(running.turn.id);
      const live = fork(runtime, first.id, "live-fork");
      let liveRequest!: NativeConversationRequest;
      const liveDeps = dependencies(runtime, (request) => {
        liveRequest = request;
        return state === "reading" ? new Promise<NativeConversationResult>(() => undefined)
          : Promise.reject(new Error("Connection lost after dispatch"));
      });
      const pending = prepareForkSession(liveDeps, live.id, new AbortController().signal);
      if (state === "reading") {
        await vi.waitFor(() => expect(liveDeps.providers.nativeConversation).toHaveBeenCalledOnce());
      } else {
        await expect(pending).rejects.toThrow("Connection lost");
        expect(runtime.store.orchestration.nativeControls.get(liveRequest.operationId)?.state).toBe("uncertain");
      }
      expect(liveRequest.source.live).toBe(true);
      // The source's run ends while that fork still holds the provider conversation; the source chat is unfenced.
      runtime.provider.resolve({ text: "running answer", sessionId: "source-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.provider.isRunning(source)).toBe(false);
      expect(runtime.store.orchestration.nativeControls.locked(source)).toBe(false);
      const deps = dependencies(runtime, async (request) => completed(request));
      const direct = async () => {
        const child = fork(runtime, first.id, "idle-fork");
        await prepareForkSession(deps, child.id, new AbortController().signal);
        expect(portableReasons(runtime, child.id)).toEqual([{ reason: "native-source-busy" }]);
        expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(false);
      };
      // The same fork dispatched by an agent's inertia_send_message.
      const dispatched = async () => {
        const child = fork(runtime, first.id, "agent-fork");
        const result = await agentSend(runtime, deps, child.id, "Continue from the agent");
        expect(result).toMatchObject({ success: true });
        expect(portableReasons(runtime, child.id)).toEqual([{ reason: "native-source-busy" }]);
        expect(runtime.provider.input?.sessionId).toBeUndefined();
        expect(runtime.provider.input?.prompt).toContain("first answer");
        runtime.provider.resolve({ text: "Agent fork done" });
        await flushTurnControllerTestPromises();
      };
      // Each path runs first in one case, so each is shown to need the fix on its own.
      for (const path of state === "reading" ? [direct, dispatched] : [dispatched, direct]) await path();
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
    } finally { runtime.store.close(); }
  });

  it("refuses to start another fork's native control and falls back portably when the fence appears only at start", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const child = fork(runtime, first.id);
      const deps = dependencies(runtime, async (request) => completed(request));
      const start = vi.spyOn(runtime.store.orchestration.nativeControls, "start")
        .mockImplementation(() => { throw new OrchestrationConflict("cleanup-pending"); });
      await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(start).toHaveBeenCalledOnce();
      expect(portableReasons(runtime, child.id)).toEqual([{ reason: "native-source-busy" }]);
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
    } finally { runtime.store.close(); }
  });

  it.each(["failed", "cancelled"] as const)("forks a %s source turn portably while a later source turn runs", async (status) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: `${status} request` });
      runtime.controller.start(queued.turn.id);
      for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
        type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: "tree-root", nativeTurnId: status,
        persistedHeadId: phase === "settled" ? status : null, phase });
      runtime.provider.resolve({ text: `${status} answer`, sessionId: "source-native", status });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(queued.turn.id).status).toBe(status);
      const running = runtime.controller.queue({ conversationId: runtime.conversationId, content: "running request" });
      runtime.controller.start(running.turn.id);
      expect(runtime.provider.isRunning(runtime.conversationId)).toBe(true);
      const child = fork(runtime, queued.turn.id);
      const deps = dependencies(runtime, async (request) => completed(request));
      await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
      expect(portableReasons(runtime, child.id)).toEqual([{ reason: "native-source-unsuccessful" }]);
      runtime.provider.resolve({ text: "running answer", sessionId: "source-native" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it("settles a live fork portably when the provider finds the boundary invalidated by a later write", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finish(runtime, "first");
      const running = runtime.controller.queue({ conversationId: runtime.conversationId, content: "running request" });
      runtime.controller.start(running.turn.id);
      const child = fork(runtime, first.id);
      const deps = dependencies(runtime, async (request) => ({ operationId: request.operationId, identity: request.source.identity,
        targetConversationId: request.kind === "fork" ? request.targetConversationId : undefined,
        status: "rejected", reason: "native-head-changed" }));
      await prepareForkSession(deps, child.id, new AbortController().signal);
      expect(deps.providers.nativeConversation.mock.calls[0]?.[0]).toMatchObject({ source: { live: true, expectedHeadId: "first" } });
      expect(runtime.store.orchestration.forks.get(child.id)?.transfer).toBe("portable");
      expect(runtime.store.orchestration.nativeControls.locked(child.id)).toBe(false);
      runtime.provider.resolve({ text: "running answer", sessionId: "source-native" });
      await flushTurnControllerTestPromises();
      const send = runtime.controller.queue({ conversationId: child.id, content: "Continue" });
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("first answer");
      expect(runtime.provider.input?.prompt).not.toContain("running answer");
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
