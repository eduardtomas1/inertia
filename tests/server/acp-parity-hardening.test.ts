// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acpStopReasonMessage } from "../../src/server/provider/acp-stop-reasons";
import { createGrokAcpHarness } from "../../src/server/provider/grok-acp-harness";
import { grokStopFailure } from "../../src/server/provider/grok-acp-support";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { kimiStopFailure } from "../../src/server/provider/kimi-acp-support";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  portableFixtureRoot,
  removePortableFixture,
  writeNodeFlagExecutable,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function acpHarnessAgent(capturePath: string, agentName: string, body: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const observed = [];
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(observed));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  observed.push(message);
  save();
  if (message.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false } },
        authMethods: [],
        agentInfo: { name: ${JSON.stringify(agentName)}, version: "1.0.0" },
      },
    });
  }
  if (message.method === "authenticate") {
    return send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
  if (message.method === "session/new") {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "acp-session-1",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [],
      },
    });
  }
  ${body}
});
`;
}

describe("ACP parity hardening (Kimi & Grok)", { concurrent: false }, () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("bounds and maps Kimi and Grok stop reasons consistently", () => {
    expect(acpStopReasonMessage("Kimi Code", "refusal")).toBe("Kimi Code declined this request.");
    expect(acpStopReasonMessage("Grok", "max_tokens")).toContain("output token limit");
    expect(acpStopReasonMessage("Kimi Code", "max_turn_requests")).toContain("request limit");

    const longReason = `unknown_${"x".repeat(300)}`;
    const kimiFailure = kimiStopFailure(longReason);
    const grokFailure = grokStopFailure(longReason);
    expect(kimiFailure).toMatchObject({
      reason: "provider-error",
      phase: "turn",
      terminalEvent: `session/prompt:${longReason.slice(0, 160)}`,
    });
    expect(grokFailure).toMatchObject({
      reason: "provider-error",
      phase: "turn",
      terminalEvent: `session/prompt:${longReason.slice(0, 160)}`,
    });
    expect(kimiFailure.message.length).toBeLessThan(120);
    expect(grokFailure.message.length).toBeLessThan(120);
  });

  it.each([
    ["kimi", "Kimi Code", () => createKimiAcpHarness()],
    ["grok", "Grok", () => createGrokAcpHarness()],
  ] as const)("rejects unsolicited terminal/create requests from %s ACP (26f0a62f7)", async (providerId, agentName, makeHarness) => {
    const root = portableFixtureRoot(`${providerId}-acp-terminal-reject`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, providerId, acpHarnessAgent(capturePath, agentName, `
      if (message.method === "session/prompt") {
        globalThis.__promptId = message.id;
        send({
          jsonrpc: "2.0",
          id: 901,
          method: "terminal/create",
          params: { sessionId: "acp-session-1", command: "sh", args: ["-c", "echo pwned"] },
        });
        return;
      }
      if (message.id === 901) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Continued safely" } },
          },
        });
        send({ jsonrpc: "2.0", id: globalThis.__promptId, result: { stopReason: "end_turn" } });
      }
    `));

    const manager = ProviderManager.createForTests(
      { commands: { [providerId]: command } },
      new AgentHarnessRegistry([makeHarness()]),
    );
    const result = await manager.run(nativeProviderRunInput({
      providerId,
      conversationId: `${providerId}-terminal-reject`,
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));

    expect(result).toMatchObject({ status: "completed", text: "Continued safely", cleanupConfirmed: true });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      id?: number;
      error?: { code?: number; message?: string };
      result?: unknown;
    }>;
    const terminalReply = captured.find((msg) => msg.id === 901);
    expect(terminalReply).toBeDefined();
    expect(terminalReply?.result).toBeUndefined();
    expect(terminalReply?.error?.code).toBe(-32601);
  });

  it.each([
    ["kimi", "Kimi Code", () => createKimiAcpHarness()],
    ["grok", "Grok", () => createGrokAcpHarness()],
  ] as const)("bounds tracked tool-call notification retention and rejects non-end_turn stop reasons on %s ACP", async (providerId, agentName, makeHarness) => {
    // 1. Non-end_turn stop reason fails with bounded stop reason message
    const stopRoot = portableFixtureRoot(`${providerId}-acp-stop-reason`);
    roots.push(stopRoot);
    const stopCapture = join(stopRoot, "capture.json");
    const stopCommand = writeNodeFlagExecutable(stopRoot, providerId, acpHarnessAgent(stopCapture, agentName, `
      if (message.method === "session/prompt") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial" } },
          },
        });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "max_turn_requests" } });
      }
    `));
    const stopManager = ProviderManager.createForTests(
      { commands: { [providerId]: stopCommand } },
      new AgentHarnessRegistry([makeHarness()]),
    );
    const stopResult = await stopManager.run(nativeProviderRunInput({
      providerId,
      conversationId: `${providerId}-stop-reason`,
      cwd: stopRoot,
      prompt: "Run",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(stopResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: {
        reason: "provider-error",
        terminalEvent: "session/prompt:max_turn_requests",
      },
    });
    expect(stopResult.error).toContain("request limit");

    // 2. Exceeding tracked tool activity retention bound (> 1024 distinct tool calls) fails with protocol-overflow
    const overflowRoot = portableFixtureRoot(`${providerId}-acp-retention-overflow`);
    roots.push(overflowRoot);
    const overflowCapture = join(overflowRoot, "capture.json");
    const overflowCommand = writeNodeFlagExecutable(overflowRoot, providerId, acpHarnessAgent(overflowCapture, agentName, `
      if (message.method === "session/prompt") {
        for (let i = 0; i < 1026; i += 1) {
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "acp-session-1",
              update: { sessionUpdate: "tool_call", toolCallId: "tool-" + i, title: "Read", status: "in_progress", kind: "read" },
            },
          });
        }
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const overflowManager = ProviderManager.createForTests(
      { commands: { [providerId]: overflowCommand } },
      new AgentHarnessRegistry([makeHarness()]),
    );
    const overflowResult = await overflowManager.run(nativeProviderRunInput({
      providerId,
      conversationId: `${providerId}-retention-overflow`,
      cwd: overflowRoot,
      prompt: "Flood",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(overflowResult).toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      failure: { reason: "protocol-overflow" },
    });
  });
});
