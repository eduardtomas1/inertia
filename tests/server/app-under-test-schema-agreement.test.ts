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
  APP_UNDER_TEST_TOOL_DEFINITIONS,
  AppUnderTestHostTools,
} from "../../src/server/runtime/app-under-test/host-tools";

type Schema = Record<string, unknown>;

const LAUNCH_ID = "22222222-2222-4222-8222-222222222222";
// Flat schemas cannot say "actionId exactly when kind is action", "text with
// visible or hidden", "not zero" or "not only whitespace"; the runtime
// validator explains each of these with an `invalid` result.
const KNOWN = new Set([
  "inertia_app_launch {\"kind\":\"action\"}",
  `inertia_app_launch {"kind":"electron","actionId":"${LAUNCH_ID}"}`,
  `inertia_app_scroll {"windowId":"${LAUNCH_ID}","deltaY":0}`,
  `inertia_app_wait_for {"windowId":"${LAUNCH_ID}","text":" "}`,
  `inertia_app_wait_for {"windowId":"${LAUNCH_ID}","state":"visible"}`,
  `inertia_app_wait_for {"windowId":"${LAUNCH_ID}","state":"hidden"}`,
]);

function stringCandidates(property: Schema): unknown[] {
  if (Array.isArray(property.enum)) return [...property.enum as unknown[]];
  if (property.format === "uuid") {
    return [
      LAUNCH_ID,
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
  for (const definition of APP_UNDER_TEST_TOOL_DEFINITIONS) {
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

function fakeManager(reached: string[]) {
  const launch = {
    launchId: LAUNCH_ID, conversationId: "11111111-1111-4111-8111-111111111111", kind: "electron", actionId: null,
    label: "Electron app", startedBy: "agent", state: "running", pid: 1, startedAt: new Date(0).toISOString(),
    readyAt: null, exitedAt: null, exitCode: null, signal: null, stopRequested: false, cdp: true, windowCount: 1, windows: [], cleanupConfirmed: null, failure: null,
  };
  const transport = {
    windows: () => [],
    pendingDialog: () => null,
    redactLog: (text: string) => text,
    inspect: vi.fn(),
    perform: vi.fn(async (command: { action: string }) => {
      reached.push(command.action);
      return { ok: true as const, value: {} };
    }),
    waitForWindow: async () => true,
    close: () => undefined,
  };
  return {
    describeTarget: () => "Electron app",
    launch: vi.fn(async () => { reached.push("launch"); return launch; }),
    status: () => [launch],
    logs: () => { reached.push("logs"); return { conversationId: launch.conversationId, launchId: LAUNCH_ID, lines: [], nextCursor: 0, truncated: false, dropped: 0 }; },
    logTail: () => [],
    windows: () => { reached.push("windows"); return []; },
    launchWindows: () => [],
    hasWindowTransport: () => true,
    pendingDialog: () => null,
    windowOwner: () => ({ launch, transport }),
    waitForReady: async () => true,
    withAction: async (_conversationId: string, _launchId: string, operation: () => Promise<unknown>) => await operation(),
    appendEvidence: () => null,
    stop: vi.fn(async () => { reached.push("stop"); return { ...launch, state: "exited" }; }),
  };
}

function fixture() {
  const conversation = { id: "11111111-1111-4111-8111-111111111111", accessMode: "full" } as Conversation;
  const tools = new AppUnderTestHostTools(fakeManager([]) as never);
  const bridge: ProviderHostToolBridge = {
    definitions: APP_UNDER_TEST_TOOL_DEFINITIONS,
    invoke: (call) => tools.invoke(conversation, call, {
      conversationId: conversation.id,
      runId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      remoteDevice: false,
    }),
  };
  return new ProviderHostToolRuntime({
    bridge, conversationId: "thread", turnId: "turn", cwd: "/project",
    onApproval: () => undefined, onApprovalResolved: () => undefined,
  });
}

describe("every schema-valid App input is accepted by the runtime validator", () => {
  it("raw definitions (also sent verbatim to Codex thread/start dynamicTools)", async () => {
    const schemas = new Map(APP_UNDER_TEST_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema as Schema]));
    // The known divergences are exactly the ones a flat schema cannot express.
    expect([...new Set(divergences(schemas))].sort()).toEqual([...KNOWN].sort());

    // Each accepted input reaches the App exactly once.
    const json = new AjvJsonSchemaValidator();
    const conversation = { id: "11111111-1111-4111-8111-111111111111", accessMode: "full" } as Conversation;
    const identity = { conversationId: conversation.id, runId: "run", turnId: "turn", remoteDevice: false };
    const unreached: string[] = [];
    for (const definition of APP_UNDER_TEST_TOOL_DEFINITIONS) {
      const validate = json.getValidator(schemas.get(definition.name)!);
      for (const input of inputsFor(schemas.get(definition.name)!)) {
        if (!validate(input).valid || !definition.inputValidator!.safeParse(input).success) continue;
        const reached: string[] = [];
        const result = await new AppUnderTestHostTools(fakeManager(reached) as never).invoke(conversation, {
          providerThreadId: "thread", providerTurnId: "turn", toolCallId: "call", tool: definition.name,
          arguments: input, signal: new AbortController().signal, requestApproval: vi.fn(),
        }, identity);
        if (definition.name !== "inertia_app_status" && reached.length !== 1) unreached.push(`${definition.name} ${JSON.stringify(input)}`);
        if (!result.success) unreached.push(`${definition.name} ${JSON.stringify(input)} ${result.text}`);
      }
    }
    expect(unreached).toEqual([]);
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
