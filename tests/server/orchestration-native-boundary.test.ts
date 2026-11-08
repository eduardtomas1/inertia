// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { NativeBoundary } from "../../src/shared/orchestration-native-boundary";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestIdentity } from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const started: NativeBoundary = { nativeConversationId: "native-thread", nativeSessionId: "native-root",
  nativeTurnId: "first-native-turn", persistedHeadId: null, phase: "started" };
const settled: NativeBoundary = { ...started, persistedHeadId: "first-native-turn", phase: "settled" };

describe("native orchestration boundaries", () => {
  it("records actual provider boundaries without confusing application IDs and replays them after restart", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Capture a stable fork point" });
    runtime.controller.start(queued.turn.id);
    const emit = (boundary: NativeBoundary) => runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "native-boundary", ...boundary });
    emit(started);
    const anchor = runtime.store.orchestration.nativeBoundaries.forRun(queued.turn.runId)!;
    expect(anchor).toMatchObject({ runId: queued.turn.runId, nativeTurnId: "first-native-turn", phase: "started" });
    expect(runtime.store.orchestration.events.projection("attempt", anchor.attemptId)?.value)
      .toMatchObject({ turnId: queued.turn.id, nativeThreadId: "native-thread", nativeTurnId: "first-native-turn" });
    const revision = runtime.store.orchestration.events.revision(runtime.conversationId);
    emit(started);
    expect(runtime.store.orchestration.events.revision(runtime.conversationId)).toBe(revision);
    emit(settled);
    runtime.provider.resolve({ status: "completed", text: "Finished", sessionId: "native-thread" });
    await flushTurnControllerTestPromises();
    const retained = runtime.store.orchestration.nativeBoundaries.forRun(queued.turn.runId);
    runtime.store.close();
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(reopened.orchestration.nativeBoundaries.forRun(queued.turn.runId)).toEqual(retained);
      reopened.orchestration.events.rebuildProjections();
      expect(reopened.orchestration.nativeBoundaries.forRun(queued.turn.runId)).toEqual(retained);
      expect(reopened.orchestration.nativeBoundaries.latest({ threadId: runtime.conversationId,
        providerInstanceId: anchor.providerInstanceId, workspaceKey: runtime.workspace,
        nativeConversationId: "native-thread" })).toEqual(retained);
      expect(reopened.orchestration.nativeBoundaries.latest({ threadId: runtime.conversationId,
        providerInstanceId: "other-account", workspaceKey: runtime.workspace,
        nativeConversationId: "native-thread" })).toBeNull();
    } finally { reopened.close(); }
  });

  it("rejects mismatched sessions, stale terminal writes and malformed anchors without changing projections", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Exact native source" });
      runtime.controller.start(queued.turn.id);
      const repository = runtime.store.orchestration.nativeBoundaries;
      repository.observe(queued.turn, started);
      const anchor = repository.forRun(queued.turn.runId);
      expect(() => repository.observe(queued.turn, { ...settled, nativeConversationId: "other-session" })).toThrow("scope-conflict");
      expect(() => repository.observe(queued.turn, { ...settled, nativeTurnId: "other-turn" })).toThrow("revision-conflict");
      expect(() => repository.observe(queued.turn, { ...settled, nativeSessionId: "other-root" })).toThrow("revision-conflict");
      expect(() => repository.observe({ ...queued.turn, conversationId: "other-chat" }, settled)).toThrow("identity conflict");
      expect(() => repository.observe(queued.turn, { ...settled, persistedHeadId: "invalid\nhead" })).toThrow();
      expect(repository.forRun(queued.turn.runId)).toEqual(anchor);
      runtime.provider.resolve({ status: "completed", sessionId: "native-thread" });
      await flushTurnControllerTestPromises();
      expect(() => repository.observe(queued.turn, settled)).toThrow("scope-conflict");
      expect(repository.forRun(queued.turn.runId)).toEqual(anchor);
    } finally { runtime.store.close(); }
  });
});
