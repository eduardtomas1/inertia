// @inertia-test-suite portable
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const OWN = "11111111-1111-4111-8111-111111111111";
const SIBLING = "22222222-2222-4222-8222-222222222222";

function attachmentStore(root: string) {
  const store = join(realpathSync(root), "conversation-attachments");
  const own = join(store, OWN);
  const sibling = join(store, SIBLING);
  mkdirSync(own, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const ownFile = join(own, `${OWN}.log`);
  const siblingFile = join(sibling, `${SIBLING}.log`);
  writeFileSync(ownFile, "own chat");
  writeFileSync(siblingFile, "other chat");
  const link = join(own, "linked.log");
  if (process.platform !== "win32") symlinkSync(siblingFile, link);
  return { store, own, ownFile, siblingFile, link };
}

function permissionServer(root: string, capturePath: string, permissions: unknown[]): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
const sessionID = "opencode-attachment-session";
const permissions = ${JSON.stringify(permissions)};
const replies = [];
let events;
let messageID;
let next = 0;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(replies));
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const ask = () => {
  if (next >= permissions.length) {
    sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "done-text", sessionID, messageID: "assistant", type: "text", text: "Done" } } });
    return sendEvent({ type: "session.idle", properties: { sessionID } });
  }
  const index = next;
  next += 1;
  sendEvent({ type: "permission.asked", properties: { id: "permission-" + index, sessionID, metadata: {}, ...permissions[index] } });
};
const session = { id: sessionID, slug: "fixture", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fixture", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, [{ name: "plan", mode: "primary", permission: [], options: {} }]);
    if (req.method === "POST" && url.pathname === "/session") return json(res, session);
    if (req.method === "GET" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); return res.flushHeaders(); }
    if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
      messageID = parsed?.messageID;
      json(res, undefined, 204);
      return setTimeout(() => {
        sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "assistant", parentID: messageID, sessionID, role: "assistant" } } });
        ask();
      }, 10);
    }
    const reply = /^\\/permission\\/(permission-\\d+)\\/reply$/u.exec(url.pathname);
    if (req.method === "POST" && reply) {
      replies.push(parsed?.reply ?? "missing");
      save();
      json(res, true);
      return setTimeout(ask, 5);
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
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`;
}

describe("OpenCode reads of this chat's own attachments", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(async (manager) => await manager.disposeAll()));
    await Promise.all(roots.splice(0).map(async (root) => await removePortableFixture(root)));
  });

  async function run(
    label: string,
    permissions: unknown[],
    mode: { interactionMode: "build" | "plan"; access: "supervised" | "auto-edit" },
    attachmentReadRoots?: readonly string[],
  ) {
    const root = portableFixtureRoot(`OpenCode attachment read ${label}`);
    roots.push(root);
    const files = attachmentStore(root);
    const capturePath = join(root, "replies.json");
    const command = portableNodeExecutable(root, "opencode");
    const resolved = permissions.map((permission) => JSON.parse(JSON.stringify(permission)
      .replaceAll("$OWN_DIR", files.own.replaceAll("\\", "\\\\"))
      .replaceAll("$OWN", files.ownFile.replaceAll("\\", "\\\\"))
      .replaceAll("$SIBLING", files.siblingFile.replaceAll("\\", "\\\\"))
      .replaceAll("$STORE", files.store.replaceAll("\\", "\\\\"))
      .replaceAll("$LINK", files.link.replaceAll("\\", "\\\\"))));
    writeNodeSubcommand(root, "serve", permissionServer(root, capturePath, resolved));
    const manager = ProviderManager.createForTests(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    managers.push(manager);
    const approvals: string[] = [];
    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: `opencode-attachment-read-${label}`,
      cwd: root,
      prompt: "Read the attached log",
      ...mode,
      ...(attachmentReadRoots === undefined ? {} : { attachmentReadRoots: attachmentReadRoots.map((path) => path.replace("$OWN_DIR", files.own)) }),
    }), {
      onApproval: (event) => {
        approvals.push(event.request.title);
        manager.respondToApproval(event.conversationId, event.request.requestId, "deny", { runId: event.runId, turnId: event.turnId });
      },
    })).resolves.toMatchObject({ status: "completed" });
    return { replies: JSON.parse(readFileSync(capturePath, "utf8")) as string[], approvals };
  }

  it.each([
    { label: "supervised", interactionMode: "build" as const, access: "supervised" as const, edit: "reject" },
    { label: "auto-edit", interactionMode: "build" as const, access: "auto-edit" as const, edit: "once" },
    { label: "plan", interactionMode: "plan" as const, access: "supervised" as const, edit: "reject" },
  ])("replies once only to read permissions for own attachments in $label mode", async ({ label, interactionMode, access, edit }) => {
    const permissions = [
      { permission: "read", patterns: ["$OWN"] },
      { permission: "read", patterns: ["$SIBLING"] },
      { permission: "read", patterns: ["$STORE"] },
      { permission: "edit", resources: ["$OWN"] },
      { permission: "external_directory", patterns: ["$OWN_DIR/*"] },
      { permission: "read", patterns: ["$OWN", "$SIBLING"] },
      ...(process.platform === "win32" ? [] : [{ permission: "read", patterns: ["$LINK"] }]),
    ];
    const { replies } = await run(label, permissions, { interactionMode, access }, ["$OWN_DIR"]);
    expect(replies).toEqual(["once", "reject", "reject", edit, "reject", "reject", ...(process.platform === "win32" ? [] : ["reject"])]);
  });

  it("still asks for an own attachment read when no read grant was passed", async () => {
    const { replies, approvals } = await run("ungranted", [{ permission: "read", patterns: ["$OWN"] }], {
      interactionMode: "build", access: "supervised",
    });
    expect(replies).toEqual(["reject"]);
    expect(approvals).toHaveLength(1);
  });
});
