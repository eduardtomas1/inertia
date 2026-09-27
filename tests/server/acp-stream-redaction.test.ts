// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const SECRET = "sk-stream-split-credential-4242";
const SPLIT = 9;

function splitSecretAgent(root: string, executableName: string, agentName: string, sessionId: string): string {
  const command = portableNodeExecutable(root, executableName);
  writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const secret = ${JSON.stringify(SECRET)};
const update = (sessionUpdate, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sessionId)}, update: { sessionUpdate, content: { type: "text", text } } } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: ${JSON.stringify(agentName)}, version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: ${JSON.stringify(sessionId)}, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/prompt") {
    update("agent_thought_chunk", "Thinking about " + secret.slice(0, ${SPLIT}));
    update("agent_thought_chunk", secret.slice(${SPLIT}) + " now");
    update("agent_message_chunk", "Key: " + secret.slice(0, ${SPLIT}));
    update("agent_message_chunk", secret.slice(${SPLIT}) + " done");
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
  return command;
}

describe("ACP streamed output redaction", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it.each([
    { providerId: "cursor" as const, executableName: "cursor-agent", agentName: "Cursor", environmentKey: "CURSOR_API_KEY", create: createCursorAcpHarness },
    { providerId: "kimi" as const, executableName: "kimi", agentName: "Kimi Code CLI", environmentKey: "KIMI_API_KEY", create: createKimiAcpHarness },
  ])("redacts a $providerId credential split across streamed chunks", async ({ providerId, executableName, agentName, environmentKey, create }) => {
    const root = portableFixtureRoot(`${providerId} stream redaction`);
    roots.push(root);
    const executable = splitSecretAgent(root, executableName, agentName, `${providerId}-stream-session`);
    const text: string[] = [];
    const reasoning: string[] = [];
    const run = create().start({
      input: nativeProviderRunInput({
        providerId,
        conversationId: `${providerId}-stream-redaction`,
        cwd: root,
        prompt: "Print the key.",
        interactionMode: "build",
        access: "supervised",
      }),
      executable,
      environment: { ...process.env, [environmentKey]: SECRET },
      providerNativeToolsAvailable: true,
      callbacks: {
        onEvent: (event) => {
          if (event.type === "text") text.push(event.text);
          if (event.type === "extension" && "event" in event && event.event.type === "reasoning-summary") {
            reasoning.push(event.event.text);
          }
        },
      },
    });

    const result = await run.result;

    expect(result).toMatchObject({ status: "completed" });
    const streamed = [text.join(""), reasoning.join(""), result.text];
    for (const value of streamed) {
      expect(value).not.toContain(SECRET.slice(0, SPLIT));
      expect(value).not.toContain(SECRET.slice(SPLIT));
    }
    expect(text.join("")).toBe("Key: [redacted] done");
    expect(result.text).toBe("Key: [redacted] done");
    expect(reasoning.join("")).toBe("Thinking about [redacted] now");
  });
});
