import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";

describe.sequential("Cursor ACP harness", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it.skipIf(process.platform === "win32")("negotiates capabilities and bridges ACP permissions, questions, plans, thinking, usage, and images", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-cursor-acp-"));
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const command = join(root, "agent");
    writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const captured = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(captured));
const sessionId = "44444444-4444-4444-8444-444444444444";
const configOptions = [
  { type: "select", id: "model", name: "Model", category: "model", currentValue: "model-a", options: [{ value: "model-a", name: "Model A" }] },
  { type: "select", id: "effort", name: "Effort", category: "thought_level", currentValue: "low", options: [{ value: "high", name: "High" }] }
];
let promptRequestId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  captured.push(message);
  save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, agentInfo: { name: "Cursor", version: "9.9.9" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] }, configOptions } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
  if (message.method === "session/prompt") {
    promptRequestId = message.id;
    return send({ jsonrpc: "2.0", id: 100, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute", status: "pending", rawInput: { command: "npm test" } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
  }
  if (message.id === 100) return send({ jsonrpc: "2.0", id: 101, method: "cursor/ask_question", params: { toolCallId: "tool-2", title: "Choose scope", questions: [{ id: "scope", prompt: "Which scope?", options: [{ id: "focused", label: "Focused" }] }] } });
  if (message.id === 101) return send({ jsonrpc: "2.0", id: 102, method: "cursor/create_plan", params: { toolCallId: "tool-3", plan: "Inspect then implement", todos: [{ id: "todo-1", content: "Inspect", status: "in_progress" }] } });
  if (message.id === 102) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stale-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan", entries: [{ content: "Implement", priority: "high", status: "pending" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-4", title: "Run command", kind: "execute", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 321, size: 200000 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Cursor response" } } } });
    return send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn", usage: { totalTokens: 350, inputTokens: 320, outputTokens: 30, thoughtTokens: 5, cachedReadTokens: 20 } } });
  }
});
`);
    chmodSync(command, 0o700);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const approvals: string[] = [];
    const questions: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usage: number[] = [];
    const metadata: string[][] = [];

    const result = await manager.run({
      providerId: "cursor",
      conversationId: "cursor-rich",
      cwd: root,
      prompt: "Build this",
      interactionMode: "plan",
      access: "supervised",
      model: "model-a",
      reasoningEffort: "high",
      imagePaths: [imagePath],
    }, {
      onApproval: (event) => {
        approvals.push(event.request.title);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => {
        questions.push(event.request.questions[0]!.question);
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { scope: ["Focused"] })).toBe(true);
      },
      onPlan: (event) => plans.push(...event.steps.map((step) => step.step)),
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => usage.push(event.usage.usedTokens),
      onMetadata: (event) => metadata.push(event.metadata.models?.map((model) => model.id) ?? []),
    });

    expect(result).toMatchObject({ status: "completed", text: "Cursor response", sessionId: "44444444-4444-4444-8444-444444444444" });
    expect(approvals).toEqual(["Run tests"]);
    expect(questions).toEqual(["Which scope?"]);
    expect(plans).toEqual(expect.arrayContaining(["Inspect", "Implement"]));
    expect(reasoning).toEqual(["Checking"]);
    expect(usage).toEqual([321, 320]);
    expect(metadata).toContainEqual(["model-a"]);
    expect(manager.cachedMetadata("cursor")).toMatchObject({
      models: [expect.objectContaining({ id: "model-a", inputModalities: ["text", "image"] })],
      metadataState: { models: { freshness: "fresh", provenance: "session" } },
    });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<Record<string, unknown>>;
    expect(captured.find((message) => message.id === 100)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(captured.find((message) => message.id === 101)).toMatchObject({ result: { outcome: "answered", answers: [{ questionId: "scope", selectedOptionIds: ["focused"] }] } });
    const prompt = captured.find((message) => message.method === "session/prompt") as { params: { prompt: Array<Record<string, unknown>> } };
    expect(prompt.params.prompt).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image", mimeType: "image/png", data: "iVBORw==" }),
      { type: "text", text: "Build this" },
    ]));
  });

  it.skipIf(process.platform === "win32")("fails closed on malformed ACP frames", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-cursor-acp-invalid-"));
    roots.push(root);
    const command = join(root, "agent");
    writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write("not-json\\n"); setTimeout(() => {}, 1000);\n`);
    chmodSync(command, 0o700);
    const manager = new ProviderManager({ commands: { cursor: command } }, new AgentHarnessRegistry([createCursorAcpHarness()]));
    await expect(manager.run({ providerId: "cursor", conversationId: "cursor-invalid", cwd: root, prompt: "Hi", interactionMode: "build", access: "supervised" })).resolves.toMatchObject({ status: "failed" });
  });
});
