// @inertia-test-suite portable
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { coveredHistoryOccupancy } from "../../src/server/orchestration-v2/portable-history-occupancy";
import { MAX_PORTABLE_COMMAND_INPUT_BYTES, MAX_PORTABLE_COMMAND_OUTPUT_BYTES } from "../../src/server/persistence/turn-context-facts";
import { AgentContextTool } from "../../src/server/runtime/agent-context-tool";
import { FORK_HISTORY_PART_CHARACTERS } from "../../src/shared/orchestration-forks";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

const databaseOf = (runtime: TurnControllerTestRuntime) =>
  (runtime.store as unknown as { database: Database.Database }).database;

async function completeTurn(runtime: TurnControllerTestRuntime, content: string, answer: string, sessionId: string) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content });
  runtime.controller.start(queued.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: answer });
  runtime.provider.resolve({ sessionId });
  await flushTurnControllerTestPromises();
  return queued;
}

/** Records every keyed statement `action` runs, with its parameters. */
function recordStatements(database: Database.Database, action: () => void): Array<{ sql: string; parameters: unknown[] }> {
  const seen: Array<{ sql: string; parameters: unknown[] }> = [];
  const prepare = database.prepare;
  database.prepare = function (sql: string) {
    const statement = prepare.call(database, sql);
    return new Proxy(statement, { get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === "get" && typeof value === "function") {
        return (...parameters: unknown[]) => { seen.push({ sql, parameters }); return (value as (...values: unknown[]) => unknown).apply(target, parameters); };
      }
      return typeof value === "function" ? (value as (...values: unknown[]) => unknown).bind(target) : value;
    } });
  } as typeof database.prepare;
  try { action(); } finally { database.prepare = prepare; }
  return seen;
}

describe("retrieving an omitted item listed in a real handoff", () => {
  it("reads the newest listed id back through inertia_request_context, exactly as stored", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude",
        modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" }) });
      const answers = new Map<string, string>();
      for (let index = 0; index < 10; index++) {
        const answer = `Answer ${index}: ${"report line ".repeat(250)}end of answer ${index}.`;
        await completeTurn(runtime, `Claude request ${index}`, answer, "claude-native");
        answers.set(`Answer ${index}`, answer);
      }
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex",
        modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }) });
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Continue on Codex" });
      runtime.controller.start(queued.turn.id);
      const prompt = runtime.provider.input!.prompt;
      const listed = /Omitted item IDs, newest last: ([^.\n\\]+)\./u.exec(prompt)?.[1]?.split(", ") ?? [];
      expect(listed.length).toBeGreaterThan(0);
      const handoff = runtime.store.orchestration.backings.handoff(queued.turn.runId)!;
      for (const id of listed) {
        expect(handoff.omittedItemIds).toContain(id);
        expect(handoff.itemIds).not.toContain(id);
      }
      const itemId = listed.at(-1)!;
      const stored = runtime.store.message(itemId);
      expect(prompt).not.toContain(stored.content);

      const turn = runtime.store.agentTurn(queued.turn.id);
      const tool = new AgentContextTool({
        store: runtime.store, contextRequests: {} as never, providerInfo: () => [],
        broadcastConversationShell: () => undefined, broadcast: () => undefined, now: () => new Date().toISOString(),
        assertSource: ({ conversation }) => runtime.store.conversation(conversation.id),
      });
      const result = await tool.invoke({ conversation: runtime.store.conversation(runtime.conversationId), turn }, {
        providerThreadId: "provider-thread", providerTurnId: "provider-turn", toolCallId: "read-listed-item",
        tool: "inertia_request_context", arguments: { conversationId: runtime.conversationId, itemId },
        signal: new AbortController().signal, requestApproval: async () => "approve" as const,
      });
      expect(result.success, result.text).toBe(true);
      const page = JSON.parse(result.text) as { item: { itemId: string; kind: string; text: string }; nextCursor: string | null };
      expect(page.item).toMatchObject({ itemId, kind: stored.role === "user" ? "user-message" : "assistant-message" });
      expect(page.item.text).toBe(stored.content);
      expect(page.nextCursor).toBeNull();
      runtime.provider.resolve({ text: "Done", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
    } finally { runtime.store.close(); }
  });

  it("looks each item up by its own key instead of scanning computed ids", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Request" });
      runtime.controller.start(queued.turn.id);
      const activity = runtime.store.addActivity({ conversationId: runtime.conversationId, runId: queued.turn.runId,
        turnId: queued.turn.id, kind: "command", title: "Bash", detail: "Command:\nls\n\nOutput:\nok", status: "completed" });
      runtime.provider.resolve({ text: "Answer", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      const database = databaseOf(runtime);
      for (const [itemId, table] of [[`activity:${activity.id}`, "activities"], [queued.message.id, "messages"]] as const) {
        const statements = recordStatements(database, () => {
          expect(runtime.store.orchestration.portableHistoryItem({ threadId: runtime.conversationId, itemId,
            maxTextBytes: 1_048_576 }).found).toBe(true);
        }).filter(({ sql }) => sql.includes("LIMIT 1") && sql.includes(`FROM ${table}`));
        expect(statements.length).toBeGreaterThan(0);
        for (const { sql, parameters } of statements) {
          const plan = (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[])
            .map(({ detail }) => detail);
          expect(plan[0]).toMatch(new RegExp(`^SEARCH ${table} USING (?:INDEX|PRIMARY KEY|INTEGER PRIMARY KEY)`, "u"));
          expect(plan.some((detail) => detail.startsWith(`SCAN ${table}`))).toBe(false);
        }
      }
      // An unknown prefix and an unknown key read as not found.
      for (const itemId of ["activity:missing", "plan:missing", "files:missing", "interrupt:missing", "missing"]) {
        expect(runtime.store.orchestration.portableHistoryItem({ threadId: runtime.conversationId, itemId, maxTextBytes: 1_000 }))
          .toEqual({ found: false, reason: "not-found" });
      }
    } finally { runtime.store.close(); }
  });
});

describe("native occupancy rounding at four bytes per token", () => {
  it("rounds an inherited item once over all its parts and a capped activity at its cap", async () => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const parent = runtime.store.conversation(runtime.conversationId);
      const turn = runtime.controller.queue({ conversationId: parent.id, content: "Large response" });
      runtime.controller.start(turn.turn.id);
      const capped = runtime.store.addActivity({ conversationId: parent.id, runId: turn.turn.runId, turnId: turn.turn.id,
        kind: "command", title: "Bash", detail: `Command:\nnpm test\n\nOutput:\n${"o".repeat(20_000)}`, status: "completed" });
      const small = runtime.store.addActivity({ conversationId: parent.id, runId: turn.turn.runId, turnId: turn.turn.id,
        kind: "command", title: "Bash", detail: "1234567", status: "completed" });
      // The first part ends on a two-byte character, so each part alone has a remainder: 65,537 bytes and 1 byte.
      const text = `${"a".repeat(FORK_HISTORY_PART_CHARACTERS - 1)}é` + "b";
      runtime.provider.resolve({ text });
      await flushTurnControllerTestPromises();
      const database = databaseOf(runtime);
      const cap = MAX_PORTABLE_COMMAND_INPUT_BYTES + MAX_PORTABLE_COMMAND_OUTPUT_BYTES + 256;
      expect(coveredHistoryOccupancy(database, parent.id, [`activity:${capped.id}`])).toBe(Math.ceil(cap / 4));
      expect(coveredHistoryOccupancy(database, parent.id, [`activity:${small.id}`])).toBe(3);

      const input = { projectId: parent.projectId, sourceConversationId: parent.id, sourceTurnId: turn.turn.id, activate: false };
      const child = runtime.store.orchestration.forks.create(input, { actorId: "human", commandId: "fork-rounding", command: { ...input } });
      const parts = runtime.store.orchestration.forks.history(child.id, 0, 100).parts.filter(({ kind }) => kind === "assistant-message");
      expect(parts.map(({ text: part }) => Buffer.byteLength(part))).toEqual([FORK_HISTORY_PART_CHARACTERS + 1, 1]);
      const occupancy = coveredHistoryOccupancy(database, child.id, [parts[0]!.id]);
      expect(occupancy).toBe(Math.ceil((FORK_HISTORY_PART_CHARACTERS + 2) / 4));
      expect(occupancy).toBeLessThan(Math.ceil((FORK_HISTORY_PART_CHARACTERS + 1) / 4) + 1);
    } finally { runtime.store.close(); }
  });
});
