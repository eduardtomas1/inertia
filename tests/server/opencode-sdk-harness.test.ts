import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  createOpenCodeSdkHarness,
  openCodeApprovalDisplay,
  readOpenCodeSdkModels,
} from "../../src/server/provider/opencode-sdk-harness";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

type LifecycleScenario =
  | "resume"
  | "cancel"
  | "stuck-cancel"
  | "oversized"
  | "utf8-oversized"
  | "event-flood"
  | "slow"
  | "endless"
  | "no-image";

function readStableCapture<T>(capturePath: string): T {
  let lastError: unknown;
  for (const candidate of [`${capturePath}.next`, capturePath]) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No fixture capture was written to ${capturePath}.`);
}

function lifecycleServerSource(root: string, capturePath: string, scenario: LifecycleScenario): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
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
      if (scenario === "utf8-oversized") setTimeout(() => sendEvent({ type: "message.updated", properties: { sessionID, payload: "é".repeat(600 * 1024) } }), 10);
      if (scenario === "event-flood") setTimeout(() => {
        for (let index = 0; index < 2050; index += 1) {
          sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "assistant-" + index, sessionID, role: "assistant" } } });
        }
        sendEvent({ type: "session.idle", properties: { sessionID } });
      }, 10);
      if (scenario === "slow") setTimeout(() => {
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "too-late", sessionID, role: "assistant" } } });
      }, 10_000);
      if (scenario === "endless") setInterval(() => {
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "heartbeat", sessionID, role: "assistant" } } });
      }, 50);
      return;
    }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/abort") {
      if (scenario === "stuck-cancel") return;
      json(res, true);
      if (scenario === "cancel") return;
      return setTimeout(() => sendEvent({ type: "session.idle", properties: { sessionID } }), 10);
    }
    return json(res, { error: "not found" }, 404);
  });
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  save();
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`;
}

function permissionDecisionServerSource(root: string, capturePath: string): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
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
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  save();
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`;
}

function stalledMetadataServerSource(
  capturePath: string,
  stage: "health" | "provider",
): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const captured = [];
const capturePath = ${JSON.stringify(capturePath)};
const save = () => {
  const nextPath = capturePath + ".next";
  fs.writeFileSync(nextPath, JSON.stringify({ port, captured }));
  try {
    fs.renameSync(nextPath, capturePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    fs.copyFileSync(nextPath, capturePath);
    fs.unlinkSync(nextPath);
  }
};
const json = (res, value) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  captured.push(url.pathname);
  save();
  if (url.pathname === "/global/health") {
    if (${JSON.stringify(stage)} === "health") return;
    return json(res, { healthy: true, version: "1.18.4" });
  }
  if (url.pathname === "/provider") return;
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  save();
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`;
}

function stalledRunInitializationServerSource(capturePath: string): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const captured = [];
const capturePath = ${JSON.stringify(capturePath)};
const save = () => {
  const nextPath = capturePath + ".next";
  fs.writeFileSync(nextPath, JSON.stringify({ port, captured }));
  try {
    fs.renameSync(nextPath, capturePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    fs.copyFileSync(nextPath, capturePath);
    fs.unlinkSync(nextPath);
  }
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  captured.push(url.pathname);
  save();
  if (url.pathname === "/global/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ healthy: true, version: "1.18.4" }));
  }
  if (url.pathname === "/provider" || url.pathname === "/agent") return;
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  save();
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`;
}

describe.sequential("OpenCode SDK harness", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("rejects direction-changing approval titles, details, and paths", () => {
    expect(openCodeApprovalDisplay({
      permission: "bash",
      patterns: ["npm test"],
      resources: ["src/app.ts"],
    })).toEqual({
      title: "OpenCode wants to use bash",
      detail: "npm test\nsrc/app.ts",
      resources: ["src/app.ts"],
    });
    expect(openCodeApprovalDisplay({ permission: "bash\u202Etxt.exe" }))
      .toBeNull();
    expect(openCodeApprovalDisplay({
      permission: "bash",
      patterns: ["npm test\u2066hidden"],
    })).toBeNull();
    expect(openCodeApprovalDisplay({
      permission: "edit",
      resources: ["src/safe.ts\u0000hidden"],
    })).toBeNull();
  });

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
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const captured = [];
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(captured));
const sessionID = "55555555-5555-4555-8555-555555555555";
let events;
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "fake", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fake", version: "1.18.4", model: { id: "model-a", providerID: "fake", variant: "high" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: true, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01", variants: { high: {} } };
const disconnectedModel = { ...model, id: "model-b", providerID: "offline", name: "Offline Model" };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    captured.push({ method: req.method, path: url.pathname, body: parsed }); save();
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }, { id: "offline", name: "Offline", source: "config", env: [], options: {}, models: { "model-b": disconnectedModel } }], default: { fake: "model-a", offline: "model-b" }, connected: ["fake"] });
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
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`);
    const models = await readOpenCodeSdkModels(command, process.env, root);
    expect(models).toEqual([expect.objectContaining({
      id: "fake/model-a",
      label: "Model A",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [expect.objectContaining({ value: "high" })],
      defaultReasoningEffort: "",
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
    const activities: Array<{ activityId?: string; detail?: string; phase: string }> = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-rich",
      cwd: root,
      prompt: "Build this",
      interactionMode: "plan",
      access: "supervised",
      model: "fake/model-a",
      reasoningEffort: "high",
      imagePaths: [imagePath],
    }), {
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
      onActivity: (event) => activities.push(event),
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
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "call-1",
      phase: "completed",
      detail: "Command:\nnpm test\n\nOutput:\nok",
    }));
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

  it.each([
    {
      stage: "health" as const,
      message: "server health check",
      expectedPaths: ["/global/health"],
    },
    {
      stage: "provider" as const,
      message: "provider catalog",
      expectedPaths: ["/global/health", "/provider"],
    },
  ])("bounds and cleans up a stalled OpenCode metadata $stage request", async ({
    stage,
    message,
    expectedPaths,
  }) => {
    const root = portableFixtureRoot(`OpenCode stalled metadata ${stage}`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      stalledMetadataServerSource(capturePath, stage),
    );

    await expect(readOpenCodeSdkModels(command, process.env, root, {
      // Leave enough time for the Windows SDK client to dispatch the request;
      // the fixture itself still proves that the stalled request is bounded.
      healthTimeoutMs: 2_000,
      providerTimeoutMs: 250,
    })).rejects.toThrow(message);

    const capture = readStableCapture<{
      port: number;
      captured: string[];
    }>(capturePath);
    expect(capture.captured).toEqual(expect.arrayContaining(expectedPaths));
    await waitFor(
      `the stalled OpenCode metadata ${stage} server to close`,
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
  });

  it("cancels and kills the owned process while startup readiness is pending", async () => {
    const root = portableFixtureRoot("OpenCode cancelled startup");
    roots.push(root);
    const markerPath = join(root, "startup-marker.txt");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "started");
setTimeout(() => fs.appendFileSync(${JSON.stringify(markerPath)}, ":still-running"), 500);
setTimeout(() => console.log("opencode server listening on http://127.0.0.1:65530"), 5_000);
`);
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 100 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-cancelled-startup",
      cwd: root,
      prompt: "Cancel before startup",
      interactionMode: "build",
      access: "supervised",
    }));

    await waitFor("the delayed OpenCode process to start", () => existsSync(markerPath));
    const cancelledAt = Date.now();
    expect(manager.cancel("opencode-cancelled-startup")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(Date.now() - cancelledAt).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(readFileSync(markerPath, "utf8")).toBe("started");
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("bounds provider and session initialization before prompting", async () => {
    const root = portableFixtureRoot("OpenCode stalled initialization");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      stalledRunInitializationServerSource(capturePath),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        // Leave enough headroom for both concurrent discovery requests to
        // reach the fixture when coverage instrumentation is active.
        initializationTimeoutMs: 1_000,
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-stalled-initialization",
      cwd: root,
      prompt: "Do not prompt",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("provider and agent discovery"),
    });
    const capture = readStableCapture<{
      port: number;
      captured: string[];
    }>(capturePath);
    expect(capture.captured).toEqual(expect.arrayContaining([
      "/global/health",
      "/provider",
      "/agent",
    ]));
    expect(capture.captured.some((path) => path.includes("/session"))).toBe(false);
    await waitFor(
      "the stalled initialization server to close",
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
  });

  it("rejects model metadata when server cleanup cannot be confirmed", async () => {
    const root = portableFixtureRoot("OpenCode unconfirmed metadata cleanup");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "resume"),
    );

    await expect(readOpenCodeSdkModels(command, process.env, root, {
      terminateProcessTree: async (child, force) => {
        await terminateProcessTreeAndWait(child, force);
        return false;
      },
    })).rejects.toThrow(
      "OpenCode metadata server process tree could not be confirmed stopped.",
    );
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

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-resume",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "completed",
      sessionId: "opencode-lifecycle-session",
      text: "Resumed OpenCode response",
    });
    const { captured } = JSON.parse(readFileSync(capturePath, "utf8")) as { captured: Array<{ method: string; path: string }> };
    expect(captured.some(({ method, path }) => method === "POST" && path === "/session")).toBe(false);
    expect(captured.some(({ method, path }) => method === "GET" && path === "/session/opencode-lifecycle-session")).toBe(true);
    expect(captured.some(({ method, path }) => method !== "GET" && path === "/session/opencode-lifecycle-session")).toBe(true);
  });

  it("does not emit completion when owned-server cleanup is unconfirmed", async () => {
    const root = portableFixtureRoot("OpenCode unconfirmed run cleanup");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "resume"),
    );
    const statuses: string[] = [];
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        terminateProcessTree: async (child, force) => {
          await terminateProcessTreeAndWait(child, force);
          return false;
        },
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-unconfirmed-cleanup",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    })).resolves.toMatchObject({
      status: "failed",
      error: "OpenCode server process tree could not be confirmed stopped.",
    });
    expect(statuses).not.toContain("completed");
    expect(statuses.at(-1)).toBe("failed");
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
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-permission-semantics",
      cwd: root,
      prompt: "Exercise permissions",
      interactionMode: "build",
      access: "supervised",
    }), {
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

  it("settles acknowledged cancellation only after the owned server is closed", async () => {
    const root = portableFixtureRoot("OpenCode cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "cancel"));
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 5_000,
      })]),
    );
    let markRunning!: () => void;
    let promptWasAcceptedWhenRunning = false;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-cancel",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: ({ status }) => {
        if (status !== "running") return;
        try {
          const value = JSON.parse(readFileSync(capturePath, "utf8")) as {
            captured: Array<{ path: string }>;
          };
          promptWasAcceptedWhenRunning = value.captured.some(({ path }) => path.endsWith("/prompt_async"));
        } catch {
          promptWasAcceptedWhenRunning = false;
        }
        markRunning();
      },
    });

    await running;
    expect(promptWasAcceptedWhenRunning).toBe(true);
    expect(manager.cancel("opencode-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    await waitFor("the OpenCode abort request", () => {
      try {
        const value = JSON.parse(readFileSync(capturePath, "utf8")) as { captured: Array<{ path: string }> };
        return value.captured.some(({ path }) => path.endsWith("/abort"));
      } catch { return false; }
    });
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
      captured: Array<{ path: string }>;
    };
    const promptIndex = capture.captured.findIndex(({ path }) => path.endsWith("/prompt_async"));
    const abortIndex = capture.captured.findIndex(({ path }) => path.endsWith("/abort"));
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(abortIndex).toBeGreaterThan(promptIndex);
    await waitFor(
      "the cancelled OpenCode server port to close",
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("forces bounded cleanup when OpenCode never acknowledges cancellation", async () => {
    const root = portableFixtureRoot("OpenCode stuck cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "stuck-cancel"));
    const terminateOwnedProcessTree = vi.fn(
      async (child, force) => await terminateProcessTreeAndWait(child, force),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        terminateProcessTree: terminateOwnedProcessTree,
      })]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-stuck-cancel",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }), { onStatus: ({ status }) => { if (status === "running") markRunning(); } });

    await running;
    expect(manager.cancel("opencode-stuck-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as { port: number };
    await waitFor(
      "the unresponsive OpenCode server port to close",
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
    expect(terminateOwnedProcessTree).toHaveBeenCalledOnce();
    expect(manager.activeConversationIds()).toEqual([]);
  }, 10_000);

  it("fails and cleans up a slow event stream at the inactivity deadline", async () => {
    const root = portableFixtureRoot("OpenCode inactive stream");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "slow"),
    );
    const terminateOwnedProcessTree = vi.fn(
      async (child, force) => await terminateProcessTreeAndWait(child, force),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        // Keep the absolute deadline well outside the inactivity boundary so
        // slower Windows process startup cannot decide which behavior wins.
        runDeadlineMs: 10_000,
        eventInactivityDeadlineMs: 300,
        terminateProcessTree: terminateOwnedProcessTree,
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-inactive",
      cwd: root,
      prompt: "Wait forever",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("event stream became inactive"),
    });
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
    };
    await waitFor(
      "the inactive OpenCode server to close",
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
    expect(terminateOwnedProcessTree).toHaveBeenCalledOnce();
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("fails and cleans up an active endless stream at the absolute run deadline", async () => {
    const root = portableFixtureRoot("OpenCode endless stream");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "endless"),
    );
    const terminateOwnedProcessTree = vi.fn(
      async (child, force) => await terminateProcessTreeAndWait(child, force),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 10_000,
        terminateProcessTree: terminateOwnedProcessTree,
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-endless",
      cwd: root,
      prompt: "Stay active forever",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("maximum run duration"),
    });
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
    };
    await waitFor(
      "the overlong OpenCode server to close",
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
    expect(terminateOwnedProcessTree).toHaveBeenCalledOnce();
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
    await expect(oversizedManager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-oversized",
      cwd: oversizedRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("oversized") });

    const utf8Root = portableFixtureRoot("OpenCode UTF-8 oversized");
    roots.push(utf8Root);
    const utf8Capture = join(utf8Root, "capture.json");
    const utf8Command = portableNodeExecutable(utf8Root, "opencode");
    writeNodeSubcommand(utf8Root, "serve", lifecycleServerSource(utf8Root, utf8Capture, "utf8-oversized"));
    const utf8Manager = new ProviderManager(
      { commands: { opencode: utf8Command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    await expect(utf8Manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-utf8-oversized",
      cwd: utf8Root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "OpenCode sent an oversized event.",
    });

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
    await expect(capabilityManager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-no-image",
      cwd: capabilityRoot,
      prompt: "Inspect",
      interactionMode: "build",
      access: "supervised",
      imagePaths: [imagePath],
    }))).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("image input support") });
  });

  it("fails and cleans up a run that exceeds its aggregate event state budget", async () => {
    const root = portableFixtureRoot("OpenCode event flood");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "event-flood"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-event-flood",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("bounded message budget"),
    });
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
    };
    await waitFor(
      "the over-budget OpenCode server to close",
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("settles missing and early-exit startup failures", async () => {
    const missingRoot = portableFixtureRoot("OpenCode missing");
    roots.push(missingRoot);
    const missing = join(missingRoot, process.platform === "win32" ? "missing.exe" : "missing");
    const missingManager = new ProviderManager(
      { commands: { opencode: missing } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    await expect(missingManager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-missing",
      cwd: missingRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({ status: "failed" });

    const exitRoot = portableFixtureRoot("OpenCode early exit");
    roots.push(exitRoot);
    const exitCommand = portableNodeExecutable(exitRoot, "opencode");
    writeNodeSubcommand(exitRoot, "serve", `process.stderr.write("fixture startup failed\\n"); process.exit(7);`);
    const exitManager = new ProviderManager(
      { commands: { opencode: exitCommand } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const exitResult = await exitManager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-exit",
      cwd: exitRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(exitResult).toMatchObject({
      status: "failed",
      error: expect.stringContaining("exited during startup"),
    });
    expect(missingManager.activeConversationIds()).toEqual([]);
    if (exitResult.cleanupConfirmed) {
      expect(exitManager.activeConversationIds()).toEqual([]);
      await expect(exitManager.disposeAll()).resolves.toBeUndefined();
    } else {
      expect(exitManager.activeConversationIds()).toEqual(["opencode-exit"]);
      await expect(exitManager.disposeAll()).rejects.toThrow(
        /cleanup could not be confirmed/iu,
      );
    }
  });
});
