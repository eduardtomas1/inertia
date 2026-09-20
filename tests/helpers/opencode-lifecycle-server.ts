export const COMPACTION_REQUEST_TIMESTAMP = 4242;

type LifecycleScenario =
  | "resume"
  | "resume-rejected-steer"
  | "resume-stuck-steer"
  | "resume-admitted-stuck-steer"
  | "early-permission-follow-up"
  | "idle-before-prompt-receipt"
  | "status-idle-before-prompt-receipt"
  | "idle-after-admission"
  | "out-of-order-parts"
  | "out-of-order-buffer-overflow"
  | "snapshot-ordering"
  | "next-events"
  | "assistant-error"
  | "unowned-session-error"
  | "external-interactions"
  | "v2-local-interaction-race"
  | "session-deleted"
  | "message-role-mutation"
  | "compact"
  | "compact-stale"
  | "compact-equal-timestamp"
  | "compact-auto"
  | "compact-wrong-message"
  | "compact-replacement-start"
  | "compact-reversed-time"
  | "compact-malformed-timestamp"
  | "compact-missing-message"
  | "cancel"
  | "stuck-cancel"
  | "oversized"
  | "utf8-oversized"
  | "event-flood"
  | "descendant-liveness"
  | "inactive-descendant"
  | "unrelated-liveness"
  | "descendant-cancel"
  | "slow"
  | "endless"
  | "no-image";
export function lifecycleServerSource(
  root: string,
  capturePath: string,
  scenario: LifecycleScenario,
  eventSubscriptionDelayMs = 0,
): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const scenario = ${JSON.stringify(scenario)};
const captured = [];
const sessionID = "opencode-lifecycle-session";
let events;
let markEventsReady;
const eventsReady = new Promise((resolve) => { markEventsReady = resolve; });
let followUpReceiptSent = false;
let followUpPromptID;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ port, captured }));
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "fixture", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fixture", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: scenario !== "no-image", video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", async () => {
    const parsed = body ? JSON.parse(body) : undefined;
    captured.push({ method: req.method, path: url.pathname, body: parsed }); save();
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, []);
    if (req.method === "POST" && url.pathname === "/session") return json(res, session);
    if (url.pathname === "/session/" + sessionID && req.method === "GET") return json(res, session);
    if (url.pathname === "/session/" + sessionID && req.method !== "GET") return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") {
      const openEvents = () => {
        events = res;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.flushHeaders();
        markEventsReady();
      };
      if (${eventSubscriptionDelayMs} > 0) return setTimeout(openEvents, ${eventSubscriptionDelayMs});
      return openEvents();
    }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/prompt_async") {
      if (scenario === "v2-local-interaction-race") {
        json(res, undefined, 204);
        setTimeout(() => {
          sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "v2-owned-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
          sendEvent({ type: "permission.v2.asked", properties: { id: "foreign-permission", sessionID, action: "edit", resources: ["foreign.ts"], source: { type: "tool", messageID: "foreign-assistant", callID: "foreign-call" } } });
          const permission = { type: "permission.v2.asked", properties: { id: "owned-permission", sessionID, action: "edit", resources: ["src/app.ts"], source: { type: "tool", messageID: "v2-owned-assistant", callID: "owned-call" } } };
          sendEvent(permission);
          sendEvent(permission);
        }, 10);
        return;
      }
      if (["idle-before-prompt-receipt", "status-idle-before-prompt-receipt"].includes(scenario)) {
        setTimeout(() => sendEvent(scenario === "idle-before-prompt-receipt"
          ? { type: "session.idle", properties: { sessionID } }
          : { type: "session.status", properties: { sessionID, status: { type: "idle" } } }), 10);
        setTimeout(() => json(res, undefined, 204), 50);
        setTimeout(() => {
          sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "fresh-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
          sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "fresh-text", sessionID, messageID: "fresh-assistant", type: "text", text: "Fresh response" } } });
          sendEvent(scenario === "idle-before-prompt-receipt"
            ? { type: "session.status", properties: { sessionID, status: { type: "idle" } } }
            : { type: "session.idle", properties: { sessionID } });
        }, 75);
        return;
      }
      if (["descendant-liveness", "inactive-descendant", "unrelated-liveness", "descendant-cancel"].includes(scenario)) {
        json(res, undefined, 204);
        // The SDK opens its SSE request lazily. Start the timeline only once
        // its writer exists, so early ancestry evidence cannot be dropped.
        await eventsReady;
        const childID = "opencode-child-session";
        const grandchildID = "opencode-grandchild-session";
        setTimeout(() => sendEvent({
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
        }), 10);
        if (scenario === "unrelated-liveness") {
          setInterval(() => sendEvent({
            type: "message.updated",
            properties: {
              sessionID: "unrelated-session",
              info: {
                id: "unrelated-assistant",
                parentID: "unrelated-prompt",
                sessionID: "unrelated-session",
                role: "assistant",
              },
            },
          }), 80);
          return;
        }
        setTimeout(() => sendEvent({
          id: "child-created",
          type: "session.created",
          properties: {
            sessionID: childID,
            info: { ...session, id: childID, parentID: sessionID },
          },
        }), 30);
        if (scenario === "inactive-descendant") {
          let inactiveEvent = 0;
          setInterval(() => {
            inactiveEvent += 1;
            sendEvent({
              id: "child-idle-" + inactiveEvent,
              type: "session.idle",
              properties: { sessionID: childID },
            });
            sendEvent({
              id: "child-metadata-" + inactiveEvent,
              type: "session.updated",
              properties: {
                info: { ...session, id: childID, parentID: sessionID },
              },
            });
            sendEvent({
              id: "child-unknown-" + inactiveEvent,
              type: "session.telemetry",
              properties: { sessionID: childID },
            });
            sendEvent({
              id: "child-malformed-work-" + inactiveEvent,
              type: "session.next.text.delta",
              properties: { sessionID: childID, timestamp: Date.now() },
            });
          }, 80);
          return;
        }
        if (scenario === "descendant-cancel") {
          setTimeout(() => sendEvent({ type: "session.idle", properties: { sessionID } }), 50);
          let childEvent = 0;
          setInterval(() => sendEvent({
            id: "child-work-" + (++childEvent),
            type: "message.updated",
            properties: {
              sessionID: childID,
              info: {
                id: "child-assistant",
                parentID: "child-prompt",
                sessionID: childID,
                role: "assistant",
                tokens: { output: childEvent },
              },
            },
          }), 80);
          return;
        }
        setTimeout(() => sendEvent({
          id: "grandchild-created",
          type: "session.created",
          properties: {
            info: { ...session, id: grandchildID, parentID: childID },
          },
        }), 80);
        for (const delay of [400, 800, 1_200, 1_600, 2_000, 2_400]) {
          setTimeout(() => sendEvent({
            id: "grandchild-work-" + delay,
            type: "message.part.updated",
            properties: {
              sessionID: grandchildID,
              part: {
                id: "private-child-text-" + delay,
                sessionID: grandchildID,
                messageID: "private-child-assistant",
                type: "text",
                text: "Private descendant output must not project",
              },
            },
          }), delay);
        }
        setTimeout(() => sendEvent({
          type: "session.idle",
          properties: { sessionID: grandchildID },
        }), 2_500);
        setTimeout(() => sendEvent({ type: "session.status", properties: { sessionID: childID, status: { type: "idle" } } }), 2_520);
        setTimeout(() => {
          sendEvent({
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "root-text",
                sessionID,
                messageID: "root-assistant",
                type: "text",
                text: "Parent resumed after descendant completion",
              },
            },
          });
          sendEvent({ type: "session.idle", properties: { sessionID } });
        }, 2_600);
        return;
      }
      if (scenario === "early-permission-follow-up") {
        json(res, undefined, 204);
        setTimeout(() => {
          sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "initial-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
          sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "initial-text", sessionID, messageID: "initial-assistant", type: "text", text: "Initial response" } } });
        }, 5);
        return;
      }
      json(res, undefined, 204);
      if (scenario === "idle-after-admission") {
        setTimeout(() => {
          sendEvent({ type: "session.next.prompt.admitted", properties: { timestamp: Date.now(), sessionID, messageID: parsed.messageID, prompt: { text: "Continue", files: [] }, delivery: "queue" } });
          sendEvent({ type: "session.idle", properties: { sessionID } });
        }, 10);
        setTimeout(() => {
          sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "admitted-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
          sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "admitted-text", sessionID, messageID: "admitted-assistant", type: "text", text: "Admitted response" } } });
          sendEvent({ type: "session.idle", properties: { sessionID } });
        }, 30);
      }
      if (scenario === "out-of-order-parts") setTimeout(() => {
        sendEvent({ type: "message.part.delta", properties: { sessionID, messageID: "ordered-assistant", partID: "ordered-text", field: "text", delta: " world" } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "ordered-text", sessionID, messageID: "ordered-assistant", type: "text", text: "Hello world" } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "ordered-tool", sessionID, messageID: "ordered-assistant", type: "tool", callID: "ordered-call", tool: "read", state: { status: "completed", input: { path: "README.md" }, output: "ok", title: "Read file" } } } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "ordered-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "ordered-tool", sessionID, messageID: "ordered-assistant", type: "tool", callID: "ordered-call", tool: "read", state: { status: "completed", input: { path: "README.md" }, output: "ok", title: "Read file" } } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "ordered-text", sessionID, messageID: "ordered-assistant", type: "text", text: "Hello world" } } });
        sendEvent({ type: "message.part.delta", properties: { sessionID, messageID: "ordered-assistant", partID: "ordered-text", field: "text", delta: "!" } });
        sendEvent({ type: "message.part.removed", properties: { sessionID, messageID: "ordered-assistant", partID: "ordered-text" } });
        sendEvent({ type: "message.part.removed", properties: { sessionID, messageID: "ordered-assistant", partID: "ordered-text" } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "ordered-text", sessionID, messageID: "ordered-assistant", type: "text", text: " Again" } } });
        sendEvent({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
      }, 10);
      if (scenario === "out-of-order-buffer-overflow") setTimeout(() => {
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "buffered-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
        sendEvent({ type: "message.part.delta", properties: { sessionID, messageID: "buffered-assistant", partID: "buffered-text", field: "text", delta: "x".repeat(256 * 1024 + 1) } });
      }, 10);
      if (scenario === "snapshot-ordering") setTimeout(() => {
        sendEvent({ type: "message.part.delta", properties: { sessionID, messageID: "snapshot-assistant", partID: "snapshot-first", field: "text", delta: " stale delta" } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "snapshot-first", sessionID, messageID: "snapshot-assistant", type: "text", text: "Authoritative snapshot" } } });
        sendEvent({ type: "message.part.delta", properties: { sessionID, messageID: "snapshot-assistant", partID: "snapshot-first", field: "metadata", delta: " must not leak" } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "snapshot-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "delta-second", sessionID, messageID: "snapshot-assistant", type: "text", text: " then snapshot" } } });
        sendEvent({ type: "message.part.delta", properties: { sessionID, messageID: "snapshot-assistant", partID: "delta-second", field: "text", delta: " plus delta" } });
        sendEvent({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
      }, 10);
      if (scenario === "next-events") setTimeout(() => {
        sendEvent({ type: "session.next.prompt.admitted", properties: { timestamp: Date.now(), sessionID, messageID: parsed.messageID, prompt: { text: "Continue", files: [] }, delivery: "queue" } });
        sendEvent({ type: "session.status", properties: { sessionID, status: { type: "busy" } } });
        sendEvent({ type: "session.next.agent.switched", properties: { timestamp: Date.now(), sessionID, messageID: parsed.messageID, agent: "plan" } });
        sendEvent({ type: "session.status", properties: { sessionID, status: { type: "busy" } } });
        sendEvent({ type: "session.next.step.started", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", agent: "review", model: { providerID: "fake", modelID: "model-a" } } });
        sendEvent({ type: "session.next.agent.switched", properties: { timestamp: Date.now(), sessionID, messageID: "next-assistant", agent: "review" } });
        sendEvent({ type: "session.next.model.switched", properties: { timestamp: Date.now(), sessionID, messageID: "next-assistant", model: { providerID: "fake", modelID: "model-a" } } });
        sendEvent({ type: "session.next.step.failed", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", error: { type: "unknown", message: "Transient upstream failure" } } });
        sendEvent({ type: "session.next.retried", properties: { timestamp: Date.now(), sessionID, attempt: 2, error: { message: "Transient upstream failure", statusCode: 503, isRetryable: true } } });
        sendEvent({ type: "session.status", properties: { sessionID, status: { type: "retry", attempt: 2, message: "Waiting before retry", next: Date.now() + 1000 } } });
        sendEvent({ type: "session.next.step.started", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", agent: "review", model: { providerID: "fake", modelID: "model-a" } } });
        sendEvent({ type: "session.next.text.started", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", textID: "next-text" } });
        sendEvent({ type: "session.next.text.delta", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", textID: "next-text", delta: "Next response" } });
        sendEvent({ type: "session.next.text.ended", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", textID: "next-text", text: "Next response" } });
        sendEvent({ type: "session.next.reasoning.delta", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", reasoningID: "next-reasoning", delta: "Checked" } });
        sendEvent({ type: "session.next.reasoning.ended", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", reasoningID: "next-reasoning", text: "Checked" } });
        sendEvent({ type: "session.next.shell.started", properties: { timestamp: Date.now(), sessionID, messageID: "next-assistant", callID: "shell-call", command: "npm test" } });
        sendEvent({ type: "session.next.shell.ended", properties: { timestamp: Date.now(), sessionID, callID: "shell-call", output: "ok" } });
        sendEvent({ type: "session.next.tool.called", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", callID: "tool-call", tool: "read", input: { path: "README.md" }, provider: { executed: true } } });
        sendEvent({ type: "session.next.tool.progress", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", callID: "tool-call", structured: {}, content: [{ type: "text", text: "Reading README.md" }] } });
        sendEvent({ type: "session.next.tool.success", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", callID: "tool-call", structured: {}, content: [], result: "done", provider: { executed: true } } });
        sendEvent({ type: "session.next.step.ended", properties: { timestamp: Date.now(), sessionID, assistantMessageID: "next-assistant", finish: "stop", cost: 0, tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } } });
        sendEvent({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
      }, 10);
      if (scenario === "assistant-error") setTimeout(() => {
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "failed-assistant", parentID: parsed.messageID, sessionID, role: "assistant", error: { name: "ProviderAuthError", data: { providerID: "fake", message: "The selected OpenCode provider needs authentication." } } } } });
        sendEvent({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
      }, 10);
      if (scenario === "unowned-session-error") setTimeout(() => {
        sendEvent({ type: "session.error", properties: { error: { name: "APIError", data: { message: "OpenCode upstream request failed.", statusCode: 503, isRetryable: false } } } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "foreign-assistant", parentID: "foreign-prompt", sessionID, role: "assistant", error: { name: "APIError", data: { message: "Foreign assistant failed." } } } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "foreign-text", sessionID, messageID: "foreign-assistant", type: "text", text: "Must not leak" } } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "owned-assistant", parentID: parsed.messageID, sessionID, role: "assistant" } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "owned-text", sessionID, messageID: "owned-assistant", type: "text", text: "Owned response" } } });
        sendEvent({ type: "session.idle", properties: { sessionID } });
      }, 10);
      if (scenario === "external-interactions") setTimeout(() => {
        sendEvent({ type: "permission.v2.asked", properties: { id: "external-permission", sessionID, action: "edit", resources: ["src/app.ts"], metadata: {} } });
        sendEvent({ type: "permission.v2.replied", properties: { sessionID, requestID: "external-permission", reply: "reject" } });
        sendEvent({ type: "question.v2.asked", properties: { id: "external-question", sessionID, questions: [{ header: "Scope", question: "Continue?", options: [{ label: "Yes", description: "Continue" }], custom: false }] } });
        sendEvent({ type: "question.v2.rejected", properties: { sessionID, requestID: "external-question" } });
        sendEvent({ type: "session.idle", properties: { sessionID } });
      }, 10);
      if (scenario === "session-deleted") setTimeout(() => {
        sendEvent({ type: "session.deleted", properties: { info: session } });
      }, 10);
      if (scenario === "message-role-mutation") setTimeout(() => {
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "mutating-text", sessionID, messageID: "mutating-message", type: "text", text: "Must not leak" } } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "mutating-message", sessionID, role: "user" } } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "mutating-message", parentID: parsed.messageID, sessionID, role: "assistant" } } });
      }, 10);
      if (["resume", "resume-rejected-steer", "resume-stuck-steer", "resume-admitted-stuck-steer"].includes(scenario)) setTimeout(() => {
        sendEvent({ type: "session.idle", properties: { sessionID: "stale-session" } });
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "assistant", parentID: parsed.messageID, sessionID, role: "assistant", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "text", sessionID, messageID: "assistant", type: "text", text: "Resumed OpenCode response" } } });
        sendEvent({ type: "session.idle", properties: { sessionID } });
      }, 10);
      if (scenario === "oversized") setTimeout(() => sendEvent({ type: "message.updated", properties: { sessionID, payload: "x".repeat(1024 * 1024 + 1) } }), 10);
      if (scenario === "utf8-oversized") setTimeout(() => sendEvent({ type: "message.updated", properties: { sessionID, payload: "é".repeat(600 * 1024) } }), 10);
      if (scenario === "event-flood") setTimeout(() => {
        for (let index = 0; index < 2050; index += 1) {
          sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "assistant-" + index, parentID: parsed.messageID, sessionID, role: "assistant" } } });
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
    if (
      scenario === "v2-local-interaction-race"
      && req.method === "POST"
      && url.pathname === "/api/session/" + sessionID + "/permission/owned-permission/reply"
    ) {
      sendEvent({ type: "permission.v2.replied", properties: { sessionID, requestID: "owned-permission", reply: "once" } });
      sendEvent({ type: "question.v2.asked", properties: { id: "foreign-question", sessionID, questions: [{ header: "Foreign", question: "Ignore?", options: [{ label: "Yes", description: "Ignore" }] }], tool: { messageID: "foreign-assistant", callID: "foreign-question-call" } } });
      const question = { type: "question.v2.asked", properties: { id: "owned-question", sessionID, questions: [{ header: "Scope", question: "Which scope?", options: [{ label: "Focused", description: "Only this package" }] }], tool: { messageID: "v2-owned-assistant", callID: "owned-question-call" } } };
      sendEvent(question);
      sendEvent(question);
      return json(res, { error: "already answered through SSE" }, 404);
    }
    if (
      scenario === "v2-local-interaction-race"
      && req.method === "POST"
      && url.pathname === "/api/session/" + sessionID + "/question/owned-question/reply"
    ) {
      sendEvent({ type: "question.v2.replied", properties: { sessionID, requestID: "owned-question", answers: [["Focused"]] } });
      sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "v2-text", sessionID, messageID: "v2-owned-assistant", type: "text", text: "V2 interaction response" } } });
      sendEvent({ type: "session.idle", properties: { sessionID } });
      return json(res, { error: "already answered through SSE" }, 404);
    }
    if (req.method === "POST" && url.pathname === "/api/session/" + sessionID + "/prompt") {
      if (scenario === "resume-stuck-steer") return;
      if (scenario === "early-permission-follow-up") {
        followUpPromptID = parsed.id;
        sendEvent({ type: "permission.asked", properties: { id: "steer-early", sessionID, permission: "bash", patterns: ["npm test"], metadata: {} } });
        return setTimeout(() => {
          followUpReceiptSent = true;
          json(res, { data: {
            admittedSeq: 2,
            id: parsed.id,
            sessionID,
            prompt: parsed.prompt,
            delivery: parsed.delivery,
            timeCreated: Date.now(),
          } });
        }, 50);
      }
      setTimeout(() => json(res, { data: {
        admittedSeq: 2,
        id: parsed.id,
        sessionID,
        prompt: parsed.prompt,
        delivery: scenario === "resume-rejected-steer" ? "queue" : parsed.delivery,
        timeCreated: Date.now(),
      } }), 50);
      if (scenario === "resume") setTimeout(() => {
        sendEvent({ type: "session.idle", properties: { sessionID } });
      }, 60);
      if (scenario === "resume") setTimeout(() => {
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "follow-up-assistant", parentID: parsed.id, sessionID, role: "assistant", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } } });
        sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "follow-up-text", sessionID, messageID: "follow-up-assistant", type: "text", text: "Follow-up OpenCode response" } } });
        sendEvent({ type: "session.idle", properties: { sessionID } });
      }, 75);
      return;
    }
    if (req.method === "POST" && url.pathname === "/permission/steer-early/reply") {
      if (!followUpReceiptSent) return json(res, { error: "permission preceded steer receipt" }, 409);
      json(res, true);
      sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "follow-up-assistant", parentID: followUpPromptID, sessionID, role: "assistant" } } });
      sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "follow-up-text", sessionID, messageID: "follow-up-assistant", type: "text", text: "Follow-up response" } } });
      return sendEvent({ type: "session.idle", properties: { sessionID } });
    }
    if (req.method === "POST" && url.pathname === "/api/session/" + sessionID + "/compact") {
      const timestamp = ${COMPACTION_REQUEST_TIMESTAMP};
      json(res, undefined, 204);
      if (scenario === "compact") setTimeout(() => {
        sendEvent({ id: "compact-1", type: "session.next.compaction.started", properties: { timestamp: Date.now(), sessionID, messageID: "summary-1", reason: "manual" } });
        sendEvent({ id: "compact-2", type: "session.next.compaction.ended", properties: { timestamp: Date.now(), sessionID, messageID: "summary-1", reason: "manual", text: "Summary", recent: "" } });
      }, 10);
      if (scenario === "compact-stale") setTimeout(() => {
        sendEvent({ id: "compact-stale-1", type: "session.next.compaction.started", properties: { timestamp: timestamp - 1, sessionID, messageID: "stale-summary", reason: "manual" } });
        sendEvent({ id: "compact-stale-2", type: "session.next.compaction.ended", properties: { timestamp: timestamp - 1, sessionID, messageID: "stale-summary", reason: "manual", text: "Stale", recent: "" } });
      }, 10);
      if (scenario === "compact-equal-timestamp") setTimeout(() => {
        sendEvent({ id: "compact-equal-1", type: "session.next.compaction.started", properties: { timestamp, sessionID, messageID: "equal-summary", reason: "manual" } });
        sendEvent({ id: "compact-equal-2", type: "session.next.compaction.ended", properties: { timestamp, sessionID, messageID: "equal-summary", reason: "manual", text: "Equal", recent: "" } });
      }, 10);
      if (scenario === "compact-auto") setTimeout(() => {
        sendEvent({ id: "compact-auto-1", type: "session.next.compaction.started", properties: { timestamp, sessionID, messageID: "auto-summary", reason: "auto" } });
        sendEvent({ id: "compact-auto-2", type: "session.next.compaction.ended", properties: { timestamp, sessionID, messageID: "auto-summary", reason: "auto", text: "Automatic", recent: "" } });
      }, 10);
      if (scenario === "compact-wrong-message") setTimeout(() => {
        sendEvent({ id: "compact-wrong-1", type: "session.next.compaction.started", properties: { timestamp, sessionID, messageID: "requested-summary", reason: "manual" } });
        sendEvent({ id: "compact-wrong-2", type: "session.next.compaction.ended", properties: { timestamp, sessionID, messageID: "different-summary", reason: "manual", text: "Wrong", recent: "" } });
      }, 10);
      if (scenario === "compact-replacement-start") setTimeout(() => {
        sendEvent({ id: "compact-replacement-1", type: "session.next.compaction.started", properties: { timestamp, sessionID, messageID: "requested-summary", reason: "manual" } });
        sendEvent({ id: "compact-replacement-2", type: "session.next.compaction.started", properties: { timestamp: timestamp + 1, sessionID, messageID: "replacement-summary", reason: "manual" } });
        sendEvent({ id: "compact-replacement-3", type: "session.next.compaction.ended", properties: { timestamp: timestamp + 2, sessionID, messageID: "replacement-summary", reason: "manual", text: "Replacement", recent: "" } });
      }, 10);
      if (scenario === "compact-reversed-time") setTimeout(() => {
        sendEvent({ id: "compact-reversed-1", type: "session.next.compaction.started", properties: { timestamp: timestamp + 2, sessionID, messageID: "reversed-summary", reason: "manual" } });
        sendEvent({ id: "compact-reversed-2", type: "session.next.compaction.ended", properties: { timestamp: timestamp + 1, sessionID, messageID: "reversed-summary", reason: "manual", text: "Reversed", recent: "" } });
      }, 10);
      if (scenario === "compact-malformed-timestamp") setTimeout(() => {
        sendEvent({ id: "compact-malformed-1", type: "session.next.compaction.started", properties: { timestamp: "later", sessionID, messageID: "malformed-summary", reason: "manual" } });
        sendEvent({ id: "compact-malformed-2", type: "session.next.compaction.ended", properties: { timestamp: "later", sessionID, messageID: "malformed-summary", reason: "manual", text: "Malformed", recent: "" } });
      }, 10);
      if (scenario === "compact-missing-message") setTimeout(() => {
        sendEvent({ id: "compact-missing-1", type: "session.next.compaction.started", properties: { timestamp, sessionID, reason: "manual" } });
        sendEvent({ id: "compact-missing-2", type: "session.next.compaction.ended", properties: { timestamp, sessionID, reason: "manual", text: "Missing", recent: "" } });
      }, 10);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/" + sessionID + "/interrupt") {
      return json(res, undefined, 204);
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

