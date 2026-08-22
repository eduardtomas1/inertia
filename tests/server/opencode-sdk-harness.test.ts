import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  createOpenCodeSdkHarness,
  exactOpenCodeSteerReceipt,
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
        for (const delay of [180, 330, 480, 630, 780]) {
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
        }), 820);
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
        }, 900);
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
      json(res, undefined, 204);
      if (scenario === "compact") setTimeout(() => {
        sendEvent({ id: "compact-1", type: "session.next.compaction.started", properties: { timestamp: Date.now(), sessionID, messageID: "summary-1", reason: "manual" } });
        sendEvent({ id: "compact-2", type: "session.next.compaction.ended", properties: { timestamp: Date.now(), sessionID, messageID: "summary-1", reason: "manual", text: "Summary", recent: "" } });
      }, 10);
      if (scenario === "compact-stale") setTimeout(() => {
        sendEvent({ id: "compact-stale-1", type: "session.next.compaction.started", properties: { timestamp: Date.now() - 60000, sessionID, messageID: "stale-summary", reason: "manual" } });
        sendEvent({ id: "compact-stale-2", type: "session.next.compaction.ended", properties: { timestamp: Date.now() - 60000, sessionID, messageID: "stale-summary", reason: "manual", text: "Stale", recent: "" } });
      }, 10);
      if (scenario === "compact-equal-timestamp") setTimeout(() => {
        sendEvent({ id: "compact-equal-1", type: "session.next.compaction.started", properties: { timestamp: 4242, sessionID, messageID: "equal-summary", reason: "manual" } });
        sendEvent({ id: "compact-equal-2", type: "session.next.compaction.ended", properties: { timestamp: 4242, sessionID, messageID: "equal-summary", reason: "manual", text: "Equal", recent: "" } });
      }, 10);
      if (scenario === "compact-auto") setTimeout(() => {
        sendEvent({ id: "compact-auto-1", type: "session.next.compaction.started", properties: { timestamp: Date.now(), sessionID, messageID: "auto-summary", reason: "auto" } });
        sendEvent({ id: "compact-auto-2", type: "session.next.compaction.ended", properties: { timestamp: Date.now(), sessionID, messageID: "auto-summary", reason: "auto", text: "Automatic", recent: "" } });
      }, 10);
      if (scenario === "compact-wrong-message") setTimeout(() => {
        sendEvent({ id: "compact-wrong-1", type: "session.next.compaction.started", properties: { timestamp: Date.now(), sessionID, messageID: "requested-summary", reason: "manual" } });
        sendEvent({ id: "compact-wrong-2", type: "session.next.compaction.ended", properties: { timestamp: Date.now(), sessionID, messageID: "different-summary", reason: "manual", text: "Wrong", recent: "" } });
      }, 10);
      if (scenario === "compact-replacement-start") setTimeout(() => {
        sendEvent({ id: "compact-replacement-1", type: "session.next.compaction.started", properties: { timestamp: Date.now(), sessionID, messageID: "requested-summary", reason: "manual" } });
        sendEvent({ id: "compact-replacement-2", type: "session.next.compaction.started", properties: { timestamp: Date.now() + 1, sessionID, messageID: "replacement-summary", reason: "manual" } });
        sendEvent({ id: "compact-replacement-3", type: "session.next.compaction.ended", properties: { timestamp: Date.now() + 2, sessionID, messageID: "replacement-summary", reason: "manual", text: "Replacement", recent: "" } });
      }, 10);
      if (scenario === "compact-reversed-time") setTimeout(() => {
        const timestamp = Date.now();
        sendEvent({ id: "compact-reversed-1", type: "session.next.compaction.started", properties: { timestamp: timestamp + 2, sessionID, messageID: "reversed-summary", reason: "manual" } });
        sendEvent({ id: "compact-reversed-2", type: "session.next.compaction.ended", properties: { timestamp: timestamp + 1, sessionID, messageID: "reversed-summary", reason: "manual", text: "Reversed", recent: "" } });
      }, 10);
      if (scenario === "compact-malformed-timestamp") setTimeout(() => {
        sendEvent({ id: "compact-malformed-1", type: "session.next.compaction.started", properties: { timestamp: "later", sessionID, messageID: "malformed-summary", reason: "manual" } });
        sendEvent({ id: "compact-malformed-2", type: "session.next.compaction.ended", properties: { timestamp: "later", sessionID, messageID: "malformed-summary", reason: "manual", text: "Malformed", recent: "" } });
      }, 10);
      if (scenario === "compact-missing-message") setTimeout(() => {
        sendEvent({ id: "compact-missing-1", type: "session.next.compaction.started", properties: { timestamp: Date.now(), sessionID, reason: "manual" } });
        sendEvent({ id: "compact-missing-2", type: "session.next.compaction.ended", properties: { timestamp: Date.now(), sessionID, reason: "manual", text: "Missing", recent: "" } });
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
      sendEvent({ type: "permission.asked", properties: { id: "deny-only", sessionID, permission: "bash", patterns: ["npm test"], metadata: {} } });
      return setTimeout(() => json(res, undefined, 204), 50);
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

  it("requires an exact v2 steer admission receipt", () => {
    const receipt = {
      data: {
        id: "follow-up-id",
        sessionID: "session-id",
        delivery: "steer",
        prompt: {
          text: "Inspect",
          files: [{ uri: "file:///safe/reference.png" }],
        },
      },
    };
    expect(exactOpenCodeSteerReceipt(
      receipt,
      "follow-up-id",
      "session-id",
      "Inspect",
      ["file:///safe/reference.png"],
    )).toBe(true);
    expect(exactOpenCodeSteerReceipt(
      { data: { ...receipt.data, delivery: "queue" } },
      "follow-up-id",
      "session-id",
      "Inspect",
      ["file:///safe/reference.png"],
    )).toBe(false);
  });

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
let promptMessageID;
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
      promptMessageID = parsed.messageID;
      json(res, undefined, 204);
      sendEvent({ id: "e1", type: "message.updated", properties: { sessionID, info: { id: "assistant-1", parentID: parsed.messageID, sessionID, role: "assistant", tokens: { input: 120, output: 30, reasoning: 5, cache: { read: 10, write: 0 } } } } });
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
      sendEvent({ id: "e8", type: "message.updated", properties: { sessionID, info: { id: "assistant-1", parentID: promptMessageID, sessionID, role: "assistant", tokens: { total: 160, input: 125, output: 30, reasoning: 5, cache: { read: 10, write: 0 } } } } });
      sendEvent({ id: "e9", type: "message.updated", properties: { sessionID, info: { id: "assistant-2", parentID: promptMessageID, sessionID, role: "assistant", tokens: { total: 40, input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } } });
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

    const result = await manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-stalled-initialization",
      cwd: root,
      prompt: "Do not prompt",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(result).toMatchObject({
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
    const imagePath = join(root, "follow-up.png");
    writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "resume"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    let followUp: Promise<boolean> | null = null;
    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-resume",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUp) return;
        followUp = manager.steer(event.conversationId, {
          content: "Inspect the attached reference too.",
          imagePaths: [imagePath],
        }, { runId: event.runId, turnId: event.turnId! });
      },
    })).resolves.toMatchObject({
      status: "completed",
      sessionId: "opencode-lifecycle-session",
      text: "Resumed OpenCode responseFollow-up OpenCode response",
    });
    await expect(followUp).resolves.toBe(true);
    const { captured } = JSON.parse(readFileSync(capturePath, "utf8")) as { captured: Array<{ method: string; path: string; body?: Record<string, unknown> }> };
    expect(captured.some(({ method, path }) => method === "POST" && path === "/session")).toBe(false);
    expect(captured.some(({ method, path }) => method === "GET" && path === "/session/opencode-lifecycle-session")).toBe(true);
    expect(captured.some(({ method, path }) => method !== "GET" && path === "/session/opencode-lifecycle-session")).toBe(true);
    expect(captured.find(({ path }) =>
      path === "/api/session/opencode-lifecycle-session/prompt")?.body)
      .toMatchObject({
        delivery: "steer",
        prompt: {
          text: "Inspect the attached reference too.",
          files: [{ uri: expect.stringMatching(/^file:/u), name: "follow-up.png" }],
        },
      });
  });

  it("waits for an exact follow-up receipt before replaying its early permission", async () => {
    const root = portableFixtureRoot("OpenCode early follow-up permission");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "early-permission-follow-up"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let followUp: Promise<boolean> | null = null;
    let approvals = 0;

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-early-follow-up-permission",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUp) return;
        followUp = manager.steer(event.conversationId, {
          content: "Run the focused check.",
          imagePaths: [],
        }, { runId: event.runId, turnId: event.turnId! });
      },
      onApproval: (event) => {
        approvals += 1;
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "deny",
        )).toBe(true);
      },
    })).resolves.toMatchObject({
      status: "completed",
      text: "Initial responseFollow-up response",
    });
    await expect(followUp).resolves.toBe(true);
    expect(approvals).toBe(1);
    const capture = readStableCapture<{
      captured: Array<{ path: string; body?: Record<string, unknown> }>;
    }>(capturePath);
    expect(capture.captured.find(({ path }) =>
      path === "/permission/steer-early/reply")?.body)
      .toEqual({ reply: "reject" });
  });

  it.each([
    ["idle-before-prompt-receipt", "legacy session.idle"],
    ["status-idle-before-prompt-receipt", "session.status idle"],
  ] as const)("ignores a stale %s until the current prompt is observed (%s)", async (scenario, _label) => {
    const root = portableFixtureRoot(`OpenCode early idle ${scenario}`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, scenario),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const statuses: string[] = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-early-idle",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    })).resolves.toMatchObject({
      status: "completed",
      sessionId: "opencode-lifecycle-session",
      text: "Fresh response",
    });
    expect(statuses).toContain("running");
    const capture = readStableCapture<{
      captured: Array<{ path: string; body?: Record<string, unknown> }>;
    }>(capturePath);
    expect(capture.captured.find(({ path }) => path.endsWith("/prompt_async"))?.body)
      .toMatchObject({ messageID: expect.stringMatching(/^msg_[a-f0-9]{32}$/u) });
  });

  it("does not treat admission alone as proof that a queued prompt has run", async () => {
    const root = portableFixtureRoot("OpenCode idle after admission");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "idle-after-admission"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-idle-after-admission",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "completed",
      text: "Admitted response",
    });
  });

  it("buffers and de-duplicates out-of-order assistant part events", async () => {
    const root = portableFixtureRoot("OpenCode out of order parts");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "out-of-order-parts"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const events: Array<Record<string, unknown>> = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-out-of-order",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    })).resolves.toMatchObject({
      status: "completed",
      text: " Again",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "text-snapshot",
      itemId: "ordered-text",
      text: "",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      activityId: "ordered-call",
      phase: "completed",
    }));
  });

  it("fails closed when buffered out-of-order deltas exceed the per-part bound", async () => {
    const root = portableFixtureRoot("OpenCode buffered delta overflow");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "out-of-order-buffer-overflow"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({ eventInactivityDeadlineMs: 1_000 })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-buffer-overflow",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "OpenCode sent an oversized buffered message-part delta.",
    });
  });

  it("uses authoritative part snapshots and only streams text-field deltas", async () => {
    const root = portableFixtureRoot("OpenCode snapshot ordering");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "snapshot-ordering"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-snapshot-ordering",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "completed",
      text: "Authoritative snapshot then snapshot plus delta",
    });
  });

  it("normalizes installed session.next text, reasoning, tool, shell, usage, and status events", async () => {
    const root = portableFixtureRoot("OpenCode next events");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "next-events"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const events: Array<Record<string, unknown>> = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-next-events",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    })).resolves.toMatchObject({ status: "completed", text: "Next response" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "reasoning-summary",
      text: "Checked",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      status: "retrying",
      providerState: "session.status/retry attempt 2",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      kind: "command",
      phase: "completed",
      activityId: "shell-call",
      label: "npm test",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      kind: "system",
      phase: "info",
      label: "OpenCode switched to the review agent",
      activityId: "next-assistant",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      kind: "turn",
      phase: "started",
      label: "OpenCode started a review step",
      activityId: "next-assistant",
      detail: "Model: fake/model-a",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      kind: "system",
      phase: "info",
      label: "OpenCode retried the model (attempt 2)",
      detail: "Transient upstream failure",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      kind: "tool",
      phase: "started",
      activityId: "tool-call",
      label: "read",
      detail: "Output:\nReading README.md",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      kind: "tool",
      phase: "completed",
      activityId: "tool-call",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "usage",
      usage: expect.objectContaining({
        inputTokens: 4,
        cachedInputTokens: 3,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      }),
    }));
  });

  it("turns an authoritative assistant error into a typed terminal failure", async () => {
    const root = portableFixtureRoot("OpenCode assistant failure");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "assistant-error"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-assistant-error",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "The selected OpenCode provider needs authentication.",
      failure: {
        reason: "provider-error",
        message: "The selected OpenCode provider needs authentication.",
        phase: "turn",
        terminalEvent: "message.updated",
        activityId: "failed-assistant",
        technicalDetail: "Type: ProviderAuthError\nProvider: fake",
      },
    });
  });

  it("ignores unscoped and foreign failures until owned work completes", async () => {
    const root = portableFixtureRoot("OpenCode unowned session failure");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "unowned-session-error"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-unowned-session-error",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "completed",
      text: "Owned response",
    });
  });

  it("settles externally answered v2 approvals and questions", async () => {
    const root = portableFixtureRoot("OpenCode external interactions");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "external-interactions"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const events: Array<Record<string, unknown>> = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-external-interactions",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    })).resolves.toMatchObject({ status: "completed" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "approval-resolved",
      decision: "deny",
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "input-resolved" }));
  });

  it("routes owned v2 interactions once and tolerates an external reply winning the HTTP race", async () => {
    const root = portableFixtureRoot("OpenCode v2 interaction race");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "v2-local-interaction-race"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let approvals = 0;
    let questions = 0;

    const runResult = await manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-v2-local-interaction-race",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onApproval: (event) => {
        approvals += 1;
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
        )).toBe(true);
      },
      onInput: (event) => {
        questions += 1;
        expect(manager.respondToInput(
          event.conversationId,
          event.request.requestId,
          { [event.request.questions[0]!.id]: ["Focused"] },
        )).toBe(true);
      },
    });
    expect(runResult.error).toBeUndefined();
    expect(runResult).toMatchObject({
      status: "completed",
      text: "V2 interaction response",
    });
    expect(approvals).toBe(1);
    expect(questions).toBe(1);
    const capture = readStableCapture<{
      captured: Array<{ path: string; body?: unknown }>;
    }>(capturePath);
    expect(capture.captured).toContainEqual(expect.objectContaining({
      path: "/api/session/opencode-lifecycle-session/permission/owned-permission/reply",
      body: { reply: "once" },
    }));
    expect(capture.captured).toContainEqual(expect.objectContaining({
      path: "/api/session/opencode-lifecycle-session/question/owned-question/reply",
      body: { answers: [["Focused"]] },
    }));
    expect(capture.captured.some(({ path }) =>
      path.includes("foreign-permission") || path.includes("foreign-question")))
      .toBe(false);
  });

  it("fails promptly when OpenCode deletes the active session", async () => {
    const root = portableFixtureRoot("OpenCode deleted session");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "session-deleted"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-deleted-session",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "OpenCode deleted the active session before the run completed.",
    });
  });

  it("fails closed instead of replaying parts when a message role mutates", async () => {
    const root = portableFixtureRoot("OpenCode message role mutation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, "message-role-mutation"));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-message-role-mutation",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "failed",
      text: "",
      error: "OpenCode changed a retained message's role identity.",
    });
  });

  it("finishes after an in-flight steer receipt is rejected at idle", async () => {
    const root = portableFixtureRoot("OpenCode rejected steer");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "resume-rejected-steer"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let followUp: Promise<boolean> | null = null;

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-rejected-steer",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUp) return;
        followUp = manager.steer(event.conversationId, {
          content: "Do not admit this follow-up.",
          imagePaths: [],
        }, { runId: event.runId, turnId: event.turnId! });
      },
    })).resolves.toMatchObject({ status: "completed" });
    await expect(followUp).resolves.toBe(false);
  });

  it("cancels within the force deadline while a steer receipt is pending", async () => {
    const root = portableFixtureRoot("OpenCode pending steer cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "resume-stuck-steer"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let followUp: Promise<boolean> | null = null;
    let cancel!: () => void;
    const cancelRequested = new Promise<void>((resolve) => { cancel = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-pending-steer-cancel",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUp) return;
        followUp = manager.steer(event.conversationId, {
          content: "Hold this follow-up.",
          imagePaths: [],
        }, { runId: event.runId, turnId: event.turnId! });
        expect(manager.cancel(event.conversationId)).toBe(true);
        cancel();
      },
    });

    await cancelRequested;
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    await expect(followUp).resolves.toBe(false);
    const capture = readStableCapture<{
      captured: Array<{ path: string }>;
    }>(capturePath);
    expect(capture.captured.some(({ path }) =>
      path === "/api/session/opencode-lifecycle-session/interrupt"))
      .toBe(true);
  }, 10_000);

  it("interrupts admitted v2 follow-up work when cancellation follows its receipt", async () => {
    const root = portableFixtureRoot("OpenCode admitted steer cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "resume-admitted-stuck-steer"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let followUp: Promise<boolean> | null = null;
    let running!: () => void;
    const runningReady = new Promise<void>((resolve) => { running = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-admitted-steer-cancel",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUp) return;
        followUp = manager.steer(event.conversationId, {
          content: "Admit this follow-up and keep it running.",
          imagePaths: [],
        }, { runId: event.runId, turnId: event.turnId! });
        running();
      },
    });

    await runningReady;
    await expect(followUp).resolves.toBe(true);
    expect(manager.cancel("opencode-admitted-steer-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const capture = readStableCapture<{
      captured: Array<{ path: string }>;
    }>(capturePath);
    expect(capture.captured.some(({ path }) =>
      path === "/api/session/opencode-lifecycle-session/interrupt"))
      .toBe(true);
  }, 10_000);

  it("uses the native v2 compaction endpoint and waits for its completion event", async () => {
    const root = portableFixtureRoot("OpenCode compact");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "compact"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), "remember retrieval exactly")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: false,
      message: expect.stringContaining("was not forwarded"),
    });
    const capture = readStableCapture<{
      captured: Array<{ method: string; path: string }>;
    }>(capturePath);
    expect(capture.captured.some(({ method, path }) =>
      method === "POST"
      && path === "/api/session/opencode-lifecycle-session/compact"
    )).toBe(true);
    expect(capture.captured.some(({ path }) => path.endsWith("/prompt_async")))
      .toBe(false);
  });

  it("interrupts an in-flight native v2 compaction through the matching v2 endpoint", async () => {
    const root = portableFixtureRoot("OpenCode compact cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "compact-stale"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let cancelled = false;
    const result = manager.compact(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-compact-cancel",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), undefined, {
      onStatus: (event) => {
        if (event.status !== "running" || cancelled) return;
        cancelled = true;
        expect(manager.cancel(event.conversationId)).toBe(true);
      },
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const capture = readStableCapture<{
      captured: Array<{ path: string }>;
    }>(capturePath);
    expect(capture.captured.some(({ path }) =>
      path === "/api/session/opencode-lifecycle-session/interrupt"))
      .toBe(true);
  });

  it.each([
    ["compact-stale", "stale pre-request"],
    ["compact-auto", "automatic"],
    ["compact-wrong-message", "wrong-message"],
    ["compact-replacement-start", "replacement-start"],
    ["compact-reversed-time", "reversed-time"],
    ["compact-malformed-timestamp", "malformed timestamp"],
    ["compact-missing-message", "missing message ID"],
  ] as const)("does not accept %s events as manual compaction proof (%s)", async (
    scenario,
    _label,
  ) => {
    const root = portableFixtureRoot(`OpenCode ${scenario}`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, scenario),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        eventInactivityDeadlineMs: 100,
      })]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: `opencode-${scenario}`,
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("event stream became inactive"),
    });
  });

  it("accepts a manual compaction lifecycle from the request millisecond", async () => {
    const root = portableFixtureRoot("OpenCode compact equal timestamp");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "compact-equal-timestamp"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        eventInactivityDeadlineMs: 100,
        compactionTimestampNow: () => 4242,
      })]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-compact-equal-timestamp",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }))).resolves.toMatchObject({ status: "completed" });
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

    const result = await manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-unconfirmed-cleanup",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "opencode-lifecycle-session",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "OpenCode server process tree could not be confirmed stopped.",
      cleanupConfirmed: false,
      failure: {
        reason: "provider-error",
        message: "OpenCode server process tree could not be confirmed stopped.",
        phase: "cleanup",
        terminalEvent: "process-tree/cleanup",
      },
    });
    expect(result.failure?.message).toBe(result.error);
    expect(statuses).not.toContain("completed");
    expect(statuses.at(-1)).toBe("failed");
  });

  it("replays an early permission after prompt receipt, then cancels the owned session", async () => {
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

  it("uses verified transitive descendant activity for liveness without projecting it", async () => {
    const root = portableFixtureRoot("OpenCode descendant liveness");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "descendant-liveness"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 300,
      })]),
    );

    const statuses: Array<{ status: string; providerState?: string }> = [];
    const result = await manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-descendant-liveness",
      cwd: root,
      prompt: "Delegate and resume",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: (event) => statuses.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "Parent resumed after descendant completion",
    });
    expect(result.text).not.toContain("Private descendant output");
    expect(statuses).toContainEqual(expect.objectContaining({
      status: "running",
      providerState: "verified descendant session activity",
    }));
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("does not let inactive descendant events refresh owned-run liveness", async () => {
    const root = portableFixtureRoot("OpenCode inactive descendant");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "inactive-descendant"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 300,
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-inactive-descendant",
      cwd: root,
      prompt: "Ignore inactive child events",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "rpc-timeout",
        terminalEvent: "event/inactivity-deadline",
      },
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("does not let unrelated directory sessions refresh owned-run liveness", async () => {
    const root = portableFixtureRoot("OpenCode unrelated liveness");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "unrelated-liveness"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 300,
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-unrelated-liveness",
      cwd: root,
      prompt: "Ignore foreign sessions",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "rpc-timeout",
        terminalEvent: "event/inactivity-deadline",
      },
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("cancels and closes the owned process tree while a descendant stays active", async () => {
    const root = portableFixtureRoot("OpenCode descendant cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "descendant-cancel"),
    );
    const terminateOwnedProcessTree = vi.fn(
      async (child, force) => await terminateProcessTreeAndWait(child, force),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        runDeadlineMs: 5_000,
        eventInactivityDeadlineMs: 300,
        terminateProcessTree: terminateOwnedProcessTree,
      })]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-descendant-cancel",
      cwd: root,
      prompt: "Delegate until cancelled",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: ({ status }) => { if (status === "running") markRunning(); },
    });

    await running;
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(manager.activeConversationIds()).toContain(
      "opencode-descendant-cancel",
    );
    expect(manager.cancel("opencode-descendant-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const capture = readStableCapture<{ port: number }>(capturePath);
    await waitFor(
      "the descendant-active OpenCode server to close",
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
      failure: {
        reason: "rpc-timeout",
        phase: "runtime",
        terminalEvent: "event/inactivity-deadline",
      },
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

  it("preserves the provider failure when owned-server cleanup is also unconfirmed", async () => {
    const root = portableFixtureRoot("OpenCode inactive unconfirmed cleanup");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      lifecycleServerSource(root, capturePath, "slow"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        eventInactivityDeadlineMs: 100,
        terminateProcessTree: async (child, force) => {
          await terminateProcessTreeAndWait(child, force);
          return false;
        },
      })]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-inactive-unconfirmed-cleanup",
      cwd: root,
      prompt: "Wait forever",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(
        /event stream became inactive.*Cleanup also failed: OpenCode server process tree could not be confirmed stopped\./u,
      ),
      cleanupConfirmed: false,
    });
    expect(manager.activeConversationIds()).toContain(
      "opencode-inactive-unconfirmed-cleanup",
    );
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
      failure: {
        reason: "rpc-timeout",
        phase: "runtime",
        terminalEvent: "run/deadline",
      },
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
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("oversized"),
      failure: { reason: "protocol-overflow", phase: "runtime" },
    });

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
      error: expect.stringContaining("bounded owned-assistant budget"),
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
