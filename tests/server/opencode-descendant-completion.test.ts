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

type CompletionScenario =
  | "replay-session-idle"
  | "replay-status-idle"
  | "replayed-root-does-not-refresh"
  | "settled-before-first-idle"
  | "terminal-progress";

function descendantCompletionServer(
  root: string,
  scenario: CompletionScenario,
): string {
  return `
const http = require("node:http");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const scenario = ${JSON.stringify(scenario)};
const sessionID = "opencode-root-session";
const childID = "opencode-child-session";
let events;
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const session = { id: sessionID, slug: "root", projectID: "project", directory: ${JSON.stringify(root)}, title: "Root", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: true, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
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
      const initialRoot = {
        id: "initial-root-message",
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: "root-assistant",
            parentID: parsed.messageID,
            sessionID,
            role: "assistant",
          },
        },
      };
      const waitingRoot = {
        id: "waiting-root-message",
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: "root-assistant",
            parentID: parsed.messageID,
            sessionID,
            role: "assistant",
            tokens: { output: 1 },
          },
        },
      };
      const childIdle = {
        id: "initial-child-idle",
        type: "session.idle",
        properties: { sessionID: childID },
      };
      const rootIdle = scenario === "replay-session-idle"
        ? { id: "initial-root-idle", type: "session.idle", properties: { sessionID } }
        : { id: "initial-root-idle", type: "session.status", properties: { sessionID, status: { type: "idle" } } };
      const finalRootActivity = () => sendEvent({
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            id: "root-final-text",
            sessionID,
            messageID: "root-assistant",
            type: "text",
            text: "Parent resumed after the child settled",
          },
        },
      });

      setTimeout(() => sendEvent(initialRoot), 10);
      setTimeout(() => sendEvent({
        type: "session.created",
        properties: {
          sessionID: childID,
          info: { ...session, id: childID, parentID: sessionID },
        },
      }), 20);

      if (scenario === "settled-before-first-idle") {
        setTimeout(() => sendEvent(childIdle), 50);
        setTimeout(() => sendEvent(rootIdle), 70);
        setTimeout(finalRootActivity, 100);
        setTimeout(() => sendEvent({ ...rootIdle, id: "fresh-root-idle" }), 120);
        return;
      }

      if (scenario === "terminal-progress") {
        setTimeout(() => sendEvent(rootIdle), 30);
        setTimeout(() => sendEvent(childIdle), 400);
        setTimeout(finalRootActivity, 700);
        setTimeout(() => sendEvent({ ...rootIdle, id: "fresh-root-idle" }), 720);
        return;
      }

      if (scenario === "replayed-root-does-not-refresh") {
        setTimeout(() => sendEvent(childIdle), 50);
        for (const delay of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000]) {
          setTimeout(() => sendEvent({
            ...initialRoot,
            id: "replayed-root-" + delay,
          }), delay);
        }
        return;
      }

      setTimeout(() => sendEvent(rootIdle), 30);
      setTimeout(() => sendEvent(waitingRoot), 40);
      setTimeout(() => sendEvent(childIdle), 50);
      setTimeout(() => sendEvent({
        type: "message.updated",
        properties: {
          sessionID: childID,
          info: {
            id: "child-assistant",
            parentID: "child-prompt",
            sessionID: childID,
            role: "assistant",
          },
        },
      }), 70);
      setTimeout(() => sendEvent({ ...childIdle, id: "replayed-child-idle" }), 90);
      setTimeout(() => sendEvent({ ...rootIdle, id: "root-idle-while-child-live" }), 110);
      setTimeout(() => sendEvent({ type: "session.status", properties: { sessionID: childID, status: { type: "idle" } } }), 130);
      setTimeout(() => sendEvent({ ...rootIdle, id: "root-idle-after-child" }), 150);
      setTimeout(() => sendEvent({ ...initialRoot, id: "replayed-initial-root" }), 160);
      setTimeout(() => sendEvent({ ...waitingRoot, id: "replayed-waiting-root" }), 170);
      setTimeout(() => sendEvent({ ...rootIdle, id: "root-idle-after-replayed-work" }), 190);
      setTimeout(finalRootActivity, 210);
      setTimeout(() => sendEvent({ ...rootIdle, id: "fresh-root-idle" }), 230);
      return;
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
`;
}

function runCompletionScenario(
  root: string,
  scenario: CompletionScenario,
  eventInactivityDeadlineMs = 500,
  runDeadlineMs = 5_000,
): Promise<Awaited<ReturnType<ProviderManager["run"]>>> {
  const command = portableNodeExecutable(root, "opencode");
  writeNodeSubcommand(
    root,
    "serve",
    descendantCompletionServer(root, scenario),
  );
  const manager = new ProviderManager(
    { commands: { opencode: command } },
    new AgentHarnessRegistry([createOpenCodeSdkHarness({
      runDeadlineMs,
      eventInactivityDeadlineMs,
    })]),
  );
  return manager.run(nativeProviderRunInput({
    providerId: "opencode",
    conversationId: `opencode-${scenario}`,
    cwd: root,
    prompt: "Wait for the delegated task, then finish",
    interactionMode: "build",
    access: "supervised",
  }));
}

describe("OpenCode descendant completion", () => {
  const roots: string[] = [];

  afterEach(async () => await Promise.all(
    roots.splice(0).map(removePortableFixture),
  ));

  it.each([
    ["session.idle", "replay-session-idle"],
    ["session.status idle", "replay-status-idle"],
  ] as const)("requires novel parent continuation before fresh root %s (%s)", async (_label, scenario) => {
    const root = portableFixtureRoot(`OpenCode descendant completion ${scenario}`);
    roots.push(root);

    await expect(runCompletionScenario(root, scenario)).resolves.toMatchObject({
      status: "completed",
      text: "Parent resumed after the child settled",
    });
  });

  it("rejects the first root idle after a child settles without parent continuation", async () => {
    const root = portableFixtureRoot("OpenCode child settles before root idle");
    roots.push(root);

    await expect(runCompletionScenario(
      root,
      "settled-before-first-idle",
    )).resolves.toMatchObject({
      status: "completed",
      text: "Parent resumed after the child settled",
    });
  });

  it("re-arms inactivity when a verified descendant reaches a terminal boundary", async () => {
    const root = portableFixtureRoot("OpenCode descendant terminal progress");
    roots.push(root);

    await expect(runCompletionScenario(
      root,
      "terminal-progress",
    )).resolves.toMatchObject({
      status: "completed",
      text: "Parent resumed after the child settled",
    });
  });

  it("does not let replayed root activity extend a latched inactivity window", async () => {
    const root = portableFixtureRoot("OpenCode replayed root inactivity");
    roots.push(root);

    await expect(runCompletionScenario(
      root,
      "replayed-root-does-not-refresh",
      250,
    )).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "rpc-timeout",
        terminalEvent: "event/inactivity-deadline",
      },
    });
  });
});
