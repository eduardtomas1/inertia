// @inertia-test-suite portable
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ProviderManager } from "../../src/server/providers";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { captured, fakeAppServer } from "../helpers/codex-app-server-fixture";
import { isItemCovered } from "../../src/server/orchestration-v2/backing-repository";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import type { ProviderHistoryInjection } from "../../src/server/provider/contracts";
import { orchestrationBackingEventSchema, type ProviderBacking } from "../../src/shared/orchestration-backings";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

const claudeSelection = providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" });
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

/** Codex, then Claude, then back to Codex: the return resumes `codex-native` with a delta of the Claude turn. */
async function returnToCodex(runtime: TurnControllerTestRuntime) {
  const first = await completeTurn(runtime, "Original Codex request", "codex-native", "Original Codex answer");
  runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
  const other = await completeTurn(runtime, "Claude follow-up", "claude-native", "Claude new answer");
  runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
  const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
  runtime.controller.start(returned.turn.id);
  const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
    identity: first.turn.continuationIdentity };
  return { first, other, returned, lookup, injection: runtime.provider.callbacks!.historyInjection! };
}

function events(runtime: TurnControllerTestRuntime) {
  const { projectId } = runtime.store.conversation(runtime.conversationId);
  return runtime.store.orchestration.events.readEvents({ projectId, threadId: runtime.conversationId, limit: 500 });
}

function projectionRows(store: RuntimeStore) {
  return (store as unknown as { database: Database.Database }).database
    .prepare("SELECT kind, id, project_id, thread_id, revision, payload_json FROM orchestration_v2_entities ORDER BY kind, id").all();
}

function handoffChanges(runtime: TurnControllerTestRuntime, runId: string) {
  return events(runtime).filter((event) => event.type === "context.handoff-state-changed"
    && (event.payload as { runId: string }).runId === runId).map(({ payload }) => payload as Record<string, unknown>);
}

function covers(runtime: TurnControllerTestRuntime, backing: ProviderBacking | null | undefined, itemId: string, runId: string): boolean {
  if (!backing) return false;
  const run = runtime.store.orchestration.events.projection("run", runId)?.value as { ordinal?: number } | undefined;
  return isItemCovered(backing, itemId, typeof run?.ordinal === "number" ? run.ordinal : null);
}

describe("native history injection: delivery records", () => {
  it("records native delivery before the turn and credits the delta, replaying to the same rows", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { first, other, returned, lookup, injection } = await returnToCodex(runtime);
      // The run carries the inline prompt; the authority carries the items and the prompt without the history block.
      expect(runtime.provider.input?.sessionId).toBe("codex-native");
      expect(runtime.provider.input?.prompt).toContain("Claude new answer");
      expect(injection.prompt).toContain("Return to Codex");
      expect(injection.prompt).not.toContain("Claude new answer");
      expect(injection.items[0]).toMatchObject({ role: "user", content: [{ type: "input_text" }] });
      expect(injection.items[0]!.content[0].text).toContain("Conversation context handoff");
      const texts = injection.items.map(({ role, content }) => `${role}:${content[0].type}:${content[0].text}`);
      expect(texts.some((text) => text.startsWith("user:input_text:") && text.includes("Claude follow-up"))).toBe(true);
      expect(texts.some((text) => text.startsWith("assistant:output_text:") && text.includes("Claude new answer"))).toBe(true);
      expect(texts.join("\n")).not.toContain("Original Codex answer");

      expect(injection.begin()).toBe(true);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "dispatching", method: "native" });
      // Output before the injection's own answer never delivers a native handoff.
      runtime.store.orchestration.acknowledge(returned.turn.runId);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)?.state).toBe("dispatching");
      expect(injection.delivered()).toBe(true);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "native" });
      expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("ready");
      // Steps are one-shot: a repeated or out-of-order step writes nothing.
      expect(injection.begin()).toBe(false);
      expect(injection.delivered()).toBe(false);
      expect(injection.unsupported()).toBe(false);

      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Returned natively" });
      runtime.provider.resolve({ sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      for (const entry of [first, other, returned]) expect(covers(runtime, backing, entry.message.id, entry.turn.runId)).toBe(true);
      expect(handoffChanges(runtime, returned.turn.runId)).toEqual([
        expect.not.objectContaining({ method: expect.anything() }),
        expect.objectContaining({ state: "dispatching", method: "native", attemptId: expect.any(String) }),
        expect.objectContaining({ state: "delivered", method: "native", targetBackingId: backing.id, nativeSessionId: "codex-native" }),
      ]);

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Next Codex turn" });
      expect(next.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)).toBeNull();

      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("keeps an injected delta covered when the turn then fails, and resumes the session with only newer items", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { other, returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
      const message = "Codex rejected the turn.";
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: message,
        failure: { reason: "codex-error", message } });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(returned.turn.id).status).toBe("failed");
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "native" });
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      expect(backing.status).toBe("ready");
      expect(covers(runtime, backing, other.message.id, other.turn.runId)).toBe(true);
      // turn/start never ran: the injection reached the thread, the turn's own prompt did not.
      expect(covers(runtime, backing, returned.message.id, returned.turn.runId)).toBe(false);
      expect(events(runtime).some(({ type }) => type === "provider.backing-invalidated")).toBe(false);

      const retry = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again" });
      expect(retry.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(retry.turn.runId)!;
      expect(handoff.itemIds).not.toContain(other.message.id);
      expect(handoff.itemIds).toContain(returned.message.id);
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("keeps the injected items but not the unsent prompt when Stop lands between delivery and turn/start", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { other, returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
      // The transport's cancellation check after injection: no turn/start, the run ends cancelled.
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(returned.turn.id).status).toBe("cancelled");
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "native" });
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      expect(backing).toMatchObject({ status: "ready" });
      expect(covers(runtime, backing, other.message.id, other.turn.runId)).toBe(true);
      expect(covers(runtime, backing, returned.message.id, returned.turn.runId)).toBe(false);
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue" });
      expect(next.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(next.turn.runId)!;
      expect(handoff.itemIds).toContain(returned.message.id);
      expect(handoff.itemIds).not.toContain(other.message.id);
    } finally { runtime.store.close(); }
  });

  it("credits the turn's own prompt once Codex started the turn, even if it then fails", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "native-boundary", nativeConversationId: "codex-native",
        nativeSessionId: null, nativeTurnId: "returned", persistedHeadId: null, phase: "started" });
      const message = "Codex failed the turn.";
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: message, failure: { reason: "codex-error", message } });
      await flushTurnControllerTestPromises();
      expect(covers(runtime, runtime.store.orchestration.backings.find(lookup), returned.message.id, returned.turn.runId)).toBe(true);
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue" });
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)).toBeNull();
    } finally { runtime.store.close(); }
  });

  it("falls back inline in the same turn when the provider does not know the method", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { other, returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.unsupported()).toBe(true);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "dispatching", method: "inline" });
      expect(injection.delivered()).toBe(false);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Inline answer" });
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "inline" });
      runtime.provider.resolve({ sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      expect(covers(runtime, runtime.store.orchestration.backings.find(lookup), other.message.id, other.turn.runId)).toBe(true);
      expect(handoffChanges(runtime, returned.turn.runId).map(({ state, method }) => [state, method ?? null])).toEqual([
        ["dispatching", null], ["dispatching", "native"], ["dispatching", "inline"], ["delivered", null]]);
    } finally { runtime.store.close(); }
  });
});

describe("turn acceptance on a harness that reports it (Codex)", () => {
  const codexLookup = (runtime: TurnControllerTestRuntime, turnId: string) => ({ threadId: runtime.conversationId,
    providerId: "codex", workspaceKey: runtime.workspace, identity: runtime.store.agentTurn(turnId).continuationIdentity,
    nativeSessionId: "codex-native" });
  const started = (runtime: TurnControllerTestRuntime, nativeTurnId: string) => runtime.provider.emit({
    ...turnControllerTestIdentity(runtime), type: "native-boundary", nativeConversationId: "codex-native",
    nativeSessionId: null, nativeTurnId, persistedHeadId: null, phase: "started" });
  const failure = { status: "failed" as const, sessionId: "codex-native", error: "Codex rejected the turn.",
    failure: { reason: "codex-error" as const, message: "Codex rejected the turn." } };

  async function failedTurn(runtime: TurnControllerTestRuntime, content: string,
    during: (runtime: TurnControllerTestRuntime) => void = () => undefined, outcome: "failed" | "cancelled" = "failed") {
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
    runtime.controller.start(queued.turn.id);
    during(runtime);
    if (outcome === "cancelled") {
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
    } else runtime.provider.resolve(failure);
    await flushTurnControllerTestPromises();
    return queued;
  }

  // Codex records thread-open notices (configuration, deprecation, MCP startup) as status activities on the turn.
  const notice = (runtime: TurnControllerTestRuntime) => runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
    type: "activity", kind: "system", phase: "info", label: "Config needs attention", detail: "A setting was ignored." });

  it.each([
    ["turn/start fails without a handoff", "failed", undefined],
    ["Stop lands during thread/resume", "cancelled", undefined],
    ["turn/start fails after a thread-open notice", "failed", notice],
  ] as const)("resends the prompt when %s", async (_label, outcome, during) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await completeTurn(runtime, "First Codex request", "codex-native", "First answer");
      const lost = await failedTurn(runtime, "Lost Codex request", during, outcome);
      const backing = runtime.store.orchestration.backings.find(codexLookup(runtime, first.turn.id))!;
      // Not delivered: the backing is as the lost turn's dispatch found it.
      expect(backing).toMatchObject({ status: "ready", lastTurnId: first.turn.id });
      expect(covers(runtime, backing, first.message.id, first.turn.runId)).toBe(true);
      expect(covers(runtime, backing, lost.message.id, lost.turn.runId)).toBe(false);
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Next request" });
      expect(next.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)?.itemIds).toContain(lost.message.id);
      runtime.controller.start(next.turn.id);
      expect(runtime.provider.input?.prompt).toContain("Lost Codex request");
    } finally { runtime.store.close(); }
  });

  it.each([
    ["Stop lands after turn/started", (runtime: TurnControllerTestRuntime) => started(runtime, "accepted"), "cancelled"],
    ["Stop races the turn/start response, which already recorded acceptance",
      (runtime: TurnControllerTestRuntime) => started(runtime, "responded"), "cancelled"],
    // In production order: turn/started, then a command and no text.
    ["a tool-only turn fails", (runtime: TurnControllerTestRuntime) => {
      started(runtime, "tools");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "activity", kind: "command", phase: "started",
        activityId: "cmd-1", label: "npm test", detail: "npm test" });
    }, "failed"],
  ] as const)("keeps the prompt delivered when %s", async (_label, during, outcome) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await completeTurn(runtime, "First Codex request", "codex-native", "First answer");
      const accepted = await failedTurn(runtime, "Accepted Codex request", during, outcome);
      const backing = runtime.store.orchestration.backings.find(codexLookup(runtime, first.turn.id))!;
      expect(covers(runtime, backing, accepted.message.id, accepted.turn.runId)).toBe(true);
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Next request" });
      expect(next.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)).toBeNull();
    } finally { runtime.store.close(); }
  });

  it("records an unaccepted switch-back as not delivered: no restored notice, and the switch is still due", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await completeTurn(runtime, "Original Codex request", "codex-native", "Original Codex answer");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const other = await completeTurn(runtime, "Claude follow-up", "claude-native", "Claude new answer");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      // Delivered inline (the injection is not used), then Codex rejects turn/start.
      const returned = await failedTurn(runtime, "Return to Codex");
      expect(returned.turn.sessionRecovery?.restoredMessageCount).toBeGreaterThan(0);
      expect(runtime.store.agentTurn(returned.turn.id).sessionRecovery).toBeNull();
      expect(runtime.store.orchestration.events.projection("run", returned.turn.runId)?.value)
        .toMatchObject({ delivery: "not-delivered" });
      expect(runtime.store.orchestration.backings.deliveredRouteTurnId(runtime.conversationId)).toBe(other.turn.id);
      const backing = runtime.store.orchestration.backings.find(codexLookup(runtime, first.turn.id))!;
      expect(backing).toMatchObject({ status: "ready", lastTurnId: first.turn.id });
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again" });
      expect(next.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)?.itemIds)
        .toEqual(expect.arrayContaining([other.message.id, returned.message.id]));
    } finally { runtime.store.close(); }
  });

  it("keeps a switch due across more failed Codex starts than any fixed window", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      await completeTurn(runtime, "Original Codex request", "codex-native", "Original Codex answer");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const other = await completeTurn(runtime, "Claude follow-up", "claude-native", "Claude new answer");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      for (let attempt = 0; attempt < 17; attempt += 1) await failedTurn(runtime, `Codex start ${attempt}`);
      expect(runtime.store.orchestration.backings.deliveredRouteTurnId(runtime.conversationId)).toBe(other.turn.id);
      const working = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Working start" });
      expect(runtime.store.orchestration.backings.handoff(working.turn.runId)?.itemIds).toContain(other.message.id);
      runtime.controller.start(working.turn.id);
      expect(runtime.provider.input?.prompt).toContain("Claude new answer");
    } finally { runtime.store.close(); }
  });

  it("treats a switch as still due when no turn ever reached a provider", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      await failedTurn(runtime, "First Codex start");
      expect(runtime.store.orchestration.backings.deliveredRouteTurnId(runtime.conversationId)).toBeNull();
    } finally { runtime.store.close(); }
  });

  it("never marks a run V2 did not admit as unaccepted (Codex compaction runs outside turn admission)", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = await completeTurn(runtime, "First Codex request", "codex-native", "First answer");
      const compaction = { ...runtime.store.agentTurn(turn.turn.id), id: "compaction-turn", runId: "compaction-run",
        status: "failed" as const };
      expect(runtime.store.orchestration.backings.unaccepted(compaction)).toBe(false);
    } finally { runtime.store.close(); }
  });

  it("keeps the restored notice of a turn whose history was injected before Codex refused the turn", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
      runtime.provider.resolve(failure);
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(returned.turn.id).sessionRecovery?.restoredMessageCount).toBeGreaterThan(0);
      // The prompt never reached Codex, but the injected history did: the route counts as reached.
      expect(runtime.store.orchestration.events.projection("run", returned.turn.runId)?.value)
        .toMatchObject({ delivery: "prompt-not-delivered" });
      expect(runtime.store.orchestration.backings.deliveredRouteTurnId(runtime.conversationId)).toBe(returned.turn.id);
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("resends both prompts after two consecutive turns that never started", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await completeTurn(runtime, "First Codex request", "codex-native", "First answer");
      const lost = await failedTurn(runtime, "First lost request");
      const again = await failedTurn(runtime, "Second lost request");
      expect(runtime.store.orchestration.backings.handoff(again.turn.runId)).toMatchObject({ state: "abandoned" });
      expect(runtime.store.orchestration.backings.find(codexLookup(runtime, first.turn.id)))
        .toMatchObject({ status: "ready", lastTurnId: first.turn.id });
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Third request" });
      expect(next.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)?.itemIds)
        .toEqual(expect.arrayContaining([lost.message.id, again.message.id]));
    } finally { runtime.store.close(); }
  });

  it("keeps the native thread when the retry of an injected switch-back also never starts", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { other, returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
      runtime.provider.resolve(failure);
      await flushTurnControllerTestPromises();
      // The retry carries the unsent prompt and is stopped while Codex resumes the thread, before any injection.
      const retry = await failedTurn(runtime, "Retry after the switch-back", undefined, "cancelled");
      expect(runtime.store.orchestration.backings.handoff(retry.turn.runId)).toMatchObject({ state: "abandoned" });
      expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("ready");
      const third = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Third turn" });
      expect(third.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(third.turn.runId)!;
      expect(handoff.itemIds).toEqual(expect.arrayContaining([returned.message.id, retry.message.id]));
      expect(handoff.itemIds).not.toContain(other.message.id);
    } finally { runtime.store.close(); }
  });

  it("still retires the session after an ambiguous injection the turn never followed", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "uncertain", method: "native" });
      expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("retired");
    } finally { runtime.store.close(); }
  });

  it("allows one injection per attempt: an unknown method keeps the handoff inline", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.unsupported()).toBe(true);
      expect(injection.begin()).toBe(false);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "dispatching", method: "inline" });
    } finally { runtime.store.close(); }
  });
});

describe("native history injection: uncertain delivery", () => {
  it.each([
    ["the transport closed during the request", "failed"],
    ["Stop arrived during the request", "cancelled"],
  ] as const)("retires the session when %s and restores the full history on a fresh thread", async (_label, outcome) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { first, other, returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      if (outcome === "cancelled") {
        expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
        runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      } else {
        const message = "The Codex App Server connection closed before the turn completed.";
        runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: message,
          failure: { reason: "transport-closed", message } });
      }
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(returned.turn.id).status).toBe(outcome);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "uncertain", method: "native" });
      expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("retired");
      expect(events(runtime).filter(({ type }) => type === "provider.backing-invalidated").map(({ payload }) => payload))
        .toEqual([expect.objectContaining({ reason: "uncertain-delivery" })]);

      const fresh = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start over" });
      expect(fresh.turn.providerSessionBefore).toBeNull();
      const handoff = runtime.store.orchestration.backings.handoff(fresh.turn.runId)!;
      expect(handoff.targetBackingId).toBeNull();
      // The full restore: the Claude turn reached Codex's route through the return's delta.
      expect(handoff.itemIds).toEqual(expect.arrayContaining([first.message.id, other.message.id, returned.message.id]));
      runtime.controller.start(fresh.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("Original Codex answer");
      expect(runtime.provider.input?.prompt).toContain("Claude new answer");
      expect(runtime.provider.callbacks?.historyInjection?.prompt).not.toContain("Original Codex answer");
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("refuses to start an injection once a Stop is recorded on the attempt", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned, injection } = await returnToCodex(runtime);
      expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
      expect(injection.begin()).toBe(false);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ method: "inline" });
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it("keeps a thread refusal before injection as not delivered, and never a started injection", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned, lookup, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      // A provider that claims nothing reached the session cannot undo a started injection.
      const message = "This conversation is open in another Codex client.";
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: message,
        failure: { reason: "codex-error", message, notDelivered: true } });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)?.state).toBe("uncertain");
      expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("retired");
    } finally { runtime.store.close(); }
  });

  it("restores the Claude turn the switch-back delivered as a delta when a later resume is rejected (G9)", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { first, other, injection } = await returnToCodex(runtime);
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Back on Codex" });
      runtime.provider.resolve({ sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      const later = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Later Codex turn" });
      runtime.controller.start(later.turn.id);
      expect(runtime.provider.input?.sessionId).toBe("codex-native");
      const replacement = runtime.provider.freshSession()!;
      expect(replacement.prompt).toContain("Original Codex answer");
      expect(replacement.prompt).toContain("Claude new answer");
      const handoff = runtime.store.orchestration.backings.handoff(later.turn.runId)!;
      expect(handoff.itemIds).toEqual(expect.arrayContaining([first.message.id, other.message.id]));
    } finally { runtime.store.close(); }
  });

  it("binds the authority to its attempt: a fresh-session fallback gets its own and the rejected one writes nothing", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { first, returned, injection } = await returnToCodex(runtime);
      const replacement = runtime.provider.freshSession();
      expect(replacement?.historyInjection).toBeDefined();
      expect(replacement!.prompt).toContain("Original Codex answer");
      expect(replacement!.historyInjection!.prompt).not.toContain("Original Codex answer");
      expect(injection.begin()).toBe(false);
      const handoff = runtime.store.orchestration.backings.handoff(returned.turn.runId)!;
      expect(handoff).toMatchObject({ state: "dispatching", method: "inline", targetBackingId: null });
      expect(handoff.itemIds).toContain(first.message.id);
      const fresh: ProviderHistoryInjection = replacement!.historyInjection!;
      // Production order: thread/start reports the session, then the injection begins.
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-fresh" });
      expect(fresh.begin()).toBe(true);
      expect(fresh.delivered()).toBe(true);
      const delivered = runtime.store.orchestration.backings.handoff(returned.turn.runId)!;
      expect(delivered).toMatchObject({ state: "delivered", method: "native", nativeSessionId: "codex-fresh",
        attemptId: runtime.store.orchestration.currentAttemptId(returned.turn.runId) });
      runtime.provider.resolve({ sessionId: "codex-fresh" });
      await flushTurnControllerTestPromises();
      const backing = runtime.store.orchestration.backings.find({ threadId: runtime.conversationId, providerId: "codex",
        workspaceKey: runtime.workspace, identity: returned.turn.continuationIdentity, nativeSessionId: "codex-fresh" })!;
      expect(backing.status).toBe("ready");
      expect(covers(runtime, backing, first.message.id, first.turn.runId)).toBe(true);
    } finally { runtime.store.close(); }
  });
});

describe("native history injection: event log compatibility", () => {
  it("replays an inline log written without a method field unchanged, before and after reopening the store", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const path = join(runtime.directory, "inertia.sqlite");
    const { returned } = await returnToCodex(runtime);
    // A provider that does not inject (as every one did before this change) delivers inline.
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Inline" });
    runtime.provider.resolve({ sessionId: "codex-native" });
    await flushTurnControllerTestPromises();
    const changes = events(runtime).filter(({ type }) => type === "context.handoff-state-changed");
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) expect(change.payload).not.toHaveProperty("method");
    expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "inline" });
    const before = projectionRows(runtime.store);
    runtime.store.orchestration.events.rebuildProjections();
    expect(projectionRows(runtime.store)).toEqual(before);
    runtime.store.close();
    const reopened = new RuntimeStore(path, runtime.workspace, { recoverInterruptedRuns: false });
    try {
      expect(reopened.orchestration.maintainProjections()).toMatchObject({ valid: true, rebuilt: false });
      expect(projectionRows(reopened)).toEqual(before);
    } finally { reopened.close(); }
    // The older payload shape stays valid.
    expect(orchestrationBackingEventSchema.parse({ type: "context.handoff-state-changed", payload: {
      handoffId: "handoff-1", runId: "run-1", attemptId: "attempt-1", state: "delivered",
      targetBackingId: null, nativeSessionId: null } }).payload).not.toHaveProperty("method");
  });

  it("refuses method changes outside dispatching and deliveries that change the method", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned } = await returnToCodex(runtime);
      const { projectId } = runtime.store.conversation(runtime.conversationId);
      const { events: store } = runtime.store.orchestration;
      const handoff = runtime.store.orchestration.backings.handoff(returned.turn.runId)!;
      const forge = (state: "dispatching" | "delivered", method?: "inline" | "native") => {
        const event = { type: "context.handoff-state-changed" as const, payload: { handoffId: handoff.id, runId: handoff.runId,
          attemptId: handoff.attemptId, state, targetBackingId: handoff.targetBackingId, nativeSessionId: handoff.nativeSessionId,
          ...(method ? { method } : {}) } };
        store.commit({ actorId: "runtime", commandId: `forged:${state}:${method ?? "none"}:${store.revision(runtime.conversationId)}`,
          threadId: runtime.conversationId, projectId, command: event, expectedRevision: store.revision(runtime.conversationId),
          events: [event], result: null });
      };
      expect(() => forge("dispatching")).toThrow(OrchestrationConflict);
      expect(() => forge("dispatching", "inline")).toThrow(OrchestrationConflict);
      expect(() => forge("delivered", "native")).toThrow(OrchestrationConflict);
      forge("dispatching", "native");
      expect(() => forge("delivered", "inline")).toThrow(OrchestrationConflict);
      forge("delivered", "native");
      expect(() => forge("dispatching", "inline")).toThrow(OrchestrationConflict);
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "native" });
    } finally { runtime.store.close(); }
  });
});

describe("native history injection: native rollback (G12)", () => {
  function boundary(runtime: TurnControllerTestRuntime, label: string) {
    for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
      type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: null, nativeTurnId: label,
      persistedHeadId: phase === "settled" ? label : null, phase });
  }

  async function codexTurn(runtime: TurnControllerTestRuntime, label: string, inject = false) {
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: `${label} request` });
    runtime.controller.start(queued.turn.id);
    if (inject) {
      const injection = runtime.provider.callbacks!.historyInjection!;
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
    }
    boundary(runtime, label);
    runtime.provider.resolve({ text: `${label} answer`, sessionId: "source-native" });
    await flushTurnControllerTestPromises();
    return queued;
  }

  /** Codex `first`, a Claude turn, Codex `third` (its delta injected), Codex `fourth`. */
  async function history(runtime: TurnControllerTestRuntime) {
    const first = await codexTurn(runtime, "first");
    runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
    const other = await completeTurn(runtime, "Claude follow-up", "claude-native", "Claude new answer");
    runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
    const third = await codexTurn(runtime, "third", true);
    expect(runtime.store.orchestration.backings.handoff(third.turn.runId)).toMatchObject({ state: "delivered", method: "native" });
    const fourth = await codexTurn(runtime, "fourth");
    const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
      identity: first.turn.continuationIdentity, nativeSessionId: "source-native" };
    expect(covers(runtime, runtime.store.orchestration.backings.find(lookup), other.message.id, other.turn.runId)).toBe(true);
    return { first, other, third, fourth, lookup };
  }

  function rollbackTo(runtime: TurnControllerTestRuntime, turnId: string, headId: string) {
    const execute = async (request: NativeConversationRequest): Promise<NativeConversationResult> => ({
      operationId: request.operationId, identity: request.source.identity, status: "completed", effect: "native-revert",
      backing: { nativeConversationId: "source-native", headId, persistedHeadId: headId } });
    const deps = { store: runtime.store, turns: runtime.controller,
      providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
      providers: { resolveModelRoute: runtime.provider.resolveModelRoute, isRunning: (id: string) => runtime.provider.isRunning(id),
        nativeConversation: vi.fn(execute) } };
    const source = { actorId: "human", commandId: `rollback-${turnId}`,
      command: { type: "conversation.rollback", requestId: `rollback-${turnId}`, payload: { conversationId: runtime.conversationId, turnId } } };
    return rollbackConversationHistory(deps, { conversationId: runtime.conversationId, turnId, source }, new AbortController().signal);
  }

  it("drops an older item a rolled-back delta delivered from outside the restore's candidate window", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const claude = [];
      for (let index = 0; index < 130; index += 1) {
        claude.push(await completeTurn(runtime, `Claude request ${index}`, "claude-native", `Claude answer ${index}`));
      }
      // The oldest answer: older than the restore's 256-candidate window, which always keeps the opening user message.
      const oldest = runtime.store.agentTurn(claude[0]!.turn.id).terminalAssistantMessageId!;
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      const first = await codexTurn(runtime, "first");
      const restore = runtime.store.orchestration.backings.handoff(first.turn.runId)!;
      expect([...restore.itemIds, ...restore.omittedItemIds ?? []]).not.toContain(oldest);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      await completeTurn(runtime, "Claude between", "claude-native", "Claude between answer");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      const third = await codexTurn(runtime, "third", true);
      const delta = runtime.store.orchestration.backings.handoff(third.turn.runId)!;
      expect([...delta.itemIds, ...delta.omittedItemIds ?? []]).toContain(oldest);
      const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity, nativeSessionId: "source-native" };
      expect(covers(runtime, runtime.store.orchestration.backings.find(lookup), oldest, claude[0]!.turn.runId)).toBe(true);
      await expect(rollbackTo(runtime, first.turn.id, "first")).resolves.toMatchObject({ transfer: "native", rolledBackTurns: 2 });
      // The rewind removed what the third run delivered, including the item older than the kept turn.
      const rewound = runtime.store.orchestration.backings.find(lookup)!;
      expect(covers(runtime, rewound, oldest, claude[0]!.turn.runId)).toBe(false);
    } finally { runtime.store.close(); }
  }, 45_000);

  it("keeps the injected items when the rollback keeps the injecting run", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { other, third, fourth, lookup } = await history(runtime);
      await expect(rollbackTo(runtime, third.turn.id, "third")).resolves.toMatchObject({ transfer: "native", rolledBackTurns: 1 });
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      expect(backing.status).toBe("ready");
      expect(covers(runtime, backing, other.message.id, other.turn.runId)).toBe(true);
      expect(covers(runtime, backing, third.message.id, third.turn.runId)).toBe(true);
      expect(covers(runtime, backing, fourth.message.id, fourth.turn.runId)).toBe(false);
    } finally { runtime.store.close(); }
  });

  it("drops the injected items when the rollback removes the injecting run", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { first, other, third, lookup } = await history(runtime);
      await expect(rollbackTo(runtime, first.turn.id, "first")).resolves.toMatchObject({ transfer: "native", rolledBackTurns: 3 });
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      expect(covers(runtime, backing, first.message.id, first.turn.runId)).toBe(true);
      expect(covers(runtime, backing, other.message.id, other.turn.runId)).toBe(false);
      expect(covers(runtime, backing, third.message.id, third.turn.runId)).toBe(false);
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });
});

describe("native history injection over the Codex App Server fixture", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapture = process.env.INERTIA_APP_SERVER_CAPTURE;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapture === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapture;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  /** The fixture's turn asks for an approval and an answer; grant both. */
  const answers = (manager: ProviderManager) => ({
    onApproval: (event: { conversationId: string; runId: string; turnId: string; request: { requestId: string } }) =>
      manager.respondToApproval(event.conversationId, event.request.requestId, "approve", { runId: event.runId, turnId: event.turnId }),
    onInput: (event: { conversationId: string; runId: string; turnId: string; request: { requestId: string } }) =>
      manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] }, { runId: event.runId, turnId: event.turnId }),
  });

  /** Runs the turn the controller started through the real transport, then hands its result back. */
  async function runOverAppServer(runtime: TurnControllerTestRuntime, scenario?: string) {
    const fake = fakeAppServer(roots);
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const manager = ProviderManager.createForTests({
      commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, environment) => ({ environment: { ...environment,
        INERTIA_APP_SERVER_CAPTURE: fake.capturePath, ...(scenario ? { INERTIA_APP_SERVER_SCENARIO: scenario } : {}) } }),
    });
    managers.push(manager);
    const result = await manager.run({ ...runtime.provider.input!, cwd: fake.root }, {
      ...runtime.provider.callbacks!,
      ...answers(manager),
    });
    runtime.provider.resolve(result);
    await flushTurnControllerTestPromises();
    return { result, messages: captured(fake.capturePath) as { method?: string; params?: Record<string, unknown> }[] };
  }

  it("injects the delta on the resumed thread, starts the turn without it and credits it", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { other, returned, lookup, injection } = await returnToCodex(runtime);
      const { result, messages } = await runOverAppServer(runtime);
      expect(result.status).toBe("completed");
      const order = messages.flatMap(({ method }) => method ? [method] : []);
      expect(order.indexOf("thread/resume")).toBeLessThan(order.indexOf("thread/inject_items"));
      expect(order.indexOf("thread/inject_items")).toBeLessThan(order.indexOf("turn/start"));
      expect(messages.find(({ method }) => method === "thread/inject_items")!.params)
        .toEqual({ threadId: "codex-native", items: injection.items });
      const turn = JSON.stringify(messages.find(({ method }) => method === "turn/start")!.params);
      expect(turn).toContain("Return to Codex");
      expect(turn).not.toContain("Claude new answer");
      expect(runtime.store.agentTurn(returned.turn.id).status).toBe("completed");
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "native" });
      expect(covers(runtime, runtime.store.orchestration.backings.find(lookup), other.message.id, other.turn.runId)).toBe(true);
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("keeps the injected delta covered when turn/start then fails", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { other, returned, lookup } = await returnToCodex(runtime);
      const { result, messages } = await runOverAppServer(runtime, "turn-start-error");
      expect(result.status).toBe("failed");
      expect(messages.some(({ method }) => method === "thread/inject_items")).toBe(true);
      expect(runtime.store.agentTurn(returned.turn.id).status).toBe("failed");
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "native" });
      const backing = runtime.store.orchestration.backings.find(lookup)!;
      expect(backing.status).toBe("ready");
      expect(covers(runtime, backing, other.message.id, other.turn.runId)).toBe(true);
      expect(covers(runtime, backing, returned.message.id, returned.turn.runId)).toBe(false);
      const retry = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Try again" });
      expect(retry.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(retry.turn.runId)!;
      expect(handoff.itemIds).not.toContain(other.message.id);
      // Codex never received "Return to Codex": the retry carries it.
      expect(handoff.itemIds).toContain(returned.message.id);
      runtime.controller.start(retry.turn.id);
      expect(runtime.provider.callbacks?.historyInjection?.items.map(({ content }) => content[0].text).join("\n"))
        .toContain("Return to Codex");
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("goes inline in the same turn on an App Server without the method, and records it", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const { returned } = await returnToCodex(runtime);
      process.env.INERTIA_APP_SERVER_INJECT = "unknown-method";
      try {
        const fake = fakeAppServer(roots);
        process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
        const manager = ProviderManager.createForTests({ commands: { codex: fake.command },
          resolveBackendLaunchOptions: (_input, environment) => ({ environment: { ...environment,
            INERTIA_APP_SERVER_CAPTURE: fake.capturePath, INERTIA_APP_SERVER_INJECT: "unknown-method" } }) });
        managers.push(manager);
        const result = await manager.run({ ...runtime.provider.input!, cwd: fake.root },
          { ...runtime.provider.callbacks!, ...answers(manager) });
        runtime.provider.resolve(result);
        await flushTurnControllerTestPromises();
        expect(result.status).toBe("completed");
        expect(JSON.stringify((captured(fake.capturePath) as { method?: string; params?: unknown }[])
          .find(({ method }) => method === "turn/start")!.params)).toContain("Claude new answer");
      } finally { delete process.env.INERTIA_APP_SERVER_INJECT; }
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)).toMatchObject({ state: "delivered", method: "inline" });
    } finally { runtime.store.close(); }
  });
});
