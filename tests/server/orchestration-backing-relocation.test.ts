// @inertia-test-suite portable
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { relocatedBackingId } from "../../src/server/orchestration-v2/backing-projector";
import { OrchestrationConflict } from "../../src/server/orchestration-v2/types";
import { sessionCwdMobility } from "../../src/server/provider/session-cwd-mobility";
import { CheckoutMoveBackgroundWorkError } from "../../src/server/runtime/turns/turn-context-handoff";
import type { ProviderBackgroundWorkSession } from "../../src/server/provider/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

const claudeSelection = providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" });
const codexSelection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" });

const usage = (usedTokens: number) => ({
  usedTokens, totalProcessedTokens: usedTokens, totalProcessedScope: "run" as const, maxTokens: 128_000,
  inputTokens: usedTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
  reasoningOutputTokens: 0, compactsAutomatically: false,
});

async function completeTurn(runtime: TurnControllerTestRuntime, content: string, sessionId: string, answer: string,
  options: { usedTokens?: number } = {}) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
  runtime.controller.start(queued.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  if (options.usedTokens !== undefined) {
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "usage", usage: usage(options.usedTokens) });
  }
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: answer });
  runtime.provider.resolve({ sessionId });
  await flushTurnControllerTestPromises();
  return queued;
}

/** A chat whose checkout can move between two folders, like a worktree handoff. */
async function movableRuntime() {
  const runtime = await createTurnControllerTestRuntime();
  const original = runtime.workspace;
  const moved = join(runtime.directory, "moved-checkout");
  await mkdir(moved);
  let checkout = original;
  const realPath = runtime.store.conversationPath.bind(runtime.store);
  vi.spyOn(runtime.store, "conversationPath").mockImplementation((id) => id === runtime.conversationId ? checkout : realPath(id));
  return { runtime, original, moved, moveTo: (path: string) => { checkout = path; } };
}

function events(runtime: TurnControllerTestRuntime) {
  const { projectId } = runtime.store.conversation(runtime.conversationId);
  return runtime.store.orchestration.events.readEvents({ projectId, threadId: runtime.conversationId, limit: 500 });
}

function projectionRows(store: RuntimeStore) {
  return (store as unknown as { database: Database.Database }).database
    .prepare("SELECT kind, id, project_id, thread_id, revision, payload_json FROM orchestration_v2_entities ORDER BY kind, id").all();
}

function closeQuietly(store: RuntimeStore) {
  try { store.close(); } catch { /* already closed by the test */ }
}

/** The provider's own latest turn names its continuation identity, whichever provider ran last. */
const lookup = (runtime: TurnControllerTestRuntime, providerId: "codex" | "claude", workspaceKey: string) => ({
  threadId: runtime.conversationId, providerId, workspaceKey,
  identity: runtime.store.agentTurnsForConversation(runtime.conversationId)
    .filter((turn) => turn.providerId === providerId).at(-1)!.continuationIdentity,
});

describe("session cwd mobility", () => {
  it("resumes across checkouts only where a harness is proven to, and starts fresh everywhere else", () => {
    expect(sessionCwdMobility("codex-app-server")).toBe("resume");
    for (const harnessId of ["codex-cli", "claude-agent-sdk", "claude-cli", "pi-rpc", "cursor-sdk", "cursor-acp",
      "cursor-cli", "kimi-acp", "grok-acp", "opencode-sdk", "opencode-cli", "antigravity-cli", "unknown-harness",
      "toString", "__proto__"]) {
      expect(sessionCwdMobility(harnessId)).toBe("fresh");
    }
  });
});

describe("a backing follows its native session across checkouts (T3 restart_and_resume)", () => {
  it("returns A → B → A on the original native session and delivers only the intervening items", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      const first = await completeTurn(runtime, "Request in A", "codex-native", "Answer in A");
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;

      moveTo(moved);
      const inB = await completeTurn(runtime, "Request in B", "codex-native", "Answer in B");
      expect(runtime.provider.input).toMatchObject({ sessionId: "codex-native", cwd: moved });
      const b1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", moved))!;
      expect(b1).toMatchObject({ id: relocatedBackingId(a1, moved), nativeSessionId: "codex-native", status: "ready" });
      expect(b1.coveredItemIds).toEqual(expect.arrayContaining([first.message.id, inB.message.id]));

      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const claude = await completeTurn(runtime, "Claude request in B", "claude-native", "Claude answer in B");

      moveTo(original);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      const back = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Back in A" });
      expect(back.turn.providerSessionBefore).toBe("codex-native");
      const a2Id = relocatedBackingId(b1, original);
      expect(a2Id).not.toBe(a1.id);
      const handoff = runtime.store.orchestration.backings.handoff(back.turn.runId)!;
      expect(handoff).toMatchObject({ targetBackingId: a2Id, nativeSessionId: "codex-native", state: "prepared" });
      expect(handoff.itemIds).toEqual(expect.arrayContaining([claude.message.id]));
      for (const covered of [first.message.id, inB.message.id]) expect(handoff.itemIds).not.toContain(covered);

      // The relocation is committed with the run, before its handoff, and retires the source in the same write.
      const admission = events(runtime).filter(({ commandId }) => commandId === events(runtime)
        .find(({ type, payload }) => type === "run.accepted" && (payload as { run: { id: string } }).run.id === back.turn.runId)!.commandId);
      expect(admission.map(({ type }) => type)).toEqual(["thread.configured", "run.accepted", "provider.backing-relocated",
        "context.handoff-prepared"]);
      expect(admission[2]!.payload).toEqual({ runId: back.turn.runId, attemptId: handoff.attemptId,
        fromBackingId: b1.id, backingId: a2Id, workspaceKey: original });
      expect(runtime.store.orchestration.backings.get(b1.id)?.status).toBe("retired");
      expect(runtime.store.orchestration.backings.get(a1.id)?.status).toBe("retired");

      runtime.controller.start(back.turn.id);
      expect(runtime.provider.input).toMatchObject({ sessionId: "codex-native", cwd: original });
      expect(runtime.provider.input?.prompt).toContain("Claude answer in B");
      expect(runtime.provider.input?.prompt).not.toContain("Answer in A");
      expect(runtime.provider.input?.prompt).not.toContain("Answer in B");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ sessionId: "codex-native", text: "Back on the original session" });
      await flushTurnControllerTestPromises();
      const a2 = runtime.store.orchestration.backings.get(a2Id)!;
      expect(a2).toMatchObject({ workspaceKey: original, nativeSessionId: "codex-native", status: "ready", coverageComplete: true });
      expect(a2.coveredItemIds).toEqual(expect.arrayContaining([first.message.id, inB.message.id, claude.message.id, back.message.id]));
      expect(runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))?.id).toBe(a2Id);
      expect(runtime.store.orchestration.backings.current(lookup(runtime, "codex", original))?.id).toBe(a2Id);

      // A retired row is never recorded again, and no move invalidated anything.
      const all = events(runtime);
      for (const retired of [a1.id, b1.id]) {
        const retiredAt = all.find(({ type, payload }) => type === "provider.backing-relocated"
          && (payload as { fromBackingId: string }).fromBackingId === retired)!.revision;
        expect(all.some(({ type, revision, payload }) => type === "provider.backing-recorded" && revision > retiredAt
          && (payload as { backing: { id: string } }).backing.id === retired)).toBe(false);
      }
      expect(all.filter(({ type }) => type === "provider.backing-invalidated")).toEqual([]);

      // Replay and a reopened store reproduce every projection.
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
      runtime.store.close();
      const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
      try {
        reopened.orchestration.events.rebuildProjections();
        expect(projectionRows(reopened)).toEqual(before);
      } finally { reopened.close(); }
    } finally { closeQuietly(runtime.store); }
  });

  it("starts fresh with the full history instead of relocating an uncertain session", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      const first = await completeTurn(runtime, "Request in A", "codex-native", "Answer in A");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      await completeTurn(runtime, "Claude request", "claude-native", "Claude answer");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      const silent = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      runtime.controller.start(silent.turn.id);
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", text: "" });
      await flushTurnControllerTestPromises();
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;
      expect(a1.status).toBe("uncertain");

      moveTo(moved);
      const afterMove = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue in B" });
      expect(afterMove.turn.providerSessionBefore).toBeNull();
      const handoff = runtime.store.orchestration.backings.handoff(afterMove.turn.runId)!;
      expect(handoff.targetBackingId).toBeNull();
      expect(handoff.itemIds).toEqual(expect.arrayContaining([first.message.id, silent.message.id]));
      expect(events(runtime).some(({ type }) => type === "provider.backing-relocated")).toBe(false);
      expect(runtime.store.orchestration.backings.get(a1.id)?.status).toBe("uncertain");
      runtime.controller.start(afterMove.turn.id);
      expect(runtime.provider.input).toMatchObject({ cwd: moved });
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("restored because this provider session does not have them");
    } finally { runtime.store.close(); }
  });

  it("starts fresh in a moved checkout for a harness that cannot resume there, and resumes its own checkout's session on return", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const first = await completeTurn(runtime, "Claude request in A", "claude-native", "Claude answer in A");
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "claude", original))!;

      moveTo(moved);
      const inB = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Claude request in B" });
      expect(inB.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.handoff(inB.turn.runId))
        .toMatchObject({ targetBackingId: null, itemIds: expect.arrayContaining([first.message.id]) });
      runtime.controller.start(inB.turn.id);
      expect(runtime.provider.input).toMatchObject({ cwd: moved });
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("Claude answer in A");
      expect(runtime.provider.input?.prompt).toContain("restored because this provider session does not have them");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "claude-fresh-b" });
      runtime.provider.resolve({ sessionId: "claude-fresh-b", text: "Claude answer in B" });
      await flushTurnControllerTestPromises();
      expect(events(runtime).some(({ type }) => type === "provider.backing-relocated")).toBe(false);
      expect(runtime.store.orchestration.backings.get(a1.id)?.status).toBe("ready");
      expect(runtime.store.orchestration.backings.find(lookup(runtime, "claude", moved))?.nativeSessionId).toBe("claude-fresh-b");

      // Back in A, the session that lives there resumes and receives what B added.
      moveTo(original);
      const back = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Back in A" });
      expect(back.turn.providerSessionBefore).toBe("claude-native");
      const handoff = runtime.store.orchestration.backings.handoff(back.turn.runId)!;
      expect(handoff.targetBackingId).toBe(a1.id);
      expect(handoff.itemIds).toEqual(expect.arrayContaining([inB.message.id]));
      expect(handoff.itemIds).not.toContain(first.message.id);
    } finally { runtime.store.close(); }
  });

  it("refuses to relocate while the replaced session reports background work, writing nothing", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      await completeTurn(runtime, "Request in A", "codex-native", "Answer in A");
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;
      moveTo(moved);
      const probes: ProviderBackgroundWorkSession[] = [];
      Object.assign(runtime.provider, { pendingBackgroundWork: (session: ProviderBackgroundWorkSession) => {
        probes.push(session);
        return "pending";
      } });
      const before = events(runtime).length;
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue in B" }))
        .toThrow(CheckoutMoveBackgroundWorkError);
      expect(probes).toEqual([expect.objectContaining({ conversationId: runtime.conversationId, providerId: "codex",
        nativeSessionId: "codex-native" })]);
      expect(events(runtime)).toHaveLength(before);
      expect(runtime.store.orchestration.backings.get(a1.id)).toEqual(a1);
      expect(runtime.store.conversation(runtime.conversationId).status).not.toBe("running");

      Object.assign(runtime.provider, { pendingBackgroundWork: () => "none" });
      const retried = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue in B" });
      expect(retried.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.get(relocatedBackingId(a1, moved))?.status).toBe("ready");
    } finally { runtime.store.close(); }
  });

  it("keeps the relocation when the provider refuses the moved turn before delivery, and redelivers the delta", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      await completeTurn(runtime, "Request in A", "codex-native", "Answer in A");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const claude = await completeTurn(runtime, "Claude request", "claude-native", "Claude answer");
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;
      moveTo(moved);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      const refused = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Codex in B" });
      const relocatedId = relocatedBackingId(a1, moved);
      runtime.controller.start(refused.turn.id);
      expect(runtime.store.orchestration.backings.get(relocatedId)?.status).toBe("uncertain");
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: "Open in another client.",
        failure: { reason: "codex-error", message: "Open in another client.", notDelivered: true } });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.handoff(refused.turn.runId)?.state).toBe("abandoned");
      const kept = runtime.store.orchestration.backings.get(relocatedId)!;
      expect(kept).toMatchObject({ status: "ready", workspaceKey: moved, coveredItemIds: a1.coveredItemIds });
      expect(runtime.store.orchestration.backings.get(a1.id)?.status).toBe("retired");

      const retry = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Codex in B again" });
      expect(retry.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(retry.turn.runId)!;
      expect(handoff.targetBackingId).toBe(relocatedId);
      expect(handoff.itemIds).toEqual(expect.arrayContaining([claude.message.id, refused.message.id]));
      expect(events(runtime).filter(({ type }) => type === "provider.backing-relocated")).toHaveLength(1);
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("replaces an exhausted session with a fresh one in the moved checkout instead of relocating it", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      const first = await completeTurn(runtime, "Request in A", "codex-native", "Answer in A", { usedTokens: 120_000 });
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const claude = await completeTurn(runtime, "Claude request", "claude-native", "Claude answer");
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;
      moveTo(moved);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      const afterMove = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Codex in B" });
      expect(afterMove.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.handoff(afterMove.turn.runId))
        .toMatchObject({ targetBackingId: null, itemIds: expect.arrayContaining([first.message.id, claude.message.id]) });
      expect(events(runtime).some(({ type }) => type === "provider.backing-relocated")).toBe(false);
      expect(events(runtime).filter(({ type }) => type === "provider.backing-invalidated").map(({ payload }) => payload))
        .toEqual([{ backingId: a1.id, reason: "context-exhausted" }]);
    } finally { runtime.store.close(); }
  });

  it("upgrades a chat moved under the earlier workspace carry without rewriting it", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      const first = await completeTurn(runtime, "Request in A", "codex-native", "Answer in A");
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;
      // The earlier build resumed the conversation's session in B and carried coverage when it saw the session there.
      moveTo(moved);
      const current = vi.spyOn(runtime.store.orchestration.backings, "current").mockReturnValue(null);
      const carriedTurn = await completeTurn(runtime, "Request in B", "codex-native", "Answer in B");
      current.mockRestore();
      const b1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", moved))!;
      expect(events(runtime).filter(({ type }) => type === "provider.backing-invalidated").map(({ payload }) => payload))
        .toEqual([{ backingId: a1.id, reason: "workspace-changed" }]);
      expect(b1.coveredItemIds).toEqual(expect.arrayContaining([first.message.id, carriedTurn.message.id]));
      const legacy = projectionRows(runtime.store);

      moveTo(original);
      const back = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Back in A" });
      expect(back.turn.providerSessionBefore).toBe("codex-native");
      expect(runtime.store.orchestration.backings.handoff(back.turn.runId)).toBeNull();
      const a2 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;
      expect(a2).toMatchObject({ id: relocatedBackingId(b1, original), status: "ready", coveredItemIds: b1.coveredItemIds });
      expect(runtime.store.orchestration.backings.get(a1.id)?.status).toBe("retired");
      // Rows written before the upgrade keep their values; only the moved-from row changes, to retired.
      const now = new Map(projectionRows(runtime.store).map((row) => [`${(row as { kind: string }).kind}:${(row as { id: string }).id}`, row]));
      for (const row of legacy as { kind: string; id: string; payload_json: string }[]) {
        if (row.kind === "provider-backing" && row.id === b1.id) continue;
        if (row.kind === "provider-backing") expect(now.get(`${row.kind}:${row.id}`)).toEqual(row);
      }
      const before = projectionRows(runtime.store);
      runtime.store.orchestration.events.rebuildProjections();
      expect(projectionRows(runtime.store)).toEqual(before);
    } finally { runtime.store.close(); }
  });

  it("refuses a relocation event that does not match its run or its source", async () => {
    const { runtime, original, moved, moveTo } = await movableRuntime();
    try {
      await completeTurn(runtime, "Request in A", "codex-native", "Answer in A");
      const a1 = runtime.store.orchestration.backings.find(lookup(runtime, "codex", original))!;
      const { orchestration } = runtime.store;
      const { projectId } = runtime.store.conversation(runtime.conversationId);
      // A run in A cannot relocate A's own backing, and a session mismatch is refused before any write.
      const local = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Still in A" });
      const run = orchestration.events.projection("run", local.turn.runId)!.value as {
        id: string; attemptId: string; threadId: string; providerInstanceId: string; workspaceKey: string };
      expect(() => orchestration.backings.relocation(run, a1.id, "codex-native")).toThrow(OrchestrationConflict);
      expect(() => orchestration.backings.relocation({ ...run, workspaceKey: moved }, a1.id, "other-native"))
        .toThrow(OrchestrationConflict);
      const forged = (payload: Record<string, string>) => {
        const event = { type: "provider.backing-relocated" as const, payload: { runId: run.id, attemptId: run.attemptId,
          fromBackingId: a1.id, backingId: relocatedBackingId(a1, moved), workspaceKey: moved, ...payload } };
        orchestration.events.commit({ actorId: "runtime", commandId: `forged:${JSON.stringify(payload)}`,
          threadId: runtime.conversationId, projectId, command: event,
          expectedRevision: orchestration.events.revision(runtime.conversationId), events: [event], result: null });
      };
      expect(() => forged({})).toThrow(OrchestrationConflict);
      expect(() => forged({ workspaceKey: original, backingId: relocatedBackingId(a1, original) })).toThrow(OrchestrationConflict);
      expect(orchestration.backings.get(a1.id)?.status).toBe("ready");
      runtime.controller.start(local.turn.id);
      runtime.provider.resolve({ sessionId: "codex-native", text: "Done in A" });
      await flushTurnControllerTestPromises();
      moveTo(moved);
      expect(runtime.controller.queue({ conversationId: runtime.conversationId, content: "Now in B" }).turn.providerSessionBefore)
        .toBe("codex-native");
    } finally { runtime.store.close(); }
  });
});
