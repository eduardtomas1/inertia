import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import {
  INERTIA_HOST_MCP_NAME,
  INERTIA_SECRET_MCP_NAME,
  OPENCODE_SECRET_MCP_TIMEOUT_MS,
} from "../../src/server/provider/host-tool-mcp-config";
import { createOpenCodeHostTools, openCodePermissions, type OpenCodeHostTools } from "../../src/server/provider/opencode-host-tools";
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
});
