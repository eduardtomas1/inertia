// @inertia-test-suite portable
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it, vi } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import {
  AGENT_BROWSER_TOOL_DEFINITIONS,
  AgentBrowserHostTools,
} from "../../src/server/runtime/agent-browser-host-tools";
import { parseAgentBrowserCommand } from "../../src/shared/agent-browser";

type Schema = Record<string, unknown>;

const KNOWN = new Set([
  "inertia_browser_scroll {\"deltaY\":0}",
  "inertia_browser_wait_for {\"text\":\" \"}",
]);

function stringCandidates(property: Schema): unknown[] {
  if (Array.isArray(property.enum)) return [...property.enum as unknown[]];
  if (property.format === "uuid") {
    return [
      "22222222-2222-4222-8222-222222222222",
      "00000000-0000-0000-0000-000000000000",
      "11111111-1111-1111-1111-111111111111",
      "urn:uuid:22222222-2222-4222-8222-222222222222",
      "not-a-uuid",
    ];
  }
  if (typeof property.pattern === "string" && property.pattern.includes("A-Za-z0-9_-")) {
    return ["e1", "x".repeat(64)];
  }
  const min = typeof property.minLength === "number" ? property.minLength : 0;
  const max = typeof property.maxLength === "number" ? property.maxLength : 64;
  const values = new Set<string>();
  if (min === 0) values.add("");
  values.add("a");
  values.add("x".repeat(max));
  values.add("\u{1F600}".repeat(max));
  values.add(" ");
  values.add("a\nb");
  values.add("a\rb");
  values.add("a\tb");
  values.add("a\u0000b");
  values.add("http://localhost:3000/");
  return [...values];
}

function candidates(property: Schema): unknown[] {
  if (property.type === "string" || Array.isArray(property.enum)) return stringCandidates(property);
  if (property.type === "integer") {
    const min = property.minimum as number;
    const max = property.maximum as number;
    return [...new Set([min, max, 0, -0, 1, -1, Math.trunc((min + max) / 2)])]
      .filter((value) => value >= min && value <= max);
  }
  if (property.type === "boolean") return [true, false];
  return [];
}

function inputsFor(schema: Schema): Array<Record<string, unknown>> {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = (schema.required ?? []) as string[];
  let inputs: Array<Record<string, unknown>> = [{}];
  for (const name of required) {
    inputs = inputs.flatMap((input) => candidates(properties[name]!).map((value) => ({ ...input, [name]: value })));
  }
  const base = inputs[0]!;
  for (const [name, property] of Object.entries(properties)) {
    if (required.includes(name)) continue;
    for (const value of candidates(property)) inputs.push({ ...base, [name]: value });
  }
  return inputs;
}

function divergences(schemas: ReadonlyMap<string, Schema>): string[] {
  const json = new AjvJsonSchemaValidator();
  const found: string[] = [];
  for (const definition of AGENT_BROWSER_TOOL_DEFINITIONS) {
    const schema = schemas.get(definition.name)!;
    for (const key of ["oneOf", "anyOf", "allOf", "not", "if", "then", "else"]) {
      expect(Object.hasOwn(schema, key), `${definition.name} ${key}`).toBe(false);
    }
    const validate = json.getValidator(schema);
    for (const input of inputsFor(schema)) {
      if (!validate(input).valid) continue;
      if (!definition.inputValidator!.safeParse(input).success) {
        found.push(`${definition.name} ${JSON.stringify(input)}`);
      }
    }
  }
  return found;
}

async function mainRejections(schemas: ReadonlyMap<string, Schema>): Promise<string[]> {
  const json = new AjvJsonSchemaValidator();
  const commands: unknown[] = [];
  const browser = new AgentBrowserHostTools({
    perform: vi.fn(async (_identity: unknown, command: unknown) => {
      commands.push(command);
      return {
        ok: true as const,
        text: "{}",
        state: { activeTabId: "22222222-2222-4222-8222-222222222222", tabs: [], activity: null },
      };
    }),
  });
  const conversation = { id: "11111111-1111-4111-8111-111111111111", accessMode: "full" } as Conversation;
  const identity = {
    conversationId: conversation.id,
    runId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
  };
  const rejected: string[] = [];
  for (const definition of AGENT_BROWSER_TOOL_DEFINITIONS) {
    const validate = json.getValidator(schemas.get(definition.name)!);
    for (const input of inputsFor(schemas.get(definition.name)!)) {
      if (!validate(input).valid || !definition.inputValidator!.safeParse(input).success) continue;
      commands.length = 0;
      await browser.invoke(conversation, {
        providerThreadId: "thread", providerTurnId: "turn", toolCallId: "call", tool: definition.name,
        arguments: input, signal: new AbortController().signal, requestApproval: vi.fn(),
      }, identity);
      if (commands.length !== 1 || parseAgentBrowserCommand(commands[0]) === null) {
        rejected.push(`${definition.name} ${JSON.stringify(input)}`);
      }
    }
  }
  return rejected;
}

function fixture() {
  const perform = vi.fn(async (_identity: unknown, command: unknown) => ({
    ok: true as const,
    text: JSON.stringify({ accepted: parseAgentBrowserCommand(command) !== null }),
    state: { activeTabId: "22222222-2222-4222-8222-222222222222", tabs: [], activity: null },
  }));
  const browser = new AgentBrowserHostTools({ perform });
  const identity = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    runId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
  };
  const conversation = { id: identity.conversationId, accessMode: "full" } as Conversation;
  const bridge: ProviderHostToolBridge = {
    definitions: AGENT_BROWSER_TOOL_DEFINITIONS,
    invoke: (call) => browser.invoke(conversation, call, identity),
  };
  return new ProviderHostToolRuntime({
    bridge, conversationId: "thread", turnId: "turn", cwd: "/project",
    onApproval: () => undefined, onApprovalResolved: () => undefined,
  });
}

describe("every schema-valid browser input is accepted by the runtime and by main", () => {
  it("raw definitions (also sent verbatim to Codex thread/start dynamicTools)", async () => {
    const schemas = new Map(AGENT_BROWSER_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema as Schema]));
    const found = divergences(schemas);
    expect(found.filter((entry) => !KNOWN.has(entry))).toEqual([]);
    expect(await mainRejections(schemas)).toEqual([]);
  });

  it("Claude SDK tools/list override", async () => {
    const tools = createClaudeHostTools(fixture());
    const client = new Client({ name: "inertia-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      for (const tool of listed.tools) expect(tool._meta).toEqual({ "anthropic/alwaysLoad": true });
      const found = divergences(new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema as Schema])));
      expect(found.filter((entry) => !KNOWN.has(entry))).toEqual([]);
    } finally {
      await tools.close();
      await client.close();
    }
  });

  it("HTTP bridge providerMcpTools", async () => {
    const session = createProviderHostToolMcpSession(fixture());
    try {
      const connection = await session.start();
      const response = await fetch(connection.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const listed = ListToolsResultSchema.parse(((await response.json()) as { result: unknown }).result);
      const found = divergences(new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema as Schema])));
      expect(found.filter((entry) => !KNOWN.has(entry))).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
