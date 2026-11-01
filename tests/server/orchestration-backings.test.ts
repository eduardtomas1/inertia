// @inertia-test-suite portable
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  portableHistoryBudget, portableHistoryCost, selectPortableHistory, type PortableHistoryItem,
} from "../../src/server/orchestration-v2/portable-history";
import {
  RestoredHistoryRejectedError, handoffContextUsage, portableHistoryBudgetInputs,
} from "../../src/server/runtime/turns/turn-context-handoff";
import type { AgentTurnUsageSnapshot, ChatAttachment } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises, turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function handoffRuntime() {
  const runtime = await createTurnControllerTestRuntime();
  const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original context" });
  runtime.controller.start(first.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "original-native" });
  runtime.provider.resolve({ text: "Original answer", sessionId: "original-native" });
  await flushTurnControllerTestPromises();
  runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
  return runtime;
}

describe("durable native provider backings and context delivery", () => {
  it("switches back to an earlier provider session with only the missing context", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original Codex request" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ text: "Original Codex answer", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity };
      const original = runtime.store.orchestration.backings.find(lookup)!;
      expect(original.status).toBe("ready");
      expect(original.coveredItemIds).toContain(first.message.id);
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
        modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
      const other = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Claude follow-up" });
      expect(runtime.store.orchestration.backings.handoff(other.turn.runId)?.state).toBe("prepared");
      runtime.controller.start(other.turn.id);
      expect(runtime.store.orchestration.backings.handoff(other.turn.runId)?.state).toBe("dispatching");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "claude-native" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Claude new answer" });
      expect(runtime.store.orchestration.backings.handoff(other.turn.runId)?.state).toBe("delivered");
      runtime.provider.resolve({ sessionId: "claude-native" });
      await flushTurnControllerTestPromises();
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(returned.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(returned.turn.runId)!;
      expect(handoff.targetBackingId).toBe(original.id);
      expect(handoff.itemIds).toContain(other.message.id);
      expect(handoff.itemIds).not.toContain(first.message.id);
      runtime.controller.start(returned.turn.id);
      expect(runtime.provider.input?.sessionId).toBe("codex-native");
      expect(runtime.provider.input?.prompt).toContain("Claude new answer");
      expect(runtime.provider.input?.prompt).not.toContain("Original Codex answer");
      runtime.provider.resolve({ sessionId: "codex-native", text: "Returned successfully" });
      await flushTurnControllerTestPromises();
      const updated = runtime.store.orchestration.backings.find(lookup)!;
      expect(updated.coveredItemIds).toContain(other.message.id);
      expect(updated.status).toBe("ready");
      runtime.store.orchestration.events.rebuildProjections();
      expect(runtime.store.orchestration.backings.find(lookup)).toEqual(updated);
    } finally { runtime.store.close(); }
  });

  it("retains uncertain delivery across a runtime restart and refuses native reuse", async () => {
    const runtime = await handoffRuntime();
    const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Request before crash" });
    runtime.controller.start(first.turn.id);
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "uncertain-native" });
    const lookup = { threadId: runtime.conversationId, providerId: "claude", workspaceKey: runtime.workspace,
      identity: first.turn.continuationIdentity };
    expect(runtime.store.orchestration.backings.find(lookup)?.status).toBe("uncertain");
    runtime.provider.resolve({ status: "failed", sessionId: "uncertain-native", text: "" });
    await flushTurnControllerTestPromises();
    runtime.store.close();
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(reopened.orchestration.backings.find(lookup)?.status).toBe("uncertain");
      expect(reopened.orchestration.backings.find({ ...lookup, workspaceKey: `${runtime.workspace}-different` })).toBeNull();
      expect(reopened.orchestration.backings.find({ ...lookup, threadId: "other-thread" })).toBeNull();
    } finally { reopened.close(); }
  });

  it("does not treat a failed, silent native request as delivered context", async () => {
    const runtime = await handoffRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Start" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "unconfirmed-native" });
      runtime.provider.resolve({ status: "failed", sessionId: "unconfirmed-native", text: "" });
      await flushTurnControllerTestPromises();
      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Retry with fresh context" });
      expect(next.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)?.state).toBe("prepared");
      runtime.controller.start(next.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "second-unconfirmed" });
      runtime.provider.resolve({ status: "failed", sessionId: "second-unconfirmed", text: "" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.handoff(next.turn.runId)?.state).toBe("uncertain");
    } finally { runtime.store.close(); }
  });

  it("records no coverage and fails typed when the restored block has no reference slot", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      await writeFile(join(runtime.workspace, "source.ts"), "export const answer = 42;");
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original Codex request" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ text: "Original Codex answer", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
        modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
      const other = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Claude follow-up" });
      runtime.controller.start(other.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "claude-native" });
      runtime.provider.resolve({ sessionId: "claude-native", text: "Claude answer" });
      await flushTurnControllerTestPromises();
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
      const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity };
      const before = runtime.store.orchestration.backings.find(lookup)!;
      const context = {
        fileReferences: Array.from({ length: 16 }, () => ({ path: "source.ts" })),
        diffSelections: Array.from({ length: 8 }, () => ({ path: "source.ts", hunkHeader: "@@ -1 +1 @@", content: "+answer = 42", selectedLineCount: 1 })),
        terminalContexts: Array.from({ length: 8 }, (_, i) => ({ terminalId: `terminal-${i}`, terminalLabel: "Tests", lineStart: 1, lineEnd: 1, content: `output-${i}` })),
      };
      expect(() => runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex", context }))
        .toThrow(RestoredHistoryRejectedError);
      expect(runtime.store.orchestration.backings.find(lookup)).toEqual(before);
      expect(runtime.store.latestAgentTurnForConversation(runtime.conversationId)?.id).toBe(other.turn.id);

      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(runtime.store.orchestration.backings.handoff(returned.turn.runId)?.itemIds).toContain(other.message.id);
    } finally { runtime.store.close(); }
  });

  it("delivers history deferred by a goal start on the next normal turn", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Keep the public API unchanged." });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ text: "Constraint noted.", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      const lookup = { threadId: runtime.conversationId, providerId: "codex", workspaceKey: runtime.workspace,
        identity: first.turn.continuationIdentity };
      runtime.store.orchestration.backings.invalidate(runtime.store.orchestration.backings.find(lookup)!, "workspace-changed");

      const goal = runtime.controller.queue({ conversationId: runtime.conversationId, content: "/goal Ship the exporter",
        goalStart: { objective: "Ship the exporter" } });
      expect(goal.turn.providerSessionBefore).toBeNull();
      expect(runtime.store.orchestration.backings.handoff(goal.turn.runId)).toBeNull();
      runtime.controller.start(goal.turn.id);
      expect(runtime.provider.input?.prompt).not.toContain("Keep the public API unchanged.");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "goal-native" });
      runtime.provider.resolve({ text: "Goal accepted.", sessionId: "goal-native" });
      await flushTurnControllerTestPromises();
      const goalBacking = runtime.store.orchestration.backings.find({ ...lookup, nativeSessionId: "goal-native" })!;
      expect(goalBacking.coveredItemIds).not.toContain(first.message.id);

      const next = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Carry on." });
      expect(next.turn.providerSessionBefore).toBe("goal-native");
      const handoff = runtime.store.orchestration.backings.handoff(next.turn.runId)!;
      expect(handoff.targetBackingId).toBe(goalBacking.id);
      expect(handoff.itemIds).toContain(first.message.id);
      expect(handoff.itemIds).not.toContain(goal.message.id);
      runtime.controller.start(next.turn.id);
      expect(runtime.provider.input?.prompt).toContain("Keep the public API unchanged.");
      expect(runtime.provider.input?.prompt).toContain("since this provider session last ran");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Carrying on." });
      runtime.provider.resolve({ sessionId: "goal-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.backings.find({ ...lookup, nativeSessionId: "goal-native" })?.coveredItemIds)
        .toContain(first.message.id);

      const settled = runtime.controller.queue({ conversationId: runtime.conversationId, content: "And again." });
      expect(settled.turn.providerSessionBefore).toBe("goal-native");
      expect(runtime.store.orchestration.backings.handoff(settled.turn.runId)).toBeNull();
    } finally { runtime.store.close(); }
  });

  it("names the context retrieval tool in portable history only on a route whose host tool bridge is attested", async () => {
    const runtime = await handoffRuntime();
    try {
      const claude = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue on Claude" });
      runtime.controller.start(claude.turn.id);
      const unattested = runtime.provider.input?.prompt ?? "";
      expect(unattested).toContain("Original answer");
      expect(unattested).toContain("Omitted history cannot be retrieved in this session");
      expect(unattested).not.toContain("inertia_request_context");
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "claude-native" });
      runtime.provider.resolve({ text: "Claude answer", sessionId: "claude-native" });
      await flushTurnControllerTestPromises();
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      runtime.controller.start(returned.turn.id);
      const attested = runtime.provider.input?.prompt ?? "";
      expect(attested).toContain("Claude answer");
      expect(attested).toContain("Retrieve omitted turns with inertia_request_context");
      expect(attested).not.toContain("Omitted history cannot be retrieved in this session");
      runtime.provider.resolve({ text: "Back on Codex", sessionId: "original-native" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });
});

const usageSnapshot = (usedTokens: number | null, maxTokens: number | null): AgentTurnUsageSnapshot => ({
  usedTokens, totalProcessedTokens: null, totalProcessedScope: "run", maxTokens, inputTokens: null,
  cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null,
  compactsAutomatically: null, providerSessionBound: true, capturedAt: "2030-01-01T00:00:00.000Z",
});
const promptBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));
const fileAttachment = (id: string): ChatAttachment => ({ id, name: `${id}.txt`, path: `/tmp/${id}.txt`, mimeType: "text/plain", size: 10 });
const historyItems: PortableHistoryItem[] = Array.from({ length: 12 }, (_, index) => ({
  id: `item-${index}`, threadId: "thread-1", runId: `run-${index}`, turnId: `turn-${index}`, providerBackingId: null,
  role: index % 2 === 0 ? "user" : "assistant", kind: index % 2 === 0 ? "user-message" : "assistant-message",
  status: "completed", text: `Historical entry ${index} ${"界".repeat(400)}`,
}));

describe("portable history budget inputs", () => {
  it("subtracts native usage, input, attachments, instructions and space for work", () => {
    const base = { configuredCap: 16_000, currentPromptBytes: promptBytes("Continue"), imageCount: 0, modelWindow: 32_000 };
    expect(portableHistoryBudget(base)).toBeLessThan(16_000);
    expect(portableHistoryBudget({ ...base, nativeContextEstimate: 8_000 })).toBeLessThan(portableHistoryBudget(base));
    expect(portableHistoryBudget({ ...base, currentPromptBytes: promptBytes("界".repeat(30_000)) })).toBe(0);
    expect(portableHistoryBudget({ ...base, nativeUsedTokens: 23_000, reportedWindow: 24_000 })).toBe(0);
    const withImage = portableHistoryBudget({ ...base, imageCount: 1 });
    expect(withImage).toBeGreaterThan(4_000);
    expect(withImage).toBeLessThan(portableHistoryBudget(base));
    expect(portableHistoryBudget({ ...base, imageCount: 2 })).toBe(0);
    expect(portableHistoryBudget({ ...base, configuredCap: 64_000, modelWindow: 1_000_000, reportedWindow: 1_000_000,
      nativeUsedTokens: 0, currentPromptBytes: promptBytes("x".repeat(70_000)), imageCount: 1 })).toBe(64_000);
    expect(portableHistoryBudget({ ...base, configuredCap: 2_000 })).toBe(2_000);

    const inputs = portableHistoryBudgetInputs({ attachments: [fileAttachment("notes"), fileAttachment("log")], imageCount: 1,
      configuredWindow: 64_000, limits: null, target: null });
    expect(inputs).toEqual({ imageCount: 1, otherAttachmentCount: 2, modelWindow: 64_000 });
    const wide = { ...base, configuredCap: 64_000, modelWindow: 64_000, imageCount: 1 };
    expect(portableHistoryBudget({ ...inputs, configuredCap: 64_000, currentPromptBytes: promptBytes("Continue") }))
      .toBe(portableHistoryBudget(wide) - 2 * 4_096);
  });

  it("keeps measured occupancy across a model change", () => {
    const previous = { usedTokens: 37_321, maxTokens: 258_400, autoCompactThreshold: 32_000 };
    expect(handoffContextUsage({ sameNativeSession: false, sameSelection: false, previousUsage: previous })).toBeNull();
    expect(handoffContextUsage({ sameNativeSession: true, sameSelection: true, previousUsage: previous })).toBe(previous);
    expect(handoffContextUsage({ sameNativeSession: true, sameSelection: false, previousUsage: previous }))
      .toEqual({ usedTokens: 37_321, maxTokens: 258_400 });
    expect(handoffContextUsage({ sameNativeSession: true, sameSelection: false,
      previousUsage: { usedTokens: 30_000, maxTokens: 32_000, autoCompactThreshold: 31_000 }, knownModelWindow: 1_000_000 }))
      .toEqual({ usedTokens: 30_000, maxTokens: 1_000_000 });
    const preserved = handoffContextUsage({ sameNativeSession: true, sameSelection: false, previousUsage: previous })!;
    expect(portableHistoryBudget({ currentPromptBytes: promptBytes("Continue work"), imageCount: 2,
      nativeUsedTokens: preserved.usedTokens!, reportedWindow: preserved.maxTokens!, modelWindow: preserved.maxTokens! })).toBe(16_000);
    expect(portableHistoryBudget({ currentPromptBytes: promptBytes("Continue work"), imageCount: 0,
      nativeContextEstimate: 120_000 })).toBe(0);

    const target = { usage: usageSnapshot(30_000, 32_000), sameSelection: false };
    expect(portableHistoryBudgetInputs({ attachments: [], imageCount: 0, configuredWindow: null,
      limits: { modelWindow: 1_000_000 }, target })).toEqual({ imageCount: 0, otherAttachmentCount: 0,
      modelWindow: 1_000_000, reportedWindow: 1_000_000, nativeUsedTokens: 30_000 });
    expect(portableHistoryBudgetInputs({ attachments: [], imageCount: 0, configuredWindow: null,
      limits: { modelWindow: 1_000_000 }, target: { ...target, sameSelection: true } })).toMatchObject({ reportedWindow: 32_000 });
    expect(portableHistoryBudgetInputs({ attachments: [], imageCount: 0, configuredWindow: null, limits: null,
      target: { usage: null, sameSelection: true } })).toEqual({ imageCount: 0, otherAttachmentCount: 0, estimateNativeOccupancy: true });
  });

  it("reserves context for image batches up to the attachment limit, honoring smaller known windows", () => {
    let previousBudget = 16_000;
    const currentPromptBytes = promptBytes("Compare these screenshots");
    for (let count = 1; count <= 100; count++) {
      const budget = portableHistoryBudget({ currentPromptBytes, imageCount: count });
      expect(budget).toBeGreaterThanOrEqual(0);
      expect(budget).toBeLessThanOrEqual(previousBudget);
      previousBudget = budget;
      if (count <= 8) expect(budget).toBe(16_000);
      if (count === 10) {
        expect(budget).toBeGreaterThan(0);
        expect(budget).toBeLessThan(16_000);
      }
      if (count === 100) expect(budget).toBe(0);
      if (budget > 0) {
        const selected = selectPortableHistory({ threadId: "thread-1", items: historyItems, budget });
        expect(portableHistoryCost(selected.items, selected.context)).toBeLessThanOrEqual(budget);
      }
      expect(portableHistoryBudget({ currentPromptBytes, imageCount: count, modelWindow: 2_000_000 })).toBe(16_000);
      expect(portableHistoryBudget({ currentPromptBytes, imageCount: count, modelWindow: 20_000 })).toBe(0);
      expect(portableHistoryBudget({ currentPromptBytes, imageCount: count, nativeUsedTokens: 0, reportedWindow: 20_000 })).toBe(0);
      const compacting = portableHistoryBudgetInputs({ attachments: [], imageCount: count, configuredWindow: null,
        limits: { modelWindow: 1_000_000, autoCompactThreshold: 20_000 }, target: null });
      expect(compacting).toMatchObject({ modelWindow: 1_000_000, autoCompactThreshold: 20_000 });
      expect(portableHistoryBudget({ ...compacting, currentPromptBytes })).toBe(0);
    }
  });
});

describe("activity items in a returning backing's delta", () => {
  it("carries the other provider's commands but not the backing's own native activity", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Original Codex request" });
      runtime.controller.start(first.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ text: "Original Codex answer", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      runtime.store.addActivity({ conversationId: runtime.conversationId, runId: first.turn.runId, turnId: first.turn.id,
        kind: "command", title: "Bash", detail: "Command:\nnpm run codex-own-check\n\nOutput:\nok", status: "completed" });
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
        modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
      const other = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Claude follow-up" });
      runtime.controller.start(other.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "claude-native" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Claude new answer" });
      runtime.provider.resolve({ sessionId: "claude-native" });
      await flushTurnControllerTestPromises();
      const claudeCommand = runtime.store.addActivity({ conversationId: runtime.conversationId, runId: other.turn.runId,
        turnId: other.turn.id, kind: "command", title: "Bash", detail: "Command:\nnpm run claude-check\n\nOutput:\nCLAUDE-OUTPUT",
        status: "failed" });
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
      const returned = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Return to Codex" });
      expect(returned.turn.providerSessionBefore).toBe("codex-native");
      const handoff = runtime.store.orchestration.backings.handoff(returned.turn.runId)!;
      expect(handoff.itemIds).toContain(`activity:${claudeCommand.id}`);
      runtime.controller.start(returned.turn.id);
      expect(runtime.provider.input?.prompt).toContain("npm run claude-check");
      expect(runtime.provider.input?.prompt).toContain("CLAUDE-OUTPUT");
      expect(runtime.provider.input?.prompt).not.toContain("codex-own-check");
      runtime.provider.resolve({ sessionId: "codex-native", text: "Returned successfully" });
      await flushTurnControllerTestPromises();
      const backing = runtime.store.orchestration.backings.find({ threadId: runtime.conversationId, providerId: "codex",
        workspaceKey: runtime.workspace, identity: first.turn.continuationIdentity })!;
      expect(backing.coveredItemIds).toContain(`activity:${claudeCommand.id}`);
    } finally { runtime.store.close(); }
  });
});
