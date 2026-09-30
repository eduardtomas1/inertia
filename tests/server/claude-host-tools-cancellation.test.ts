import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import {
  AGENT_BROWSER_TOOL_DEFINITIONS,
  AgentBrowserHostTools,
} from "../../src/server/runtime/agent-browser-host-tools";

const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
};

describe("Claude SDK list override keeps call-time checks", () => {
  it("propagates an MCP cancellation to the Browser request and reports owner mismatch", async () => {
    let seen: AbortSignal | undefined;
    const perform = vi.fn(async (_identity: unknown, _command: unknown, signal?: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false as const, code: "cancelled" as const, message: "cancelled" };
    });
    const browser = new AgentBrowserHostTools({ perform });
    let conversation = { id: identity.conversationId, accessMode: "full" } as Conversation;
    const runtime = new ProviderHostToolRuntime({
      bridge: {
        definitions: AGENT_BROWSER_TOOL_DEFINITIONS,
        invoke: (call) => browser.invoke(conversation, call, identity),
      },
      conversationId: "thread", turnId: "turn", cwd: "/project",
      onApproval: () => undefined, onApprovalResolved: () => undefined,
    });
    const tools = createClaudeHostTools(runtime);
    const client = new Client({ name: "inertia-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const controller = new AbortController();
      const call = client.callTool({ name: "inertia_browser_snapshot", arguments: {} }, undefined, { signal: controller.signal });
      await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());
      controller.abort();
      await expect(call).rejects.toThrow();
      await vi.waitFor(() => expect(seen?.aborted).toBe(true));

      conversation = { id: "55555555-5555-4555-8555-555555555555", accessMode: "full" } as Conversation;
      const denied = await client.callTool({ name: "inertia_browser_snapshot", arguments: {} });
      expect(JSON.stringify(denied)).toContain("invalid_owner");
      expect(perform).toHaveBeenCalledOnce();
    } finally {
      await tools.close();
      await client.close();
    }
  });
});
