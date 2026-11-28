// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { relocatedBackingId } from "../../src/server/orchestration-v2/backing-projector";
import { portableForkHistory } from "../../src/server/orchestration-v2/portable-fork-history";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationResult, NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { userCorrectableRuntimeError } from "../../src/server/runtime-errors";
import { commandRejection } from "../../src/server/runtime/commands/command-rejection";
import { classifiedMessageSendError } from "../../src/server/runtime/commands/message-send-support";
import { prepareForkSession } from "../../src/server/runtime/fork-session-service";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

const claudeSelection = providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" });
const kimiSelection = providerNativeModelSelection({ providerId: "kimi", modelId: "kimi-test" });
const piSelection = providerNativeModelSelection({ providerId: "pi", modelId: "test/model" });

/** Every chat of the runtime resolves to `checkout` once it is set, like a chat handed to a worktree. */
async function movable(runtime: TurnControllerTestRuntime) {
  const moved = join(runtime.directory, "moved-checkout");
  const elsewhere = join(runtime.directory, "third-checkout");
  await mkdir(moved);
  await mkdir(elsewhere);
  const overrides = new Map<string, string>();
  const realPath = runtime.store.conversationPath.bind(runtime.store);
  vi.spyOn(runtime.store, "conversationPath").mockImplementation((id) => overrides.get(id) ?? realPath(id));
  return { moved, elsewhere, moveTo: (conversationId: string, path: string) => { overrides.set(conversationId, path); } };
}

/** A turn that reports native boundaries, so native rollback and fork can find it. */
async function nativeTurn(runtime: TurnControllerTestRuntime, label: string, conversationId = runtime.conversationId,
  sessionId = "source-native") {
  const queued = runtime.controller.queue({ conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
    type: "native-boundary", nativeConversationId: sessionId, nativeSessionId: null, nativeTurnId: label,
    persistedHeadId: phase === "settled" ? label : null, phase });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  runtime.provider.resolve({ text: `${label} answer`, sessionId });
  await flushTurnControllerTestPromises();
  return queued;
}

function nativeDependencies(runtime: TurnControllerTestRuntime,
  execute: (request: NativeConversationRequest, selection?: unknown, options?: { cwd?: string }) => Promise<NativeConversationResult>) {
  return { store: runtime.store, turns: runtime.controller,
    providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
    providers: { resolveModelRoute: runtime.provider.resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
      nativeConversation: vi.fn(execute) } };
}

function events(runtime: TurnControllerTestRuntime, threadId = runtime.conversationId) {
  const { projectId } = runtime.store.conversation(threadId);
  return runtime.store.orchestration.events.readEvents({ projectId, threadId, limit: 500 });
}

const identityOf = (runtime: TurnControllerTestRuntime, providerId: "codex" | "claude" | "pi", conversationId = runtime.conversationId) =>
  runtime.store.agentTurnsForConversation(conversationId).filter((turn) => turn.providerId === providerId).at(-1)!.continuationIdentity;

function importChat(runtime: TurnControllerTestRuntime, providerId: "codex" | "claude", sessionId: string) {
  const selection = providerNativeModelSelection({ providerId });
  return runtime.store.importCliConversation({ projectId: runtime.store.conversation(runtime.conversationId).projectId,
    sourceKey: randomUUID().replaceAll("-", "").padEnd(64, "0"), providerId, sessionId,
    cwd: runtime.store.conversationPath(runtime.conversationId), title: "Imported",
    messages: [{ role: "user", content: "Earlier imported work", createdAt: "2026-09-25T10:00:00.000Z" }], selection,
    continuationIdentity: runtime.provider.resolveModelRoute(selection).continuationIdentity,
    omittedMessages: 0, omittedBytes: 0, droppedRecords: 0, continuation: "native" as const });
}

describe("a session without a backing in a moved checkout", () => {
  it("resumes an imported codex session in a moved checkout, and fails closed when the provider says it is gone", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }) });
    try {
      const { moved, moveTo } = await movable(runtime);
      const sessionId = randomUUID();
      const chat = importChat(runtime, "codex", sessionId);
      moveTo(chat, moved);
      const send = runtime.controller.queue({ conversationId: chat, content: "Continue in the worktree." });
      expect(send.turn.providerSessionBefore).toBe(sessionId);
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input).toMatchObject({ sessionId, cwd: moved });
      expect(runtime.provider.input?.prompt).not.toContain("Earlier imported work");

      // Codex finds threads by id under CODEX_HOME, so a refusal means the session is gone: the import fails closed as in A.
      expect(runtime.provider.freshSession()).toBeNull();
      const gone = "The saved provider session is no longer available.";
      runtime.provider.resolve({ status: "failed", sessionId, error: gone,
        failure: { reason: "provider-error", message: gone, sessionUnavailable: true } });
      await flushTurnControllerTestPromises();
      const failures = (runtime.store.conversationDetail(chat)?.activities ?? []).filter(({ kind, turnId }) => kind === "error" && turnId === send.turn.id);
      expect(failures).toEqual([expect.objectContaining({ title: "The original Codex session for this imported chat is no longer available." })]);
      expect(runtime.store.conversation(chat).providerSessionId).toBe(sessionId);
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("resumes an imported claude session in a moved checkout, and falls back to a fresh session when the provider says it is gone (N20)", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }) });
    try {
      const { moved, moveTo } = await movable(runtime);
      const sessionId = randomUUID();
      const chat = importChat(runtime, "claude", sessionId);
      moveTo(chat, moved);
      const send = runtime.controller.queue({ conversationId: chat, content: "Continue in the worktree." });
      expect(send.turn.providerSessionBefore).toBe(sessionId);
      runtime.controller.start(send.turn.id);
      expect(runtime.provider.input).toMatchObject({ sessionId, cwd: moved });
      expect(runtime.provider.input?.prompt).not.toContain("Earlier imported work");

      // N20 (2c4622efb): imported Claude sessions fall back cleanly to a fresh session with the full portable summary.
      const replacement = runtime.provider.freshSession();
      expect(replacement).not.toBeNull();
      expect(replacement?.prompt).toContain("Earlier imported work");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), conversationId: chat, type: "session", sessionId: "fresh-in-moved" });
      runtime.provider.resolve({ status: "completed", sessionId: "fresh-in-moved", text: "Continued fresh in moved" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(send.turn.id)).toMatchObject({ status: "completed", providerSessionAfter: "fresh-in-moved" });
      expect(runtime.store.conversation(chat).providerSessionId).toBe("fresh-in-moved");
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("starts an imported Claude session fresh in a moved checkout when Claude Code cannot reach its stored transcript", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }) });
    try {
      const { moved, moveTo } = await movable(runtime);
      const sessionId = randomUUID();
      const chat = importChat(runtime, "claude", sessionId);
      moveTo(chat, moved);
      const send = runtime.controller.queue({ conversationId: chat, content: "Continue in the worktree." });
      runtime.controller.start(send.turn.id);
      // An older Claude Code looks only in B's project folder; the transcript is still in A's.
      const replacement = runtime.provider.freshSession({ priorCleanup: "confirmed", sessionStoredElsewhere: true });
      expect(replacement?.prompt).toContain("Earlier imported work");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), conversationId: chat, type: "session", sessionId: "fresh-in-b" });
      runtime.provider.resolve({ status: "completed", sessionId: "fresh-in-b", text: "Continued fresh in B" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(send.turn.id)).toMatchObject({ status: "completed", providerSessionAfter: "fresh-in-b" });
      expect(runtime.store.conversation(chat).providerSessionId).toBe("fresh-in-b");
      expect(runtime.controller.queue({ conversationId: chat, content: "And again." }).turn.providerSessionBefore).toBe("fresh-in-b");
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("releases an imported Claude session whose stored transcript Claude Code could not reach, after the fallback was declined", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }) });
    try {
      const { moved, moveTo } = await movable(runtime);
      const sessionId = randomUUID();
      const chat = importChat(runtime, "claude", sessionId);
      moveTo(chat, moved);
      const send = runtime.controller.queue({ conversationId: chat, content: "Continue in the worktree." });
      runtime.controller.start(send.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), conversationId: chat, type: "text", text: "Partial" });
      expect(runtime.provider.freshSession()).toBeNull();
      const message = `No conversation found with session ID: ${sessionId}`;
      runtime.provider.resolve({ status: "failed", sessionId, error: message,
        failure: { reason: "provider-error", message, sessionUnavailable: true, sessionStoredElsewhere: true } });
      await flushTurnControllerTestPromises();
      const errors = (runtime.store.conversationDetail(chat)?.activities ?? []).filter(({ kind, turnId }) => kind === "error" && turnId === send.turn.id);
      expect(errors.map(({ title }) => title)).not.toContain("The original Claude Code session for this imported chat is no longer available.");
      expect(runtime.store.conversation(chat).providerSessionId).toBeNull();
      const retry = runtime.controller.queue({ conversationId: chat, content: "Try again." });
      expect(retry.turn.providerSessionBefore).toBeNull();
      runtime.controller.start(retry.turn.id);
      expect(runtime.provider.input?.prompt).toContain("Earlier imported work");
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("starts fresh when the run that produced the session ran in another checkout and its backing is gone", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, moveTo } = await movable(runtime);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      await nativeTurn(runtime, "claude-first", runtime.conversationId, "claude-native");
      const lookup = { threadId: runtime.conversationId, providerId: "claude", identity: identityOf(runtime, "claude") };
      const original = runtime.store.orchestration.backings.find({ ...lookup, workspaceKey: runtime.workspace })!;
      runtime.store.orchestration.backings.invalidate(original, "uncertain-delivery");
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("claude-native");
      expect(runtime.store.orchestration.backings.sessionWorkspaceKey(runtime.conversationId, "claude-native")).toBe(runtime.workspace);

      moveTo(runtime.conversationId, moved);
      const afterMove = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue in B" });
      expect(afterMove.turn.providerSessionBefore).toBeNull();
      runtime.controller.start(afterMove.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("claude-first answer");
    } finally { runtime.store.close(); }
  });

  it("never resumes a Codex session whose backing was retired, in a moved or a third checkout", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, moveTo } = await movable(runtime);
      await nativeTurn(runtime, "first");
      const lookup = { threadId: runtime.conversationId, providerId: "codex", identity: identityOf(runtime, "codex") };
      const original = runtime.store.orchestration.backings.find({ ...lookup, workspaceKey: runtime.workspace })!;
      // As after a restart mid-dispatch.
      runtime.store.orchestration.backings.invalidate(original, "uncertain-delivery");
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("source-native");
      moveTo(runtime.conversationId, moved);
      const afterMove = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue in B" });
      expect(afterMove.turn.providerSessionBefore).toBeNull();
      runtime.controller.start(afterMove.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("first answer");
      runtime.provider.resolve({ status: "cancelled" });
      await flushTurnControllerTestPromises();

      // A relocated row that is retired keeps its session retired in a checkout it never ran in.
      const second = await createTurnControllerTestRuntime();
      try {
        const chat = await movable(second);
        await nativeTurn(second, "first");
        chat.moveTo(second.conversationId, chat.moved);
        await nativeTurn(second, "in-b");
        const relocated = second.store.orchestration.backings.find({ threadId: second.conversationId, providerId: "codex",
          workspaceKey: chat.moved, identity: identityOf(second, "codex") })!;
        second.store.orchestration.backings.invalidate(relocated, "uncertain-delivery");
        chat.moveTo(second.conversationId, chat.elsewhere);
        expect(second.controller.queue({ conversationId: second.conversationId, content: "In C" }).turn.providerSessionBefore)
          .toBeNull();
      } finally { second.store.close(); }
    } finally { runtime.store.close(); }
  });

  it("keeps resuming a session that no run, fork or import records, as before backings existed", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, moveTo } = await movable(runtime);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection,
        providerSessionId: "unrecorded-native" });
      expect(runtime.store.orchestration.backings.sessionWorkspaceKey(runtime.conversationId, "unrecorded-native")).toBeNull();
      moveTo(runtime.conversationId, moved);
      const turn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue" });
      expect(turn.turn.providerSessionBefore).toBe("unrecorded-native");
    } finally { runtime.store.close(); }
  });

  it("follows a native fork moved before its first send: Codex, Claude and Pi resume it with inherited coverage", async () => {
    for (const providerId of ["codex", "claude", "pi"] as const) {
      const runtime = await createTurnControllerTestRuntime();
      try {
        const { moved, moveTo } = await movable(runtime);
        if (providerId !== "codex") {
          runtime.store.updateConversation(runtime.conversationId, { providerId,
            modelSelection: providerId === "claude" ? claudeSelection : piSelection });
        }
        const first = await nativeTurn(runtime, "first");
        const parent = runtime.store.conversation(runtime.conversationId);
        const input = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: first.turn.id, activate: false };
        const child = runtime.store.orchestration.forks.create(input, { actorId: "human", commandId: `fork-${providerId}`, command: { ...input } });
        const deps = nativeDependencies(runtime, async (request) => ({ operationId: request.operationId,
          identity: request.source.identity, targetConversationId: child.id, status: "completed", effect: "native-fork",
          backing: { nativeConversationId: "fork-native", headId: "first", persistedHeadId: "first" } }));
        await prepareForkSession(deps, child.id, new AbortController().signal);
        expect(runtime.store.conversation(child.id).providerSessionId).toBe("fork-native");
        expect(runtime.store.orchestration.backings.sessionWorkspaceKey(child.id, "fork-native")).toBe(runtime.workspace);

        moveTo(child.id, moved);
        const send = runtime.controller.queue({ conversationId: child.id, content: "Continue the fork in a worktree" });
        runtime.controller.start(send.turn.id);
        expect(runtime.provider.input).toMatchObject({ cwd: moved, sessionId: "fork-native" });
        expect(send.turn.providerSessionBefore).toBe("fork-native");
        expect(runtime.provider.input?.prompt).not.toContain("first answer");
        // Pi continues a copy of the fork made in the moved checkout; the fork had no backing to move yet.
        const session = providerId === "pi" ? "fork-copy" : "fork-native";
        runtime.provider.emit({ ...turnControllerTestIdentity(runtime), conversationId: child.id, type: "session", sessionId: session,
          ...(providerId === "pi" ? { forkedFrom: "fork-native" } : {}) });
        runtime.provider.resolve({ text: "Fork continued", sessionId: session });
        await flushTurnControllerTestPromises();
        const backing = runtime.store.orchestration.backings.find({ threadId: child.id, providerId,
          workspaceKey: moved, identity: identityOf(runtime, providerId, child.id) })!;
        expect(backing.nativeSessionId).toBe(session);
        const inherited = runtime.store.orchestration.forks.history(child.id, 0, 100).parts.filter(({ part }) => part === 0)
          .map(({ id }) => id);
        expect(inherited.length).toBeGreaterThan(0);
        // The native fork already holds its inherited history; the next delta must not send it again.
        expect(backing.inheritedCoverage).toBe("complete");
        expect(portableForkHistory((runtime.store as unknown as { database: Database.Database }).database, child.id, backing).items).toEqual([]);
      } finally { runtime.store.close(); }
    }
  });
});

function rollbackTo(runtime: TurnControllerTestRuntime, deps: ReturnType<typeof nativeDependencies>, turnId: string, commandId: string) {
  return rollbackConversationHistory(deps, { conversationId: runtime.conversationId, turnId,
    source: { actorId: "human", commandId, command: { type: "conversation.rollback", requestId: commandId,
      payload: { conversationId: runtime.conversationId, turnId } } } }, new AbortController().signal);
}

function revertingTo(runtime: TurnControllerTestRuntime, headId: string, nativeConversationId = "source-native") {
  return nativeDependencies(runtime, async (value) => ({ operationId: value.operationId, identity: value.source.identity,
    status: "completed", effect: "native-revert", backing: { nativeConversationId, headId, persistedHeadId: headId } }));
}

describe("native history control after a relocation", () => {
  it("rolls a relocated Codex session back natively in the moved checkout to a turn from before the move", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, moveTo } = await movable(runtime);
      const first = await nativeTurn(runtime, "first");
      await nativeTurn(runtime, "second");
      moveTo(runtime.conversationId, moved);
      const third = await nativeTurn(runtime, "third");
      const lookup = { threadId: runtime.conversationId, providerId: "codex", identity: identityOf(runtime, "codex") };
      const relocated = runtime.store.orchestration.backings.find({ ...lookup, workspaceKey: moved })!;
      expect(relocated.status).toBe("ready");

      const deps = revertingTo(runtime, "first");
      await expect(rollbackTo(runtime, deps, first.turn.id, "rollback-in-b"))
        .resolves.toMatchObject({ transfer: "native", retainedTurnId: first.turn.id });
      const [request, , options] = deps.providers.nativeConversation.mock.calls[0]!;
      expect(request).toMatchObject({ kind: "rollback", boundary: { kind: "turn", nativeTurnId: "first" },
        source: { nativeConversationId: "source-native", expectedHeadId: "third" } });
      expect(options).toMatchObject({ cwd: await realpath(moved) });
      expect(runtime.store.orchestration.backings.get(relocated.id)?.status).toBe("ready");
      expect(runtime.store.orchestration.history.rolledBack(third.turn.id)).toBe(true);
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "After the rollback" });
      expect(next.turn.providerSessionBefore).toBe("source-native");
    } finally { runtime.store.close(); }
  });

  it("uses the newest head after A → B → A and rolls back natively in A", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, moveTo } = await movable(runtime);
      await nativeTurn(runtime, "first");
      const second = await nativeTurn(runtime, "second");
      moveTo(runtime.conversationId, moved);
      await nativeTurn(runtime, "third");
      // Back in A, before any turn there, the head is B's newest boundary, not A's older one.
      moveTo(runtime.conversationId, runtime.workspace);
      const instance = runtime.store.orchestration.backings.current({ threadId: runtime.conversationId, providerId: "codex",
        identity: identityOf(runtime, "codex") })!.providerInstanceId;
      const head = () => runtime.store.orchestration.history.physicalHead({ threadId: runtime.conversationId,
        providerInstanceId: instance, nativeConversationId: "source-native" });
      expect(head()).toBe("third");
      const fourth = await nativeTurn(runtime, "fourth");
      expect(head()).toBe("fourth");

      const deps = revertingTo(runtime, "second");
      await expect(rollbackTo(runtime, deps, second.turn.id, "rollback-back-in-a"))
        .resolves.toMatchObject({ transfer: "native", retainedTurnId: second.turn.id });
      const [request, , options] = deps.providers.nativeConversation.mock.calls[0]!;
      expect(request).toMatchObject({ boundary: { kind: "turn", nativeTurnId: "second" }, source: { expectedHeadId: "fourth" } });
      expect(options).toMatchObject({ cwd: await realpath(runtime.workspace) });
      expect(runtime.store.orchestration.history.rolledBack(fourth.turn.id)).toBe(true);
    } finally { runtime.store.close(); }
  });

  it("falls back to portable rollback when a fresh harness started a new session in the moved checkout", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, moveTo } = await movable(runtime);
      // Kimi ACP has not shown that it resumes a session from another cwd.
      runtime.store.updateConversation(runtime.conversationId, { providerId: "kimi", modelSelection: kimiSelection });
      const first = await nativeTurn(runtime, "first", runtime.conversationId, "kimi-native");
      moveTo(runtime.conversationId, moved);
      const inB = await nativeTurn(runtime, "in-b", runtime.conversationId, "kimi-fresh-b");
      expect(inB.turn.providerSessionBefore).toBeNull();
      const deps = revertingTo(runtime, "first", "kimi-native");
      await expect(rollbackTo(runtime, deps, first.turn.id, "rollback-fresh-harness"))
        .resolves.toMatchObject({ transfer: "portable", retainedTurnId: first.turn.id });
      expect(deps.providers.nativeConversation).not.toHaveBeenCalled();
      expect(runtime.store.orchestration.history.rolledBack(inB.turn.id)).toBe(true);
    } finally { runtime.store.close(); }
  });
});

describe("admission after preparation", () => {
  it("refuses with a typed, user-correctable conflict when the checkout changed since preparation", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, elsewhere, moveTo } = await movable(runtime);
      await nativeTurn(runtime, "first");
      const lookup = { threadId: runtime.conversationId, providerId: "codex", identity: identityOf(runtime, "codex") };
      const original = runtime.store.orchestration.backings.find({ ...lookup, workspaceKey: runtime.workspace })!;
      moveTo(runtime.conversationId, moved);
      const admit = runtime.store.orchestration.admit.bind(runtime.store.orchestration);
      const spy = vi.spyOn(runtime.store.orchestration, "admit").mockImplementation((...args) => {
        moveTo(runtime.conversationId, elsewhere);
        return admit(...args);
      });
      const before = events(runtime).length;
      let caught: unknown;
      try { runtime.controller.queue({ conversationId: runtime.conversationId, content: "Moved twice" }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OrchestrationConflict);
      expect((caught as OrchestrationConflict).code).toBe("checkout-changed");
      expect(userCorrectableRuntimeError(caught)).toBe(true);
      // On the send path the conflict stays user-correctable: no rejected receipt, no incident.
      const classified = classifiedMessageSendError(caught, "turn-persistence");
      expect(classified.message).toBe("This chat moved to another checkout while the message was being prepared. Send it again.");
      expect(userCorrectableRuntimeError(classified)).toBe(true);
      expect(commandRejection(classified)).toBeNull();
      expect(events(runtime)).toHaveLength(before);
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("ready");

      spy.mockRestore();
      const retried = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Moved twice" });
      expect(retried.turn.providerSessionBefore).toBe("source-native");
      expect(runtime.store.orchestration.backings.get(relocatedBackingId(original, elsewhere))?.status).toBe("ready");
    } finally { runtime.store.close(); }
  });
});

describe("forged relocation events", () => {
  it("refuses a retired source, another chat's source and a source with incomplete coverage", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { moved, moveTo } = await movable(runtime);
      await nativeTurn(runtime, "first");
      const { orchestration } = runtime.store;
      const { projectId } = runtime.store.conversation(runtime.conversationId);
      const lookup = { threadId: runtime.conversationId, providerId: "codex", identity: identityOf(runtime, "codex") };
      const a1 = orchestration.backings.find({ ...lookup, workspaceKey: runtime.workspace })!;

      // Incomplete coverage: the source may not be relocated, whatever the run.
      const incomplete = { ...a1, coverageComplete: false };
      vi.spyOn(orchestration.backings, "get").mockImplementation((id) => id === a1.id ? incomplete : null);
      const fakeRun = { id: "run", attemptId: "attempt", threadId: runtime.conversationId,
        providerInstanceId: a1.providerInstanceId, workspaceKey: moved };
      expect(() => orchestration.backings.relocation(fakeRun, a1.id, a1.nativeSessionId)).toThrow(OrchestrationConflict);
      vi.mocked(orchestration.backings.get).mockRestore();

      moveTo(runtime.conversationId, moved);
      const inB = await nativeTurn(runtime, "second");
      const run = orchestration.events.projection("run", inB.turn.runId)!.value as { id: string; attemptId: string };
      const forged = (fromBackingId: string, backingId: string, threadId = runtime.conversationId) => {
        const event = { type: "provider.backing-relocated" as const, payload: { runId: run.id, attemptId: run.attemptId,
          fromBackingId, backingId, workspaceKey: moved } };
        orchestration.events.commit({ actorId: "runtime", commandId: `forged:${fromBackingId}:${threadId}`, threadId, projectId,
          command: event, expectedRevision: orchestration.events.revision(threadId), events: [event], result: null });
      };
      // A retired source: a1 was relocated to B when the second turn was admitted.
      expect(orchestration.backings.get(a1.id)?.status).toBe("retired");
      expect(() => forged(a1.id, relocatedBackingId(a1, moved))).toThrow(OrchestrationConflict);
      expect(() => orchestration.backings.relocation({ ...fakeRun, id: run.id, attemptId: run.attemptId }, a1.id,
        a1.nativeSessionId)).toThrow(OrchestrationConflict);

      // Another chat's source, named from this chat.
      const other = runtime.store.createConversation(projectId, "Other chat", { activate: false });
      await nativeTurn(runtime, "other", other.id, "other-native");
      const foreign = orchestration.backings.find({ threadId: other.id, providerId: "codex",
        workspaceKey: runtime.store.conversationPath(other.id), identity: identityOf(runtime, "codex", other.id) })!;
      expect(() => forged(foreign.id, relocatedBackingId(foreign, moved))).toThrow(OrchestrationConflict);
      expect(orchestration.backings.get(foreign.id)?.status).toBe("ready");
      expect(events(runtime).filter(({ type }) => type === "provider.backing-relocated")).toHaveLength(1);
    } finally { runtime.store.close(); }
  });
});

