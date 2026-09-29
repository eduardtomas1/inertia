// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { AgentHarness, AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { AcpSecretRedactor } from "../../src/server/provider/acp-redaction";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const BRIDGE_TOKEN = "Tk9q7Zr2Wv5Nx8Lm4Pc6Hy3Jd1";
const BRIDGE_URL = "http://127.0.0.1:65001/qzx-mcp";

type Scenario = "echo" | "stderr-error" | "provider-cancel" | "local-cancel";

const PROVIDERS = [
  { providerId: "cursor" as const, executableName: "cursor-agent", agentName: "Cursor", create: createCursorAcpHarness as (options: object) => AgentHarness },
  { providerId: "kimi" as const, executableName: "kimi", agentName: "Kimi Code CLI", create: createKimiAcpHarness as (options: object) => AgentHarness },
];

function expectedEcho(): string {
  const lines: string[] = [];
  for (const secret of [BRIDGE_TOKEN, BRIDGE_URL]) {
    for (let split = 1; split < secret.length; split += 1) lines.push(`${split}:[redacted]\n`);
    lines.push("whole:[redacted]\n");
  }
  return lines.join("");
}

function bridgeEchoAgent(root: string, executableName: string, agentName: string, scenario: Scenario): string {
  const command = portableNodeExecutable(root, executableName);
  writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const scenario = ${JSON.stringify(scenario)};
const sessionId = "bridge-redaction-session";
let secrets = [];
let promptId;
const chunk = (sessionUpdate, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, agentInfo: { name: ${JSON.stringify(agentName)}, version: "test" } } });
  if (message.method === "session/new") {
    const server = message.params.mcpServers[0];
    const token = server.headers.find(({ name }) => name === "Authorization").value.slice("Bearer ".length);
    secrets = [token, server.url];
    if (scenario === "stderr-error") {
      process.stderr.write("bridge " + token.slice(0, 7));
      setTimeout(() => process.stderr.write(token.slice(7) + " at " + server.url + "\\n"), 10);
    }
    return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  }
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/cancel" && scenario === "local-cancel") {
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  }
  if (message.method !== "session/prompt") return;
  promptId = message.id;
  if (scenario === "stderr-error") {
    return setTimeout(() => send({ jsonrpc: "2.0", id: promptId, error: { code: -32000, message: "Bridge " + secrets[0] + " at " + secrets[1] + " failed." } }), 30);
  }
  chunk("agent_message_chunk", "Starting ");
  for (const secret of secrets) {
    for (let split = 1; split < secret.length; split += 1) {
      for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) {
        chunk(kind, split + ":" + secret.slice(0, split));
        chunk(kind, secret.slice(split) + "\\n");
      }
    }
    for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) chunk(kind, "whole:" + secret + "\\n");
  }
  if (scenario !== "echo") {
    chunk("agent_message_chunk", "tail " + secrets[0].slice(0, -1));
    chunk("agent_thought_chunk", "tail " + secrets[1].slice(0, -1));
  }
  if (scenario === "local-cancel") return;
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: scenario === "provider-cancel" ? "cancelled" : "end_turn" } });
});
`);
  return command;
}

function leaked(serialized: string): string[] {
  const windows: string[] = [];
  for (let index = 0; index + 6 <= BRIDGE_TOKEN.length; index += 1) {
    const window = BRIDGE_TOKEN.slice(index, index + 6);
    if (serialized.includes(window)) windows.push(window);
  }
  if (serialized.includes("65001") || serialized.includes("qzx-mcp")) windows.push("bridge URL");
  return windows;
}

describe("ACP host bridge credential redaction", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  async function bridgeRun(provider: typeof PROVIDERS[number], scenario: Scenario) {
    const root = portableFixtureRoot(`${provider.providerId} bridge ${scenario}`);
    roots.push(root);
    const executable = bridgeEchoAgent(root, provider.executableName, provider.agentName, scenario);
    const events: AgentHarnessEvent[] = [];
    let text = "";
    let reasoning = "";
    let cancel: ((force: boolean) => void) | undefined;
    const run = provider.create({
      createHostMcpSession: () => ({
        start: async () => ({ url: BRIDGE_URL, bearerToken: BRIDGE_TOKEN }),
        close: async () => undefined,
      }),
    }).start({
      input: nativeProviderRunInput({
        providerId: provider.providerId,
        conversationId: `${provider.providerId}-bridge-${scenario}`,
        cwd: root,
        prompt: "Echo the bridge credential.",
        interactionMode: "build",
        access: "supervised",
      }),
      executable,
      environment: { ...process.env },
      providerNativeToolsAvailable: true,
      hostTools: { definitions: [], invoke: async () => ({ success: true, text: "{}" }) },
      callbacks: {
        onEvent: (event) => {
          events.push(event);
          if (event.type === "text") {
            text += event.text;
            if (scenario === "local-cancel" && event.text.includes("Starting")) cancel?.(false);
          }
          if (event.type === "extension" && "event" in event && event.event.type === "reasoning-summary") {
            reasoning += event.event.text;
          }
        },
      },
    });
    cancel = run.cancel;
    const result = await run.result;
    return { result, events, text, reasoning };
  }

  describe.each(PROVIDERS)("$providerId", (provider) => {
    it("redacts the bridge token and URL split at every position and echoed whole", async () => {
      const { result, events, text, reasoning } = await bridgeRun(provider, "echo");

      expect(result).toMatchObject({ status: "completed" });
      expect(leaked(JSON.stringify({ result, events }))).toEqual([]);
      expect(text).toBe(`Starting ${expectedEcho()}`);
      expect(result.text).toBe(`Starting ${expectedEcho()}`);
      expect(reasoning).toBe(expectedEcho());
    });

    it("redacts the bridge credentials from stderr diagnostics and the error message", async () => {
      const { result, events } = await bridgeRun(provider, "stderr-error");

      expect(result).toMatchObject({ status: "failed" });
      expect(leaked(JSON.stringify({ result, events }))).toEqual([]);
    });

    it.each(["provider-cancel", "local-cancel"] as const)("never emits a held bridge credential prefix on %s", async (scenario) => {
      const { result, events } = await bridgeRun(provider, scenario);

      expect(result).toMatchObject({ status: "cancelled" });
      expect(leaked(JSON.stringify({ result, events }))).toEqual([]);
    });
  });
});

describe("ACP secret registration", () => {
  it("accepts a credential registered after output started and redacts it across later chunks", () => {
    const redactor = new AcpSecretRedactor({});
    expect(redactor.assistantChunk("before ")).toBe("before ");

    expect(() => redactor.addSecrets([BRIDGE_TOKEN])).not.toThrow();
    const output = redactor.assistantChunk(`x ${BRIDGE_TOKEN.slice(0, 9)}`)
      + redactor.assistantChunk(`${BRIDGE_TOKEN.slice(9)} y`)
      + redactor.finishAssistant();

    expect(output).toBe("x [redacted] y");
  });

  it("re-scans held output against a credential registered while it is pending", () => {
    const redactor = new AcpSecretRedactor({ FIRST_TOKEN: `${BRIDGE_TOKEN}-first` });
    const held = redactor.assistantChunk(`x ${BRIDGE_TOKEN.slice(0, 12)}`);
    expect(held).toBe("x ");

    redactor.addSecrets([BRIDGE_TOKEN]);
    const output = held + redactor.assistantChunk(`${BRIDGE_TOKEN.slice(12)} y`) + redactor.finishAssistant();

    expect(output).toBe("x [redacted] y");
  });
});
