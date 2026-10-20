import { describe, expect, it } from "vitest";

import {
  createAgentHarnessEmitter,
  type AgentHarnessEvent,
} from "../../src/server/provider/agent-harness";
import { ClaudePermissionBroker } from "../../src/server/provider/claude-permission-broker";
import { INERTIA_HOST_MCP_NAME } from "../../src/server/provider/host-tool-mcp-config";
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

function watcherBroker(events: AgentHarnessEvent[], readOnlyProfile: "watcher" | null = "watcher"): ClaudePermissionBroker {
  return new ClaudePermissionBroker({
    input: {
      ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-permission-broker-watcher",
        cwd: "/workspace",
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
    "rg -n parse src",
    "cat /workspace/src/parser.ts",
  ])("runs the read-only command %s for a watcher without an approval", async (command) => {
    const events: AgentHarnessEvent[] = [];
    const input = { command, description: "Inspect the work" };
    await expect(watcherBroker(events).canUseTool("Bash", input, callbackOptions()))
      .resolves.toEqual({ behavior: "allow", updatedInput: input });
    expect(events).toEqual([]);
  });

  it.each([
    ["a command outside the allowlist", { command: "npm test" }, {}],
    ["a redirect", { command: "git diff > out.txt" }, {}],
    ["a read outside the workspace", { command: "cat /etc/passwd" }, {}],
    ["a background command", { command: "git diff", run_in_background: true }, {}],
    ["a command outside Claude's sandbox", { command: "git diff", dangerouslyDisableSandbox: true }, {}],
    ["a path Claude flagged", { command: "cat src/parser.ts" }, { blockedPath: "/elsewhere/parser.ts" }],
    ["a command that is not text", { command: ["git", "diff"] }, {}],
  ])("keeps the approval path for %s in a watcher turn", async (_label, input, extra) => {
    const events: AgentHarnessEvent[] = [];
    const permissions = watcherBroker(events);
    const decision = permissions.canUseTool("Bash", input, callbackOptions(extra));
    await expect.poll(() => approvalRequests(events).length).toBe(1);
    const [request] = approvalRequests(events);
    expect(request).toMatchObject({ kind: "command" });
    expect(permissions.settleApproval(request!.requestId, "deny")).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "deny", message: "User declined tool execution." });
  });

  it("asks before an allowlisted command outside a watcher turn and before a host-served Bash tool", async () => {
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
  ])("keeps a watcher's %s on the approval path", async (toolName, input) => {
    const events: AgentHarnessEvent[] = [];
    const permissions = watcherBroker(events);
    const decision = permissions.canUseTool(toolName, input, callbackOptions());
    await expect.poll(() => approvalRequests(events).length).toBe(1);
    const [request] = approvalRequests(events);
    expect(request).toMatchObject({ kind: "file-change" });
    expect(permissions.settleApproval(request!.requestId, "deny")).toBe(true);
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  });
});

