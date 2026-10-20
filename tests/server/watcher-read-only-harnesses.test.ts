// @inertia-test-suite portable
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CanUseTool, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentTurn, ModelSelection, ProviderId, ServerEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING } from "../../src/shared/watcher";
import { RuntimeStore } from "../../src/server/database";
import { captureCheckoutFingerprint } from "../../src/server/git/checkout-fingerprint";
import { validateProviderRunInput } from "../../src/server/provider/adapters";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import { INERTIA_HOST_MCP_NAME } from "../../src/server/provider/host-tool-mcp-config";
import { openCodePermissions } from "../../src/server/provider/opencode-host-tools";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import type { ReadOnlyWatcherViolation, TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { CLAUDE_PROTOCOL_SESSION_ID, claudeSuccessResult, claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { processExists } from "../helpers/codex-app-server-fixture";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput, resolveNativeModelRoute } from "./model-route-fixture";

/**
 * Runs real watcher turns (plan mode, supervised access) through the
 * TurnController's read-only watcher policy and the real Claude, Codex and
 * OpenCode harness adapters, against scripted providers only. Each scripted
 * provider performs a write only if Inertia lets it, so the temporary
 * repository's checkout fingerprint is the proof that nothing changed.
 */

const PARSER_SOURCE = "export function parse(input: string): string[] {\n  return input.split(\" \");\n}\n";
const OVERWRITE = "export {};\n";
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const now = (): string => new Date().toISOString();

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A committed repository; provider fixture entry points are excluded so the tree starts clean. */
function repository(root: string, excluded: readonly string[]): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "watcher@example.invalid");
  git(repo, "config", "user.name", "Watcher fixture");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "src", "parser.ts"), PARSER_SOURCE);
  git(repo, "add", "src/parser.ts");
  git(repo, "commit", "-q", "-m", "initial");
  appendFileSync(join(repo, ".git", "info", "exclude"), excluded.map((path) => `/${path}\n`).join(""));
  return repo;
}

async function checkoutState(repo: string) {
  const fingerprint = await captureCheckoutFingerprint(repo, { deadlineAt: Date.now() + 30_000 });
  if (fingerprint.state !== "captured") throw new Error(`Fingerprint ${fingerprint.state}.`);
  return {
    head: fingerprint.head,
    entries: [...fingerprint.entries],
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    parser: readFileSync(join(repo, "src", "parser.ts"), "utf8"),
  };
}

interface WatcherHarnessRuntime {
  repo: string;
  store: RuntimeStore;
  controller: TurnController;
  watcherId: string;
  linkId: string;
  inputs: ProviderRunInput[];
  events: ServerEvent[];
  violations: ReadOnlyWatcherViolation[];
  startCheck(): AgentTurn;
  settled(turnId: string): Promise<AgentTurn>;
  activities(): Array<{ kind: string; status: string; title: string }>;
}

/**
 * A watched chat and an attached watcher on the given route, with a
 * TurnController whose provider runtime is the real ProviderManager.
 */
function watcherHarnessRuntime(root: string, repo: string, manager: ProviderManager, selection: ModelSelection): WatcherHarnessRuntime {
  const store = new RuntimeStore(join(root, "inertia.sqlite"), repo, { recoverInterruptedRuns: false });
  const project = store.createProject("Watcher harness project", repo);
  const watched = store.createConversation(project.id, "Fix the parser", {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "model-a" }),
    interactionMode: "build",
    accessMode: "supervised",
  });
  const { link, conversation: watcher } = store.watcherLinks.createWithConversation({
    link: {
      id: randomUUID(),
      watchedConversationId: watched.id,
      preset: "reviewer",
      instructions: "",
      sharing: { ...DEFAULT_WATCHER_SHARING },
      budgets: { ...DEFAULT_WATCHER_BUDGETS },
      privateConnect: "inherit",
    },
    conversation: {
      projectId: project.id,
      title: "Watcher · Reviewer · Fix the parser",
      options: { modelSelection: selection, interactionMode: "plan", accessMode: "supervised" },
    },
  }, now());
  const inputs: ProviderRunInput[] = [];
  const events: ServerEvent[] = [];
  const violations: ReadOnlyWatcherViolation[] = [];
  const provider: TurnProviderRuntime = {
    resolveModelRoute: resolveNativeModelRoute,
    harnessIdFor: (input) => manager.harnessIdFor(input),
    providerCapabilityAvailable: () => true,
    run: (input, callbacks) => {
      inputs.push(input);
      return manager.run(input, callbacks);
    },
    cancel: (conversationId) => manager.cancel(conversationId),
    stopOwned: (conversationId, identity, graceMs) => manager.stopOwned(conversationId, identity, graceMs),
    isRunning: (conversationId) => manager.isRunning(conversationId),
    ownsRun: (conversationId, identity) => manager.ownsRun(conversationId, identity),
    respondToApproval: (conversationId, requestId, decision, identity) =>
      manager.respondToApproval(conversationId, requestId, decision, identity),
    respondToInput: (conversationId, requestId, answers, identity) =>
      manager.respondToInput(conversationId, requestId, answers, identity),
    disposeAll: () => manager.disposeAll(),
  };
  const controller = new TurnController(store, provider, new Map(), new Map(), new Map(), {
    broadcast: (event) => { events.push(event); },
    broadcastSnapshot: () => undefined,
    // No capability contract: these turns carry no host tools or capability packs.
    providerInfo: () => [],
    onReadOnlyViolation: (_turn, violation) => { violations.push(violation); },
  }, {
    scheduler: { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
    clock: () => new Date(),
    id: randomUUID,
    turnTimeoutMs: 60_000,
  });
  cleanups.push(async () => {
    await controller.dispose();
    await manager.disposeAll();
    store.close();
  });
  return {
    repo,
    store,
    controller,
    watcherId: watcher.id,
    linkId: link.id,
    inputs,
    events,
    violations,
    startCheck() {
      expect(store.watcherLinks.transition(link.id, ["watching", "waking"], { status: "waking" }, now())).not.toBeNull();
      const wake = store.watcherLinks.createWake({
        id: randomUUID(),
        linkId: link.id,
        watchedTurnId: null,
        trigger: "manual",
        eventsCovered: 1,
        itemsTruncated: 0,
        itemsOmitted: 0,
        digestBytes: 64,
      }, now());
      expect(wake).not.toBeNull();
      const queued = controller.queue({
        conversationId: watcher.id,
        content: "Check 1 for \"Fix the parser\". Review src/parser.ts.",
        authorizedWatcherWakeId: wake!.wakeId,
        activateConversation: false,
      });
      store.watcherLinks.attachWakeTurn(wake!.wakeId, queued.turn.id, now());
      expect(controller.start(queued.turn.id)).toBe(true);
      return queued.turn;
    },
    async settled(turnId) {
      await waitFor("the watcher turn to settle", () => TERMINAL.has(store.agentTurn(turnId).status), 20_000);
      await controller.drainSettlementTasks();
      await waitFor("the provider run to release its owner", () => !manager.isRunning(watcher.id), 10_000);
      return store.agentTurn(turnId);
    },
    activities: () => store.conversationDetail(watcher.id)!.activities.map(({ kind, status, title }) => ({ kind, status, title })),
  };
}

function expectWatcherRunInput(input: ProviderRunInput | undefined, providerId: ProviderId): void {
  expect(input).toMatchObject({ providerId, interactionMode: "plan", access: "supervised", readOnlyProfile: "watcher" });
}

// --- Claude Agent SDK -------------------------------------------------------

/** The plan-mode tools Claude Code runs without asking `canUseTool`. */
const CLAUDE_PLAN_MODE_READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob"]);

interface ClaudeQueryOptions {
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  settingSources?: unknown;
  canUseTool?: CanUseTool;
  abortController?: AbortController;
}

interface ClaudeScript {
  options: ClaudeQueryOptions;
  /** Claude Code's own gate: plan mode allows read-only tools, anything else asks `canUseTool`. */
  permission(tool: string, input: Record<string, unknown>, toolUseId: string): Promise<PermissionResult>;
  aborted(): Promise<boolean>;
}

let claudeFrame = 0;
function claudeEnvelope(): Record<string, unknown> {
  claudeFrame += 1;
  return { uuid: `watcher-frame-${claudeFrame}`, session_id: CLAUDE_PROTOCOL_SESSION_ID, parent_tool_use_id: null };
}

function claudeToolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: "assistant",
    ...claudeEnvelope(),
    message: { id: `msg-${id}`, type: "message", role: "assistant", model: "fixture", content: [{ type: "tool_use", id, name, input }] },
  } as unknown as SDKMessage;
}

function claudeToolResult(toolUseId: string, content: string, isError = false): SDKMessage {
  return {
    type: "user",
    ...claudeEnvelope(),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  } as unknown as SDKMessage;
}

function claudeText(text: string): SDKMessage {
  return {
    type: "assistant",
    ...claudeEnvelope(),
    message: { id: "msg-final", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

function claudeStream(event: Record<string, unknown>): SDKMessage {
  return { type: "stream_event", ...claudeEnvelope(), event } as unknown as SDKMessage;
}

function claudeManager(script: (sdk: ClaudeScript) => AsyncGenerator<SDKMessage>) {
  const record = { options: [] as ClaudeQueryOptions[], interrupted: 0, closed: 0 };
  const harness = createClaudeAgentSdkHarness({
    createQuery: ({ options }) => {
      const queryOptions = (options ?? {}) as ClaudeQueryOptions;
      record.options.push(queryOptions);
      const signal = queryOptions.abortController?.signal ?? new AbortController().signal;
      const sdk: ClaudeScript = {
        options: queryOptions,
        permission: async (tool, input, toolUseId) => {
          if (queryOptions.permissionMode === "plan" && CLAUDE_PLAN_MODE_READ_TOOLS.has(tool)) {
            return { behavior: "allow", updatedInput: input };
          }
          return await queryOptions.canUseTool!(tool, input, { signal, toolUseID: toolUseId, requestId: toolUseId })
            ?? { behavior: "deny", message: "No permission decision." };
        },
        aborted: async () => {
          const deadline = Date.now() + 5_000;
          while (!signal.aborted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
          return signal.aborted;
        },
      };
      return fixtureClaudeQuery(script(sdk), {
        interrupt: async () => { record.interrupted += 1; },
        close: () => { record.closed += 1; },
      });
    },
  });
  const manager = ProviderManager.createForTests({ commands: { claude: "/fixture/claude" } }, new AgentHarnessRegistry([harness]));
  return { manager, record };
}

function grepRepository(repo: string, pattern: string): string {
  return readFileSync(join(repo, "src", "parser.ts"), "utf8").split("\n")
    .flatMap((line, index) => line.includes(pattern) ? [`src/parser.ts:${index + 1}:${line}`] : []).join("\n");
}

describe("watcher turns on the Claude Agent SDK harness", () => {
  it("runs in plan mode, reads without a prompt and declines a write through the read-only policy", async () => {
    const root = portableFixtureRoot("watcher claude");
    roots.push(root);
    const repo = repository(root, []);
    const parserPath = join(repo, "src", "parser.ts");
    const decisions: Record<string, PermissionResult> = {};
    const outputs: string[] = [];
    const { manager, record } = claudeManager(async function* (sdk) {
      yield claudeSystem("init");
      for (const [id, tool, input] of [
        ["toolu-read", "Read", { file_path: parserPath }],
        ["toolu-grep", "Grep", { pattern: "parse", path: repo }],
      ] as const) {
        decisions[tool] = await sdk.permission(tool, input, id);
        yield claudeToolUse(id, tool, input);
        const output = decisions[tool].behavior !== "allow"
          ? "denied"
          : tool === "Read" ? readFileSync(parserPath, "utf8") : grepRepository(repo, input.pattern);
        outputs.push(output);
        yield claudeToolResult(id, output);
      }
      const write = { file_path: parserPath, content: OVERWRITE };
      decisions.Write = await sdk.permission("Write", write, "toolu-write");
      if (decisions.Write.behavior === "allow") writeFileSync(parserPath, OVERWRITE);
      yield claudeText("SILENT");
      yield claudeSuccessResult("SILENT", "completed");
    });
    const runtime = watcherHarnessRuntime(root, repo, manager, providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }));
    const before = await checkoutState(repo);

    const turn = await runtime.settled(runtime.startCheck().id);

    expectWatcherRunInput(runtime.inputs[0], "claude");
    expect(record.options[0]).toMatchObject({ permissionMode: "plan", allowDangerouslySkipPermissions: false, settingSources: [] });
    expect(typeof record.options[0]!.canUseTool).toBe("function");
    expect(decisions.Read).toMatchObject({ behavior: "allow" });
    expect(decisions.Grep).toMatchObject({ behavior: "allow" });
    expect(outputs[0]).toBe(PARSER_SOURCE);
    expect(outputs[1]).toContain("src/parser.ts:1:export function parse");
    expect(decisions.Write).toMatchObject({ behavior: "deny", message: "User declined tool execution." });
    expect(runtime.violations).toEqual([expect.objectContaining({ linkId: runtime.linkId, kind: "write-attempt", stopped: false })]);
    expect(runtime.events.some((event) => event.type === "agent.approval.requested")).toBe(false);
    expect(runtime.activities()).toEqual([
      { kind: "tool", status: "completed", title: "Read" },
      { kind: "tool", status: "completed", title: "Grep" },
      { kind: "status", status: "completed", title: "Needed permission: Claude wants to use Write — declined (watchers are read-only)" },
    ]);
    expect(turn).toMatchObject({ status: "completed" });
    expect(await checkoutState(repo)).toEqual(before);
    expect(before.status).toBe("");
  });

  it("stops a started edit before it runs, cancels the query and shuts down cleanly", async () => {
    const root = portableFixtureRoot("watcher claude cancel");
    roots.push(root);
    const repo = repository(root, []);
    const parserPath = join(repo, "src", "parser.ts");
    let abortedBeforeEdit: boolean | null = null;
    const { manager, record } = claudeManager(async function* (sdk) {
      yield claudeSystem("init");
      yield claudeStream({ type: "message_start", message: { id: "msg-edit", content: [] } });
      yield claudeStream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-edit", name: "Edit", input: {} } });
      // Claude Code would now run the edit; Inertia has to stop the turn first.
      abortedBeforeEdit = await sdk.aborted();
      if (!abortedBeforeEdit) writeFileSync(parserPath, OVERWRITE);
    });
    const runtime = watcherHarnessRuntime(root, repo, manager, providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }));
    const before = await checkoutState(repo);

    const turn = await runtime.settled(runtime.startCheck().id);

    expect(abortedBeforeEdit).toBe(true);
    expect(turn).toMatchObject({ status: "failed", terminalReason: "unsupported-interaction" });
    expect(runtime.violations).toEqual([expect.objectContaining({ kind: "write-attempt", stopped: true })]);
    expect(record.closed + record.interrupted).toBeGreaterThan(0);
    expect(manager.isRunning(runtime.watcherId)).toBe(false);
    expect(await checkoutState(repo)).toEqual(before);
  });
});

// --- Codex app-server -------------------------------------------------------

type CodexScenario = "read-then-write" | "malformed";

/** A scripted app-server that writes only when its write command is approved. */
function codexAppServer(root: string, repo: string, scenario: CodexScenario) {
  const command = portableNodeExecutable(root, "codex");
  const capturePath = join(root, "codex-capture.jsonl");
  const pidPath = join(root, "codex.pid");
  writeNodeSubcommand(repo, "app-server", `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const scenario = ${JSON.stringify(scenario)};
const capture = (value) => fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const target = path.join(process.cwd(), "src", "parser.ts");
const threadId = "watcher-thread";
const turnId = "watcher-turn";
const startedAt = Math.floor(Date.now() / 1000);
const turn = (status) => ({ id: turnId, items: [], itemsView: "notLoaded", status, error: null, startedAt, completedAt: status === "inProgress" ? null : startedAt, durationMs: status === "inProgress" ? null : 0 });
const sandbox = (mode) => mode === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "unexpected", mode };
const item = (method, value) => send({ method, params: { threadId, turnId, ...(method === "item/started" ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() }), item: value } });
const finish = () => {
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-1", delta: "SILENT" } });
  item("item/completed", { id: "message-1", type: "agentMessage", text: "SILENT", phase: "final_answer" });
  send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    return send({ id: message.id, result: {
      thread: { id: threadId }, model: message.params.model ?? "fixture", modelProvider: "openai", serviceTier: null,
      disabledPluginIds: [], cwd: process.cwd(), instructionSources: [], approvalPolicy: message.params.approvalPolicy,
      approvalsReviewer: message.params.approvalsReviewer, sandbox: sandbox(message.params.sandbox), reasoningEffort: null,
    } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId, turn: turn("inProgress") } });
    if (scenario === "malformed") return process.stdout.write("{not-json}\\n");
    // A known-safe read runs inside the read-only sandbox without an approval.
    item("item/started", { id: "read-1", type: "commandExecution", command: "cat src/parser.ts", status: "inProgress" });
    item("item/completed", { id: "read-1", type: "commandExecution", command: "cat src/parser.ts", status: "completed", aggregatedOutput: fs.readFileSync(target, "utf8") });
    // Anything else needs approval under the untrusted policy.
    return send({ id: "approval-write", method: "item/commandExecution/requestApproval", params: {
      kind: "command", threadId, turnId, itemId: "write-1", startedAtMs: Date.now(), environmentId: null,
      command: "tee src/parser.ts", cwd: process.cwd(), commandActions: [], reason: "Rewrite the parser",
      availableDecisions: ["accept", "decline", "cancel"],
    } });
  }
  if (message.id === "approval-write") {
    const accepted = message.result?.decision === "accept";
    if (accepted) fs.writeFileSync(target, ${JSON.stringify(OVERWRITE)});
    item("item/completed", { id: "write-1", type: "commandExecution", command: "tee src/parser.ts", status: accepted ? "completed" : "declined", aggregatedOutput: "" });
    return finish();
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return send({ method: "turn/completed", params: { threadId, turn: turn("interrupted") } });
  }
  if (message.id !== undefined && message.method) send({ id: message.id, error: { code: -32601, message: "unsupported in fixture" } });
});
`);
  const manager = ProviderManager.createForTests({ commands: { codex: command } });
  return {
    manager,
    requests: () => readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    pid: () => Number(readFileSync(pidPath, "utf8")),
    pidWritten: () => existsSync(pidPath),
  };
}

async function expectProcessGone(pid: number): Promise<void> {
  await waitFor(`fixture process ${pid} to exit`, () => !processExists(pid), 10_000);
}

describe("watcher turns on the Codex app-server harness", () => {
  it("requests the read-only sandbox with the untrusted policy, runs a safe read and declines a write", async () => {
    const root = portableFixtureRoot("watcher codex");
    roots.push(root);
    const repo = repository(root, ["app-server"]);
    const codex = codexAppServer(root, repo, "read-then-write");
    const runtime = watcherHarnessRuntime(root, repo, codex.manager, providerNativeModelSelection({ providerId: "codex", modelId: "model-a" }));
    const before = await checkoutState(repo);

    const turn = await runtime.settled(runtime.startCheck().id);

    expectWatcherRunInput(runtime.inputs[0], "codex");
    const requests = codex.requests();
    const threadStart = requests.find(({ method }) => method === "thread/start")?.params as Record<string, unknown>;
    const turnStart = requests.find(({ method }) => method === "turn/start")?.params as Record<string, unknown>;
    expect(threadStart).toEqual({
      cwd: runtime.inputs[0]!.cwd,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      model: "model-a",
    });
    expect(turnStart).toEqual({
      threadId: "watcher-thread",
      input: [expect.objectContaining({ type: "text" })],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: "model-a",
      summary: "auto",
      collaborationMode: { mode: "plan", settings: { model: "model-a", reasoning_effort: null, developer_instructions: null } },
    });
    expect(requests.find(({ id }) => id === "approval-write")).toMatchObject({ result: { decision: "decline" } });
    expect(runtime.activities()).toEqual([
      { kind: "status", status: "completed", title: "Turn completed" },
      { kind: "command", status: "completed", title: "Command" },
      { kind: "status", status: "completed", title: "Needed permission: Approve command — declined (watchers are read-only)" },
      { kind: "command", status: "failed", title: "Command" },
    ]);
    const commands = runtime.store.conversationDetail(runtime.watcherId)!.activities.filter(({ kind }) => kind === "command");
    expect(commands.map(({ status, detail }) => ({ status, detail }))).toEqual([
      { status: "completed", detail: `Command:\ncat src/parser.ts\n\nOutput:\n${PARSER_SOURCE.trimEnd()}` },
      { status: "failed", detail: "Command:\ntee src/parser.ts" },
    ]);
    expect(runtime.violations).toEqual([expect.objectContaining({ kind: "command-attempt", stopped: false })]);
    expect(runtime.events.some((event) => event.type === "agent.approval.requested")).toBe(false);
    expect(turn).toMatchObject({ status: "completed" });
    expect(await checkoutState(repo)).toEqual(before);
    await codex.manager.disposeAll();
    await expectProcessGone(codex.pid());
  });

  it("fails a malformed frame closed, terminates the app-server and leaves the checkout unchanged", async () => {
    const root = portableFixtureRoot("watcher codex malformed");
    roots.push(root);
    const repo = repository(root, ["app-server"]);
    const codex = codexAppServer(root, repo, "malformed");
    const runtime = watcherHarnessRuntime(root, repo, codex.manager, providerNativeModelSelection({ providerId: "codex", modelId: "model-a" }));
    const before = await checkoutState(repo);

    const turn = await runtime.settled(runtime.startCheck().id);

    expect(turn.status).toBe("failed");
    expect(codex.pidWritten()).toBe(true);
    await expectProcessGone(codex.pid());
    expect(runtime.violations).toEqual([]);
    expect(await checkoutState(repo)).toEqual(before);
  });
});

// --- OpenCode SDK -----------------------------------------------------------

/** OpenCode's plan agent rules, which the session ruleset is appended to. */
const OPENCODE_PLAN_AGENT_RULES: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "allow" },
  { permission: "plan_exit", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" },
];
const OPENCODE_NATIVE_TOOLS = ["bash", "edit", "write", "patch", "read", "glob", "grep", "list", "webfetch", "todowrite", "task"];
const OPENCODE_SCRIPTED_CALLS = [
  { tool: "read", pattern: "src/parser.ts" },
  { tool: "glob", pattern: "src/**/*.ts" },
  { tool: "grep", pattern: "parse" },
  { tool: "list", pattern: "src" },
  { tool: "edit", pattern: "src/parser.ts" },
  { tool: "bash", pattern: "rm src/parser.ts" },
];

interface OpenCodeCapture {
  sessionPermission?: PermissionRuleset;
  offeredTools?: string[];
  calls: Array<{ tool: string; action: string; reply?: string }>;
  aborted?: boolean;
}

/**
 * A scripted OpenCode server that evaluates the session ruleset the way
 * OpenCode does (agent rules, then session rules, last match wins), prompts
 * for `ask`, and writes only when an edit or shell call is allowed.
 */
function openCodeServer(root: string, repo: string) {
  const command = portableNodeExecutable(root, "opencode");
  const capturePath = join(root, "opencode-capture.json");
  const pidPath = join(root, "opencode.pid");
  writeNodeSubcommand(repo, "serve", `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const capture = { calls: [] };
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(capture));
const agentRules = ${JSON.stringify(OPENCODE_PLAN_AGENT_RULES)};
const nativeTools = ${JSON.stringify(OPENCODE_NATIVE_TOOLS)};
const calls = ${JSON.stringify(OPENCODE_SCRIPTED_CALLS)};
const target = path.join(process.cwd(), "src", "parser.ts");
const sessionID = "opencode-watcher-session";
const session = { id: sessionID, slug: "watcher", projectID: "project", directory: process.cwd(), title: "Watcher", version: "1.18.4", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const wildcard = (value, pattern) => {
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  if (!value.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (const middle of parts.slice(1, -1)) {
    const found = value.indexOf(middle, at);
    if (found < 0) return false;
    at = found + middle.length;
  }
  const last = parts[parts.length - 1];
  return value.length - last.length >= at && value.endsWith(last);
};
let rules = [];
const evaluate = (permission, pattern) => [...agentRules, ...rules].findLast((rule) => wildcard(permission, rule.permission) && wildcard(pattern, rule.pattern))?.action ?? "ask";
const disabled = (tool) => [...agentRules, ...rules].findLast((rule) => wildcard(tool, rule.permission))?.pattern === "*"
  && [...agentRules, ...rules].findLast((rule) => wildcard(tool, rule.permission))?.action === "deny";
let events;
let promptMessageID;
let pending = null;
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const part = (index, state) => sendEvent({ type: "message.part.updated", properties: { sessionID, time: Date.now(), part: { id: "tool-" + index, sessionID, messageID: "assistant-1", type: "tool", callID: "call-" + index, tool: calls[index].tool, state: { input: { pattern: calls[index].pattern }, time: { start: Date.now(), end: Date.now() }, ...state } } } });
const execute = (index) => {
  const call = calls[index];
  if (call.tool === "edit" || call.tool === "bash") fs.writeFileSync(target, ${JSON.stringify(OVERWRITE)});
  const output = call.tool === "read" || call.tool === "grep" ? fs.readFileSync(target, "utf8") : "src/parser.ts";
  part(index, { status: "completed", output, title: call.pattern, metadata: {} });
};
const step = (index) => {
  if (index >= calls.length) {
    sendEvent({ type: "message.part.updated", properties: { sessionID, time: Date.now(), part: { id: "text-1", sessionID, messageID: "assistant-1", type: "text", text: "SILENT", time: { start: Date.now(), end: Date.now() } } } });
    return sendEvent({ type: "session.idle", properties: { sessionID } });
  }
  const call = calls[index];
  const action = evaluate(call.tool, call.pattern);
  capture.calls.push({ tool: call.tool, action });
  save();
  if (action === "allow") { execute(index); return step(index + 1); }
  if (action === "deny") {
    part(index, { status: "error", error: "The user has specified a rule which prevents you from using this specific tool call." });
    return step(index + 1);
  }
  pending = { index, id: "permission-" + index };
  sendEvent({ type: "permission.asked", properties: { id: pending.id, sessionID, permission: call.tool, patterns: [call.pattern], metadata: {}, always: [] } });
};
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(value)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.4" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, [{ name: "plan", mode: "primary", permission: agentRules, options: {} }, { name: "build", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "allow" }], options: {} }]);
    if (req.method === "POST" && url.pathname === "/session") {
      rules = parsed.permission ?? [];
      capture.sessionPermission = rules;
      capture.offeredTools = nativeTools.filter((tool) => !disabled(tool));
      save();
      return json(res, session);
    }
    if (req.method === "GET" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); return res.flushHeaders(); }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/prompt_async") {
      promptMessageID = parsed.messageID;
      json(res, undefined, 204);
      sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "assistant-1", parentID: promptMessageID, sessionID, role: "assistant", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } } });
      return step(0);
    }
    if (req.method === "POST" && pending && url.pathname === "/permission/" + pending.id + "/reply") {
      const { index } = pending;
      pending = null;
      capture.calls[capture.calls.length - 1].reply = parsed.reply;
      save();
      json(res, true);
      if (parsed.reply === "reject") part(index, { status: "error", error: "The user rejected permission to use this specific tool call." });
      else execute(index);
      return step(index + 1);
    }
    if (req.method === "POST" && url.pathname === "/session/" + sessionID + "/abort") {
      capture.aborted = true;
      save();
      json(res, true);
      return sendEvent({ type: "session.idle", properties: { sessionID } });
    }
    return json(res, { error: "not found" }, 404);
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log("opencode server listening on http://127.0.0.1:" + address.port);
});
`);
  const manager = ProviderManager.createForTests({ commands: { opencode: command } }, new AgentHarnessRegistry([createOpenCodeSdkHarness()]));
  return {
    manager,
    capture: () => JSON.parse(readFileSync(capturePath, "utf8")) as OpenCodeCapture,
    pid: () => Number(readFileSync(pidPath, "utf8")),
  };
}

describe("watcher turns on the OpenCode SDK harness", () => {
  it("prompts for read, glob, grep and list under the supervised plan ruleset alone", async () => {
    const root = portableFixtureRoot("watcher opencode supervised");
    roots.push(root);
    const repo = repository(root, ["serve"]);
    const opencode = openCodeServer(root, repo);
    cleanups.push(() => opencode.manager.disposeAll());
    const asked: string[] = [];
    const result = await opencode.manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-supervised-plan",
      cwd: repo,
      prompt: "Review the parser.",
      interactionMode: "plan",
      access: "supervised",
      model: "fake/model-a",
    }), {
      onApproval: (event) => {
        asked.push(event.request.title);
        expect(opencode.manager.respondToApproval(event.conversationId, event.request.requestId, "deny", { runId: event.runId, turnId: event.turnId })).toBe(true);
      },
    });

    expect(result).toMatchObject({ status: "completed" });
    const capture = opencode.capture();
    expect(capture.sessionPermission).toEqual(openCodePermissions("supervised", "plan"));
    expect(capture.calls).toEqual([
      { tool: "read", action: "ask", reply: "reject" },
      { tool: "glob", action: "ask", reply: "reject" },
      { tool: "grep", action: "ask", reply: "reject" },
      { tool: "list", action: "ask", reply: "reject" },
      { tool: "edit", action: "deny" },
      { tool: "bash", action: "ask", reply: "reject" },
    ]);
    expect(asked).toEqual(["read", "glob", "grep", "list", "bash"].map((tool) => `OpenCode wants to use ${tool}`));
  });

  it("carries the watcher profile, so reads run without a prompt and writes are denied", async () => {
    const root = portableFixtureRoot("watcher opencode");
    roots.push(root);
    const repo = repository(root, ["serve"]);
    const opencode = openCodeServer(root, repo);
    const runtime = watcherHarnessRuntime(root, repo, opencode.manager, providerNativeModelSelection({ providerId: "opencode", modelId: "fake/model-a" }));
    const before = await checkoutState(repo);

    const turn = await runtime.settled(runtime.startCheck().id);

    expectWatcherRunInput(runtime.inputs[0], "opencode");
    const capture = opencode.capture();
    expect(capture.sessionPermission).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: `${INERTIA_HOST_MCP_NAME}_*`, pattern: "*", action: "allow" },
    ]);
    expect(capture.offeredTools).toEqual(["read", "glob", "grep", "list"]);
    expect(capture.calls).toEqual([
      { tool: "read", action: "allow" },
      { tool: "glob", action: "allow" },
      { tool: "grep", action: "allow" },
      { tool: "list", action: "allow" },
      { tool: "edit", action: "deny" },
      { tool: "bash", action: "deny" },
    ]);
    expect(runtime.activities()).toEqual([
      { kind: "tool", status: "completed", title: "src/parser.ts" },
      { kind: "tool", status: "completed", title: "src/**/*.ts" },
      { kind: "tool", status: "completed", title: "parse" },
      { kind: "tool", status: "completed", title: "src" },
      { kind: "tool", status: "failed", title: "edit" },
      { kind: "command", status: "failed", title: "bash" },
    ]);
    expect(runtime.violations).toEqual([]);
    expect(runtime.events.some((event) => event.type === "agent.approval.requested")).toBe(false);
    expect(turn).toMatchObject({ status: "completed" });
    expect(await checkoutState(repo)).toEqual(before);
    await opencode.manager.disposeAll();
    await expectProcessGone(opencode.pid());
  });

  it("admits the watcher profile only on a plan-mode, supervised run", () => {
    const input = (interactionMode: "build" | "plan", access: "full" | "supervised"): ProviderRunInput => ({
      ...nativeProviderRunInput({ providerId: "opencode", conversationId: `profile-${interactionMode}-${access}`, cwd: process.cwd(), prompt: "Review.", interactionMode, access }),
      readOnlyProfile: "watcher",
    });
    expect(() => validateProviderRunInput(input("plan", "supervised"))).not.toThrow();
    expect(() => validateProviderRunInput(input("build", "supervised"))).toThrow("The read-only profile is invalid.");
    expect(() => validateProviderRunInput(input("plan", "full"))).toThrow("The read-only profile is invalid.");
    expect(() => validateProviderRunInput({ ...input("plan", "supervised"), readOnlyProfile: "other" as never }))
      .toThrow("The read-only profile is invalid.");
  });
});
