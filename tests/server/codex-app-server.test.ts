import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager, type ProviderAccessMode, type ProviderApprovalEvent } from "../../src/server/providers";
import { readCodexMetadata } from "../../src/server/codex-metadata";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

describe.sequential("Codex App Server runtime", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;
  const originalApprovalKind = process.env.INERTIA_APP_SERVER_APPROVAL_KIND;
  const originalOversize = process.env.INERTIA_APP_SERVER_OVERSIZE;
  const originalScenario = process.env.INERTIA_APP_SERVER_SCENARIO;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    if (originalApprovalKind === undefined) delete process.env.INERTIA_APP_SERVER_APPROVAL_KIND;
    else process.env.INERTIA_APP_SERVER_APPROVAL_KIND = originalApprovalKind;
    if (originalOversize === undefined) delete process.env.INERTIA_APP_SERVER_OVERSIZE;
    else process.env.INERTIA_APP_SERVER_OVERSIZE = originalOversize;
    if (originalScenario === undefined) delete process.env.INERTIA_APP_SERVER_SCENARIO;
    else process.env.INERTIA_APP_SERVER_SCENARIO = originalScenario;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function trackedManager(command: string, cancelGraceMs?: number): ProviderManager {
    const manager = new ProviderManager({
      commands: { codex: command },
      ...(cancelGraceMs === undefined ? {} : { cancelGraceMs }),
    });
    managers.push(manager);
    return manager;
  }

  function fakeAppServer(): { root: string; command: string; capturePath: string } {
    const root = portableFixtureRoot("app server");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    const capturePath = join(root, "capture.jsonl");
    writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
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
  send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "reasoning-1", summaryIndex: 0, delta: "Checking the safest path." } });
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: 11839, inputTokens: 11833, cachedInputTokens: 3456, outputTokens: 6, reasoningOutputTokens: 0 }, last: { totalTokens: 126, inputTokens: 120, cachedInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } } });
  send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1893456000 }, secondary: null }, rateLimitsByLimitId: null } });
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
  if (message.method === "model/list") return send({ id: message.id, result: { data: [{ id: "model-a", model: "model-a", displayName: "Model A", description: "A test model", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "high", description: "Careful" }], defaultReasoningEffort: "low", inputModalities: ["text", "image"], isDefault: true }], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1893456000 }, secondary: null }, rateLimitsByLimitId: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "incompatible-full-access" && message.params.approvalPolicy === "never") {
      return send({ id: message.id, error: { code: -32602, message: "invalid params: unknown variant danger-full-access" } });
    }
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
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "wait-for-interrupt") return;
    if (message.params.approvalPolicy === "never") {
      requestInput();
      return;
    }
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
    return { root, command, capturePath };
  }

  function captured(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("reads provider-supplied models, reasoning options, and remaining usage", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const metadata = await readCodexMetadata(fake.command, process.env, fake.root);
    expect(metadata.models).toEqual([expect.objectContaining({
      id: "model-a",
      label: "Model A",
      isDefault: true,
      defaultReasoningEffort: "low",
      reasoningOptions: [
        { value: "low", label: "Low", description: "Quick" },
        { value: "high", label: "High", description: "Careful" },
      ],
    })]);
    expect(metadata.rateLimits).toEqual([expect.objectContaining({
      id: "codex:primary",
      label: "Codex usage",
      usedPercent: 37,
      remainingPercent: 63,
      windowMinutes: 10080,
    })]);
  });

  it("round-trips approve-once, user input, native plans, deltas, resume, and images", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "command";
    const manager = trackedManager(fake.command);
    const approvals: string[] = [];
    const approvalRequests: ProviderApprovalEvent["request"][] = [];
    const inputs: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usage: Array<number | null> = [];
    const metadata: string[][] = [];

    const run = manager.run({
      providerId: "codex",
      conversationId: "conversation-approve",
      cwd: fake.root,
      prompt: "Work carefully",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
      imagePaths: [join(fake.root, "reference.png")],
      reasoningEffort: "high",
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
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => usage.push(event.usage.usedTokens),
      onMetadata: (event) => metadata.push(event.metadata.rateLimits?.map((limit) => limit.id) ?? []),
    });

    const result = await run;
    expect(result).toMatchObject({ status: "completed", sessionId: "thread-existing", text: "Hello from Codex" });
    expect(result).not.toHaveProperty("diagnostic");
    expect(approvals).toEqual(["npm test"]);
    expect(approvalRequests[0]).toMatchObject({
      availableDecisions: ["approve", "deny", "cancel"],
      networkScope: { host: "registry.npmjs.org", protocol: "https" },
      permissionRoots: [
        { path: normalize(join(realpathSync(fake.root), "fixtures")), access: "read" },
        { path: normalize(join(realpathSync(fake.root), "coverage")), access: "write" },
      ],
    });
    expect(inputs).toEqual(["Which path should Codex take?"]);
    expect(plans).toEqual(["A native plan"]);
    expect(reasoning).toEqual(["Checking the safest path."]);
    expect(usage).toEqual([126]);
    expect(metadata).toContainEqual(["codex:primary"]);
    expect(manager.cachedMetadata("codex")).toMatchObject({
      rateLimits: [expect.objectContaining({ id: "codex:primary", usedPercent: 41 })],
      metadataState: { rateLimits: { freshness: "fresh", provenance: "provider" } },
    });

    const messages = captured(fake.capturePath);
    const resumed = messages.find(({ method }) => method === "thread/resume") as { params: Record<string, unknown> };
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(resumed.params).toEqual({
      threadId: "thread-existing",
      excludeTurns: true,
      cwd: fake.root,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      effort: "high",
    });
    expect(turn.params).toEqual({
      threadId: "thread-existing",
      input: [
        { type: "text", text: "Work carefully", text_elements: [] },
        { type: "localImage", path: join(fake.root, "reference.png") },
      ],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      effort: "high",
      summary: "auto",
    });
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "accept" } });
    expect(messages.find(({ id }) => id === "input-rpc")).toMatchObject({ result: { answers: { choice: { answers: ["  Safe  "] } } } });
    expect(messages.find(({ method }) => method === "initialized")).toEqual({ method: "initialized" });
    await manager.disposeAll();
  });

  it("uses workspace-write for auto-edit build turns and maps denial", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "file-change";
    const manager = trackedManager(fake.command);

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
    expect(messages.find(({ method }) => method === "thread/start")).toEqual({
      method: "thread/start",
      id: 2,
      params: {
        cwd: fake.root,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });
    expect(messages.find(({ method }) => method === "turn/start")).toEqual({
      method: "turn/start",
      id: 3,
      params: {
        threadId: "thread-new",
        input: [{ type: "text", text: "Try an edit", text_elements: [] }],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        summary: "auto",
      },
    });
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "decline" } });
    await manager.disposeAll();
  });

  it("keeps full access on App Server while streaming rich plan-turn state", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const manager = trackedManager(fake.command);
    const approvals: string[] = [];
    const inputs: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usage: Array<number | null> = [];

    const result = manager.run({
      providerId: "codex",
      conversationId: "conversation-full",
      cwd: fake.root,
      prompt: "Plan with full access",
      interactionMode: "plan",
      access: "full",
      sessionId: "thread-full",
      imagePaths: [join(fake.root, "full-reference.png")],
      reasoningEffort: "high",
    }, {
      onApproval: (event) => approvals.push(event.request.requestId),
      onInput: (event) => {
        inputs.push(event.request.questions[0]?.question ?? "");
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Direct"] })).toBe(true);
      },
      onPlan: (event) => plans.push(event.explanation ?? ""),
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => usage.push(event.usage.usedTokens),
    });

    await expect(result).resolves.toMatchObject({
      status: "completed",
      sessionId: "thread-full",
      text: "Hello from Codex",
    });
    expect(approvals).toEqual([]);
    expect(inputs).toEqual(["Which path should Codex take?"]);
    expect(plans).toEqual(["A native plan"]);
    expect(reasoning).toEqual(["Checking the safest path."]);
    expect(usage).toEqual([126]);

    const messages = captured(fake.capturePath);
    const resumed = messages.find(({ method }) => method === "thread/resume") as { params: Record<string, unknown> };
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(resumed.params).toEqual({
      threadId: "thread-full",
      excludeTurns: true,
      cwd: fake.root,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      effort: "high",
    });
    expect(turn.params).toEqual({
      threadId: "thread-full",
      input: [
        { type: "text", text: "Plan with full access", text_elements: [] },
        { type: "localImage", path: join(fake.root, "full-reference.png") },
      ],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "high",
      summary: "auto",
      collaborationMode: {
        mode: "plan",
        settings: { model: "fake", reasoning_effort: "high", developer_instructions: null },
      },
    });
    expect(messages.find(({ id }) => id === "input-rpc")).toMatchObject({ result: { answers: { choice: { answers: ["Direct"] } } } });
    await manager.disposeAll();
  });

  it("interrupts a full-access App Server turn without changing transport", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "wait-for-interrupt";
    const manager = trackedManager(fake.command, 500);
    let cancelled = false;

    const result = manager.run({
      providerId: "codex",
      conversationId: "conversation-full-cancel",
      cwd: fake.root,
      prompt: "Wait",
      interactionMode: "build",
      access: "full",
    }, {
      onStatus: (event) => {
        if (event.status !== "running" || cancelled) return;
        cancelled = manager.cancel(event.conversationId);
      },
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled", sessionId: "thread-new" });
    expect(cancelled).toBe(true);
    const messages = captured(fake.capturePath);
    expect(messages.find(({ method }) => method === "turn/start")).toMatchObject({
      params: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    });
    expect(messages.find(({ method }) => method === "turn/interrupt")).toMatchObject({
      params: { threadId: "thread-new", turnId: "turn-1" },
    });
    await manager.disposeAll();
  });

  it("fails closed when App Server rejects full-access policy fields", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "incompatible-full-access";
    const manager = trackedManager(fake.command);
    const approvals: string[] = [];

    const result = await manager.run({
      providerId: "codex",
      conversationId: "conversation-full-incompatible",
      cwd: fake.root,
      prompt: "Run with full access",
      interactionMode: "build",
      access: "full",
    }, { onApproval: (event) => approvals.push(event.request.requestId) });

    expect(result).toMatchObject({
      status: "failed",
      error: "This Codex App Server version does not support Full Access. Update Codex CLI and try again.",
    });
    expect(result).not.toHaveProperty("compatibilityError");
    expect(approvals).toEqual([]);
    const messages = captured(fake.capturePath);
    expect(messages.find(({ method }) => method === "thread/start")).toMatchObject({
      params: { approvalPolicy: "never", sandbox: "danger-full-access" },
    });
    expect(messages.some(({ method }) => method === "turn/start")).toBe(false);
    await manager.disposeAll();
  });

  it("round-trips schema-native permission approvals without exposing raw params", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "permissions";
    const manager = trackedManager(fake.command);
    const approvalRequests: ProviderApprovalEvent["request"][] = [];
    const approvalResponses: boolean[] = [];
    const inputResponses: boolean[] = [];

    const result = manager.run({
      providerId: "codex",
      conversationId: "conversation-permissions",
      cwd: fake.root,
      prompt: "Inspect generated files",
      interactionMode: "build",
      access: "supervised",
    }, {
      onApproval: (event) => {
        approvalRequests.push(event.request);
        approvalResponses.push(manager.respondToApproval(event.conversationId, event.request.requestId, "approve"));
      },
      onInput: (event) => inputResponses.push(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] })),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(approvalRequests).toEqual([expect.objectContaining({
      kind: "permissions",
      permissionRoots: [{ path: normalize(join(realpathSync(fake.root), "generated")), access: "read" }],
    })]);
    expect(approvalResponses).toEqual([true]);
    expect(inputResponses).toEqual([true]);
    const response = captured(fake.capturePath).find(({ id }) => id === "approval-rpc");
    expect(response).toMatchObject({ result: { scope: "turn" } });
    const responsePath = (response as { result?: { permissions?: { fileSystem?: { read?: unknown[] } } } } | undefined)
      ?.result?.permissions?.fileSystem?.read?.[0];
    expect(typeof responsePath === "string" ? normalize(responsePath) : responsePath)
      .toBe(normalize(join(realpathSync(fake.root), "generated")));
    expect(JSON.stringify(response)).not.toContain("environmentId");
    await manager.disposeAll();
  });

  it("keeps plan mode read-only and cancels the active turn from an approval", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "command";
    const manager = trackedManager(fake.command, 500);

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

  it("fails closed on an oversized protocol line instead of hanging", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_OVERSIZE = "1";
    const manager = trackedManager(fake.command, 100);
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

  it("ignores a stale completion while opening the new turn", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "stale-completion";
    const manager = trackedManager(fake.command);

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

  it("interrupts deterministically when Codex offers only unsupported decisions", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "unsupported-decisions";
    const manager = trackedManager(fake.command, 500);
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

  it("settles a missing App Server executable without leaving an active run", async () => {
    const root = portableFixtureRoot("missing app server");
    roots.push(root);
    const missing = join(root, process.platform === "win32" ? "missing.exe" : "missing");
    const manager = trackedManager(missing);

    await expect(manager.run({
      providerId: "codex",
      conversationId: "conversation-missing",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "failed" });
    expect(manager.activeConversationIds()).toEqual([]);
    await manager.disposeAll();
  });
});
