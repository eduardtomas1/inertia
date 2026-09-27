import { fixtureCaptureWriterSource } from "./portable-provider-fixture";

export interface StalledReplyScenario {
  interaction: "permission" | "question";
  protocol: "legacy" | "v2";
  externalResolutionMs?: number;
}

export function stalledReplyServerSource(
  root: string,
  capturePath: string,
  scenario: StalledReplyScenario,
): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const scenario = ${JSON.stringify(scenario)};
const captured = [];
const sessionID = "opencode-stalled-reply-session";
const interactionID = "stalled-" + scenario.interaction;
let events;
const save = () => ${fixtureCaptureWriterSource(capturePath)}({ port, captured });
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "fixture", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fixture", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const v2 = scenario.protocol === "v2";
const questions = [{ header: "Scope", question: "Which scope?", options: [{ label: "Focused", description: "Only this package" }], custom: false }];
const askedEvent = scenario.interaction === "permission"
  ? (v2
      ? { type: "permission.v2.asked", properties: { id: interactionID, sessionID, action: "edit", resources: ["src/app.ts"], metadata: {} } }
      : { type: "permission.asked", properties: { id: interactionID, sessionID, permission: "bash", patterns: ["npm test"], metadata: {} } })
  : { type: v2 ? "question.v2.asked" : "question.asked", properties: { id: interactionID, sessionID, questions } };
const resolvedEvent = scenario.interaction === "permission"
  ? { type: v2 ? "permission.v2.replied" : "permission.replied", properties: { sessionID, requestID: interactionID, reply: "once" } }
  : { type: v2 ? "question.v2.replied" : "question.replied", properties: { sessionID, requestID: interactionID, answers: [["Focused"]] } };
const replyPrefix = (v2 ? "/api/session/" + sessionID : "") + "/" + scenario.interaction + "/" + interactionID + "/";
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
    if (req.method === "PATCH" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); return res.flushHeaders(); }
    if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
      sendEvent(askedEvent);
      return setTimeout(() => json(res, undefined, 204), 20);
    }
    if (req.method === "POST" && url.pathname.startsWith(replyPrefix)) {
      if (scenario.externalResolutionMs !== undefined) {
        setTimeout(() => {
          sendEvent(resolvedEvent);
          sendEvent({ type: "session.idle", properties: { sessionID } });
        }, scenario.externalResolutionMs);
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/" + sessionID + "/interrupt") return json(res, undefined, 204);
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
