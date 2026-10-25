import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgentHarnessEmitter,
  type AgentHarnessEvent,
} from "../../src/server/provider/agent-harness";
import { ClaudePermissionBroker } from "../../src/server/provider/claude-permission-broker";
import {
  CLAUDE_WATCHER_PLAN_REFUSAL,
  CLAUDE_WATCHER_QUESTION_REFUSAL,
  CLAUDE_WATCHER_READ_REFUSAL,
  CLAUDE_WATCHER_WRITE_REFUSAL,
  claudeWatcherDecision,
  claudeWatcherToolRefusal,
} from "../../src/server/provider/claude-watcher-permissions";
import { readOnlyCommandReminder } from "../../src/server/runtime/watcher/read-only-commands";
import { INERTIA_HOST_MCP_NAME } from "../../src/server/provider/host-tool-mcp-config";
import { portableFixtureRoot } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const HOST_TOOL = `mcp__${INERTIA_HOST_MCP_NAME}__inertia_create_conversation`;

function broker(
  providerNativeToolsAvailable: boolean,
  interactionMode: "build" | "plan" = "build",
  events: AgentHarnessEvent[] = [],
): ClaudePermissionBroker {
  return new ClaudePermissionBroker({
    input: nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-permission-broker",
      cwd: "/workspace",
      prompt: "Use the tools",
      interactionMode,
      access: "supervised",
    }),
    emitter: createAgentHarnessEmitter(
      "claude",
      "claude-permission-broker",
      { onEvent: (event) => events.push(event) },
      "claude-permission-broker-run",
      "claude-permission-broker-turn",
    ),
    providerNativeToolsAvailable,
    hostToolNames: new Set([HOST_TOOL]),
    cancelled: () => false,
  });
}

function watcherBroker(
  events: AgentHarnessEvent[],
  readOnlyProfile: "watcher" | null = "watcher",
  cwd = "/workspace",
): ClaudePermissionBroker {
  return new ClaudePermissionBroker({
    input: {
      ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-permission-broker-watcher",
        cwd,
        prompt: "Review the work",
        interactionMode: "plan",
        access: "supervised",
      }),
      ...(readOnlyProfile ? { readOnlyProfile } : {}),
    },
    emitter: createAgentHarnessEmitter(
      "claude",
      "claude-permission-broker-watcher",
      { onEvent: (event) => events.push(event) },
      "claude-permission-broker-run",
      "claude-permission-broker-turn",
    ),
    providerNativeToolsAvailable: true,
    hostToolNames: new Set([HOST_TOOL]),
    cancelled: () => false,
  });
}

function approvalRequests(events: readonly AgentHarnessEvent[]): Array<{ requestId: string; kind: string; command?: string }> {
  return events.flatMap((event) => event.type === "extension"
    && event.extension === "claude-agent-sdk"
    && event.event.type === "approval"
    ? [event.event.request]
    : []);
}

function callbackOptions(extra: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: "tool-use",
    requestId: "permission",
    ...extra,
  };
}

describe("Claude permission broker", () => {
  it.each([
    ["the in-process SDK server", { mcpServer: { name: INERTIA_HOST_MCP_NAME, source: "sdk" } }, "allow"],
    ["a CLI that does not report the server", {}, "allow"],
    ["a configured server with the same name", { mcpServer: { name: INERTIA_HOST_MCP_NAME, source: "project" } }, "deny"],
    ["another SDK server", { mcpServer: { name: "other", source: "sdk" } }, "deny"],
  ])("trusts an Inertia host tool name from %s only when Inertia serves it", async (_label, extra, behavior) => {
    await expect(broker(false).canUseTool(HOST_TOOL, { title: "New chat" }, callbackOptions(extra)))
      .resolves.toMatchObject({ behavior });
  });

  it.each([
    [{ questions: [] }, "Claude sent an empty question request."],
    [{ questions: "Which scope?" }, "Claude sent an invalid question request."],
  ])("denies a malformed question request instead of failing the callback", async (input, message) => {
    await expect(broker(true).canUseTool("AskUserQuestion", input, callbackOptions()))
      .resolves.toEqual({ behavior: "deny", message });
  });

  it.each([
    ["TodoWrite", { todos: [{ content: "Ship", status: "in_progress", activeForm: "Shipping" }] }],
    ["TaskCreate", { subject: "Ship", description: "Ship the change" }],
    ["TaskUpdate", { taskId: "1", status: "completed" }],
    ["TaskList", {}],
    ["TaskGet", { taskId: "1" }],
  ] as const)("lets Claude keep its own %s checklist without asking the user", async (toolName, input) => {
    for (const mode of ["build", "plan"] as const) {
      const events: AgentHarnessEvent[] = [];
      await expect(broker(true, mode, events).canUseTool(toolName, input, callbackOptions()))
        .resolves.toEqual({ behavior: "allow", updatedInput: input });
      expect(events).toEqual([]);
    }
    await expect(broker(false).canUseTool(toolName, input, callbackOptions()))
      .resolves.toMatchObject({ behavior: "deny" });
  });

  it.each([
    "git diff --stat",
    "git log --oneline | head -5",
    "cat /workspace/src/parser.ts",
  ])("runs the read-only command %s for a watcher without an approval", async (command) => {
    const events: AgentHarnessEvent[] = [];
    const input = { command, description: "Inspect the work" };
    await expect(watcherBroker(events).canUseTool("Bash", input, callbackOptions()))
      .resolves.toEqual({ behavior: "allow", updatedInput: input });
    expect(events).toEqual([]);
  });

  it.each([
    ["rg -n parse src", "rg --no-config -n parse src"],
    ["git log --oneline | rg fix", "git log --oneline | rg --no-config fix"],
  ])("runs the ripgrep command %s for a watcher without its configuration file", async (command, rewritten) => {
    const events: AgentHarnessEvent[] = [];
    const input = { command, description: "Search the work" };
    await expect(watcherBroker(events).canUseTool("Bash", input, callbackOptions()))
      .resolves.toEqual({ behavior: "allow", updatedInput: { command: rewritten, description: "Search the work" } });
    expect(events).toEqual([]);
  });

  async function declinedThroughRuntime(
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    cwd = "/workspace",
    decision: "deny" | "approve" = "deny",
  ) {
    const events: AgentHarnessEvent[] = [];
    const permissions = watcherBroker(events, "watcher", cwd);
    const result = permissions.canUseTool(toolName, input, callbackOptions(extra));
    await expect.poll(() => approvalRequests(events).length).toBe(1);
    const [request] = approvalRequests(events);
    expect(permissions.settleApproval(request!.requestId, decision)).toBe(true);
    return { request: request!, result: await result, events };
  }

  it("declines a watcher command that follows a link out of the workspace and tells Claude why", async () => {
    const root = portableFixtureRoot("broker watcher link");
    try {
      const workspace = join(root, "workspace");
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(join(root, "outside"));
      writeFileSync(join(workspace, "src", "parser.ts"), "export {};\n");
      writeFileSync(join(root, "outside", "secret.txt"), "outside\n");
      symlinkSync(join(root, "outside"), join(workspace, "linked"), "junction");
      const events: AgentHarnessEvent[] = [];
      const readInside = { command: "cat src/parser.ts" };
      await expect(watcherBroker(events, "watcher", workspace).canUseTool("Bash", readInside, callbackOptions()))
        .resolves.toEqual({ behavior: "allow", updatedInput: readInside });
      expect(events).toEqual([]);
      const { request, result } = await declinedThroughRuntime("Bash", { command: "cat linked/secret.txt" }, {}, workspace);
      expect(request).toMatchObject({ kind: "command" });
      expect(result).toEqual({
        behavior: "deny",
        message: `The command reads outside the workspace. ${readOnlyCommandReminder("posix")}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a command outside the allowlist", { command: "npm test" }, {}, "npm is not a read-only command watchers can run."],
    ["a redirect", { command: "git diff > out.txt" }, {}, "The command uses shell syntax that watchers cannot run."],
    ["a read outside the workspace", { command: "cat /etc/passwd" }, {}, "The command reads outside the workspace."],
    ["a background command", { command: "git diff", run_in_background: true }, {}, "Watchers can't run commands in the background."],
    ["a command outside Claude's sandbox", { command: "git diff", dangerouslyDisableSandbox: true }, {}, "Watchers can't run commands outside the sandbox."],
    ["a path Claude flagged", { command: "cat src/parser.ts" }, { blockedPath: "/elsewhere/parser.ts" }, "The command reads outside the workspace."],
    ["a command that is not text", { command: ["git", "diff"] }, {}, "The command was not text."],
    ["an in-place sed", { command: "sed -i 's/a/b/' src/parser.ts" }, {}, "sed can only print line ranges in a watcher"],
  ])("declines %s through the runtime with the allowlist's reason", async (_label, input, extra, reason) => {
    const { request, result } = await declinedThroughRuntime("Bash", input, extra);
    expect(request).toMatchObject({ kind: "command" });
    expect(result).toMatchObject({ behavior: "deny" });
    const message = (result as { message: string }).message;
    expect(message.startsWith(reason)).toBe(true);
    expect(message.endsWith(readOnlyCommandReminder("posix"))).toBe(true);
    expect(message).not.toContain("User declined tool execution.");
  });

  it("keeps the watcher reason when Claude's approval display text is unsafe", async () => {
    const events: AgentHarnessEvent[] = [];
    await expect(watcherBroker(events).canUseTool("Bash", { command: "npm test" }, callbackOptions({ title: "Run\u0000it" })))
      .resolves.toEqual({ behavior: "deny", message: `npm is not a read-only command watchers can run. ${readOnlyCommandReminder("posix")}` });
    expect(approvalRequests(events)).toEqual([]);
  });

  it("keeps declining a watcher request even if the runtime approves it", async () => {
    const { result } = await declinedThroughRuntime("Bash", { command: "npm test" }, {}, "/workspace", "approve");
    expect(result).toMatchObject({ behavior: "deny" });
  });

  it("asks before an allowlisted command outside a watcher turn and declines a host-served Bash tool in one", async () => {
    for (const [profile, extra] of [[null, {}], ["watcher", { mcpServer: { name: "other", source: "sdk" } }]] as const) {
      const events: AgentHarnessEvent[] = [];
      const permissions = watcherBroker(events, profile);
      const decision = permissions.canUseTool("Bash", { command: "git diff" }, callbackOptions(extra));
      await expect.poll(() => approvalRequests(events).length).toBe(1);
      expect(permissions.settleApproval(approvalRequests(events)[0]!.requestId, "deny")).toBe(true);
      await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    }
  });

  it.each([
    ["Write", { file_path: "/workspace/src/parser.ts", content: "" }],
    ["Edit", { file_path: "/workspace/src/parser.ts", old_string: "a", new_string: "b" }],
    ["MultiEdit", { file_path: "/workspace/src/parser.ts", edits: [] }],
    ["NotebookEdit", { notebook_path: "/workspace/notes.ipynb", new_source: "" }],
  ])("declines a watcher's %s as a write attempt and tells Claude to report instead", async (toolName, input) => {
    const { request, result } = await declinedThroughRuntime(toolName, input);
    expect(request).toMatchObject({ kind: "file-change" });
    expect(result).toEqual({ behavior: "deny", message: CLAUDE_WATCHER_WRITE_REFUSAL });
  });

  it("declines a watcher's question at once without asking the user or the runtime", async () => {
    const events: AgentHarnessEvent[] = [];
    await expect(watcherBroker(events).canUseTool("AskUserQuestion", {
      questions: [{ question: "Which file?", header: "Scope", options: [{ label: "A", description: "a" }], multiSelect: false }],
    }, callbackOptions())).resolves.toEqual({ behavior: "deny", message: CLAUDE_WATCHER_QUESTION_REFUSAL });
    expect(events).toEqual([]);
  });

  it("keeps a watcher's plan hand-off as the plan and declines leaving or entering plan mode", async () => {
    const exit = await declinedThroughRuntime("ExitPlanMode", { plan: "- risk: retries never back off" });
    expect(exit.events.some((event) => event.type === "extension" && event.event.type === "plan")).toBe(true);
    expect(exit.request).toMatchObject({ kind: "permissions" });
    expect(exit.result).toEqual({ behavior: "deny", message: CLAUDE_WATCHER_PLAN_REFUSAL });
    const enter = await declinedThroughRuntime("EnterPlanMode", {});
    expect(enter.result).toEqual({ behavior: "deny", message: CLAUDE_WATCHER_PLAN_REFUSAL });
  });

  it.each([
    ["WebFetch", { url: "https://example.com", prompt: "read" }, {}],
    ["WebSearch", { query: "x" }, {}],
    ["Task", { description: "explore", prompt: "go" }, {}],
    ["Agent", { description: "explore", prompt: "go" }, {}],
    ["mcp__github__create_issue", { title: "x" }, { mcpServer: { name: "github", source: "project" } }],
    ["SomethingNew", {}, {}],
  ])("declines the watcher tool %s with a reason and not as a write", async (toolName, input, extra) => {
    const { request, result } = await declinedThroughRuntime(toolName, input, extra);
    expect(request).toMatchObject({ kind: "permissions" });
    expect(result).toEqual({ behavior: "deny", message: claudeWatcherToolRefusal(toolName) });
  });
});

describe("Claude watcher decisions", () => {
  const decide = (toolName: string, toolInput: Record<string, unknown>, cwd: string, platform: NodeJS.Platform = process.platform) =>
    claudeWatcherDecision({ toolName, toolInput, cwd, mcpServer: false, blockedPath: undefined, platform });

  it("checks PowerShell paths by the host's path rules", async () => {
    await expect(decide("PowerShell", { command: "cat '/work/repo/src/a.ts'" }, "/work/repo", "linux")).resolves.toMatchObject({ kind: "allow" });
    await expect(decide("PowerShell", { command: "cat '/etc/passwd'" }, "/work/repo", "linux")).resolves.toMatchObject({
      kind: "decline", message: expect.stringContaining("The command reads outside the workspace."),
    });
  });

  it("treats Claude's Bash as a POSIX shell on Windows and PowerShell by the Windows rules", async () => {
    const root = portableFixtureRoot("claude watcher shells");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "parser.ts"), "export {};\n");
      for (const command of ["rg -n \"parse input\" src", "git log --oneline 2>/dev/null | head -5"]) {
        await expect(decide("Bash", { command }, root, "win32")).resolves.toMatchObject({ kind: "allow" });
        await expect(decide("PowerShell", { command }, root, "win32")).resolves.toMatchObject({
          kind: "decline",
          approval: "command",
          message: expect.stringContaining(readOnlyCommandReminder("windows")),
        });
      }
      await expect(decide("Bash", { command: "sed -n '1,5p' src/parser.ts" }, root, "win32")).resolves.toMatchObject({ kind: "allow" });
      await expect(decide("PowerShell", { command: "sed -n '1,5p' src/parser.ts" }, root, "win32")).resolves.toMatchObject({ kind: "allow" });
      await expect(decide("PowerShell", { command: "rg -n 'parse input' src" }, root, "win32")).resolves.toEqual({
        kind: "allow",
        updatedInput: { command: "rg --no-config -n 'parse input' src" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a routed read run only inside the workspace and never on an environment file", async () => {
    const root = portableFixtureRoot("claude watcher reads");
    try {
      const workspace = join(root, "workspace");
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(join(root, "outside"));
      writeFileSync(join(workspace, "src", "parser.ts"), "export {};\n");
      writeFileSync(join(workspace, ".env"), "SECRET=1\n");
      writeFileSync(join(root, "outside", "secret.txt"), "outside\n");
      await expect(decide("Read", { file_path: join(workspace, "src", "parser.ts") }, workspace)).resolves.toMatchObject({ kind: "allow" });
      await expect(decide("Grep", { pattern: "parse", path: "src" }, workspace)).resolves.toMatchObject({ kind: "allow" });
      await expect(decide("Glob", { pattern: "**/*.ts" }, workspace)).resolves.toMatchObject({ kind: "allow" });
      await expect(decide("Grep", { pattern: "process.env.API_URL", path: "src" }, workspace)).resolves.toMatchObject({ kind: "allow" });
      await expect(decide("Glob", { pattern: "src/environment*.ts" }, workspace)).resolves.toMatchObject({ kind: "allow" });
      for (const [toolName, input] of [
        ["Read", { file_path: join(root, "outside", "secret.txt") }],
        ["Read", { file_path: join(workspace, ".env") }],
        ["LS", { path: join(root, "outside") }],
        ["Glob", { pattern: "../outside/*" }],
        ["Glob", { pattern: "**/.env" }],
        ["Glob", { pattern: "config/*.env.*" }],
        ["Grep", { pattern: "KEY", glob: ".env*" }],
        ["Grep", { pattern: "KEY", type: "env" }],
        ["Grep", { pattern: "KEY", path: ".env" }],
      ] as const) {
        await expect(decide(toolName, input, workspace)).resolves.toEqual({
          kind: "decline", approval: "permissions", message: CLAUDE_WATCHER_READ_REFUSAL,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
