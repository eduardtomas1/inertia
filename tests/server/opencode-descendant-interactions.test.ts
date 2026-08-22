import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function descendantInteractionServer(
  root: string,
  capturePath: string,
  emitRootActivity = true,
): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const captured = [];
const sessionID = "opencode-root-session";
const childID = "opencode-child-session";
const emitRootActivity = ${JSON.stringify(emitRootActivity)};
let events;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ port, captured }));
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "root", projectID: "project", directory: ${JSON.stringify(root)}, title: "Root", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: true, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    captured.push({ method: req.method, path: url.pathname, body: parsed });
    save();
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, []);
    if (req.method === "POST" && url.pathname === "/session") return json(res, session);
    if (req.method === "GET" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") {
      events = res;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      return res.flushHeaders();
    }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/prompt_async") {
      json(res, undefined, 204);
      if (emitRootActivity) setTimeout(() => sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "root-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } }), 10);
      setTimeout(() => sendEvent({ type: "session.created", properties: { sessionID: childID, info: { ...session, id: childID, parentID: sessionID } } }), 20);
      setTimeout(() => sendEvent({ type: "permission.v2.asked", properties: { id: "child-permission", sessionID: "unrelated-session", action: "edit", resources: ["foreign.ts"], source: { type: "tool", messageID: "foreign-assistant", callID: "foreign-call" } } }), 30);
      setTimeout(() => sendEvent({ type: "permission.v2.asked", properties: { id: "child-permission", sessionID: childID, action: "edit", resources: ["src/child.ts"], source: { type: "tool", messageID: "child-assistant", callID: "child-call" } } }), 40);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/" + childID + "/permission/child-permission/reply") {
      json(res, true);
      sendEvent({ type: "permission.v2.replied", properties: { sessionID: childID, requestID: "child-permission", reply: "once" } });
      sendEvent({ type: "question.v2.asked", properties: { id: "child-question", sessionID: childID, questions: [{ header: "Child", question: "Continue child work?", options: [{ label: "Yes", description: "Continue" }] }], tool: { messageID: "child-assistant", callID: "child-question-call" } } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/" + childID + "/question/child-question/reply") {
      json(res, true);
      sendEvent({ type: "question.v2.replied", properties: { sessionID: childID, requestID: "child-question", answers: [["Yes"]] } });
      sendEvent({ type: "message.part.updated", properties: { sessionID: childID, part: { id: "private-child-text", sessionID: childID, messageID: "child-assistant", type: "text", text: "Private child interaction output" } } });
      if (emitRootActivity) sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "root-text", sessionID, messageID: "root-assistant", type: "text", text: "Parent resumed after child interaction" } } });
      sendEvent({ type: "session.idle", properties: { sessionID } });
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/abort")) return json(res, true);
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

describe("OpenCode descendant interactions", () => {
  const roots: string[] = [];

  afterEach(async () => await Promise.all(
    roots.splice(0).map(removePortableFixture),
  ));

  it("routes verified child interactions without projecting private output", async () => {
    const root = portableFixtureRoot("OpenCode descendant interaction");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      descendantInteractionServer(root, capturePath),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 500,
      })]),
    );
    let approvals = 0;
    let questions = 0;

    const result = await manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-descendant-interaction",
      cwd: root,
      prompt: "Delegate with supervised interactions",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (approval) => {
        approvals += 1;
        expect(manager.respondToApproval(
          approval.conversationId,
          approval.request.requestId,
          "approve",
        )).toBe(true);
      },
      onInput: (input) => {
        questions += 1;
        expect(manager.respondToInput(
          input.conversationId,
          input.request.requestId,
          { [input.request.questions[0]!.id]: ["Yes"] },
        )).toBe(true);
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "Parent resumed after child interaction",
    });
    expect(result.text).not.toContain("Private child interaction output");
    expect(approvals).toBe(1);
    expect(questions).toBe(1);
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      captured: Array<{ path: string; body?: unknown }>;
    };
    expect(capture.captured).toContainEqual(expect.objectContaining({
      path: "/api/session/opencode-child-session/permission/child-permission/reply",
      body: { reply: "once" },
    }));
    expect(capture.captured).toContainEqual(expect.objectContaining({
      path: "/api/session/opencode-child-session/question/child-question/reply",
      body: { answers: [["Yes"]] },
    }));
    expect(capture.captured.some(({ path }) =>
      path.includes("/api/session/unrelated-session/"))).toBe(false);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("does not let child interactions satisfy root completion activity", async () => {
    const root = portableFixtureRoot("OpenCode child-only interaction");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      descendantInteractionServer(root, capturePath, false),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 250,
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-child-only-interaction",
      cwd: root,
      prompt: "Do not let child activity finish the root",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (approval) => {
        expect(manager.respondToApproval(
          approval.conversationId,
          approval.request.requestId,
          "approve",
        )).toBe(true);
      },
      onInput: (input) => {
        expect(manager.respondToInput(
          input.conversationId,
          input.request.requestId,
          { [input.request.questions[0]!.id]: ["Yes"] },
        )).toBe(true);
      },
    })).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "rpc-timeout",
        terminalEvent: "event/inactivity-deadline",
      },
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
