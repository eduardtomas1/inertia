import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  loopbackPortIsOpen,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

describe.sequential("Cursor ACP harness", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("negotiates capabilities and bridges ACP permissions, questions, plans, thinking, usage, and images", async () => {
    const root = portableFixtureRoot("cursor ACP");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
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
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const approvals: string[] = [];
    const questions: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usage: Array<number | null> = [];
    const usageDetails: Array<Record<string, unknown>> = [];
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
      onUsage: (event) => {
        usage.push(event.usage.usedTokens);
        usageDetails.push(event.usage);
      },
      onMetadata: (event) => metadata.push(event.metadata.models?.map((model) => model.id) ?? []),
    });

    expect(result).toMatchObject({ status: "completed", text: "Cursor response", sessionId: "44444444-4444-4444-8444-444444444444" });
    expect(approvals).toEqual(["Run tests"]);
    expect(questions).toEqual(["Which scope?"]);
    expect(plans).toEqual(expect.arrayContaining(["Inspect", "Implement"]));
    expect(reasoning).toEqual(["Checking"]);
    expect(usage).toEqual([321, 321]);
    expect(usageDetails.at(-1)).toMatchObject({
      usedTokens: 321,
      totalProcessedTokens: 350,
      totalProcessedScope: "session",
      maxTokens: 200_000,
      inputTokens: 320,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      compactsAutomatically: null,
    });
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

  it("fails closed on malformed ACP frames", async () => {
    const root = portableFixtureRoot("cursor ACP invalid");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `process.stdout.write("not-json\\n"); setTimeout(() => {}, 1000);`);
    const manager = new ProviderManager({ commands: { cursor: command } }, new AgentHarnessRegistry([createCursorAcpHarness()]));
    await expect(manager.run({ providerId: "cursor", conversationId: "cursor-invalid", cwd: root, prompt: "Hi", interactionMode: "build", access: "supervised" })).resolves.toMatchObject({ status: "failed" });
  });

  it("loads a resumable ACP session instead of creating a replacement", async () => {
    const root = portableFixtureRoot("cursor ACP resume");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/load") return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Resumed response" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );

    await expect(manager.run({
      providerId: "cursor",
      conversationId: "cursor-resume",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-existing-session",
    })).resolves.toMatchObject({ status: "completed", sessionId: "cursor-existing-session", text: "Resumed response" });
    const messages = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{ method?: string }>;
    expect(messages.some(({ method }) => method === "session/load")).toBe(true);
    expect(messages.some(({ method }) => method === "session/new")).toBe(false);
  });

  it("cancels through ACP and closes the owned process socket", async () => {
    const root = portableFixtureRoot("cursor ACP cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const messages = [];
let promptId;
const probe = net.createServer(() => {});
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ port: probe.address()?.port, messages }));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
probe.listen(0, "127.0.0.1", save);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-cancel-session", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") { promptId = message.id; return; }
  if (message.method === "session/cancel") return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run({
      providerId: "cursor",
      conversationId: "cursor-cancel",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }, { onStatus: ({ status }) => { if (status === "running") markRunning(); } });

    await running;
    await waitFor("Cursor fixture capture", () => {
      try { return Boolean(JSON.parse(readFileSync(capturePath, "utf8")).port); } catch { return false; }
    });
    expect(manager.cancel("cursor-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { port: number; messages: Array<{ method?: string }> };
    expect(captured.messages.some(({ method }) => method === "session/cancel")).toBe(true);
    await waitFor("the Cursor child socket to close", async () => !(await loopbackPortIsOpen(captured.port)));
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("rejects oversized ACP frames and unavailable negotiated capabilities", async () => {
    const oversizedRoot = portableFixtureRoot("cursor ACP oversized");
    roots.push(oversizedRoot);
    const oversizedCommand = portableNodeExecutable(oversizedRoot, "cursor-agent");
    writeNodeSubcommand(oversizedRoot, "acp", `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`);
    const oversizedManager = new ProviderManager(
      { commands: { cursor: oversizedCommand } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(oversizedManager.run({
      providerId: "cursor",
      conversationId: "cursor-oversized",
      cwd: oversizedRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("oversized") });

    const capabilityRoot = portableFixtureRoot("cursor ACP capabilities");
    roots.push(capabilityRoot);
    const imagePath = join(capabilityRoot, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const capabilityCommand = portableNodeExecutable(capabilityRoot, "cursor-agent");
    writeNodeSubcommand(capabilityRoot, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-no-images", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
});
`);
    const capabilityManager = new ProviderManager(
      { commands: { cursor: capabilityCommand } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(capabilityManager.run({
      providerId: "cursor",
      conversationId: "cursor-no-resume",
      cwd: capabilityRoot,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "existing",
    })).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("resume support") });
    await expect(capabilityManager.run({
      providerId: "cursor",
      conversationId: "cursor-no-image",
      cwd: capabilityRoot,
      prompt: "Inspect",
      interactionMode: "build",
      access: "supervised",
      imagePaths: [imagePath],
    })).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("image prompt support") });
  });

  it("settles startup failure when the ACP executable is missing", async () => {
    const root = portableFixtureRoot("cursor ACP missing");
    roots.push(root);
    const missing = join(root, process.platform === "win32" ? "missing.exe" : "missing");
    const manager = new ProviderManager(
      { commands: { cursor: missing } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run({
      providerId: "cursor",
      conversationId: "cursor-missing",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "failed" });
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
