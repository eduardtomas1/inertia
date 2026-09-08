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
    { access: "supervised", decision: "approve", outcome: "accepted" },
    { access: "supervised", decision: "deny", outcome: "rejected" },
    { access: "supervised", decision: "cancel", outcome: "cancelled" },
    { access: "auto-edit", decision: "approve", outcome: "accepted" },
    { access: "full", decision: "approve", outcome: "accepted" },
  ] as const)("uses $access/$decision authority for a $outcome plan", async ({ access, decision, outcome }) => {
    const root = portableFixtureRoot(`Cursor plan ${access} ${decision}`);
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
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-plan-session" } });
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
      prompt: "Plan", interactionMode: "build", access,
    }), {
      onApproval: (event) => { approval = event; },
      onPlan: (event) => { plans.push(event.explanation); },
    });
    void result.then(() => { settled = true; });
    try {
      if (access === "supervised") {
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
      else expect(access).not.toBe("supervised");
    } finally {
      manager.cancel("cursor-plan");
      await result;
    }
  });
});
