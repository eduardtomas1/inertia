// @inertia-test-suite portable
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { ModelSelection } from "../../src/shared/contracts";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const cursorSdkSelection: ModelSelection = { ...providerNativeModelSelection({ providerId: "cursor", modelId: "synthetic-model" }),
  harnessId: "cursor-sdk" };
const codexSelection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" });

async function completeTurn(runtime: TurnControllerTestRuntime, content: string, sessionId: string, answer: string) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
  runtime.controller.start(queued.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: answer });
  runtime.provider.resolve({ sessionId });
  await flushTurnControllerTestPromises();
  return queued;
}

/**
 * A Cursor SDK chat that went to Codex and back: the return turn resumes the Cursor agent with the Codex turn as its
 * inline handoff, and streams output, which delivers that handoff and readies the agent's backing.
 */
async function returnedToCursor() {
  const runtime = await createTurnControllerTestRuntime({}, { modelSelection: cursorSdkSelection });
  const first = await completeTurn(runtime, "Original Cursor request", "cursor-agent", "Original Cursor answer");
  expect(runtime.provider.input?.harnessId).toBe("cursor-sdk");
  runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
  const codex = await completeTurn(runtime, "Codex follow-up", "codex-native", "Codex answer");
  runtime.store.updateConversation(runtime.conversationId, { providerId: "cursor", modelSelection: cursorSdkSelection });
  const dropped = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Rename the exporter" });
  expect(dropped.turn.providerSessionBefore).toBe("cursor-agent");
  runtime.controller.start(dropped.turn.id);
  expect(runtime.provider.input?.harnessId).toBe("cursor-sdk");
  expect(runtime.provider.input?.prompt).toContain("Codex answer");
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "cursor-agent" });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Renaming the exporter now" });
  const { backings } = runtime.store.orchestration;
  expect(backings.handoff(dropped.turn.runId)).toMatchObject({ state: "delivered", method: "inline" });
  const lookup = { threadId: runtime.conversationId, providerId: "cursor", workspaceKey: runtime.workspace,
    identity: first.turn.continuationIdentity, nativeSessionId: "cursor-agent" };
  expect(backings.find(lookup)).toMatchObject({ status: "ready", lastRunId: dropped.turn.runId });
  return { runtime, first, codex, dropped, lookup };
}

function run(runtime: TurnControllerTestRuntime, runId: string) {
  return runtime.store.orchestration.events.projection("run", runId)?.value as Record<string, unknown>;
}

function projectionRows(runtime: TurnControllerTestRuntime) {
  return (runtime.store as unknown as { database: Database.Database }).database
    .prepare("SELECT kind, id, project_id, thread_id, revision, payload_json FROM orchestration_v2_entities ORDER BY kind, id").all();
}

/** The next Cursor turn resumes the agent and resends what the dropped prompt carried, then completes. */
async function expectResent(runtime: TurnControllerTestRuntime, f: Awaited<ReturnType<typeof returnedToCursor>>) {
  const { backings } = runtime.store.orchestration;
  const kept = backings.find(f.lookup)!;
  expect(kept).toMatchObject({ status: "ready", lastRunId: f.first.turn.runId });
  for (const id of [f.codex.message.id, f.dropped.message.id]) expect(kept.coveredItemIds).not.toContain(id);
  // The return turn is not delivered, so the switch it attempted is still due.
  expect(backings.deliveredRouteTurnId(runtime.conversationId)).toBe(f.codex.turn.id);
  const retry = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try the rename again" });
  expect(retry.turn.providerSessionBefore).toBe("cursor-agent");
  const handoff = backings.handoff(retry.turn.runId)!;
  expect(handoff.targetBackingId).toBe(kept.id);
  expect(handoff.itemIds).toEqual(expect.arrayContaining([f.codex.message.id, f.dropped.message.id]));
  runtime.controller.start(retry.turn.id);
  expect(runtime.provider.input?.prompt).toContain("Codex answer");
  expect(runtime.provider.input?.prompt).toContain("Rename the exporter");
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "cursor-agent" });
  runtime.provider.resolve({ sessionId: "cursor-agent", text: "Renamed" });
  await flushTurnControllerTestPromises();
  expect(backings.find(f.lookup)?.coveredItemIds).toEqual(expect.arrayContaining([f.codex.message.id, f.dropped.message.id]));
}

describe("a Cursor SDK turn that ends before its first checkpoint did not deliver its prompt (T3 c5fa33b27)", () => {
  it("settles a failed turn whose provider dropped the prompt as not delivered, though output streamed, and resends it", async () => {
    const f = await returnedToCursor();
    const { runtime, dropped } = f;
    try {
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "failed",
        message: "Cursor SDK execution failed.", promptDropped: true });
      runtime.provider.resolve({ status: "failed", sessionId: "cursor-agent", error: "Cursor SDK execution failed.",
        failure: { reason: "provider-error", message: "Cursor SDK execution failed." } });
      await flushTurnControllerTestPromises();
      expect(run(runtime, dropped.turn.runId)).toMatchObject({ status: "failed", delivery: "not-delivered", promptDropped: true });
      // The handoff its output delivered is taken back; the restored-history notice goes with it.
      expect(runtime.store.orchestration.backings.handoff(dropped.turn.runId)?.state).toBe("abandoned");
      expect(runtime.store.agentTurn(dropped.turn.id).sessionRecovery).toBeNull();
      // The settlement replays exactly.
      const before = projectionRows(runtime);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime)).toEqual(before);
      await expectResent(runtime, f);
    } finally { runtime.store.close(); }
  });

  it("settles a turn the user stopped after its provider dropped the prompt as not delivered and missed", async () => {
    const f = await returnedToCursor();
    const { runtime, dropped } = f;
    try {
      // Production order: the Stop settles the turn only after the provider run settled, and the harness reports
      // its terminal status before its result.
      runtime.provider.deferOwnedStop("settled");
      runtime.controller.cancel(runtime.conversationId);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "cancelled", promptDropped: true });
      runtime.provider.resolve({ status: "cancelled", sessionId: "cursor-agent" });
      runtime.provider.resolveOwnedStop();
      await flushTurnControllerTestPromises();
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(dropped.turn.id).status).toBe("cancelled");
      expect(run(runtime, dropped.turn.runId)).toMatchObject({ status: "cancelled", delivery: "not-delivered", promptDropped: true });
      expect(runtime.store.orchestration.backings.handoff(dropped.turn.runId)?.state).toBe("abandoned");
      await expectResent(runtime, f);
    } finally { runtime.store.close(); }
  });

  it("keeps a checkpointed failure delivered, and takes back only what a dropped prompt of the exact run carried", async () => {
    const f = await returnedToCursor();
    const { runtime, dropped: kept } = f;
    try {
      // The provider kept the prompt (Cursor saved a checkpoint): the failure settles as before, its output delivering.
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "failed", message: "Cursor SDK execution failed." });
      runtime.provider.resolve({ status: "failed", sessionId: "cursor-agent", error: "Cursor SDK execution failed.",
        failure: { reason: "provider-error", message: "Cursor SDK execution failed." } });
      await flushTurnControllerTestPromises();
      expect(run(runtime, kept.turn.runId)).toMatchObject({ status: "failed" });
      expect(run(runtime, kept.turn.runId)).not.toHaveProperty("delivery");
      expect(run(runtime, kept.turn.runId)).not.toHaveProperty("promptDropped");
      const { backings, events } = runtime.store.orchestration;
      expect(backings.handoff(kept.turn.runId)?.state).toBe("delivered");
      expect(backings.find(f.lookup)?.coveredItemIds).toEqual(expect.arrayContaining([f.codex.message.id, kept.message.id]));
      expect(backings.deliveredRouteTurnId(runtime.conversationId)).toBe(kept.turn.id);
      // Only a run marked `promptDropped` takes back an inline handoff its output delivered.
      const handoff = backings.handoff(kept.turn.runId)!;
      const projectId = runtime.store.conversation(runtime.conversationId).projectId;
      const abandon = { type: "context.handoff-state-changed" as const, payload: { handoffId: handoff.id, runId: handoff.runId,
        attemptId: handoff.attemptId, state: "abandoned" as const, targetBackingId: handoff.targetBackingId, nativeSessionId: handoff.nativeSessionId } };
      expect(() => events.commit({ actorId: "runtime", commandId: "abandon-delivered", projectId, threadId: runtime.conversationId,
        command: abandon, expectedRevision: events.revision(runtime.conversationId), events: [abandon], result: null }))
        .toThrow(expect.objectContaining({ code: "revision-conflict" }));

      // A dropped status naming another run is not this turn's: it stays delivered.
      const failTurn = async (content: string, promptDropped: Record<string, unknown>) => {
        const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
        runtime.controller.start(queued.turn.id);
        runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "cursor-agent" });
        runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: `Working on: ${content}` });
        runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "failed", promptDropped: true, ...promptDropped });
        runtime.provider.resolve({ status: "failed", sessionId: "cursor-agent", error: "Cursor SDK execution failed.",
          failure: { reason: "provider-error", message: "Cursor SDK execution failed." } });
        await flushTurnControllerTestPromises();
        return queued;
      };
      const foreign = await failTurn("Now update the callers", { runId: "another-run" });
      expect(run(runtime, foreign.turn.runId)).not.toHaveProperty("delivery");
      expect(backings.find(f.lookup)).toMatchObject({ lastRunId: foreign.turn.runId });
      expect(backings.find(f.lookup)?.coveredItemIds).toContain(foreign.message.id);

      // The exact run's dropped prompt is taken back alone: what earlier runs delivered stays covered.
      const lost = await failTurn("And the tests", {});
      expect(run(runtime, lost.turn.runId)).toMatchObject({ status: "failed", delivery: "not-delivered", promptDropped: true });
      const backing = backings.find(f.lookup)!;
      expect(backing).toMatchObject({ status: "ready", lastRunId: foreign.turn.runId });
      expect(backing.coveredItemIds).toEqual(expect.arrayContaining([f.codex.message.id, kept.message.id, foreign.message.id]));
      expect(backing.coveredItemIds).not.toContain(lost.message.id);
      expect(backings.deliveredRouteTurnId(runtime.conversationId)).toBe(foreign.turn.id);
    } finally { runtime.store.close(); }
  });
});
