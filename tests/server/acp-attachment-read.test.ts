// @inertia-test-suite portable
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { portableFixtureRoot, portableNodeExecutable, removePortableFixture, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
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

function permissionAgent(root: string, name: string, agentName: string, capturePath: string, requests: unknown[]): string {
  const command = portableNodeExecutable(root, name);
  writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "77777777-7777-4777-8777-777777777777";
const requests = ${JSON.stringify(requests)};
const outcomes = [];
let promptId;
let next = 0;
const ask = () => {
  if (next >= requests.length) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
  const index = next;
  next += 1;
  send({ jsonrpc: "2.0", id: 1000 + index, method: "session/request_permission", params: {
    sessionId,
    toolCall: { toolCallId: "tool-" + index, title: "Request " + index, status: "pending", ...requests[index] },
    options: [
      { optionId: "allow-" + index, name: "Allow once", kind: "allow_once" },
      { optionId: "reject-" + index, name: "Reject", kind: "reject_once" },
    ],
  } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: ${JSON.stringify(agentName)}, version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    return ask();
  }
  if (typeof message.id === "number" && message.id >= 1000) {
    const outcome = message.result?.outcome;
    outcomes.push(outcome?.outcome === "selected" ? outcome.optionId.split("-")[0] : outcome?.outcome ?? "error");
    fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(outcomes));
    return ask();
  }
  if (message.method && message.id !== undefined) return send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`);
  return command;
}

describe.each([
  { providerId: "cursor" as const, binary: "cursor-agent", agentName: "Cursor", harness: createCursorAcpHarness },
  { providerId: "kimi" as const, binary: "kimi", agentName: "Kimi Code CLI", harness: createKimiAcpHarness },
])("$providerId reads of this chat's own attachments", ({ providerId, binary, agentName, harness }) => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await removePortableFixture(root);
  });

  it.each([
    { label: "supervised", interactionMode: "build" as const, access: "supervised" as const, denied: "reject", edit: "reject" },
    { label: "auto-edit", interactionMode: "build" as const, access: "auto-edit" as const, denied: "reject", edit: "allow" },
    { label: "plan", interactionMode: "plan" as const, access: "supervised" as const, denied: "cancelled", edit: "cancelled" },
  ])("allows only own attachment reads without a prompt in $label mode", async ({ interactionMode, access, denied, edit }) => {
    const root = portableFixtureRoot(`${providerId} attachment read ${access} ${interactionMode}`);
    roots.push(root);
    const files = attachmentStore(root);
    const capturePath = join(root, "outcomes.json");
    const requests = [
      { kind: "read", locations: [{ path: files.ownFile }] },
      { kind: "read", locations: [{ path: files.siblingFile }] },
      { kind: "read", locations: [{ path: files.store }] },
      { kind: "edit", locations: [{ path: files.ownFile }] },
      { kind: "read" },
      { kind: "read", locations: [{ path: files.ownFile }, { path: files.siblingFile }] },
      ...(process.platform === "win32" ? [] : [{ kind: "read", locations: [{ path: files.link }] }]),
      { kind: "read", locations: [{ path: files.own }] },
    ];
    const command = permissionAgent(root, binary, agentName, capturePath, requests);
    const manager = ProviderManager.createForTests(
      { commands: { [providerId]: command } },
      new AgentHarnessRegistry([harness()]),
    );
    const approvals: string[] = [];
    await expect(manager.run(nativeProviderRunInput({
      providerId,
      conversationId: `${providerId}-attachment-read-${access}-${interactionMode}`,
      cwd: root,
      prompt: "Read the attached log",
      interactionMode,
      access,
      attachmentReadRoots: [files.own],
    }), {
      onApproval: (event) => {
        approvals.push(event.request.title);
        manager.respondToApproval(event.conversationId, event.request.requestId, "deny", { runId: event.runId, turnId: event.turnId });
      },
    })).resolves.toMatchObject({ status: "completed" });
    const outcomes = JSON.parse(readFileSync(capturePath, "utf8")) as string[];
    const symlinkOutcome = process.platform === "win32" ? [] : [denied];
    expect(outcomes).toEqual(["allow", denied, denied, edit, denied, denied, ...symlinkOutcome, "allow"]);
    expect(approvals.some((title) => title === "Request 0" || title === `Request ${requests.length - 1}`)).toBe(false);
  });

  it("still asks for an own attachment read when no read grant was passed and honours a cancel", async () => {
    const root = portableFixtureRoot(`${providerId} attachment read without grant`);
    roots.push(root);
    const files = attachmentStore(root);
    const capturePath = join(root, "outcomes.json");
    const command = permissionAgent(root, binary, agentName, capturePath, [{ kind: "read", locations: [{ path: files.ownFile }] }]);
    const manager = ProviderManager.createForTests(
      { commands: { [providerId]: command } },
      new AgentHarnessRegistry([harness()]),
    );
    const approvals: string[] = [];
    await expect(manager.run(nativeProviderRunInput({
      providerId,
      conversationId: `${providerId}-attachment-read-ungranted`,
      cwd: root,
      prompt: "Read the attached log",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (event) => {
        approvals.push(event.request.title);
        manager.respondToApproval(event.conversationId, event.request.requestId, "cancel", { runId: event.runId, turnId: event.turnId });
      },
    })).resolves.toMatchObject({ status: "completed" });
    expect(approvals).toEqual(["Request 0"]);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual(["cancelled"]);
  });
});
