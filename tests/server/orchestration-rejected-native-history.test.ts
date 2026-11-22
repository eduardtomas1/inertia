// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderBackgroundWorkSession, ProviderRunFailure } from "../../src/server/provider/contracts";
import { ContextHandoffBackgroundWorkError } from "../../src/server/runtime/turns/turn-context-handoff";
import type { OrchestrationBackingEvent } from "../../src/shared/orchestration-backings";
import { orchestrationRunSchema } from "../../src/shared/orchestration-v2";
import type { NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

// T3 b99333dc7 `CodexManagedErrors.ts`: the failed turn's message.
const REJECTED_MESSAGE = "Codex could not verify this session's encrypted conversation history. Send another message to continue in a fresh session with the visible conversation history.";
const REJECTED: ProviderRunFailure = { reason: "codex-error", message: REJECTED_MESSAGE, code: "invalid_encrypted_content" };
const UNRELATED: ProviderRunFailure = { reason: "codex-error", message: "Encrypted content could not be verified" };

/** A Codex turn its provider accepted (a native turn boundary), on `sessionId`. */
async function acceptedTurn(runtime: TurnControllerTestRuntime, content: string, sessionId: string,
  outcome: { text: string } | { failure: ProviderRunFailure }) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
  runtime.controller.start(queued.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
    type: "native-boundary", nativeConversationId: sessionId, nativeSessionId: null, nativeTurnId: queued.turn.id,
    persistedHeadId: phase === "settled" ? queued.turn.id : null, phase });
  if ("text" in outcome) {
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: outcome.text });
    runtime.provider.resolve({ sessionId });
  } else {
    runtime.provider.resolve({ status: "failed", sessionId, error: outcome.failure.message, failure: outcome.failure });
  }
  await flushTurnControllerTestPromises();
  return queued;
}

async function failedOnNativeSession(failure: ProviderRunFailure) {
  const runtime = await createTurnControllerTestRuntime();
  const first = await acceptedTurn(runtime, "Reply BASELINE_OK; remember the constraint", "codex-native",
    { text: "BASELINE_OK" });
  const failed = await acceptedTurn(runtime, "Continue using encrypted history", "codex-native", { failure });
  const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
    identity: first.turn.continuationIdentity };
  const original = runtime.store.orchestration.backings.find(lookup)!;
  expect(original).toMatchObject({ nativeSessionId: "codex-native", status: "ready" });
  return { runtime, first, failed, lookup, original };
}

function threadEvents(runtime: TurnControllerTestRuntime) {
  const { projectId } = runtime.store.conversation(runtime.conversationId);
  return runtime.store.orchestration.events.readEvents({ projectId, threadId: runtime.conversationId, limit: 500 });
}

function run(runtime: TurnControllerTestRuntime, runId: string) {
  return orchestrationRunSchema.parse(runtime.store.orchestration.events.projection("run", runId)?.value);
}

describe("Codex rejecting a native session's encrypted history (T3 rejected_native_history)", () => {
  it("records the code on the failed run and shows T3's message on the failed turn", async () => {
    const { runtime, failed } = await failedOnNativeSession(REJECTED);
    try {
      expect(run(runtime, failed.turn.runId)).toMatchObject({ status: "failed", failureCode: "invalid_encrypted_content" });
      expect(runtime.store.agentTurn(failed.turn.id).status).toBe("failed");
      expect(runtime.events).toContainEqual(expect.objectContaining({ type: "agent.failed", turnId: failed.turn.id,
        message: REJECTED_MESSAGE }));
      expect(runtime.events).toContainEqual(expect.objectContaining({ type: "agent.activity",
        activity: expect.objectContaining({ turnId: failed.turn.id, kind: "error", title: REJECTED_MESSAGE }) }));
    } finally { runtime.store.close(); }
  });

  it("starts the next turn in a fresh session with the full portable history and retires the rejected one", async () => {
    const { runtime, first, failed, lookup, original } = await failedOnNativeSession(REJECTED);
    try {
      const probes: ProviderBackgroundWorkSession[] = [];
      Object.assign(runtime.provider, { pendingBackgroundWork: (session: ProviderBackgroundWorkSession) => {
        probes.push(session);
        return "none";
      } });
      const recovered = runtime.controller.queue({ conversationId: runtime.conversationId, content: "huh" });
      expect(probes).toEqual([expect.objectContaining({ conversationId: runtime.conversationId, providerId: "codex",
        nativeSessionId: "codex-native" })]);
      expect(recovered.turn.providerSessionBefore).toBeNull();
      expect(threadEvents(runtime).filter((event) => event.type === "provider.backing-invalidated").map(({ payload }) => payload))
        .toEqual([{ backingId: original.id, reason: "rejected-native-history" } satisfies
          Extract<OrchestrationBackingEvent, { type: "provider.backing-invalidated" }>["payload"]]);
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("retired");
      expect(runtime.store.orchestration.backings.handoff(recovered.turn.runId)).toMatchObject({ targetBackingId: null });
      expect(runtime.store.orchestration.backings.handoff(recovered.turn.runId)?.itemIds)
        .toEqual(expect.arrayContaining([first.message.id, failed.message.id]));

      runtime.controller.start(recovered.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("remember the constraint");
      expect(runtime.provider.input?.prompt).toContain("BASELINE_OK");
      expect(runtime.provider.input?.prompt.split("huh")).toHaveLength(2);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-fresh" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "RECOVERY_OK" });
      runtime.provider.resolve({ sessionId: "codex-fresh" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.find(lookup)).toMatchObject({ nativeSessionId: "codex-fresh", status: "ready" });

      // The replacement is the current session from here on: no second recovery.
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "ok" });
      expect(next.turn.providerSessionBefore).toBe("codex-fresh");
      expect(probes).toHaveLength(1);
    } finally { runtime.store.close(); }
  });

  it("fails honestly when the fresh session comes back as the rejected one, and never adopts it (T3 d32df2d34)", async () => {
    const { runtime, lookup, original } = await failedOnNativeSession(REJECTED);
    try {
      const recovered = runtime.controller.queue({ conversationId: runtime.conversationId, content: "huh" });
      runtime.controller.start(recovered.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ sessionId: "codex-native", text: "Answer on the rejected session" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(recovered.turn.id)).toMatchObject({ status: "failed", providerSessionAfter: null });
      expect(runtime.events).toContainEqual(expect.objectContaining({ type: "agent.failed", turnId: recovered.turn.id,
        message: "The provider returned its existing session when asked for a fresh one, so the conversation context could not be moved to a new session." }));
      expect(runtime.store.orchestration.backings.find(lookup)).toMatchObject({ id: original.id, status: "retired" });
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).not.toBe("codex-native");
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "ok" });
      expect(next.turn.providerSessionBefore).toBeNull();
    } finally { runtime.store.close(); }
  });

  it("refuses with T3's message while the rejected session still has background work", async () => {
    const { runtime, lookup, original } = await failedOnNativeSession(REJECTED);
    try {
      Object.assign(runtime.provider, { pendingBackgroundWork: () => "pending" });
      const before = threadEvents(runtime).length;
      const refuse = () => runtime.controller.queue({ conversationId: runtime.conversationId, content: "huh" });
      expect(refuse).toThrow(ContextHandoffBackgroundWorkError);
      expect(refuse).toThrow("The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.");
      expect(threadEvents(runtime)).toHaveLength(before);
      expect(runtime.store.orchestration.backings.find(lookup)).toEqual(original);

      // A refusal reaches no provider, so the rejected run stays the one to recover from.
      Object.assign(runtime.provider, { pendingBackgroundWork: () => "none" });
      const retried = runtime.controller.queue({ conversationId: runtime.conversationId, content: "huh" });
      expect(retried.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("retired");
    } finally { runtime.store.close(); }
  });

  it("keeps resuming the native session after an unrelated failure", async () => {
    const { runtime, lookup } = await failedOnNativeSession(REJECTED);
    try {
      // Control: the rejection moves the chat to a fresh session.
      const recovered = await acceptedTurn(runtime, "huh", "codex-fresh", { text: "RECOVERY_OK" });
      expect(recovered.turn.providerSessionBefore).toBeNull();
      // T3 `other-error`: the same provider text without the managed code.
      const failed = await acceptedTurn(runtime, "Continue", "codex-fresh", { failure: UNRELATED });
      expect(run(runtime, failed.turn.runId)).toMatchObject({ status: "failed" });
      expect(run(runtime, failed.turn.runId).failureCode).toBeUndefined();
      Object.assign(runtime.provider, { pendingBackgroundWork: () => { throw new Error("probe must not run"); } });

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "ok" });
      expect(next.turn.providerSessionBefore).toBe("codex-fresh");
      expect(runtime.store.orchestration.backings.find(lookup)).toMatchObject({ nativeSessionId: "codex-fresh", status: "ready" });
    } finally { runtime.store.close(); }
  });

  it("ignores a rejection on a native session that is no longer the current one", async () => {
    const { runtime, first, failed, original } = await failedOnNativeSession(REJECTED);
    try {
      expect(run(runtime, failed.turn.runId).failureCode).toBe("invalid_encrypted_content");
      // T3 `repaired-native`: the chat's current native conversation already moved off the rejected thread.
      const { projectId } = runtime.store.conversation(runtime.conversationId);
      const repaired = { ...original, id: "backing-repaired", nativeSessionId: "codex-repaired",
        lastRunId: first.turn.runId, lastTurnId: first.turn.id };
      const event: OrchestrationBackingEvent = { type: "provider.backing-recorded",
        payload: { backing: repaired, runId: first.turn.runId, attemptId: run(runtime, first.turn.runId).attemptId } };
      runtime.store.orchestration.events.commit({ actorId: "runtime", commandId: "repaired-native", projectId,
        threadId: runtime.conversationId, command: event,
        expectedRevision: runtime.store.orchestration.events.revision(runtime.conversationId), events: [event], result: null });
      Object.assign(runtime.provider, { pendingBackgroundWork: () => { throw new Error("probe must not run"); } });

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "huh" });
      expect(next.turn.providerSessionBefore).toBe("codex-repaired");
      expect(threadEvents(runtime).some((entry) => entry.type === "provider.backing-invalidated")).toBe(false);
    } finally { runtime.store.close(); }
  });

  it("passes over a later Codex run its provider never received", async () => {
    const { runtime, original } = await failedOnNativeSession(REJECTED);
    try {
      // A goal start resumes the rejected session (exempt), and Codex never accepts its turn: `not-delivered`.
      const goal = runtime.controller.queue({ conversationId: runtime.conversationId, content: "/goal Finish",
        goalStart: { objective: "Finish" } });
      expect(goal.turn.providerSessionBefore).toBe("codex-native");
      runtime.controller.start(goal.turn.id);
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: "Codex could not start the goal.",
        failure: { reason: "codex-error", message: "Codex could not start the goal." } });
      await flushTurnControllerTestPromises();
      expect(run(runtime, goal.turn.runId)).toMatchObject({ status: "failed", delivery: "not-delivered" });

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "huh" });
      expect(next.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("retired");
    } finally { runtime.store.close(); }
  });

  it("lets a goal start resume the rejected session, as with context exhaustion", async () => {
    const { runtime, original } = await failedOnNativeSession(REJECTED);
    try {
      Object.assign(runtime.provider, { pendingBackgroundWork: () => { throw new Error("probe must not run"); } });
      const goal = runtime.controller.queue({ conversationId: runtime.conversationId, content: "/goal Finish",
        goalStart: { objective: "Finish" } });
      expect(goal.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("ready");
    } finally { runtime.store.close(); }
  });

  it("ignores a rejection recorded on another provider instance", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      // The other instance's run reuses the Codex session's id, so only the instance filter tells them apart.
      await acceptedTurn(runtime, "Codex baseline", "shared-native", { text: "BASELINE_OK" });
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
        modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
      const other = await acceptedTurn(runtime, "Claude turn", "shared-native", { failure: REJECTED });
      expect(run(runtime, other.turn.runId).failureCode).toBe("invalid_encrypted_content");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
      Object.assign(runtime.provider, { pendingBackgroundWork: () => { throw new Error("probe must not run"); } });

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Back on Codex" });
      expect(next.turn.providerSessionBefore).toBe("shared-native");
      expect(threadEvents(runtime).some((entry) => entry.type === "provider.backing-invalidated")).toBe(false);
    } finally { runtime.store.close(); }
  });

  it("still starts fresh after a native rollback of the rejected run", async () => {
    const { runtime, first, failed, original } = await failedOnNativeSession(REJECTED);
    try {
      const nativeConversation = vi.fn(async (request: NativeConversationRequest): Promise<NativeConversationResult> => ({
        operationId: request.operationId, identity: request.source.identity, status: "completed", effect: "native-revert",
        backing: { nativeConversationId: "codex-native", headId: first.turn.id, persistedHeadId: first.turn.id } }));
      const deps = { store: runtime.store, turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: { resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id), nativeConversation } };
      const commandId = "rollback-rejected";
      await expect(rollbackConversationHistory(deps, { conversationId: runtime.conversationId, turnId: first.turn.id,
        source: { actorId: "human", commandId, command: { type: "conversation.rollback", requestId: commandId,
          payload: { conversationId: runtime.conversationId, turnId: first.turn.id } } } }, new AbortController().signal))
        .resolves.toMatchObject({ transfer: "native", rolledBackTurns: 1 });
      expect(runtime.store.orchestration.history.rolledBack(failed.turn.id)).toBe(true);
      expect(runtime.store.orchestration.backings.current({ threadId: runtime.conversationId, providerId: "codex",
        identity: first.turn.continuationIdentity })).toMatchObject({ nativeSessionId: "codex-native", status: "ready" });

      // The revert keeps the native session and the older turns whose encrypted content Codex rejected.
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "huh" });
      expect(next.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.get(original.id)?.status).toBe("retired");
    } finally { runtime.store.close(); }
  });
});
