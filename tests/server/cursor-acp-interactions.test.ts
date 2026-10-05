// @inertia-test-suite portable
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import type { ProviderApprovalEvent } from "../../src/server/provider/contracts";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Cursor ACP question response contract", { concurrent: false }, () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it.each(["answered", "cancelled"] as const)(
    "sends the documented %s outcome envelope and admits a resumed follow-up after cleanup",
    async (outcome) => {
      const root = portableFixtureRoot(`Cursor question ${outcome}`);
      roots.push(root);
      const capturePath = join(root, "question-response.json");
      const requestsPath = join(root, "requests.jsonl");
      const command = portableNodeExecutable(root, "cursor-agent");
      const expected = { outcome: outcome === "answered"
        ? { outcome, answers: [{ questionId: "scope", selectedOptionIds: ["focused"] }] }
        : { outcome } };
      // A strict protocol peer, not an assertion copied from the adapter:
      // https://cursor.com/docs/cli/acp#cursorask_question
      writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const { isDeepStrictEqual } = require("node:util");
const readline = require("node:readline");
const sessionId = "cursor-question-session";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const text = (value, id = sessionId) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } } });
let promptId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "fixture" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
  if (message.method === "session/load") {
    text("Replayed history");
    return send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    if (message.params.prompt.some((block) => block.text === "Follow up")) {
      text("Foreign response", "other-session");
      text("Follow-up response");
      return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
    return send({ jsonrpc: "2.0", id: 100, method: "cursor/ask_question", params: { toolCallId: "question-tool", questions: [{ id: "scope", prompt: "Choose scope", options: [{ id: "focused", label: "Focused" }] }] } });
  }
  if (message.method === "session/cancel") return text("Late cancelled content");
  if (message.id === 100) {
    const accepted = isDeepStrictEqual(message.result, ${JSON.stringify(expected)});
    fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ response: message.result, accepted }));
    return send(accepted
      ? { jsonrpc: "2.0", id: promptId, result: { stopReason: ${JSON.stringify(outcome === "cancelled" ? "cancelled" : "end_turn")} } }
      : { jsonrpc: "2.0", id: promptId, error: { code: -32602, message: "Invalid Cursor question outcome envelope" } });
  }
});

`);
      const manager = ProviderManager.createForTests(
        { commands: { cursor: command }, cancelGraceMs: 500 },
        new AgentHarnessRegistry([createCursorAcpHarness()]),
      );
      const input = nativeProviderRunInput({
        providerId: "cursor", conversationId: "cursor-question", cwd: root,
        prompt: "Ask", interactionMode: "build", access: "supervised",
      });
      let questionCount = 0;
      const result = await manager.run(input, {
        onInput: ({ conversationId, request, runId, turnId }) => {
          questionCount += 1;
          if (outcome === "cancelled") expect(manager.cancel(conversationId)).toBe(true);
          else expect(manager.respondToInput(conversationId, request.requestId, {
            scope: ["focused"],
          }, { runId, turnId })).toBe(true);
        },
      });
      expect(questionCount).toBe(1);
      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({ response: expected, accepted: true });
      expect(result).toMatchObject({
        status: outcome === "answered" ? "completed" : "cancelled",
        sessionId: "cursor-question-session", cleanupConfirmed: true, text: "",
      });
      expect(manager.activeConversationIds()).toEqual([]);
      const next = await manager.run({
        ...input, runId: "cursor-follow-up-run", turnId: "cursor-follow-up-turn",
        prompt: "Follow up", sessionId: result.sessionId,
      });
      expect(next).toMatchObject({
        status: "completed", sessionId: "cursor-question-session",
        text: "Follow-up response", cleanupConfirmed: true,
      });
      expect(manager.activeConversationIds()).toEqual([]);
      const requests = readFileSync(requestsPath, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: { sessionId?: string } });
      expect(requests.filter(({ method }) => method === "session/new")).toHaveLength(1);
      expect(requests.filter(({ method }) => method === "session/load")).toMatchObject([
        { params: { sessionId: "cursor-question-session" } },
      ]);
      expect(requests.filter(({ method }) => method === "session/prompt")).toHaveLength(2);
    },
  );
});

describe("Cursor ACP plan approval policy", { concurrent: false }, () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it.each([
    { mode: "build", access: "supervised", decision: "approve", outcome: "accepted" },
    { mode: "build", access: "supervised", decision: "deny", outcome: "rejected" },
    { mode: "build", access: "supervised", decision: "cancel", outcome: "cancelled" },
    { mode: "build", access: "auto-edit", decision: "approve", outcome: "accepted" },
    { mode: "build", access: "full", decision: "approve", outcome: "accepted" },
    { mode: "plan", access: "supervised", decision: "approve", outcome: "accepted" },
    { mode: "plan", access: "supervised", decision: "deny", outcome: "rejected" },
    { mode: "plan", access: "full", decision: "deny", outcome: "rejected" },
  ] as const)("uses $mode $access/$decision authority for a $outcome plan", async ({ mode, access, decision, outcome }) => {
    const root = portableFixtureRoot(`Cursor plan ${mode} ${access} ${decision}`);
    roots.push(root);
    const responsePath = join(root, "plan-response.json");
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let promptId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "fixture" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-plan-session", modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] } } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/prompt") {
    promptId = message.id;
    return send({ jsonrpc: "2.0", id: 100, method: "cursor/create_plan", params: { toolCallId: "plan-tool", plan: "Inspect then verify", todos: [{ id: "inspect", content: "Inspect", status: "pending" }] } });
  }
  if (message.id === 100) {
    fs.writeFileSync(${JSON.stringify(responsePath)}, JSON.stringify(message.result));
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: message.result?.outcome?.outcome === "cancelled" ? "cancelled" : "end_turn" } });
  }
});
`);
    const manager = ProviderManager.createForTests(
      { commands: { cursor: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    let approval: ProviderApprovalEvent | undefined;
    let settled = false;
    const plans: Array<string | null> = [];
    const result = manager.run(nativeProviderRunInput({
      providerId: "cursor", conversationId: "cursor-plan", cwd: root,
      prompt: "Plan", interactionMode: mode, access,
    }), {
      onApproval: (event) => { approval = event; },
      onPlan: (event) => { plans.push(event.explanation); },
    });
    void result.then(() => { settled = true; });
    try {
      if (access === "supervised" || mode === "plan") {
        await waitFor("Cursor plan decision boundary", () => Boolean(approval) || settled);
        expect(approval).toBeDefined();
        const event = approval!;
        expect(event.request).toMatchObject({ kind: "file-change", title: "Create Cursor plan" });
        expect(plans).toEqual(["Inspect then verify"]);
        expect(existsSync(responsePath)).toBe(false);
        expect(settled).toBe(false);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve", {
          runId: "foreign-run", turnId: event.turnId,
        })).toBe(false);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve", {
          runId: event.runId, turnId: "foreign-turn",
        })).toBe(false);
        expect(existsSync(responsePath)).toBe(false);
        if (decision === "cancel") expect(manager.cancel(event.conversationId)).toBe(true);
        else expect(manager.respondToApproval(event.conversationId, event.request.requestId, decision, {
          runId: event.runId, turnId: event.turnId,
        })).toBe(true);
      }
      await expect(result).resolves.toMatchObject({
        status: decision === "cancel" ? "cancelled" : "completed", cleanupConfirmed: true,
      });
      expect(JSON.parse(readFileSync(responsePath, "utf8"))).toMatchObject({ outcome: { outcome } });
      expect(manager.activeConversationIds()).toEqual([]);
      if (approval) expect(manager.respondToApproval(approval.conversationId, approval.request.requestId, "approve", {
        runId: approval.runId, turnId: approval.turnId,
      })).toBe(false);
      else expect(access !== "supervised" && mode === "build").toBe(true);
    } finally {
      manager.cancel("cursor-plan");
      await result;
    }
  });
});

describe("Cursor ACP in-band backend errors", { concurrent: false }, () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  async function cursorTurn(updates: object[]) {
    const root = portableFixtureRoot("Cursor in-band error");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "cursor-inband-session";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "2026.09.02-c22c1a3" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: [] } });
  if (message.method === "session/prompt") {
    for (const update of ${JSON.stringify(updates)}) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = ProviderManager.createForTests(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const text: string[] = [];
    const result = await manager.run(nativeProviderRunInput({
      providerId: "cursor", conversationId: "cursor-inband", cwd: root,
      prompt: "Hello", interactionMode: "build", access: "supervised",
    }), { onText: (event) => { text.push(event.text); } });
    return { result, text: text.join("") };
  }

  const chunk = (value: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });

  it("fails a sign-in request through the authentication path that leads to Connect", async () => {
    const { result, text } = await cursorTurn([chunk("\n\nPlease sign in to continue")]);
    expect(result).toMatchObject({
      status: "failed",
      text: "",
      cleanupConfirmed: true,
      failure: {
        reason: "provider-error",
        message: "Cursor needs you to sign in. Connect Cursor in provider settings, then try again.",
        phase: "auth",
        terminalEvent: "session/prompt:sign-in-required",
      },
    });
    expect(result.failure?.usageLimited).toBeUndefined();
    expect(text).toBe("");
  });

  it("fails a plan limit as a usage-limited turn", async () => {
    const { result, text } = await cursorTurn([chunk("\n\nUpgrade your plan to continue")]);
    expect(result).toMatchObject({
      status: "failed",
      text: "",
      failure: {
        reason: "provider-error",
        message: "Cursor: Upgrade your plan to continue",
        phase: "turn",
        terminalEvent: "session/prompt:backend-error",
        usageLimited: true,
      },
    });
    expect(text).toBe("");
  });

  it.each([
    ["\n\nAdd a payment method to continue", "Cursor: Add a payment method to continue"],
    ["\n\nCheck your settings to continue", "Cursor: Check your settings to continue"],
    ["\n\nError: The model is overloaded", "Cursor: Error: The model is overloaded"],
  ])("fails %j with the backend text as the reason", async (value, message) => {
    const { result, text } = await cursorTurn([chunk(value)]);
    expect(result).toMatchObject({
      status: "failed",
      text: "",
      failure: { reason: "provider-error", message, phase: "turn", terminalEvent: "session/prompt:backend-error" },
    });
    expect(result.failure?.usageLimited).toBeUndefined();
    expect(text).toBe("");
  });

  it.each([
    { name: "a sentence without Cursor's leading blank lines", updates: [chunk("Please sign in to continue")], expected: "Please sign in to continue" },
    { name: "an ordinary answer that uses the same words", updates: [chunk("\n\nUpgrade your plan to continue using longer contexts.")], expected: "\n\nUpgrade your plan to continue using longer contexts." },
    { name: "a matching first chunk followed by more answer", updates: [chunk("\n\nUpgrade your plan to continue"), chunk(" if you need more requests.")], expected: "\n\nUpgrade your plan to continue if you need more requests." },
    { name: "a matching chunk after other turn output", updates: [chunk("Checking."), chunk("\n\nPlease sign in to continue")], expected: "Checking.\n\nPlease sign in to continue" },
    { name: "a matching chunk after reasoning", updates: [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } }, chunk("\n\nError: quoted from the log")], expected: "\n\nError: quoted from the log" },
  ])("completes $name", async ({ updates, expected }) => {
    const { result, text } = await cursorTurn(updates);
    expect(result).toMatchObject({ status: "completed", text: expected });
    expect(result.failure).toBeUndefined();
    expect(text).toBe(expected);
  });
});
