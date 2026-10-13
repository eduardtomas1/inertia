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
});
