import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createOpenCodeSdkHarness, readOpenCodeSdkModels } from "../../src/server/provider/opencode-sdk-harness";

describe.sequential("OpenCode SDK harness", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it.skipIf(process.platform === "win32")("owns the local server and bridges SSE text, reasoning, tools, todos, permissions, questions, usage, models, and images", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-opencode-sdk-"));
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const command = join(root, "opencode");
    writeFileSync(command, `#!${process.execPath}
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
      return sendEvent({ id: "e8", type: "session.idle", properties: { sessionID } });
    }
    if (req.method === "POST" && url.pathname.endsWith("/abort")) return json(res, true);
    return json(res, { error: "not found" }, 404);
  });
});
server.listen(port, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + port));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
    chmodSync(command, 0o700);
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
    const usage: number[] = [];
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
      onUsage: (event) => usage.push(event.usage.usedTokens),
      onMetadata: (event) => metadata.push(event.metadata.models?.map((model) => model.id) ?? []),
    });

    expect(result).toMatchObject({ status: "completed", text: "OpenCode response", sessionId: "55555555-5555-4555-8555-555555555555" });
    expect(approvals).toEqual(["OpenCode wants to use bash"]);
    expect(questions).toEqual(["Which scope?"]);
    expect(plans).toEqual(["Inspect"]);
    expect(reasoning).toEqual(["Checking constraints"]);
    expect(usage).toEqual([120]);
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
});
