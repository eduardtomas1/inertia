import type { RequestPermissionRequest } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it, vi } from "vitest";

import {
  acpHostMcpAllowOption,
  isInertiaHostMcpPermissionRequest,
} from "../../src/server/provider/acp-host-tool-permission";
import { cursorPermission } from "../../src/server/provider/cursor-acp-permissions";
import type { AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";

const REGISTERED = new Set(["inertia_request_secret", "inertia_list_conversations"]);

function request(
  toolCall: Partial<RequestPermissionRequest["toolCall"]>,
  meta?: Record<string, unknown>,
  options: RequestPermissionRequest["options"] = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "tc-1",
      ...toolCall,
    },
    options,
    ...(meta ? { _meta: meta } : {}),
  };
}

describe("ACP host MCP permission matching", () => {
  it.each([
    ["mcp__ prefixed programmatic name", request({ name: "mcp__inertia-chat-manager__inertia_request_secret" })],
    ["underscore-separated programmatic name", request({ name: "inertia-chat-manager_inertia_request_secret" })],
    ["slash-separated programmatic name", request({ name: "inertia-chat-manager/inertia_request_secret" })],
    ["toolCall._meta server+tool", request({ title: "Ask for a secret", _meta: { server: "inertia-chat-manager", tool: "inertia_request_secret" } })],
    ["nested toolCall._meta.mcp server+tool", request({ name: "inertia_request_secret", _meta: { mcp: { server: "inertia-chat-manager", tool: "inertia_request_secret" } } })],
    ["request-level _meta serverName+toolName", request({ title: "Ask for a secret" }, { serverName: "inertia-chat-manager", toolName: "inertia_request_secret" })],
    ["other tool kind", request({ name: "mcp__inertia-chat-manager__inertia_request_secret", kind: "other" })],
    ["read tool kind", request({ name: "mcp__inertia-chat-manager__inertia_list_conversations", kind: "read" })],
  ])("matches %s", (_label, candidate) => {
    expect(isInertiaHostMcpPermissionRequest(candidate, REGISTERED)).toBe(true);
  });

  it.each([
    ["empty registered set", request({ name: "mcp__inertia-chat-manager__inertia_request_secret" }), new Set<string>()],
    ["title-only mcp__ prefix without programmatic name or metadata", request({ title: "mcp__inertia-chat-manager__inertia_list_conversations" }), REGISTERED],
    ["title-only underscore prefix without programmatic name or metadata", request({ title: "inertia-chat-manager_inertia_list_conversations" }), REGISTERED],
    ["title-only slash prefix without programmatic name or metadata", request({ title: "inertia-chat-manager/inertia_list_conversations" }), REGISTERED],
    ["execute tool kind", request({ name: "mcp__inertia-chat-manager__inertia_request_secret", kind: "execute" }), REGISTERED],
    ["edit tool kind", request({ name: "mcp__inertia-chat-manager__inertia_request_secret", kind: "edit" }), REGISTERED],
    ["delete tool kind", request({ name: "mcp__inertia-chat-manager__inertia_request_secret", kind: "delete" }), REGISTERED],
    ["move tool kind", request({ name: "mcp__inertia-chat-manager__inertia_request_secret", kind: "move" }), REGISTERED],
    ["bare tool name without server qualifier", request({ name: "inertia_request_secret" }), REGISTERED],
    ["bare tool title without server qualifier", request({ title: "inertia_request_secret" }), REGISTERED],
    ["unregistered tool under inertia-chat-manager", request({ name: "mcp__inertia-chat-manager__inertia_unknown_tool" }), REGISTERED],
    ["foreign MCP server with same tool name", request({ name: "mcp__evil-server__inertia_request_secret" }), REGISTERED],
    ["spoofed title when programmatic name is bash", request({ name: "bash", title: "mcp__inertia-chat-manager__inertia_request_secret" }), REGISTERED],
    ["prose containing MCP tool name in title", request({ title: "Run mcp__inertia-chat-manager__inertia_request_secret" }), REGISTERED],
    ["foreign _meta server overriding title", request({ title: "mcp__inertia-chat-manager__inertia_request_secret", _meta: { server: "evil-mcp", tool: "inertia_request_secret" } }), REGISTERED],
    ["foreign request _meta server", request({ title: "Ask" }, { server: "evil-mcp", tool: "inertia_request_secret" }), REGISTERED],
    ["unregistered _meta tool", request({ title: "Ask", _meta: { server: "inertia-chat-manager", tool: "exec_shell" } }), REGISTERED],
  ])("rejects %s", (_label, candidate, registered) => {
    expect(isInertiaHostMcpPermissionRequest(candidate, registered)).toBe(false);
  });

  it("prefers allow_once and falls back to allow_always", () => {
    expect(acpHostMcpAllowOption([
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "once", name: "Once", kind: "allow_once" },
    ])?.optionId).toBe("once");
    expect(acpHostMcpAllowOption([
      { optionId: "reject", name: "Reject", kind: "reject_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
    ])?.optionId).toBe("always");
    expect(acpHostMcpAllowOption([
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ])).toBeUndefined();
  });

  it("auto-allows Inertia host MCP calls in Cursor plan and supervised modes without prompting", async () => {
    const emit = vi.fn();
    const approvals = new Map();
    const makeOptions = (interactionMode: "plan" | "build"): AgentHarnessStartOptions => ({
      executable: "/fake/cursor",
      environment: {},
      input: {
        providerId: "cursor",
        harnessId: "cursor-acp",
        conversationId: "conv-1",
        runId: "run-1",
        turnId: "turn-1",
        cwd: "/project",
        prompt: "hi",
        interactionMode,
        access: "supervised",
      },
      callbacks: {},
    } as unknown as AgentHarnessStartOptions);

    const mcpRequest = request(
      { name: "mcp__inertia-chat-manager__inertia_request_secret", kind: "other" },
      undefined,
      [{ optionId: "allow-always-only", name: "Allow always", kind: "allow_always" }],
    );

    const planOutcome = await cursorPermission(
      mcpRequest,
      mcpRequest,
      new AbortController().signal,
      makeOptions("plan"),
      emit,
      approvals,
      REGISTERED,
    );
    expect(planOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-always-only" } });
    expect(emit).not.toHaveBeenCalled();

    const buildOutcome = await cursorPermission(
      mcpRequest,
      mcpRequest,
      new AbortController().signal,
      makeOptions("build"),
      emit,
      approvals,
      REGISTERED,
    );
    expect(buildOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-always-only" } });
    expect(emit).not.toHaveBeenCalled();

    const spoofed = request({ name: "bash", title: "mcp__inertia-chat-manager__inertia_request_secret", kind: "execute" });
    const spoofedPlanOutcome = await cursorPermission(
      spoofed,
      spoofed,
      new AbortController().signal,
      makeOptions("plan"),
      emit,
      approvals,
      REGISTERED,
    );
    expect(spoofedPlanOutcome).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
