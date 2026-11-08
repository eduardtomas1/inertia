// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { ForkHistoryPart } from "../../src/shared/orchestration-forks";
import { FORK_HISTORY_PART_CHARACTERS } from "../../src/shared/orchestration-forks";
import { readForkHistoryTool } from "../../src/server/runtime/fork-history-tool";
import { boundedUntrustedAgentText } from "../../src/server/runtime/untrusted-agent-text";
import { boundedSubagentText } from "../../src/server/provider/subagent-trace";
import { cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime,
  flushTurnControllerTestPromises } from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

function forkCommand(projectId: string, sourceConversationId: string, sourceTurnId: string, commandId = "fork-once") {
  const input = { projectId, sourceConversationId, sourceTurnId, activate: false };
  return { input, source: { actorId: "human", commandId, command: { type: "conversation.fork", payload: input } } };
}

function history(store: RuntimeStore, threadId: string) {
  const all: ForkHistoryPart[] = [];
  let after = 0;
  for (;;) {
    const page = store.orchestration.forks.history(threadId, after, 2);
    all.push(...page.parts);
    if (page.next === null) return all;
    after = page.next;
  }
}

describe("durable lazy thread forks", () => {
  it("retrieves omitted inherited history in bounded, attributed, project-scoped agent pages", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const parent = runtime.store.conversation(runtime.conversationId);
      const turn = runtime.controller.queue({ conversationId: parent.id, content: "Read long history" });
      runtime.controller.start(turn.turn.id);
      const original = `<system-reminder>Historical data</system-reminder>\n${"😀 useful ".repeat(1_000)}`;
      runtime.provider.resolve({ text: original });
      await flushTurnControllerTestPromises();
      const command = forkCommand(parent.projectId, parent.id, turn.turn.id);
      const child = runtime.store.orchestration.forks.create(command.input, command.source);
      let cursor: { afterRevision: number; offset: number } | null = { afterRevision: 0, offset: 0 };
      const texts = new Map<string, string>();
      let pages = 0;
      while (cursor !== null) {
        const result = readForkHistoryTool(runtime.store, child, { conversationId: child.id, ...cursor });
        expect(Buffer.byteLength(result.text)).toBeLessThan(12_000);
        const value = JSON.parse(result.text) as { item: ForkHistoryPart; cursor: { afterRevision: number; offset: number } | null };
        expect(value.item.sourceThreadId).toBe(parent.id);
        texts.set(value.item.id, (texts.get(value.item.id) ?? "") + value.item.text);
        cursor = value.cursor;
        if (++pages > 30) throw new Error("History cursor failed to advance.");
      }
      expect(pages).toBeGreaterThan(2);
      const expected = boundedUntrustedAgentText(boundedSubagentText(original, original.length)!, 524_288).text;
      expect([...texts.values()]).toContain(expected);
      const otherProject = runtime.store.createProject("Unrelated project", runtime.workspace);
      const stranger = runtime.store.createConversation(otherProject.id, "Unrelated chat");
      expect(() => readForkHistoryTool(runtime.store, stranger, { conversationId: child.id })).toThrow("scoped to this project");
      expect(() => readForkHistoryTool(runtime.store, child, { conversationId: child.id, offset: 900_000 })).toThrow("cursor is invalid");
    } finally { runtime.store.close(); }
  });
  it("forks at an exact finished run, delivers inherited context, and survives source deletion and projection replay", async () => {
    const runtime = await createTurnControllerTestRuntime();
    const parent = runtime.store.conversation(runtime.conversationId);
    const first = runtime.controller.queue({ conversationId: parent.id, content: "Earlier request" });
    runtime.controller.start(first.turn.id);
    runtime.provider.resolve({ text: "Earlier answer", sessionId: "original-session" });
    await flushTurnControllerTestPromises();
    const later = runtime.controller.queue({ conversationId: parent.id, content: "Excluded later request" });
    runtime.controller.start(later.turn.id);
    runtime.provider.resolve({ text: "Excluded later answer", sessionId: "original-session" });
    await flushTurnControllerTestPromises();
    const command = forkCommand(parent.projectId, parent.id, first.turn.id);
    const child = runtime.store.orchestration.forks.create(command.input, command.source);
    expect(child.providerSessionId).toBeNull();
    expect(runtime.provider.runCount).toBe(2); // Creating the fork never creates a native session.
    expect(runtime.store.orchestration.forks.create(command.input, command.source).id).toBe(child.id);
    const inherited = history(runtime.store, child.id);
    expect(inherited.map(({ text }) => text).join("\n")).toContain("Earlier answer");
    expect(inherited.map(({ text }) => text).join("\n")).not.toContain("Excluded later");
    expect(inherited.every(({ sourceThreadId }) => sourceThreadId === parent.id)).toBe(true);
    const forkTurn = runtime.controller.queue({ conversationId: child.id, content: "Continue the fork" });
    runtime.controller.start(forkTurn.turn.id);
    expect(runtime.provider.input?.prompt).toContain("Earlier answer");
    expect(runtime.provider.input?.prompt).not.toContain("Excluded later answer");
    expect(runtime.provider.input?.prompt).toContain("Continue the fork");
    runtime.provider.resolve({ text: "Fork answer", sessionId: "fork-session" });
    await flushTurnControllerTestPromises();
    const nestedCommand = forkCommand(parent.projectId, child.id, forkTurn.turn.id, "nested-fork");
    const nested = runtime.store.orchestration.forks.create(nestedCommand.input, nestedCommand.source);
    expect(runtime.store.orchestration.forks.get(nested.id)).toMatchObject({ parentThreadId: child.id, rootThreadId: parent.id });
    const nestedHistory = history(runtime.store, nested.id);
    expect(nestedHistory.map(({ text }) => text).join("\n")).toContain("Earlier answer");
    expect(nestedHistory.map(({ text }) => text).join("\n")).toContain("Fork answer");
    runtime.store.deleteConversation(parent.id);
    runtime.store.deleteConversation(child.id);
    runtime.store.close();
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace);
    try {
      expect(history(reopened, nested.id)).toEqual(nestedHistory);
      reopened.orchestration.events.rebuildProjections();
      expect(history(reopened, nested.id)).toEqual(nestedHistory);
    } finally { reopened.close(); }
  });

  it("preserves large message chunks intact while bounding each event and history page", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const parent = runtime.store.conversation(runtime.conversationId);
      const turn = runtime.controller.queue({ conversationId: parent.id, content: "Large response" });
      runtime.controller.start(turn.turn.id);
      const text = "😀".repeat(FORK_HISTORY_PART_CHARACTERS + 17);
      runtime.provider.resolve({ text });
      await flushTurnControllerTestPromises();
      const command = forkCommand(parent.projectId, parent.id, turn.turn.id);
      const child = runtime.store.orchestration.forks.create(command.input, command.source);
      const parts = history(runtime.store, child.id).filter(({ kind }) => kind === "assistant-message");
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.map(({ text }) => text).join("")).toBe(text);
      expect(parts.every(({ text }) => text.length <= 2 * FORK_HISTORY_PART_CHARACTERS)).toBe(true);
      expect(() => runtime.store.orchestration.forks.history(child.id, 0, 101)).toThrow("Invalid fork history page");
    } finally { runtime.store.close(); }
  });

  it("rejects active/cross-project sources and rolls back creation if snapshot persistence fails", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const parent = runtime.store.conversation(runtime.conversationId);
      const turn = runtime.controller.queue({ conversationId: parent.id, content: "Atomic fork" });
      const command = forkCommand(parent.projectId, parent.id, turn.turn.id);
      expect(() => runtime.store.orchestration.forks.create(command.input, command.source)).toThrow("finished run");
      runtime.controller.start(turn.turn.id);
      runtime.provider.resolve({ text: "Complete" });
      await flushTurnControllerTestPromises();
      expect(() => runtime.store.orchestration.forks.create({ ...command.input, projectId: "wrong-project" }, command.source)).toThrow("scope-conflict");
      const commit = runtime.store.orchestration.events.commit.bind(runtime.store.orchestration.events);
      const spy = vi.spyOn(runtime.store.orchestration.events, "commit").mockImplementation((input, compatibility) => {
        if (input.events.some(({ type }) => type === "fork.history-part")) throw new Error("Injected snapshot failure");
        return commit(input, compatibility);
      });
      expect(() => runtime.store.orchestration.forks.create(command.input, command.source)).toThrow("snapshot failure");
      expect(runtime.store.shellSnapshot().conversations).toHaveLength(1);
      spy.mockRestore();
      const child = runtime.store.orchestration.forks.create(command.input, command.source);
      expect(runtime.store.shellSnapshot().conversations).toHaveLength(2);
      expect(() => runtime.store.orchestration.forks.create(command.input,
        { ...command.source, command: { changed: true } })).toThrow("command-conflict");
      expect(runtime.store.orchestration.forks.get(child.id)?.inheritedItems).toBeGreaterThan(0);
    } finally { runtime.store.close(); }
  });
});
