import { describe, expect, it, vi } from "vitest";

import { parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import type { Conversation } from "../../src/shared/contracts";
import { RuntimeAgentBrowserBrokerClient } from "../../src/server/runtime/agent-browser-broker-client";
import {
  AGENT_BROWSER_TOOL_DEFINITIONS,
  AgentBrowserHostTools,
} from "../../src/server/runtime/agent-browser-host-tools";

const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
};
const emoji = "\u{1F600}";

function invoke(tool: string, args: Record<string, unknown>) {
  const posted: unknown[] = [];
  const broker = new RuntimeAgentBrowserBrokerClient((event) => { posted.push(event); }, 1_000);
  const tools = new AgentBrowserHostTools(broker);
  const controller = new AbortController();
  const pending = tools.invoke(
    { id: identity.conversationId, accessMode: "full" } as Conversation,
    {
      providerThreadId: "thread", providerTurnId: "turn", toolCallId: "call", tool,
      arguments: args, signal: controller.signal, requestApproval: vi.fn(),
    },
    identity,
  );
  return { posted, broker, controller, pending };
}

async function postedEvent(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const { posted, broker, controller, pending } = invoke(tool, args);
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
  controller.abort();
  broker.close?.();
  await pending.catch(() => undefined);
  return posted[0];
}

describe("agent browser text lengths agree between the tool validator and main", () => {
  it("parses the same lengths in BMP characters", async () => {
    expect(parseRuntimeWorkerEvent(await postedEvent("inertia_browser_type", { ref: "e1", text: "x".repeat(4_000) })))
      .toMatchObject({ command: expect.anything() });
    expect(parseRuntimeWorkerEvent(await postedEvent("inertia_browser_wait_for", { text: "x".repeat(200) })))
      .toMatchObject({ command: expect.anything() });
  });

  it.each([
    ["inertia_browser_type", { ref: "e1", text: emoji.repeat(4_000) }],
    ["inertia_browser_wait_for", { text: emoji.repeat(200) }],
    ["inertia_browser_navigate", { url: `http://localhost:3000/${emoji.repeat(2_100)}` }],
  ])("forwards astral %s arguments that main accepts", async (tool, args) => {
    const event = await postedEvent(tool, args);
    expect(event).toMatchObject({ type: "runtime.agent-browser-request" });
    expect(parseRuntimeWorkerEvent(event)).toMatchObject({ command: expect.anything() });
  });

  it.each([
    ["inertia_browser_type", { ref: "e1", text: emoji.repeat(4_001) }],
    ["inertia_browser_wait_for", { text: emoji.repeat(201) }],
    ["inertia_browser_navigate", { url: `http://localhost:3000/${emoji.repeat(4_096)}` }],
  ])("answers over-long astral %s arguments as invalid without posting", async (tool, args) => {
    const { posted, pending } = invoke(tool, args);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ error: { code: "invalid" } });
    expect(posted).toEqual([]);
  });

  it("documents the code point unit on every bounded string schema", () => {
    for (const definition of AGENT_BROWSER_TOOL_DEFINITIONS) {
      const properties = (definition.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
      for (const [name, property] of Object.entries(properties)) {
        if (typeof property.maxLength !== "number") continue;
        expect(property.description, `${definition.name}.${name}`).toMatch(/Unicode code points/u);
      }
    }
  });
});
