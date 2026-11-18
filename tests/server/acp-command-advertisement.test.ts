// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type { AgentHarness, AgentHarnessCallbacks } from "../../src/server/provider/agent-harness";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createGrokAcpHarness } from "../../src/server/provider/grok-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { MAX_PROVIDER_SLASH_COMMANDS } from "../../src/server/provider/provider-slash-commands";
import type { ProviderSlashCommand } from "../../src/shared/contracts";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeFlagExecutable,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

type AcpProvider = "cursor" | "grok" | "kimi";
type Scenario =
  | "before-new-response"
  | "before-load-response"
  | "during-prompt"
  | "after-prompt"
  | "other-session"
  | "malformed"
  | "oversized";

const OWN_SESSION = "own-session";
const REVIEW: ProviderSlashCommand[] = [{ name: "review", description: "Review the diff", argumentHint: "<focus>" }];
const AGENT_NAMES: Record<AcpProvider, { name: string; version: string }> = {
  cursor: { name: "Cursor", version: "test" },
  grok: { name: "Grok", version: "1.0.70" },
  kimi: { name: "Kimi Code CLI", version: "test" },
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

function agentSource(providerId: AcpProvider, scenario: Scenario): string {
  return `
const readline = require("node:readline");
const frame = (value) => JSON.stringify(value) + "\\n";
const sessionId = ${JSON.stringify(OWN_SESSION)};
const scenario = ${JSON.stringify(scenario)};
const advertise = (target, availableCommands) => frame({ jsonrpc: "2.0", method: "session/update", params: {
  sessionId: target, update: { sessionUpdate: "available_commands_update", availableCommands },
} });
const review = [{ name: "review", description: "Review the diff", input: { hint: "<focus>" } }];
const oversized = Array.from({ length: 1000 }, (_, index) => ({
  name: "command-" + String(index).padStart(4, "0"), description: "Command " + index,
}));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    authMethods: [],
    agentInfo: ${JSON.stringify(AGENT_NAMES[providerId])},
  } }));
  if (message.method === "session/new" || message.method === "session/load") {
    let burst = "";
    if (scenario === "before-new-response" || scenario === "before-load-response") burst += advertise(sessionId, review);
    if (scenario === "other-session") burst += advertise("other-session", review);
    if (scenario === "malformed") burst += advertise(sessionId, "not a list") + advertise(sessionId, [{ name: 5, description: "bad" }]);
    burst += frame({ jsonrpc: "2.0", id: message.id, result: {
      ...(message.method === "session/new" ? { sessionId } : {}),
      modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
      configOptions: [],
    } });
    return process.stdout.write(burst);
  }
  if (message.method === "session/prompt") {
    let burst = "";
    if (scenario === "during-prompt") burst += advertise(sessionId, review);
    if (scenario === "other-session") burst += advertise("other-session", review);
    if (scenario === "malformed") burst += advertise(sessionId, [{ description: "no name" }]);
    if (scenario === "oversized") burst += advertise(sessionId, oversized);
    burst += frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" },
    } } });
    burst += frame({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    if (scenario === "after-prompt") burst += advertise(sessionId, review);
    return process.stdout.write(burst);
  }
  if (message.id !== undefined && message.method) {
    return process.stdout.write(frame({ jsonrpc: "2.0", id: message.id, result: {} }));
  }
});
`;
}

function fixture(providerId: AcpProvider, scenario: Scenario): { harness: AgentHarness; command: string; root: string } {
  const root = portableFixtureRoot(`${providerId} command advertisement ${scenario}`);
  roots.push(root);
  const source = agentSource(providerId, scenario);
  if (providerId === "grok") {
    return { harness: createGrokAcpHarness({ controlRpcTimeoutMs: 5_000 }), command: writeNodeFlagExecutable(root, "grok", source), root };
  }
  const command = portableNodeExecutable(root, providerId === "cursor" ? "cursor-agent" : "kimi");
  writeNodeSubcommand(root, "acp", source);
  return {
    harness: providerId === "cursor"
      ? createCursorAcpHarness({ controlRpcTimeoutMs: 5_000 })
      : createKimiAcpHarness({ controlRpcTimeoutMs: 5_000 }),
    command,
    root,
  };
}

async function runScenario(providerId: AcpProvider, scenario: Scenario) {
  const { harness, command, root } = fixture(providerId, scenario);
  const advertised: ProviderSlashCommand[][] = [];
  const callbacks: AgentHarnessCallbacks = {
    onEvent: (event) => {
      if (event.type !== "extension" || !("event" in event)) return;
      const rich = event.event;
      if (rich.type === "metadata" && rich.metadata.commands) advertised.push(rich.metadata.commands);
    },
  };
  const result = await harness.start({
    executable: command,
    environment: process.env,
    callbacks,
    providerNativeToolsAvailable: false,
    input: nativeProviderRunInput({
      providerId,
      conversationId: `command-advertisement-${scenario}`,
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
      ...(scenario === "before-load-response" ? { sessionId: OWN_SESSION } : {}),
    }),
  }).result;
  return { result, advertised };
}

describe.each(["cursor", "grok", "kimi"] as const)("%s ACP command advertisements", (providerId) => {
  it.each(["before-new-response", "before-load-response", "during-prompt", "after-prompt"] as const)(
    "publishes the run's own session commands sent %s and completes the turn",
    async (scenario) => {
      const { result, advertised } = await runScenario(providerId, scenario);

      expect(result).toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
      expect(advertised).toEqual([REVIEW]);
    },
    30_000,
  );

  it("ignores commands advertised for another session", async () => {
    const { result, advertised } = await runScenario(providerId, "other-session");

    expect(result).toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
    expect(advertised).toEqual([]);
  }, 30_000);

  it("ignores malformed command lists without failing the turn", async () => {
    const { result, advertised } = await runScenario(providerId, "malformed");

    expect(result).toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
    expect(result.error).toBeUndefined();
    expect(advertised).toEqual([]);
  }, 30_000);

  it("bounds an oversized command list", async () => {
    const { result, advertised } = await runScenario(providerId, "oversized");

    expect(result).toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
    expect(advertised).toHaveLength(1);
    expect(advertised[0]).toHaveLength(MAX_PROVIDER_SLASH_COMMANDS);
    expect(advertised[0]![0]).toEqual({ name: "command-0000", description: "Command 0", argumentHint: null });
    expect(advertised[0]!.at(-1)!.name).toBe(`command-${String(MAX_PROVIDER_SLASH_COMMANDS - 1).padStart(4, "0")}`);
  }, 30_000);
});
