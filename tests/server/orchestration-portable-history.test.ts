// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PortableHistoryBudgetError, portableHistoryBudget, portableHistoryCost, portableHistoryTurnRange,
  selectPortableHistory, type PortableHistoryItem,
} from "../../src/server/orchestration-v2/portable-history";
import { portableCommandText } from "../../src/server/persistence/turn-context-facts";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import type { TurnGitArtifactFile } from "../../src/shared/contracts";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

const item = (id: string, role: "user" | "assistant", text: string): PortableHistoryItem => ({
  id, threadId: "thread-1", role, text, runId: `run-${id}`, turnId: `turn-${id}`, providerBackingId: null,
  kind: role === "user" ? "user-message" : "assistant-message", status: "completed",
});

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

async function finishTurn(runtime: TurnControllerTestRuntime, label: string,
  result: { status?: "completed" | "failed" | "cancelled"; native?: true } = {}) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: `${label} request` });
  runtime.controller.start(queued.turn.id);
  if (result.native) {
    for (const phase of ["started", "settled"] as const) runtime.provider.emit({ ...turnControllerTestIdentity(runtime),
      type: "native-boundary", nativeConversationId: "source-native", nativeSessionId: null, nativeTurnId: label,
      persistedHeadId: phase === "settled" ? label : null, phase });
  }
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "source-native" });
  runtime.provider.resolve({ status: result.status ?? "completed", sessionId: "source-native",
    ...(result.status === undefined || result.status === "completed" ? { text: `${label} answer` } : {}) });
  await flushTurnControllerTestPromises();
  return runtime.store.agentTurn(queued.turn.id);
}

function command(runtime: TurnControllerTestRuntime, turn: { id: string; runId: string }, detail: string,
  status: "completed" | "failed" | "running" = "completed") {
  return runtime.store.addActivity({ conversationId: runtime.conversationId, runId: turn.runId, turnId: turn.id,
    kind: "command", title: "Bash", detail, status });
}

function changedFile(runtime: TurnControllerTestRuntime, turnId: string, path: string, status = "modified") {
  const file: TurnGitArtifactFile = { path, previousPath: null, status, insertions: 3, deletions: 1,
    binary: false, untracked: false, staged: false, unstaged: true, indexStatus: ".", worktreeStatus: "M" };
  const createdAt = new Date().toISOString();
  runtime.store.createTurnGitArtifact({ turnId, status: "pending", createdAt });
  runtime.store.completeTurnGitArtifact(turnId, { files: [file], insertions: 3, deletions: 1,
    status: "ready", completeness: "complete", updatedAt: createdAt });
}

function plan(runtime: TurnControllerTestRuntime, turn: { id: string; runId: string }, explanation: string) {
  runtime.store.upsertAgentPlan({ conversationId: runtime.conversationId, runId: turn.runId, turnId: turn.id, explanation,
    steps: [{ step: "Write the parser", status: "completed" }, { step: "Run the suite", status: "pending" }] });
}

function history(runtime: TurnControllerTestRuntime, extra: { hostToolBridgeAttested?: boolean } = {}) {
  return runtime.store.orchestration.portableHistory({ threadId: runtime.conversationId, capacityBytes: 64_000,
    currentPromptBytes: 100, imageCount: 0, modelWindow: 1_000_000, configuredCap: 64_000, ...extra });
}

const message = (id: string, role: "user" | "assistant", text: string): PortableHistoryItem => ({
  id, threadId: "thread-1", role, text, runId: "run-source", turnId: "turn-source", providerBackingId: "backing-source",
  kind: role === "user" ? "user-message" : "assistant-message", status: "interrupted",
});
const t3Messages = [
  message("item:one", "user", "Preserve every line.\n\n  And this indentation.\n"),
  message("item:two", "assistant", "Partial work: 日本語 🧪 مرحبا\n" + "x".repeat(600)),
];

describe("T3-compatible portable history selection", () => {
  it("preserves short history intact and chronological with explicit provenance", () => {
    const items = [item("1", "user", "Original request"), item("2", "assistant", "Partial response")];
    items[1]!.status = "interrupted";
    const result = selectPortableHistory({ threadId: "thread-1", items, budget: 16_000 });
    expect(result.items).toEqual(items);
    expect(result.omittedCount).toBe(0);
    expect(result.rendered).toContain('"status":"interrupted"');
    expect(result.rendered.indexOf("Original request")).toBeLessThan(result.rendered.indexOf("Partial response"));
    expect(result.cost).toBe(portableHistoryCost(result.items, result.context));
    expect(result.context).toContain("inertia_request_context");
  });

  it("prioritizes recent user/assistant and opening context without clipping large messages", () => {
    const items = [item("opening", "user", "Beginning"), item("large", "assistant", "x".repeat(12_000)),
      item("recent", "user", "Latest question"), item("answer", "assistant", "Latest answer")];
    const result = selectPortableHistory({ threadId: "thread-1", items, budget: 3_000, previouslyOmitted: 300 });
    expect(result.items.map(({ id }) => id)).toEqual(["opening", "recent", "answer"]);
    expect(result.omittedItemIds).toEqual(["large"]);
    expect(result.omittedCount).toBe(301);
    expect(result.cost).toBeLessThanOrEqual(3_000);
    expect(result.rendered).not.toContain("xxx");
  });

  it("reserves the entire new prompt, images, native occupancy and response space", () => {
    expect(portableHistoryBudget({ currentPromptBytes: 50_000, imageCount: 1,
      modelWindow: 100_000, nativeUsedTokens: 10_000 })).toBe(6_808);
    expect(portableHistoryBudget({ currentPromptBytes: 80_000, imageCount: 0,
      modelWindow: 100_000 })).toBe(0);
    expect(portableHistoryBudget({ currentPromptBytes: 0, imageCount: 0,
      modelWindow: 1_000_000, configuredCap: 100_000 })).toBe(64_000);
    expect(portableHistoryBudget({ currentPromptBytes: 20_000, imageCount: 0,
      modelWindow: 100_000, reportedWindow: 40_000 })).toBe(4_000);
    expect(() => selectPortableHistory({ threadId: "thread-1", items: [], budget: 1 }))
      .toThrow(PortableHistoryBudgetError);
  });

  it("caps the work reserve at half of a small window (T3 9ec71438c)", () => {
    // The former reserve, max(16,000, window / 4), took 16,000 of a 20,000 window and left 4,000 at most.
    expect(portableHistoryBudget({ currentPromptBytes: 0, imageCount: 0, modelWindow: 20_000 })).toBe(10_000);
    expect(portableHistoryBudget({ currentPromptBytes: 2_000, imageCount: 0, modelWindow: 20_000 })).toBe(8_000);
    expect(portableHistoryBudget({ currentPromptBytes: 0, imageCount: 0, modelWindow: 16_000 })).toBe(8_000);
    expect(portableHistoryBudget({ currentPromptBytes: 0, imageCount: 0, modelWindow: 32_000 })).toBe(16_000);
    // Larger windows keep the quarter reserve (or 16,000), below the configured 64,000 cap or at it.
    expect(portableHistoryBudget({ currentPromptBytes: 0, imageCount: 0, modelWindow: 128_000, configuredCap: 64_000 })).toBe(64_000);
    expect(portableHistoryBudget({ currentPromptBytes: 0, imageCount: 0, modelWindow: 80_000, configuredCap: 64_000 })).toBe(60_000);
  });

  it("rejects foreign identity, duplicate entries and unsupported private state", () => {
    const first = item("1", "user", "Question");
    expect(() => selectPortableHistory({ threadId: "other", items: [first], budget: 16_000 })).toThrow("identity");
    expect(() => selectPortableHistory({ threadId: "thread-1", items: [first, first], budget: 16_000 })).toThrow("identity");
    expect(() => selectPortableHistory({ threadId: "thread-1", items: [{ ...first, reasoning: "private" } as never], budget: 16_000 })).toThrow();
  });
});

describe("portable history durable source", () => {
  it("reads complete stream chunks, omits oversized entries and leaves the current message separate", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.createMessage(runtime.conversationId, "Original request", "user");
      runtime.store.createMessage(runtime.conversationId, "x".repeat(65_000), "assistant");
      runtime.store.createMessage(runtime.conversationId, "Small answer", "assistant");
      const current = runtime.store.createMessage(runtime.conversationId, "New request untouched", "user");
      const history = runtime.store.orchestration.portableHistory({ threadId: runtime.conversationId,
        excludedMessageId: current.id, capacityBytes: 16_000, currentPromptBytes: 100, imageCount: 0 });
      expect(history?.selection.items.map(({ text }) => text)).toEqual(["Original request", "Small answer"]);
      expect(history?.omittedMessageCount).toBe(1);
      expect(history?.blocks[0]?.content).not.toContain("New request untouched");
    } finally { runtime.store.close(); }
  });

  it("retains endpoint containment and fails admission when a context handoff cannot fit", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.createMessage(runtime.conversationId, "Unattributed private context", "user");
      const history = runtime.store.orchestration.portableHistory({ threadId: runtime.conversationId,
        capacityBytes: 16_000, currentPromptBytes: 100, imageCount: 0,
        route: { backendProfileId: "different", endpointIdentity: "https://other.example", includeUnattributed: false } });
      expect(history?.messageCount).toBe(0);
      expect(history?.withheldMessageCount).toBe(1);
      expect(history?.blocks[0]?.content).not.toContain("private context");
      expect(() => runtime.store.orchestration.portableHistory({ threadId: runtime.conversationId,
        capacityBytes: 16_000, currentPromptBytes: 30_000, modelWindow: 32_000, imageCount: 0 }))
        .toThrow(PortableHistoryBudgetError);
    } finally { runtime.store.close(); }
  });
});

describe("T3-compatible portable item kinds and budget", () => {
  it("carries a failed command's exit code and output as attributed activity and rejects reasoning", () => {
    const text = portableCommandText("claude", { title: "Bash", status: "failed",
      detail: `Command:\nvp test\n\nError:\nExit code 1\nFailure near the end: ${"界".repeat(300)}` });
    expect(text).toContain("Command: vp test");
    expect(text).toContain("Exit code: 1");
    expect(text).toContain("界".repeat(300));
    const activity: PortableHistoryItem = { ...message("item:command", "assistant", text), kind: "command", status: "failed" };
    const result = selectPortableHistory({ threadId: "thread-1", items: [activity], budget: 16_000 });
    expect(result.items).toEqual([activity]);
    expect(result.rendered).toContain('"kind":"command"');
    expect(result.rendered).toContain('"providerBackingId":"backing-source"');
    expect(() => selectPortableHistory({ threadId: "thread-1", budget: 16_000,
      items: [{ ...activity, kind: "reasoning" } as never] })).toThrow();
  });

  it("omits oversized multilingual items whole, preserving original constraints and recent work", () => {
    const candidates = [t3Messages[0]!, message("huge", "assistant", "界🧪".repeat(20_000)),
      message("old", "assistant", "a".repeat(4_000)), t3Messages[1]!];
    const selected = selectPortableHistory({ threadId: "thread-1", items: candidates, budget: 3_000 });
    expect(selected.items).toEqual(t3Messages);
    expect(selected.omittedCount).toBe(2);
    expect(portableHistoryCost(selected.items, selected.context)).toBeLessThanOrEqual(3_000);
  });

  it("counts JSON escaping and UTF-8 bytes across many messages", () => {
    const candidates = Array.from({ length: 256 }, (_, index) =>
      message(`item:${index}`, index % 2 ? "assistant" : "user", "\u0000\\\"🧪界".repeat(15)));
    for (const budget of [1_024, 4_000, 16_000]) {
      const selected = selectPortableHistory({ threadId: "thread-1", items: candidates, previouslyOmitted: 244, budget });
      expect(portableHistoryCost(selected.items, selected.context)).toBeLessThanOrEqual(budget);
      expect(selected.cost).toBeLessThanOrEqual(budget);
      expect(selected.omittedCount).toBeGreaterThan(244);
    }
  });

  it("fits the final envelope at intermediate selected and omitted digit boundaries", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => message(`boundary:${index}`, "user", "Short request"));
    for (let budget = 4_000; budget <= 9_000; budget++) {
      const selected = selectPortableHistory({ threadId: "thread-1", items: candidates, previouslyOmitted: 90, budget });
      expect(portableHistoryCost(selected.items, selected.context) <= budget).toBe(true);
    }
  });

  it("covers the turn range of a very long delta and names the source item range", () => {
    const ordinals = new Map([["turn-early", 2], ["turn-late", 5]]);
    const turns = ["turn-early", "turn-late"];
    const items = Array.from({ length: 150_000 }, (_, index) => ({ turnId: turns[index % 2]! }));
    expect(portableHistoryTurnRange(ordinals, [...items, { turnId: null }, { turnId: "inherited-turn" }]))
      .toEqual({ from: 2, to: 5 });
    expect(portableHistoryTurnRange(ordinals, [{ turnId: null }])).toBeNull();
    const selected = selectPortableHistory({ threadId: "thread-1", budget: 16_000, turnOrdinals: ordinals,
      items: [{ ...item("a", "user", "Early"), turnId: "turn-early" }, { ...item("b", "assistant", "Late"), turnId: "turn-late" }] });
    expect(selected.context).toContain('Covered chat turns 2-5; source items "a" through "b".');
    expect(selectPortableHistory({ threadId: "thread-1", budget: 16_000, items: [item("c", "user", "Unattributed")] }).context)
      .toContain('Covered chat turns: none recorded; source items "c" through "c".');
  });

  it("names the retrieval tool only when the route's host tool bridge is attested", () => {
    const items = [item("1", "user", "Question")];
    const attested = selectPortableHistory({ threadId: "thread-1", items, budget: 16_000, hostToolBridgeAttested: true });
    expect(attested.context).toContain('Recover an omitted item only when the request needs it, with '
      + 'inertia_request_context({conversationId:"thread-1",itemId:"<omitted item ID>"}); continue long text with '
      + "cursor=nextCursor until null. Items included below need no read.");
    const unattested = selectPortableHistory({ threadId: "thread-1", items, budget: 16_000, hostToolBridgeAttested: false });
    expect(unattested.context).not.toContain("inertia_request_context");
    expect(unattested.context).toContain("Omitted history cannot be retrieved in this session");
    expect(unattested.cost).toBe(portableHistoryCost(unattested.items, unattested.context));
  });
});

describe("omitted item ids in the coverage text (T3 9f1e97de6)", () => {
  const listedIds = (context: string) => /Omitted item IDs, newest last: ([^\n]*?)\.(?: \d+ older|\n)/u
    .exec(context)?.[1]?.split(", ") ?? [];

  it("points history recovery at the omitted items instead of a read from the chat's start", () => {
    const omitted = message("item:omitted", "assistant", "o".repeat(4_000));
    const selected = selectPortableHistory({ threadId: "thread-1", budget: 3_000, items: [t3Messages[0]!, omitted,
      ...Array.from({ length: 3 }, (_, index) => message(`item:recent-${index}`, "assistant", "recent"))] });
    expect(selected.omittedItemIds).toEqual([omitted.id]);
    expect(selected.items.map(({ id }) => id)).not.toContain(omitted.id);
    expect(selected.context).toContain("1 omitted. Omitted item IDs, newest last: item:omitted.\n");
    expect(selected.context).not.toContain("older omitted items are not listed");
    expect(selected.cost).toBeLessThanOrEqual(3_000);
  });

  it("lists at most the 20 newest omitted candidates, newest last, and counts the rest", () => {
    const candidates = Array.from({ length: 60 }, (_, index) => message(`item:${index}`, index % 2 ? "assistant" : "user",
      `entry ${index} ${"y".repeat(600)}`));
    const selected = selectPortableHistory({ threadId: "thread-1", items: candidates, previouslyOmitted: 7, budget: 6_000 });
    const listed = listedIds(selected.context);
    expect(selected.omittedItemIds.length).toBeGreaterThan(20);
    expect(listed).toEqual(selected.omittedItemIds.slice(-20));
    expect(selected.context).toContain(`${selected.omittedCount - 20} older omitted items are not listed.`);
    expect(selected.omittedCount).toBe(7 + selected.omittedItemIds.length);
    for (const id of listed) expect(selected.items.some((entry) => entry.id === id)).toBe(false);
  });

  it("keeps the list within an eighth of the budget and the whole block within the budget", () => {
    const long = (index: number) => `item:${String(index).padStart(3, "0")}:${"k".repeat(180)}`;
    const candidates = Array.from({ length: 40 }, (_, index) => message(long(index), "assistant", "z".repeat(900)));
    for (const budget of [2_000, 3_000, 4_000, 8_000, 16_000, 64_000]) {
      const selected = selectPortableHistory({ threadId: "thread-1", items: candidates, previouslyOmitted: 3, budget });
      const listed = listedIds(selected.context);
      expect(listed.length).toBeLessThanOrEqual(20);
      expect(listed).toEqual(listed.length ? selected.omittedItemIds.slice(-listed.length) : []);
      const list = /( Omitted item IDs, newest last: [^\n]*)\n/u.exec(selected.context)?.[1] ?? "";
      expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThanOrEqual(list ? budget / 8 : 2);
      expect(selected.cost).toBeLessThanOrEqual(budget);
    }
    expect(listedIds(selectPortableHistory({ threadId: "thread-1", items: candidates, budget: 4_000 }).context).length)
      .toBeLessThan(20);
  });

  it("fits the final envelope at every budget while the list grows and shrinks", () => {
    const candidates = Array.from({ length: 30 }, (_, index) => message(`boundary:${index}`, "assistant", "w".repeat(300)));
    for (let budget = 1_024; budget <= 12_000; budget += 7) {
      const selected = selectPortableHistory({ threadId: "thread-1", items: candidates, previouslyOmitted: 95, budget });
      expect(portableHistoryCost(selected.items, selected.context) <= budget).toBe(true);
    }
  });

  it("names no ids where omitted history cannot be retrieved", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => message(`item:${index}`, "assistant", "v".repeat(800)));
    const selected = selectPortableHistory({ threadId: "thread-1", items: candidates, budget: 3_000,
      hostToolBridgeAttested: false });
    expect(selected.omittedItemIds.length).toBeGreaterThan(0);
    expect(selected.context).not.toContain("Omitted item IDs");
  });
});

describe("portable activity items from durable turns", () => {
  it("emits attributed command, error, plan, file-change and interruption items without reasoning or live tool state", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const first = await finishTurn(runtime, "first");
      command(runtime, first, `Command:\nOPENAI_API_KEY=sk-livesecretvalue123456 npm test\n\nOutput:\n${"noise ".repeat(2_000)}`
        + `Failure near the end: ${"界".repeat(300)}`, "failed");
      command(runtime, first, "Command:\nnpm run live\n\nOutput:\nLIVE-TOOL-STATE", "running");
      runtime.store.addActivity({ conversationId: runtime.conversationId, runId: first.runId, turnId: first.id,
        kind: "reasoning", title: "Thinking", detail: "PRIVATE-REASONING", status: "completed" });
      runtime.store.addActivity({ conversationId: runtime.conversationId, runId: first.runId, turnId: first.id,
        kind: "tool", title: "MCP tool", detail: "TOOL-PAYLOAD", status: "completed" });
      plan(runtime, first, "Parse the export, then run the suite.");
      changedFile(runtime, first.id, "src/parser.ts", "added");
      const failed = await finishTurn(runtime, "failed", { status: "failed" });
      const stopped = await finishTurn(runtime, "stopped", { status: "cancelled" });
      const live = runtime.controller.queue({ conversationId: runtime.conversationId, content: "live request" });
      runtime.controller.start(live.turn.id);
      command(runtime, live.turn, "Command:\nnpm run watch\n\nOutput:\nLIVE-TURN-OUTPUT");
      const backing = runtime.store.orchestration.backings.find({ threadId: runtime.conversationId, providerId: "codex",
        workspaceKey: runtime.workspace, identity: first.continuationIdentity })!;
      const result = history(runtime)!;
      const items = result.selection.items;
      const only = (kind: PortableHistoryItem["kind"]) => {
        const matches = items.filter((entry) => entry.kind === kind);
        expect(matches).toHaveLength(1);
        return matches[0]!;
      };
      expect(result.selection.omittedCount).toBe(0);
      expect(only("command")).toMatchObject({ role: "assistant", status: "failed", turnId: first.id, runId: first.runId,
        providerBackingId: backing.id, threadId: runtime.conversationId });
      expect(only("command").text).toContain("Command: [redacted] npm test");
      expect(only("command").text).toContain("Exit code: unknown\nOutcome: failed");
      expect(only("command").text).toMatch(/\[\d+ earlier bytes of output omitted\]/u);
      expect(only("command").text).toContain(`Failure near the end: ${"界".repeat(300)}`);
      expect(Buffer.byteLength(only("command").text)).toBeLessThanOrEqual(4_096 + 200);
      expect(only("plan")).toMatchObject({ role: "assistant", turnId: first.id, providerBackingId: backing.id });
      expect(only("plan").text).toBe("Proposed plan:\nParse the export, then run the suite.\n\nSteps:\n"
        + "- [x] Write the parser\n- [ ] Run the suite");
      expect(only("file-change")).toMatchObject({ turnId: first.id, text: "File change (added): src/parser.ts" });
      expect(only("error")).toMatchObject({ role: "assistant", status: "failed", turnId: failed.id, runId: failed.runId });
      expect(only("interrupt-result")).toMatchObject({ status: "cancelled", turnId: stopped.id,
        text: "The user stopped this turn before it finished." });
      for (const entry of items) {
        expect(entry.at).toEqual(expect.any(String));
        if (entry.turnId !== null && entry.turnId !== live.turn.id) expect(entry.providerBackingId).toBe(backing.id);
      }
      expect(items.map(({ kind }) => kind).sort()).toEqual(["assistant-message", "command", "error", "file-change",
        "interrupt-result", "plan", "user-message", "user-message", "user-message", "user-message"]);
      const times = items.map(({ at }) => at!);
      expect(times).toEqual([...times].sort((left, right) => left.localeCompare(right, "en")));
      const rendered = result.blocks.map(({ content }) => content).join("\n");
      for (const hidden of ["PRIVATE-REASONING", "LIVE-TOOL-STATE", "LIVE-TURN-OUTPUT", "TOOL-PAYLOAD", "livesecretvalue"]) {
        expect(rendered).not.toContain(hidden);
      }
      expect(result.blocks.map(({ label }) => label)).not.toContain("Handoff outcome");
      expect(result.selection.context).toMatch(/Covered chat turns 1-4; source items/u);
      expect(history(runtime, { hostToolBridgeAttested: false })!.selection.context).not.toContain("inertia_request_context");
    } finally { runtime.store.close(); }
  });

  it("leaves rolled-back turns' activities out of the handoff and the next fresh-session prompt", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const retained = await finishTurn(runtime, "retained", { native: true });
      command(runtime, retained, "Command:\nnpm run retained-check\n\nOutput:\nretained ok");
      plan(runtime, retained, "RETAINED-PLAN");
      const removed = await finishTurn(runtime, "removed", { native: true });
      command(runtime, removed, "Command:\nnpm run rolled-back-check\n\nOutput:\nROLLED-BACK-OUTPUT", "failed");
      runtime.store.addActivity({ conversationId: runtime.conversationId, runId: removed.runId, turnId: removed.id,
        kind: "error", title: "ROLLED-BACK-ERROR", detail: null, status: "failed" });
      plan(runtime, removed, "ROLLED-BACK-PLAN");
      changedFile(runtime, removed.id, "src/rolled-back.ts");
      const before = history(runtime)!.selection.items;
      const idsOf = (turnId: string) => before.filter((entry) => entry.turnId === turnId).map(({ id }) => id);
      const readItem = (itemId: string, threadId = runtime.conversationId) =>
        runtime.store.orchestration.portableHistoryItem({ threadId, itemId, maxTextBytes: 1_048_576 });
      expect(idsOf(removed.id).length).toBeGreaterThanOrEqual(5);
      for (const id of [...idsOf(retained.id), ...idsOf(removed.id)]) expect(readItem(id).found).toBe(true);
      const nativeConversation = vi.fn(async (request: NativeConversationRequest) => ({ operationId: request.operationId,
        identity: request.source.identity, status: "unsupported" as const, reason: "native-history-control-unavailable" as const }));
      const deps = { store: runtime.store, turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: { resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id), nativeConversation } };
      const commandId = "portable-history-rollback";
      await expect(rollbackConversationHistory(deps, { conversationId: runtime.conversationId, turnId: retained.id,
        source: { actorId: "human", commandId, command: { type: "conversation.rollback", requestId: commandId,
          payload: { conversationId: runtime.conversationId, turnId: retained.id } } } }, new AbortController().signal))
        .resolves.toMatchObject({ transfer: "portable" });
      const rendered = history(runtime)!.blocks.map(({ content }) => content).join("\n");
      expect(rendered).toContain("npm run retained-check");
      expect(rendered).toContain("RETAINED-PLAN");
      for (const hidden of ["rolled-back-check", "ROLLED-BACK-OUTPUT", "ROLLED-BACK-ERROR", "ROLLED-BACK-PLAN", "src/rolled-back.ts"]) {
        expect(rendered).not.toContain(hidden);
      }
      // An item read by id follows the same rule as the handoff: a rolled-back turn's items are gone.
      for (const id of idsOf(removed.id)) expect(readItem(id)).toEqual({ found: false, reason: "not-found" });
      const retainedCommand = readItem(idsOf(retained.id).find((id) => id.startsWith("activity:"))!);
      expect(retainedCommand).toMatchObject({ found: true, item: { kind: "command", turnId: retained.id } });
      expect(retainedCommand.found && retainedCommand.text).toContain("npm run retained-check");
      // Ids are scoped to the chat that owns them.
      const otherChat = runtime.store.createConversation(runtime.store.conversation(runtime.conversationId).projectId,
        "Other chat", { activate: false });
      for (const id of idsOf(retained.id)) expect(readItem(id, otherChat.id)).toEqual({ found: false, reason: "not-found" });
      const fresh = runtime.controller.queue({ conversationId: runtime.conversationId, content: "fresh request" });
      runtime.controller.start(fresh.turn.id);
      expect(runtime.provider.input?.sessionId).toBeUndefined();
      expect(runtime.provider.input?.prompt).toContain("npm run retained-check");
      expect(runtime.provider.input?.prompt).not.toContain("rolled-back-check");
      expect(runtime.provider.input?.prompt).not.toContain("ROLLED-BACK-PLAN");
    } finally { runtime.store.close(); }
  });
});
