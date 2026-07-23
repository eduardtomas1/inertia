import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createOpenCodeSdkHarness, readOpenCodeSdkModels } from "../../src/server/provider/opencode-sdk-harness";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

type LifecycleScenario = "resume" | "cancel" | "oversized" | "no-image";

function lifecycleServerSource(root: string, capturePath: string, scenario: LifecycleScenario): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const scenario = ${JSON.stringify(scenario)};
const captured = [];
const sessionID = "opencode-lifecycle-session";
let events;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ port, captured }));
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "fixture", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fixture", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: scenario !== "no-image", video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    captured.push({ method: req.method, path: url.pathname, body: parsed }); save();
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, []);
    if (req.method === "POST" && url.pathname === "/session") return json(res, session);
    if (url.pathname === "/session/" + sessionID && req.method === "GET") return json(res, session);
    if (url.pathname === "/session/" + sessionID && req.method !== "GET") return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); return res.flushHeaders(); }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/prompt_async") {
      json(res, undefined, 204);
      if (scenario === "resume") setTimeout(() => {
        sendEvent({ type: "session.idle", properties: { sessionID: "stale-session" } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "assistant", sessionID, role: "assistant", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "text", sessionID, messageID: "assistant", type: "text", text: "Resumed OpenCode response" } } });
        sendEvent({ type: "session.idle", properties: { sessionID } });
      }, 10);
      if (scenario === "oversized") setTimeout(() => sendEvent({ type: "message.updated", properties: { sessionID, payload: "x".repeat(1024 * 1024 + 1) } }), 10);
      return;
    }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/abort") {
      json(res, true);
      return setTimeout(() => sendEvent({ type: "session.idle", properties: { sessionID } }), 10);
    }
    return json(res, { error: "not found" }, 404);
  });
});
server.listen(port, "127.0.0.1", save);
`;
}

function permissionDecisionServerSource(root: string, capturePath: string): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const captured = [];
const sessionID = "opencode-permission-session";
let events;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ port, captured }));
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "fixture", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fixture", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    captured.push({ method: req.method, path: url.pathname, body: parsed }); save();
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, []);
    if (req.method === "POST" && url.pathname === "/session") return json(res, session);
    if (req.method === "GET" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); return res.flushHeaders(); }
    if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
      json(res, undefined, 204);
      return sendEvent({ type: "permission.asked", properties: { id: "deny-only", sessionID, permission: "bash", patterns: ["npm test"], metadata: {} } });
    }
    if (req.method === "POST" && url.pathname === "/permission/deny-only/reply") {
      json(res, true);
      return sendEvent({ type: "permission.asked", properties: { id: "cancel-turn", sessionID, permission: "edit", resources: ["src/app.ts"], metadata: {} } });
    }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/abort") {
      json(res, true);
      return setTimeout(() => sendEvent({ type: "session.idle", properties: { sessionID } }), 10);
    }
    return json(res, { error: "not found" }, 404);
  });
});
server.listen(port, "127.0.0.1", save);
`;
}

describe.sequential("OpenCode SDK harness", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("owns the local server and bridges SSE text, reasoning, tools, todos, permissions, questions, usage, models, and images", async () => {
    const root = portableFixtureRoot("OpenCode SDK");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const captured = [];
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(captured));
const sessionID = "55555555-5555-4555-8555-555555555555";
let events;
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "fake", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fake", version: "1.18.4", model: { id: "model-a", providerID: "fake", variant: "high" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: true, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01", variants: { high: {} } };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    captured.push({ method: req.method, path: url.pathname, body: parsed }); save();
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, [{ name: "plan", mode: "primary", permission: [], options: {} }]);
    if (req.method === "POST" && url.pathname === "/session") return json(res, session);
    if (req.method === "GET" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); return res.flushHeaders(); }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/prompt_async") {
      json(res, undefined, 204);
      sendEvent({ id: "e1", type: "message.updated", properties: { sessionID, info: { id: "assistant-1", sessionID, role: "assistant", tokens: { input: 120, output: 30, reasoning: 5, cache: { read: 10, write: 0 } } } } });
      return sendEvent({ id: "e2", type: "permission.asked", properties: { id: "permission-1", sessionID, permission: "bash", patterns: ["npm test"], metadata: {}, always: [] } });
    }
    if (req.method === "POST" && url.pathname === "/permission/permission-1/reply") {
      json(res, true);
      return sendEvent({ id: "e3", type: "question.asked", properties: { id: "question-1", sessionID, questions: [{ header: "Scope", question: "Which scope?", options: [{ label: "Focused", description: "Only this package" }], custom: true }] } });
    }
    if (req.method === "POST" && url.pathname === "/question/question-1/reply") {
      json(res, true);
      sendEvent({ id: "e4", type: "message.part.updated", properties: { sessionID, time: Date.now(), part: { id: "reason-1", sessionID, messageID: "assistant-1", type: "reasoning", text: "Checking constraints", time: { start: Date.now() } } } });
      sendEvent({ id: "e5", type: "message.part.updated", properties: { sessionID, time: Date.now(), part: { id: "text-1", sessionID, messageID: "assistant-1", type: "text", text: "OpenCode response", time: { start: Date.now(), end: Date.now() } } } });
      sendEvent({ id: "e6", type: "message.part.updated", properties: { sessionID, time: Date.now(), part: { id: "tool-1", sessionID, messageID: "assistant-1", type: "tool", callID: "call-1", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "ok", title: "Run tests", metadata: {}, time: { start: Date.now(), end: Date.now() } } } } });
      sendEvent({ id: "e7", type: "todo.updated", properties: { sessionID, todos: [{ content: "Inspect", status: "completed", priority: "high" }] } });
      sendEvent({ id: "e8", type: "message.updated", properties: { sessionID, info: { id: "assistant-1", sessionID, role: "assistant", tokens: { total: 160, input: 125, output: 30, reasoning: 5, cache: { read: 10, write: 0 } } } } });
      sendEvent({ id: "e9", type: "message.updated", properties: { sessionID, info: { id: "assistant-2", sessionID, role: "assistant", tokens: { total: 40, input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } } });
      return sendEvent({ id: "e10", type: "session.idle", properties: { sessionID } });
    }
    if (req.method === "POST" && url.pathname.endsWith("/abort")) return json(res, true);
    return json(res, { error: "not found" }, 404);
  });
});
server.listen(port, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + port));
`);
    const models = await readOpenCodeSdkModels(command, process.env, root);
    expect(models).toEqual([expect.objectContaining({
      id: "fake/model-a",
      label: "Model A",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [expect.objectContaining({ value: "high" })],
    })]);
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const approvals: string[] = [];
    const questions: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usage: Array<number | null> = [];
    const usageDetails: Array<Record<string, unknown>> = [];
    const metadata: string[][] = [];

    const result = await manager.run({
      providerId: "opencode",
      conversationId: "opencode-rich",
      cwd: root,
      prompt: "Build this",
      interactionMode: "plan",
      access: "supervised",
      model: "fake/model-a",
      reasoningEffort: "high",
      imagePaths: [imagePath],
    }, {
      onApproval: (event) => {
        approvals.push(event.request.title);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => {
        questions.push(event.request.questions[0]!.question);
        const questionId = event.request.questions[0]!.id;
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { [questionId]: ["Focused"] })).toBe(true);
      },
      onPlan: (event) => plans.push(...event.steps.map((step) => step.step)),
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => {
        usage.push(event.usage.usedTokens);
        usageDetails.push(event.usage);
      },
      onMetadata: (event) => metadata.push(event.metadata.models?.map((model) => model.id) ?? []),
    });

    expect(result).toMatchObject({ status: "completed", text: "OpenCode response", sessionId: "55555555-5555-4555-8555-555555555555" });
    expect(approvals).toEqual(["OpenCode wants to use bash"]);
    expect(questions).toEqual(["Which scope?"]);
    expect(plans).toEqual(["Inspect"]);
    expect(reasoning).toEqual(["Checking constraints"]);
    expect(usage).toEqual([130, 135, 30]);
    expect(usageDetails[0]).toEqual(expect.objectContaining({
      usedTokens: 130,
      totalProcessedTokens: 165,
      totalProcessedScope: "run",
      maxTokens: 200_000,
      inputTokens: 120,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      compactsAutomatically: null,
    }));
    expect(usageDetails.at(-1)).toMatchObject({
      totalProcessedTokens: 200,
      usedTokens: 30,
      inputTokens: 30,
      outputTokens: 10,
    });
    expect(metadata).toContainEqual(["fake/model-a"]);
    expect(manager.cachedMetadata("opencode")).toMatchObject({
      models: [expect.objectContaining({ id: "fake/model-a" })],
      metadataState: { models: { freshness: "fresh", provenance: "provider" } },
    });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{ method: string; path: string; body?: Record<string, unknown> }>;
    expect(captured.filter(({ path }) => path === "/provider")).toHaveLength(1);
    expect(captured.find(({ path }) => path === "/session")?.body).toMatchObject({ agent: "plan", model: { id: "model-a", providerID: "fake", variant: "high" } });
    expect(captured.find(({ path }) => path.endsWith("/prompt_async"))?.body).toMatchObject({
      agent: "plan",
      model: { modelID: "model-a", providerID: "fake" },
      variant: "high",
      parts: expect.arrayContaining([expect.objectContaining({ type: "file", mime: "image/png" })]),
    });
    expect(captured.find(({ path }) => path === "/permission/permission-1/reply")?.body).toEqual({ reply: "once" });
    expect(captured.find(({ path }) => path === "/question/question-1/reply")?.body).toEqual({ answers: [["Focused"]] });
  });

  it("resumes the selected session and ignores stale-session events", async () => {
    const root = portableFixtureRoot("OpenCode resume");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "resume"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run({
      providerId: "opencode",
      conversationId: "opencode-resume",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    })).resolves.toMatchObject({
      status: "completed",
      sessionId: "opencode-lifecycle-session",
      text: "Resumed OpenCode response",
    });
    const { captured } = JSON.parse(readFileSync(capturePath, "utf8")) as { captured: Array<{ method: string; path: string }> };
    expect(captured.some(({ method, path }) => method === "POST" && path === "/session")).toBe(false);
    expect(captured.some(({ method, path }) => method === "GET" && path === "/session/opencode-lifecycle-session")).toBe(true);
    expect(captured.some(({ method, path }) => method !== "GET" && path === "/session/opencode-lifecycle-session")).toBe(true);
  });

  it("denies one permission without aborting, then cancels the owned session and settles the turn", async () => {
    const root = portableFixtureRoot("OpenCode permission semantics");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", permissionDecisionServerSource(root, capturePath));
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let approvals = 0;
    const result = manager.run({
      providerId: "opencode",
      conversationId: "opencode-permission-semantics",
      cwd: root,
      prompt: "Exercise permissions",
      interactionMode: "build",
      access: "supervised",
    }, {
      onApproval: (event) => {
        approvals += 1;
        const decision = approvals === 1 ? "deny" : "cancel";
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, decision)).toBe(true);
      },
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(approvals).toBe(2);
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
      captured: Array<{ path: string; body?: Record<string, unknown> }>;
    };
    expect(capture.captured.find(({ path }) => path === "/permission/deny-only/reply")?.body).toEqual({ reply: "reject" });
    expect(capture.captured.some(({ path }) => path === "/permission/cancel-turn/reply")).toBe(false);
    expect(capture.captured.some(({ path }) => path.endsWith("/abort"))).toBe(true);
    await waitFor("the cancelled OpenCode process to close", async () => !(await loopbackPortIsOpen(capture.port)));
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("cancels through the owned server and leaves no listening process", async () => {
    const root = portableFixtureRoot("OpenCode cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "cancel"));
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run({
      providerId: "opencode",
      conversationId: "opencode-cancel",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }, { onStatus: ({ status }) => { if (status === "running") markRunning(); } });

    await running;
    expect(manager.cancel("opencode-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    await waitFor("the OpenCode abort request", () => {
      try {
        const value = JSON.parse(readFileSync(capturePath, "utf8")) as { captured: Array<{ path: string }> };
        return value.captured.some(({ path }) => path.endsWith("/abort"));
      } catch { return false; }
    });
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { port: number };
    await waitFor("the OpenCode child socket to close", async () => !(await loopbackPortIsOpen(capture.port)));
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("rejects oversized events and unavailable image capability", async () => {
    const oversizedRoot = portableFixtureRoot("OpenCode oversized");
    roots.push(oversizedRoot);
    const oversizedCapture = join(oversizedRoot, "capture.json");
    const oversizedCommand = portableNodeExecutable(oversizedRoot, "opencode");
    writeNodeSubcommand(oversizedRoot, "serve", lifecycleServerSource(oversizedRoot, oversizedCapture, "oversized"));
    const oversizedManager = new ProviderManager(
      { commands: { opencode: oversizedCommand } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    await expect(oversizedManager.run({
      providerId: "opencode",
      conversationId: "opencode-oversized",
      cwd: oversizedRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("oversized") });

    const capabilityRoot = portableFixtureRoot("OpenCode image capability");
    roots.push(capabilityRoot);
    const capabilityCapture = join(capabilityRoot, "capture.json");
    const imagePath = join(capabilityRoot, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const capabilityCommand = portableNodeExecutable(capabilityRoot, "opencode");
    writeNodeSubcommand(capabilityRoot, "serve", lifecycleServerSource(capabilityRoot, capabilityCapture, "no-image"));
    const capabilityManager = new ProviderManager(
      { commands: { opencode: capabilityCommand } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    await expect(capabilityManager.run({
      providerId: "opencode",
      conversationId: "opencode-no-image",
      cwd: capabilityRoot,
      prompt: "Inspect",
      interactionMode: "build",
      access: "supervised",
      imagePaths: [imagePath],
    })).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("image input support") });
  });

  it("settles missing and early-exit startup failures", async () => {
    const missingRoot = portableFixtureRoot("OpenCode missing");
    roots.push(missingRoot);
    const missing = join(missingRoot, process.platform === "win32" ? "missing.exe" : "missing");
    const missingManager = new ProviderManager(
      { commands: { opencode: missing } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    await expect(missingManager.run({
      providerId: "opencode",
      conversationId: "opencode-missing",
      cwd: missingRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "failed" });

    const exitRoot = portableFixtureRoot("OpenCode early exit");
    roots.push(exitRoot);
    const exitCommand = portableNodeExecutable(exitRoot, "opencode");
    writeNodeSubcommand(exitRoot, "serve", `process.stderr.write("fixture startup failed\\n"); process.exit(7);`);
    const exitManager = new ProviderManager(
      { commands: { opencode: exitCommand } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    await expect(exitManager.run({
      providerId: "opencode",
      conversationId: "opencode-exit",
      cwd: exitRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("exited during startup") });
    expect(missingManager.activeConversationIds()).toEqual([]);
    expect(exitManager.activeConversationIds()).toEqual([]);
  });
});
