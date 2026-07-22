import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager, type ProviderAccessMode, type ProviderApprovalEvent } from "../../src/server/providers";

describe.sequential("Codex App Server runtime", () => {
  const roots: string[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;
  const originalApprovalKind = process.env.INERTIA_APP_SERVER_APPROVAL_KIND;
  const originalOversize = process.env.INERTIA_APP_SERVER_OVERSIZE;
  const originalScenario = process.env.INERTIA_APP_SERVER_SCENARIO;

  afterEach(() => {
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    if (originalApprovalKind === undefined) delete process.env.INERTIA_APP_SERVER_APPROVAL_KIND;
    else process.env.INERTIA_APP_SERVER_APPROVAL_KIND = originalApprovalKind;
    if (originalOversize === undefined) delete process.env.INERTIA_APP_SERVER_OVERSIZE;
    else process.env.INERTIA_APP_SERVER_OVERSIZE = originalOversize;
    if (originalScenario === undefined) delete process.env.INERTIA_APP_SERVER_SCENARIO;
    else process.env.INERTIA_APP_SERVER_SCENARIO = originalScenario;
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function fakeAppServer(): { root: string; command: string; capturePath: string } {
    const root = mkdtempSync(join(tmpdir(), "inertia-app-server-"));
    roots.push(root);
    const command = join(root, "codex");
    const capturePath = join(root, "capture.jsonl");
    writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.145.0"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (args[0] !== "app-server") process.exit(9);
const capture = (value) => fs.appendFileSync(process.env.INERTIA_APP_SERVER_CAPTURE, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const approvalMethod = process.env.INERTIA_APP_SERVER_APPROVAL_KIND === "file-change"
  ? "item/fileChange/requestApproval"
  : process.env.INERTIA_APP_SERVER_APPROVAL_KIND === "permissions"
    ? "item/permissions/requestApproval"
    : "item/commandExecution/requestApproval";
let threadId = "thread-new";
let turnId = "turn-1";
const requestInput = () => send({
  id: "input-rpc",
  method: "item/tool/requestUserInput",
  params: {
    threadId,
    turnId,
    itemId: "input-item",
    autoResolutionMs: null,
    questions: [{
      id: "choice",
      header: "Direction",
      question: "Which path should Codex take?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Safe", description: "Use the bounded path." }],
    }],
  },
});
const complete = () => {
  send({ method: "turn/plan/updated", params: { threadId, turnId, explanation: "A native plan", plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "inProgress" }] } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-1", delta: "Hello " } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-1", delta: "from Codex" } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") {
    return send({ id: message.id, result: { userAgent: "fake" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || "thread-new";
    send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fake" } });
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "stale-completion") {
      send({ method: "turn/completed", params: { threadId, turn: { id: "stale-turn", status: "completed", items: [], error: null } } });
    }
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    if (process.env.INERTIA_APP_SERVER_OVERSIZE === "1") {
      return process.stdout.write(
        "x".repeat(1024 * 1024 + 32) + "\\n"
        + JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "trailing", delta: "must be ignored" } }) + "\\n"
        + JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } }) + "\\n"
      );
    }
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "orphan-turn", status: "completed", items: [], error: null } } });
    const params = process.env.INERTIA_APP_SERVER_SCENARIO === "unsupported-decisions"
      ? { threadId, turnId, itemId: "command-1", startedAtMs: Date.now(), command: "npm test", cwd: process.cwd(), availableDecisions: ["acceptForSession"] }
      : approvalMethod === "item/fileChange/requestApproval"
      ? { threadId, turnId, itemId: "change-1", startedAtMs: Date.now(), reason: "Write the requested file", grantRoot: process.cwd() }
      : approvalMethod === "item/permissions/requestApproval"
        ? {
            threadId,
            turnId,
            itemId: "permission-1",
            environmentId: null,
            startedAtMs: Date.now(),
            cwd: process.cwd(),
            reason: "Read generated fixtures",
            permissions: {
              network: null,
              fileSystem: { read: [process.cwd() + "/generated"], write: null, entries: [] },
            },
          }
      : {
          threadId,
          turnId,
          itemId: "command-1",
          startedAtMs: Date.now(),
          command: "npm test",
          cwd: process.cwd(),
          reason: "Validate the change",
          networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: { read: [process.cwd() + "/fixtures"], write: [process.cwd() + "/coverage"], entries: [] },
          },
        };
    return send({ id: "approval-rpc", method: approvalMethod, params });
  }
  if (message.id === "approval-rpc") {
    if (message.error) return;
    if (message.result.decision !== "cancel") requestInput();
    return;
  }
  if (message.id === "input-rpc") return complete();
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
  }
});
`);
    chmodSync(command, 0o700);
    return { root, command, capturePath };
  }

  function captured(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it.skipIf(process.platform === "win32")("round-trips approve-once, user input, native plans, deltas, resume, and images", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "command";
    const manager = new ProviderManager({ commands: { codex: fake.command } });
    const approvals: string[] = [];
    const approvalRequests: ProviderApprovalEvent["request"][] = [];
    const inputs: string[] = [];
    const plans: string[] = [];

    const run = manager.run({
      providerId: "codex",
      conversationId: "conversation-approve",
      cwd: fake.root,
      prompt: "Work carefully",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
      imagePaths: [join(fake.root, "reference.png")],
    }, {
      onApproval: (event) => {
        approvals.push(event.request.command ?? "");
        approvalRequests.push(event.request);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => {
        inputs.push(event.request.questions[0]?.question ?? "");
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["  Safe  "] })).toBe(true);
      },
      onPlan: (event) => plans.push(event.explanation ?? ""),
    });

    const result = await run;
    expect(result).toMatchObject({ status: "completed", sessionId: "thread-existing", text: "Hello from Codex" });
    expect(result).not.toHaveProperty("diagnostic");
    expect(approvals).toEqual(["npm test"]);
    expect(approvalRequests[0]).toMatchObject({
      availableDecisions: ["approve", "deny", "cancel"],
      networkScope: { host: "registry.npmjs.org", protocol: "https" },
      permissionRoots: [
        { path: join(realpathSync(fake.root), "fixtures"), access: "read" },
        { path: join(realpathSync(fake.root), "coverage"), access: "write" },
      ],
    });
    expect(inputs).toEqual(["Which path should Codex take?"]);
    expect(plans).toEqual(["A native plan"]);

    const messages = captured(fake.capturePath);
    const resumed = messages.find(({ method }) => method === "thread/resume") as { params: Record<string, unknown> };
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(resumed.params).toMatchObject({ threadId: "thread-existing", excludeTurns: true, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only" });
    expect(turn.params).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false } });
    expect(turn.params.input).toEqual([
      { type: "text", text: "Work carefully", text_elements: [] },
      { type: "localImage", path: join(fake.root, "reference.png") },
    ]);
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "accept" } });
    expect(messages.find(({ id }) => id === "input-rpc")).toMatchObject({ result: { answers: { choice: { answers: ["  Safe  "] } } } });
    expect(messages.find(({ method }) => method === "initialized")).toEqual({ method: "initialized" });
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("uses workspace-write for auto-edit build turns and maps denial", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "file-change";
    const manager = new ProviderManager({ commands: { codex: fake.command } });

    const result = manager.run({
      providerId: "codex",
      conversationId: "conversation-deny",
      cwd: fake.root,
      prompt: "Try an edit",
      interactionMode: "build",
      access: "auto-edit",
    }, {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "deny")).toBe(true),
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] })).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    const messages = captured(fake.capturePath);
    expect(messages.find(({ method }) => method === "thread/start")).toMatchObject({ params: { approvalPolicy: "on-request", sandbox: "workspace-write" } });
    expect(messages.find(({ method }) => method === "turn/start")).toMatchObject({ params: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } } });
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "decline" } });
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("round-trips schema-native permission approvals without exposing raw params", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "permissions";
    const manager = new ProviderManager({ commands: { codex: fake.command } });

    const result = manager.run({
      providerId: "codex",
      conversationId: "conversation-permissions",
      cwd: fake.root,
      prompt: "Inspect generated files",
      interactionMode: "build",
      access: "supervised",
    }, {
      onApproval: (event) => {
        expect(event.request.kind).toBe("permissions");
        expect(event.request.permissionRoots).toEqual([{ path: join(realpathSync(fake.root), "generated"), access: "read" }]);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] })).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    const response = captured(fake.capturePath).find(({ id }) => id === "approval-rpc");
    expect(response).toMatchObject({ result: { scope: "turn", permissions: { fileSystem: { read: [join(realpathSync(fake.root), "generated")] } } } });
    expect(JSON.stringify(response)).not.toContain("environmentId");
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("keeps plan mode read-only and cancels the active turn from an approval", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "command";
    const manager = new ProviderManager({ commands: { codex: fake.command }, cancelGraceMs: 500 });

    const result = manager.run({
      providerId: "codex",
      conversationId: "conversation-cancel",
      cwd: fake.root,
      prompt: "Plan only",
      interactionMode: "plan",
      access: "auto-edit" as ProviderAccessMode,
    }, {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "cancel")).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const messages = captured(fake.capturePath);
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(turn.params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } });
    expect((turn.params.input as Array<{ text?: string }>)[0]?.text).toBe("Plan only");
    expect(turn.params.collaborationMode).toEqual({
      mode: "plan",
      settings: { model: "fake", reasoning_effort: null, developer_instructions: null },
    });
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "cancel" } });
    expect(messages.some(({ method }) => method === "turn/interrupt")).toBe(true);
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("fails closed on an oversized protocol line instead of hanging", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_OVERSIZE = "1";
    const manager = new ProviderManager({ commands: { codex: fake.command }, cancelGraceMs: 100 });
    const approvals: string[] = [];
    const text: string[] = [];
    const result = await manager.run({
      providerId: "codex",
      conversationId: "conversation-overflow",
      cwd: fake.root,
      prompt: "Do nothing",
      interactionMode: "build",
      access: "supervised",
    }, {
      onApproval: (event) => approvals.push(event.request.requestId),
      onText: (event) => text.push(event.text),
    });
    expect(result).toMatchObject({ status: "failed", error: "Codex could not complete the request." });
    expect(approvals).toEqual([]);
    expect(text).toEqual([]);
    expect(manager.activeConversationIds()).toEqual([]);
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("ignores a stale completion while opening the new turn", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "stale-completion";
    const manager = new ProviderManager({ commands: { codex: fake.command } });

    const result = manager.run({
      providerId: "codex",
      conversationId: "conversation-stale",
      cwd: fake.root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
    }, {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true),
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] })).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Hello from Codex" });
    await manager.disposeAll();
  });

  it.skipIf(process.platform === "win32")("interrupts deterministically when Codex offers only unsupported decisions", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "unsupported-decisions";
    const manager = new ProviderManager({ commands: { codex: fake.command }, cancelGraceMs: 500 });
    const approvals: string[] = [];

    const result = await manager.run({
      providerId: "codex",
      conversationId: "conversation-unsupported",
      cwd: fake.root,
      prompt: "Try a command",
      interactionMode: "build",
      access: "supervised",
    }, { onApproval: (event) => approvals.push(event.request.requestId) });

    expect(result).toMatchObject({ status: "cancelled" });
    expect(approvals).toEqual([]);
    const messages = captured(fake.capturePath);
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ error: { code: -32602 } });
    expect(messages.some(({ method }) => method === "turn/interrupt")).toBe(true);
    await manager.disposeAll();
  });
});
