import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { createAgentHarnessEmitter, type AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";
import {
  INERTIA_HOST_MCP_NAME,
  INERTIA_SECRET_MCP_NAME,
  INERTIA_WAIT_MCP_NAME,
  OPENCODE_SECRET_MCP_TIMEOUT_MS,
  OPENCODE_WAIT_HOST_TOOLS,
  OPENCODE_WAIT_MCP_TIMEOUT_MS,
  OPENCODE_WAIT_TOOL_WORK_MS,
} from "../../src/server/provider/host-tool-mcp-config";
import { HOST_TOOL_APPROVAL_TIMEOUT_MS } from "../../src/server/provider/host-tool-runtime";
import { AGENT_CONTEXT_TOOL_DEFINITION } from "../../src/server/runtime/agent-context-tool";
import { AGENT_THREAD_TOOL_DEFINITIONS } from "../../src/server/runtime/agent-thread-tool-definitions";
import { DELEGATION_WAIT_MAX_MS } from "../../src/shared/orchestration-delegation";
import { DELEGATED_WAIT_CALL_BUDGET_MS } from "../../src/server/runtime/delegation/task-wait";
import { createOpenCodeHostTools, openCodePermissions, type OpenCodeHostTools } from "../../src/server/provider/opencode-host-tools";
import {
  createOpenCodeInteractionState,
  handleOpenCodeInteractionEvent,
} from "../../src/server/provider/opencode-sdk-events";
import { OpenCodeRunOwnership } from "../../src/server/provider/opencode-run-ownership";
import { hostToolActivityTitle } from "../../src/shared/activity-display";
import { SECRET_REQUEST_TOOL_NAME, SECRET_REQUEST_WAIT_MS_BY_PROVIDER } from "../../src/node/agent-secrets";

interface AddedServer {
  name: string;
  config: { url: string; headers: Record<string, string>; timeout: number };
}

const installed: Array<{ tools: OpenCodeHostTools; client: OpencodeClient }> = [];

afterEach(async () => {
  await Promise.allSettled(installed.splice(0).map(({ tools, client }) => tools.cleanup(client)));
});

function definition(name: string): ProviderHostToolBridge["definitions"][number] {
  return {
    name,
    description: name,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    inputValidator: z.object({}).strict(),
    readOnly: true,
  };
}

function bridge(names: readonly string[]): ProviderHostToolBridge {
  return {
    definitions: names.map(definition),
    invoke: async (call) => ({ success: true, text: JSON.stringify({ tool: call.tool }) }),
  };
}

function fakeClient(added: AddedServer[], disconnected: string[]): OpencodeClient {
  return {
    mcp: {
      add: async (input: AddedServer) => {
        added.push(input);
        return { data: { [input.name]: { status: "connected" } } };
      },
      disconnect: async (input: { name: string }) => {
        disconnected.push(input.name);
        return { data: true };
      },
    },
  } as unknown as OpencodeClient;
}

async function install(names: readonly string[]) {
  const tools = createOpenCodeHostTools({
    bridge: bridge(names),
    conversationId: "conversation",
    turnId: "turn",
    cwd: "/project",
    onApproval: () => undefined,
    onApprovalResolved: () => undefined,
  })!;
  const added: AddedServer[] = [];
  const disconnected: string[] = [];
  const client = fakeClient(added, disconnected);
  installed.push({ tools, client });
  await tools.install(client, async (_label, operation) => await operation(new AbortController().signal));
  return { tools, client, added, disconnected };
}

async function rpc(server: AddedServer, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(server.config.url, {
    method: "POST",
    headers: { ...server.config.headers, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json() as Record<string, unknown>;
}

describe("OpenCode secret request MCP scope", () => {
  it("serves the secret request on its own long-wait server and keeps every other host tool on the short timeout", async () => {
    const { added } = await install(["inertia_list_conversations", SECRET_REQUEST_TOOL_NAME]);
    expect(added.map(({ name, config }) => [name, config.timeout])).toEqual([
      [INERTIA_HOST_MCP_NAME, 30_000],
      [INERTIA_SECRET_MCP_NAME, OPENCODE_SECRET_MCP_TIMEOUT_MS],
    ]);
    expect(OPENCODE_SECRET_MCP_TIMEOUT_MS).toBeGreaterThan(SECRET_REQUEST_WAIT_MS_BY_PROVIDER.opencode);
    const [main, secrets] = added as [AddedServer, AddedServer];
    expect(main.config.url).not.toBe(secrets.config.url);

    const mainTools = await rpc(main, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const secretTools = await rpc(secrets, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(mainTools).toMatchObject({ result: { tools: [{ name: "inertia_list_conversations" }] } });
    expect((mainTools.result as { tools: unknown[] }).tools).toHaveLength(1);
    expect(secretTools).toMatchObject({ result: { tools: [{ name: SECRET_REQUEST_TOOL_NAME }] } });
    expect((secretTools.result as { tools: unknown[] }).tools).toHaveLength(1);

    const misrouted = await rpc(main, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: SECRET_REQUEST_TOOL_NAME, arguments: {} },
    });
    expect(misrouted).toMatchObject({ error: { code: -32602 } });
    const crossed = await rpc(secrets, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "inertia_list_conversations", arguments: {} },
    });
    expect(crossed).toMatchObject({ error: { code: -32602 } });
    const served = await rpc(secrets, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: SECRET_REQUEST_TOOL_NAME, arguments: {} },
    });
    expect(served).toMatchObject({ result: { content: [{ type: "text", text: JSON.stringify({ tool: SECRET_REQUEST_TOOL_NAME }) }] } });
  });

  it("adds no second server when the turn has no secret tool, and redacts and disconnects every server it added", async () => {
    const plain = await install(["inertia_list_conversations"]);
    expect(plain.added.map(({ name }) => name)).toEqual([INERTIA_HOST_MCP_NAME]);

    const both = await install(["inertia_list_conversations", SECRET_REQUEST_TOOL_NAME]);
    const tokens = both.added.map(({ config }) => config.headers.Authorization!.replace("Bearer ", ""));
    const leaked = both.added.map(({ config }) => `${config.url} ${tokens.join(" ")}`).join(" ");
    expect(both.tools.redact(leaked)).not.toMatch(/http|[A-Za-z0-9_-]{40,}/u);
    expect(JSON.stringify(both.tools.redactPayload({ leaked }))).not.toContain(tokens[1]!);
    await both.tools.cleanup(both.client);
    expect(both.disconnected).toEqual([INERTIA_HOST_MCP_NAME, INERTIA_SECRET_MCP_NAME]);
  });

  it("allows both Inertia servers without a native prompt and labels the secret tool like other host tools", () => {
    const rules = openCodePermissions("supervised", "build");
    expect(rules.at(-1)).toEqual({ permission: `${INERTIA_SECRET_MCP_NAME}_*`, pattern: "*", action: "allow" });
    expect(rules).toContainEqual({ permission: `${INERTIA_HOST_MCP_NAME}_*`, pattern: "*", action: "allow" });
    expect(hostToolActivityTitle({ kind: "tool", title: `${INERTIA_SECRET_MCP_NAME}_${SECRET_REQUEST_TOOL_NAME}`, status: "running" }))
      .toBe("Asking for a secret");
  });

  it("serves tools that wait on the user or another chat from a server whose timeout covers an approval and the longest wait", async () => {
    const waiting = ["inertia_delegate_task", "inertia_wait_for_task", "inertia_request_context", "inertia_create_conversation"];
    const { added } = await install(["inertia_list_conversations", "inertia_get_task_status", ...waiting]);
    expect(added.map(({ name, config }) => [name, config.timeout])).toEqual([
      [INERTIA_HOST_MCP_NAME, 30_000],
      [INERTIA_WAIT_MCP_NAME, OPENCODE_WAIT_MCP_TIMEOUT_MS],
    ]);
    expect(OPENCODE_WAIT_MCP_TIMEOUT_MS).toBeGreaterThan(HOST_TOOL_APPROVAL_TIMEOUT_MS + DELEGATION_WAIT_MAX_MS);
    // A 45 s wait alone outlasts the main server's 30 s, so the wait tools stay on their own server.
    expect(DELEGATION_WAIT_MAX_MS).toBeGreaterThan(30_000);
    // The server also carries creation (an isolated worktree) and the 5 min context chooser after an approval, so its
    // timeout does not follow the delegated wait's maximum; the wait call keeps its own 375 s budget.
    expect(OPENCODE_WAIT_MCP_TIMEOUT_MS).toBe(HOST_TOOL_APPROVAL_TIMEOUT_MS + OPENCODE_WAIT_TOOL_WORK_MS + 60_000);
    expect(OPENCODE_WAIT_MCP_TIMEOUT_MS).toBe(960_000);
    expect(OPENCODE_WAIT_TOOL_WORK_MS).toBeGreaterThan(5 * 60_000 + DELEGATION_WAIT_MAX_MS);
    expect(DELEGATED_WAIT_CALL_BUDGET_MS.opencode).toBeLessThan(OPENCODE_WAIT_MCP_TIMEOUT_MS);
    const [main, waits] = added as [AddedServer, AddedServer];
    const names = async (server: AddedServer) => ((await rpc(server, { jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name).sort();
    expect(await names(main)).toEqual(["inertia_get_task_status", "inertia_list_conversations"]);
    expect(await names(waits)).toEqual([...waiting].sort());
    expect(await rpc(main, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "inertia_delegate_task", arguments: {} } }))
      .toMatchObject({ error: { code: -32602 } });
    expect(await rpc(waits, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "inertia_wait_for_task", arguments: {} } }))
      .toMatchObject({ result: { content: [{ type: "text", text: JSON.stringify({ tool: "inertia_wait_for_task" }) }] } });

    const rules = openCodePermissions("supervised", "build");
    expect(rules).toContainEqual({ permission: `${INERTIA_WAIT_MCP_NAME}_*`, pattern: "*", action: "allow" });
    expect(openCodePermissions("full", "build", "watcher"))
      .toContainEqual({ permission: `${INERTIA_WAIT_MCP_NAME}_*`, pattern: "*", action: "allow" });
  });

  it("lists only real approval-gated or waiting host tools as long waits, and adds no wait server without them", async () => {
    const known = new Set([...AGENT_THREAD_TOOL_DEFINITIONS.map(({ name }) => name), AGENT_CONTEXT_TOOL_DEFINITION.name]);
    for (const tool of OPENCODE_WAIT_HOST_TOOLS) expect(known.has(tool), tool).toBe(true);
    const plain = await install(["inertia_list_conversations", "inertia_get_task_status"]);
    expect(plain.added.map(({ name }) => name)).toEqual([INERTIA_HOST_MCP_NAME]);
  });

  it("auto-replies once in handleOpenCodeInteractionEvent for active Inertia host and secret MCP permissions only", () => {
    const replyPermission = vi.fn(async () => undefined);
    const replies = {
      permission: replyPermission,
      question: vi.fn(async () => undefined),
      rejectQuestion: vi.fn(async () => undefined),
    };
    const activeBridge = bridge(["inertia_list_conversations", SECRET_REQUEST_TOOL_NAME]);
    const runInteraction = (permission: string, hostTools: ProviderHostToolBridge | undefined, nativeId: string) => {
      const approvals = new Map();
      const inputs = new Map();
      const ownership = new OpenCodeRunOwnership("msg-1");
      ownership.acceptPrompt("msg-1");
      const emitter = createAgentHarnessEmitter("opencode", "conv-1", {}, "run-1", "turn-1", "/project");
      handleOpenCodeInteractionEvent(
        {
          type: "permission.v2.asked",
          properties: {
            id: nativeId,
            sessionID: "session-1",
            permission,
            patterns: ["*"],
          },
        } as never,
        {
          executable: "/fake/opencode",
          environment: {},
          hostTools,
          input: {
            providerId: "opencode",
            harnessId: "opencode-sdk",
            conversationId: "conv-1",
            runId: "run-1",
            turnId: "turn-1",
            cwd: "/project",
            prompt: "hi",
            interactionMode: "build",
            access: "supervised",
          },
          callbacks: {},
        } as unknown as AgentHarnessStartOptions,
        replies,
        emitter,
        approvals,
        inputs,
        createOpenCodeInteractionState(),
        { messageId: "msg-1", observed: true, activityObserved: false, workingActivityStarted: false },
        ownership,
        "root",
        () => undefined,
      );
      return approvals;
    };

    const secretApprovals = runInteraction(`${INERTIA_SECRET_MCP_NAME}_${SECRET_REQUEST_TOOL_NAME}`, activeBridge, "p1");
    expect(secretApprovals.size).toBe(0);
    expect(replyPermission).toHaveBeenCalledWith({ protocol: "v2", sessionId: "session-1", nativeId: "p1" }, "once");

    const hostApprovals = runInteraction(`${INERTIA_HOST_MCP_NAME}_inertia_list_conversations`, activeBridge, "p2");
    expect(hostApprovals.size).toBe(0);
    expect(replyPermission).toHaveBeenCalledWith({ protocol: "v2", sessionId: "session-1", nativeId: "p2" }, "once");

    replyPermission.mockClear();
    const foreignApprovals = runInteraction("other-mcp_inertia_request_secret", activeBridge, "p3");
    expect(foreignApprovals.size).toBe(1);
    expect(replyPermission).not.toHaveBeenCalled();

    const inactiveApprovals = runInteraction(`${INERTIA_SECRET_MCP_NAME}_${SECRET_REQUEST_TOOL_NAME}`, undefined, "p4");
    expect(inactiveApprovals.size).toBe(1);
    expect(replyPermission).not.toHaveBeenCalled();
  });

  it("tracks pending host tool calls and fires pause/re-arm callbacks cleanly", async () => {
    let release!: () => void;
    let started = 0;
    let settled = 0;
    const tools = createOpenCodeHostTools({
      bridge: {
        definitions: [definition(SECRET_REQUEST_TOOL_NAME)],
        invoke: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { success: true, text: "{}" };
        },
      },
      conversationId: "conversation",
      turnId: "turn",
      cwd: "/project",
      onApproval: () => undefined,
      onApprovalResolved: () => undefined,
      onCallStarted: () => { started += 1; },
      onCallsSettled: () => { settled += 1; },
    })!;
    const added: AddedServer[] = [];
    const client = fakeClient(added, []);
    installed.push({ tools, client });
    await tools.install(client, async (_label, operation) => await operation(new AbortController().signal));
    const secretServer = added.find(({ name }) => name === INERTIA_SECRET_MCP_NAME)!;

    expect(tools.hasPendingCalls()).toBe(false);
    const pendingRpc = rpc(secretServer, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: SECRET_REQUEST_TOOL_NAME, arguments: {} },
    });
    await vi.waitFor(() => expect(tools.hasPendingCalls()).toBe(true));
    expect(started).toBe(1);
    expect(settled).toBe(0);

    release();
    await pendingRpc;
    expect(tools.hasPendingCalls()).toBe(false);
    expect(settled).toBe(1);
  });
});
