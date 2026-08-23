import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import type { AgentApprovalRequest } from "../../src/server/provider/interactions";

function hostBridge(): ProviderHostToolBridge {
  return {
    definitions: [{
      name: "inertia_create_conversation",
      description: "Create one independent Inertia chat.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string", maxLength: 120 } },
        required: ["title"],
      },
      inputValidator: z.object({ title: z.string().min(1).max(120) }).strict(),
      readOnly: false,
    }],
    invoke: async (call) => {
      const decision = await call.requestApproval({
        title: "Create chat",
        detail: "Create one chat.",
        reason: "Requested by Claude.",
        permissionRoots: [],
      });
      return decision === "approve"
        ? { success: true, text: JSON.stringify({ created: true }) }
        : { success: false, text: decision };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Condition was not observed.");
}

describe("Claude in-process Inertia chat tools", () => {
  it("returns host-owned PNG evidence through Claude MCP content", async () => {
    const image = Buffer.from("png-evidence").toString("base64");
    const bridge = hostBridge();
    bridge.invoke = async () => ({
      success: true,
      text: "captured",
      image: { mimeType: "image/png", data: image },
    });
    const runtime = new ProviderHostToolRuntime({
      bridge,
      conversationId: "claude-parent",
      turnId: "claude-turn",
      cwd: "/project",
      onApproval: () => undefined,
      onApprovalResolved: () => undefined,
    });
    const tools = createClaudeHostTools(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inertia-image-test", version: "1.0.0" });
    await tools.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    expect(await client.callTool({
      name: "inertia_create_conversation",
      arguments: { title: "Visual proof" },
    })).toMatchObject({
      content: [
        { type: "text", text: "captured" },
        { type: "image", mimeType: "image/png", data: image },
      ],
    });
    await tools.close();
    await client.close().catch(() => undefined);
  });

  it("executes a real SDK MCP call with one host-owned approval and closes exactly", async () => {
    const approvals: AgentApprovalRequest[] = [];
    const resolved: Array<[string, string]> = [];
    const runtime = new ProviderHostToolRuntime({
      bridge: hostBridge(),
      conversationId: "claude-parent",
      turnId: "claude-turn",
      cwd: "/project",
      onApproval: (request) => approvals.push(request),
      onApprovalResolved: (requestId, decision) => resolved.push([requestId, decision]),
    });
    const tools = createClaudeHostTools(runtime);
    expect(tools.providerToolNames).toEqual(new Set([
      "mcp__inertia-chat-manager__inertia_create_conversation",
    ]));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inertia-test", version: "1.0.0" });
    await tools.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    expect(await client.listTools()).toMatchObject({
      tools: [{
        name: "inertia_create_conversation",
        annotations: { readOnlyHint: false },
      }],
    });
    const call = client.callTool({
      name: "inertia_create_conversation",
      arguments: { title: "Verifier" },
    });
    await waitFor(() => approvals.length === 1);
    expect(runtime.respondToApproval(approvals[0]!.requestId, "approve")).toBe(true);
    expect(await call).toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ created: true }) }],
    });
    expect(approvals).toHaveLength(1);
    expect(resolved).toEqual([[approvals[0]!.requestId, "approve"]]);
    const terminalClose = tools.close();
    const concurrentClose = tools.close();
    expect(concurrentClose).toBe(terminalClose);
    await terminalClose;
    expect(runtime.isSettled()).toBe(true);
    await expect(client.listTools()).rejects.toThrow();
    await client.close().catch(() => undefined);
  });

  it("shares one close rejection across concurrent cleanup callers", async () => {
    const runtime = new ProviderHostToolRuntime({
      bridge: hostBridge(),
      conversationId: "claude-parent",
      turnId: "claude-turn",
      cwd: "/project",
      onApproval: () => undefined,
      onApprovalResolved: () => undefined,
    });
    const tools = createClaudeHostTools(runtime);
    vi.spyOn(tools.config.instance, "close")
      .mockRejectedValue(new Error("fixture close failure"));
    const cancelClose = tools.close();
    const terminalClose = tools.close();
    expect(terminalClose).toBe(cancelClose);
    await expect(cancelClose).rejects.toThrow("fixture close failure");
    await expect(terminalClose).rejects.toThrow("fixture close failure");
    expect(runtime.isSettled()).toBe(true);
  });
});
