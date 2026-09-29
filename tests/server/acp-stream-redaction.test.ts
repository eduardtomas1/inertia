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

const SECRET = "Zq7xW-canary-9mT4pL-2k8R";
const SPLIT = 9;

type Scenario =
  | "complete-split"
  | "complete-short"
  | "ordinary"
  | "provider-cancel"
  | "other-stop"
  | "unconfirmed-compaction"
  | "rpc-error"
  | "malformed"
  | "oversized"
  | "process-exit"
  | "local-cancel";

const PROVIDERS = [
  { providerId: "cursor" as const, executableName: "cursor-agent", agentName: "Cursor", environmentKey: "CURSOR_API_KEY", create: createCursorAcpHarness as () => AgentHarness },
  { providerId: "kimi" as const, executableName: "kimi", agentName: "Kimi Code CLI", environmentKey: "KIMI_API_KEY", create: createKimiAcpHarness as () => AgentHarness },
];

function streamingAgent(
  root: string,
  executableName: string,
  agentName: string,
  sessionId: string,
  scenario: Scenario,
): string {
  const command = portableNodeExecutable(root, executableName);
  writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const secret = ${JSON.stringify(SECRET)};
const scenario = ${JSON.stringify(scenario)};
const sessionId = ${JSON.stringify(sessionId)};
const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const chunk = (sessionUpdate, text) => update({ sessionUpdate, content: { type: "text", text } });
let promptId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: ${JSON.stringify(agentName)}, version: "test" } } });
  if (message.method === "session/new" || message.method === "session/load") {
    if (message.method === "session/load") update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "summarize", description: "summarize" }, { name: "compact", description: "compact" }] });
    return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  }
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/cancel" && scenario === "local-cancel") {
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  }
  if (message.method !== "session/prompt") return;
  promptId = message.id;
  const tail = scenario === "ordinary"
    ? ["All ", "done."]
    : scenario === "complete-split"
      ? [secret.slice(0, ${SPLIT}), secret.slice(${SPLIT}) + " end"]
      : [secret.slice(0, ${SPLIT}), secret.slice(${SPLIT}, -1)];
  chunk("agent_thought_chunk", "Thinking " + tail[0]);
  chunk("agent_thought_chunk", tail[1]);
  chunk("agent_message_chunk", "Key: " + tail[0]);
  chunk("agent_message_chunk", tail[1]);
  if (scenario === "provider-cancel") return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  if (scenario === "other-stop") return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "max_tokens" } });
  if (scenario === "rpc-error") return send({ jsonrpc: "2.0", id: promptId, error: { code: -32000, message: "Provider failed." } });
  if (scenario === "malformed") return process.stdout.write("{not json\\n");
  if (scenario === "oversized") return process.stdout.write("x".repeat(1024 * 1024 + 16) + "\\n");
  if (scenario === "process-exit") return setTimeout(() => process.exit(1), 20);
  if (scenario === "local-cancel") return;
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
});
`);
  return command;
}

function secretWindowLeaked(value: string): string | undefined {
  for (let index = 0; index + 6 <= SECRET.length; index += 1) {
    const window = SECRET.slice(index, index + 6);
    if (value.includes(window)) return window;
  }
  return undefined;
}

describe("ACP streamed output redaction", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  async function streamedRun(
    provider: typeof PROVIDERS[number],
    scenario: Scenario,
  ) {
    const root = portableFixtureRoot(`${provider.providerId} stream ${scenario}`);
    roots.push(root);
    const executable = streamingAgent(
      root,
      provider.executableName,
      provider.agentName,
      `${provider.providerId}-stream-session`,
      scenario,
    );
    const events: AgentHarnessEvent[] = [];
    const text: string[] = [];
    const reasoning: string[] = [];
    let cancel: ((force: boolean) => void) | undefined;
    const compacting = scenario === "unconfirmed-compaction";
    const run = provider.create().start({
      input: nativeProviderRunInput({
        providerId: provider.providerId,
        conversationId: `${provider.providerId}-stream-${scenario}`,
        cwd: root,
        prompt: "Print the key.",
        interactionMode: "build",
        access: "supervised",
        ...(compacting ? { sessionId: `${provider.providerId}-stream-session`, operation: { kind: "compact" as const } } : {}),
      }),
      executable,
      environment: { ...process.env, [provider.environmentKey]: SECRET },
      providerNativeToolsAvailable: true,
      callbacks: {
        onEvent: (event) => {
          events.push(event);
          if (event.type === "text") {
            text.push(event.text);
            if (scenario === "local-cancel" && event.text.includes("Key: ")) cancel?.(false);
          }
          if (event.type === "extension" && "event" in event && event.event.type === "reasoning-summary") {
            reasoning.push(event.event.text);
          }
        },
      },
    });
    cancel = run.cancel;
    const result = await run.result;
    return { result, events, text: text.join(""), reasoning: reasoning.join("") };
  }

  describe.each(PROVIDERS)("$providerId", (provider) => {
    it("redacts a credential split across the final chunks of a completed turn", async () => {
      const { result, events, text, reasoning } = await streamedRun(provider, "complete-split");

      expect(result).toMatchObject({ status: "completed" });
      expect(secretWindowLeaked(JSON.stringify({ result, events }))).toBeUndefined();
      expect(text).toBe("Key: [redacted] end");
      expect(result.text).toBe("Key: [redacted] end");
      expect(reasoning).toBe("Thinking [redacted] end");
    });

    it("redacts a completed turn whose stream ends one character short of a credential", async () => {
      const { result, events, text, reasoning } = await streamedRun(provider, "complete-short");

      expect(result).toMatchObject({ status: "completed" });
      expect(secretWindowLeaked(JSON.stringify({ result, events }))).toBeUndefined();
      expect(text).toBe("Key: [redacted]");
      expect(result.text).toBe("Key: [redacted]");
      expect(reasoning).toBe("Thinking [redacted]");
    });

    it("emits ordinary trailing text of a completed turn completely", async () => {
      const { result, text, reasoning } = await streamedRun(provider, "ordinary");

      expect(result).toMatchObject({ status: "completed" });
      expect(text).toBe("Key: All done.");
      expect(result.text).toBe("Key: All done.");
      expect(reasoning).toBe("Thinking All done.");
    });

    it.each([
      ["provider-cancel", "cancelled"],
      ["other-stop", "failed"],
      ["unconfirmed-compaction", "failed"],
      ["rpc-error", "failed"],
      ["malformed", "failed"],
      ["oversized", "failed"],
      ["process-exit", "failed"],
      ["local-cancel", "cancelled"],
    ] as const)("never emits a buffered credential prefix when the turn ends through %s", async (scenario, status) => {
      const { result, events } = await streamedRun(provider, scenario);

      expect(result).toMatchObject({ status });
      expect(secretWindowLeaked(JSON.stringify({ result, events }))).toBeUndefined();
    });
  });
});

describe("ACP final flush rule", () => {
  it("redacts a significant trailing credential prefix and keeps short ordinary endings", () => {
    const redactor = new AcpSecretRedactor({ CURSOR_API_KEY: SECRET, SHORT_TOKEN: "ab12" });

    expect(redactor.assistantChunk(`Key: ${SECRET.slice(0, 6)}`) + redactor.finishAssistant())
      .toBe("Key: [redacted]");
    expect(redactor.reasoningChunk(`Word ${SECRET.slice(0, 5)}`) + redactor.finishReasoning())
      .toBe(`Word ${SECRET.slice(0, 5)}`);
  });

  it("redacts a trailing prefix that covers half of a short credential", () => {
    const redactor = new AcpSecretRedactor({ SHORT_TOKEN: "ab12" });

    expect(redactor.assistantChunk("value a") + redactor.finishAssistant()).toBe("value a");
    const second = new AcpSecretRedactor({ SHORT_TOKEN: "ab12" });
    expect(second.assistantChunk("value ab") + second.finishAssistant()).toBe("value [redacted]");
  });
});
