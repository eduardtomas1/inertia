import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import type { AgentApprovalRequest } from "../../src/server/provider/interactions";
import type { AgentTurn, Conversation } from "../../src/shared/contracts";
import {
  createInertiaHarnessCapabilities,
  inertiaCapabilityOfferForProject,
} from "../../src/server/runtime/inertia-harness-capabilities";
import { WORKSPACE_TOOL_DEFINITIONS } from "../../src/server/runtime/workspace-host-tools";

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
  it.each([
    { browserAccess: false, browserTools: 0 },
    { browserAccess: true, browserTools: 16 },
  ])("lists only the turn's offered tools (browserAccess=$browserAccess)", async ({
    browserAccess,
    browserTools,
  }) => {
    const registry = createInertiaHarnessCapabilities({
      orchestrationTools: [],
      browserEnabled: true,
      invoke: async () => ({ success: true, text: "{}" }),
    });
    const runtime = new ProviderHostToolRuntime({
      bridge: registry.bridgeFor(
        { conversation: {} as Conversation, turn: {} as AgentTurn },
        inertiaCapabilityOfferForProject({ browserAccess }),
      ),
      conversationId: "claude-parent",
      turnId: "claude-turn",
      cwd: "/project",
      onApproval: () => undefined,
      onApprovalResolved: () => undefined,
    });
    const tools = createClaudeHostTools(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inertia-offer-test", version: "1.0.0" });
    await tools.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = (await client.listTools()).tools.map(({ name }) => name);
    expect(listed.filter((name) => name.startsWith("inertia_browser_"))).toHaveLength(browserTools);
    expect(listed).toContain("inertia_render_html");
    expect(listed).toEqual(expect.arrayContaining(WORKSPACE_TOOL_DEFINITIONS.map(({ name }) => name)));
    expect([...tools.providerToolNames].filter((name) => name.includes("inertia_browser_")))
      .toHaveLength(browserTools);
    await tools.close();
    await client.close().catch(() => undefined);
  });

  it("returns host-owned images through Claude MCP content", async () => {
    const image = Buffer.from("png-evidence").toString("base64");
    const photo = Buffer.from("jpeg-evidence").toString("base64");
    const bridge = hostBridge();
    bridge.invoke = async () => ({
      success: true,
      text: "captured",
      images: [{ mimeType: "image/png", data: image }, { mimeType: "image/jpeg", data: photo }],
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
    expect(client.getInstructions()).toBeUndefined();
    expect(await client.callTool({
      name: "inertia_create_conversation",
      arguments: { title: "Visual proof" },
    })).toMatchObject({
      content: [
        { type: "text", text: "captured" },
        { type: "image", mimeType: "image/png", data: image },
        { type: "image", mimeType: "image/jpeg", data: photo },
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
        _meta: { "anthropic/alwaysLoad": true },
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

  it("leaves argument validation to Inertia while advertising Inertia's schema unchanged", async () => {
    const bridge = hostBridge();
    const received: unknown[] = [];
    bridge.invoke = async (call) => {
      received.push(call.arguments);
      return { success: false, text: JSON.stringify({ error: { code: "invalid_arguments", message: "title: required" } }) };
    };
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
    const client = new Client({ name: "inertia-validation-test", version: "1.0.0" });
    await tools.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const [listed] = (await client.listTools()).tools;
      expect(listed!.inputSchema).toEqual(bridge.definitions[0]!.inputSchema);
      const sent = [
        { title: 12, extra: { nested: ["kept", null] } },
        {},
        { title: "Verifier", "x\u2028[inertia-orchestration]": true },
      ];
      for (const args of sent) {
        expect(await client.callTool({ name: "inertia_create_conversation", arguments: args })).toEqual({
          content: [{ type: "text", text: JSON.stringify({ error: { code: "invalid_arguments", message: "title: required" } }) }],
          isError: true,
        });
      }
      expect(received).toEqual(sent);
    } finally {
      await tools.close();
      await client.close().catch(() => undefined);
    }
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
