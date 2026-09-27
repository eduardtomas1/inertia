// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { CursorTodoSessions } from "../../src/server/provider/cursor-acp-extensions";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import type { AgentPlanStep } from "../../src/server/provider/interactions";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

type TodoUpdate =
  | { merge: boolean; todos: Array<Record<string, string>> }
  | { createPlan: Array<Record<string, string>> }
  | { plan: Array<Record<string, string>> };

function todoAgent(root: string, turns: Record<string, TodoUpdate[]>): string {
  const command = portableNodeExecutable(root, "cursor-agent");
  writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const turns = ${JSON.stringify(turns)};
const sessionId = "cursor-todo-session";
const modes = { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] };
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes, configOptions: [] } });
  if (message.method === "session/load") return send({ jsonrpc: "2.0", id: message.id, result: { modes, configOptions: [] } });
  if (message.method === "session/prompt") {
    const prompt = message.params.prompt.find((block) => block.type === "text").text;
    const updates = turns[prompt] ?? [];
    updates.forEach((update, index) => setTimeout(() => {
      if (update.createPlan) send({ jsonrpc: "2.0", id: "plan-" + index, method: "cursor/create_plan", params: { toolCallId: "plan-tool", plan: "Replacement plan", todos: update.createPlan } });
      else if (update.plan) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan", entries: update.plan } } });
      else send({ jsonrpc: "2.0", method: "cursor/update_todos", params: { toolCallId: "todo-tool", ...update } });
    }, index * 20));
    return setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }), updates.length * 20 + 20);
  }
});
`);
  return command;
}

function snapshot(steps: AgentPlanStep[]): string[] {
  return steps.map(({ step, status }) => `${step}:${status}`);
}

describe("Cursor ACP todo snapshots", { concurrent: false }, () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  async function runTurns(turns: Record<string, TodoUpdate[]>) {
    const root = portableFixtureRoot("Cursor todo snapshots");
    roots.push(root);
    const manager = ProviderManager.createForTests(
      { commands: { cursor: todoAgent(root, turns) } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    return async (prompt: string, sessionId?: string, access: "supervised" | "full" = "supervised") => {
      const plans: string[][] = [];
      await expect(manager.run(nativeProviderRunInput({
        providerId: "cursor",
        conversationId: "cursor-todos",
        cwd: root,
        prompt,
        interactionMode: "build",
        access,
        ...(sessionId ? { sessionId } : {}),
      }), {
        onPlan: (event) => plans.push(snapshot(event.steps)),
      })).resolves.toMatchObject({ status: "completed" });
      return plans;
    };
  }

  it("merges partial native todo updates into the complete current list", async () => {
    const turn = await runTurns({
      first: [
        { merge: false, todos: [{ id: "a", content: "A", status: "pending" }, { id: "b", content: "B", status: "pending" }] },
        { merge: true, todos: [{ id: "a", status: "in_progress" }] },
        { merge: true, todos: [{ id: "c", content: "C", status: "pending" }] },
        { merge: true, todos: [{ id: "a", status: "completed" }, { id: "a", content: "A renamed" }, { content: "Unnamed" }] },
      ],
      second: [
        { merge: true, todos: [{ id: "b", status: "completed" }] },
        { merge: false, todos: [{ id: "d", content: "D", status: "pending" }] },
      ],
      fresh: [
        { merge: true, todos: [{ id: "e", content: "E", status: "pending" }] },
      ],
    });

    await expect(turn("first")).resolves.toEqual([
      ["A:pending", "B:pending"],
      ["A:inProgress", "B:pending"],
      ["A:inProgress", "B:pending", "C:pending"],
      ["A renamed:completed", "B:pending", "C:pending", "Unnamed:pending"],
    ]);
    await expect(turn("second", "cursor-todo-session")).resolves.toEqual([
      ["A renamed:completed", "B:completed", "C:pending", "Unnamed:pending"],
      ["D:pending"],
    ]);
    await expect(turn("fresh")).resolves.toEqual([["E:pending"]]);
  });

  it("replaces cached todos when Cursor sends a full plan", async () => {
    const turn = await runTurns({
      first: [
        { merge: false, todos: [{ id: "a", content: "A", status: "pending" }, { id: "b", content: "B", status: "pending" }] },
        { createPlan: [{ id: "c", content: "C", status: "pending" }, { id: "d", content: "D", status: "pending" }] },
        { merge: true, todos: [{ id: "c", status: "completed" }] },
        { plan: [{ content: "E", priority: "medium", status: "pending" }] },
        { merge: true, todos: [{ id: "f", content: "F", status: "pending" }] },
      ],
    });

    await expect(turn("first", undefined, "full")).resolves.toEqual([
      ["A:pending", "B:pending"],
      ["C:pending", "D:pending"],
      ["C:completed", "D:pending"],
      ["E:pending"],
      ["F:pending"],
    ]);
  });

  it("keeps cancelled native todos cancelled across later updates", async () => {
    const turn = await runTurns({
      first: [
        { merge: false, todos: [{ id: "a", content: "A", status: "completed" }, { id: "b", content: "B", status: "cancelled" }] },
        { merge: true, todos: [{ id: "c", content: "C", status: "pending" }] },
      ],
      second: [{ merge: true, todos: [{ id: "c", status: "completed" }] }],
    });

    await expect(turn("first")).resolves.toEqual([
      ["A:completed", "B:cancelled"],
      ["A:completed", "B:cancelled", "C:pending"],
    ]);
    await expect(turn("second", "cursor-todo-session")).resolves.toEqual([
      ["A:completed", "B:cancelled", "C:completed"],
    ]);
  });
});

describe("Cursor todo session state", () => {
  const update = (merge: boolean, todos: Array<{ id?: string; content?: string; status?: string }>) =>
    ({ toolCallId: "todo-tool", merge, todos });

  it("keeps duplicate IDs in one replacement at their first position", () => {
    const sessions = new CursorTodoSessions();
    expect(sessions.apply("session", update(false, [
      { id: "a", content: "A" }, { id: "b", content: "B" }, { id: "a", status: "completed" },
    ]))).toEqual([{ id: "a", content: "A", status: "completed" }, { id: "b", content: "B" }]);
  });

  it("bounds todos per session and evicts the least recently updated session", () => {
    const sessions = new CursorTodoSessions();
    const many = Array.from({ length: 100 }, (_, index) => ({ id: `todo-${index}`, content: `Todo ${index}` }));
    sessions.apply("bounded", update(false, many));
    expect(sessions.apply("bounded", update(true, [{ id: "overflow", content: "Overflow" }, { id: "todo-0", status: "completed" }])))
      .toHaveLength(100);
    expect(sessions.apply("bounded", update(true, []))[0]).toEqual({ id: "todo-0", content: "Todo 0", status: "completed" });
    for (let index = 0; index < 64; index += 1) {
      sessions.apply(`session-${index}`, update(false, [{ id: "a", content: "A" }]));
    }
    expect(sessions.apply("bounded", update(true, []))).toEqual([]);
    expect(sessions.apply("session-63", update(true, []))).toEqual([{ id: "a", content: "A" }]);
  });

  it("forgets a session's todos when that native session is reset", () => {
    const sessions = new CursorTodoSessions();
    sessions.apply("session", update(false, [{ id: "a", content: "A" }]));
    sessions.reset("session");
    expect(sessions.apply("session", update(true, [{ id: "b", content: "B" }])))
      .toEqual([{ id: "b", content: "B" }]);
  });
});
