// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGeminiAcpHarness } from "../../src/server/provider/gemini-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import type { ProviderRunResult } from "../../src/server/provider/contracts";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { executableProcessExists } from "../helpers/executable-process";
import {
  portableFixtureRoot, portableNodeExecutable, removePortableFixture,
  writeNodeFlagExecutable, writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe.each(["gemini", "kimi"] as const)("%s completed turn and next send", (providerId) => {
  it("retires each native child, rejects active steering and excludes output after the prompt response", async () => {
    const root = portableFixtureRoot(`${providerId} two sequential ACP turns`);
    const capturePath = join(root, "wire.jsonl");
    const source = `
const fs = require("node:fs");
const readline = require("node:readline");
let sessionId = "session-" + process.pid;
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] };
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    pid: process.pid, method: message.method, sessionId: message.params?.sessionId,
    prompt: message.params?.prompt,
  }) + "\\n");
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } },
    authMethods: [], agentInfo: { name: ${JSON.stringify(providerId === "gemini" ? "gemini-cli" : "Kimi Code CLI")}, version: "fixture" },
  } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes, configOptions: [] } });
  if (message.method === "session/resume") {
    sessionId = message.params.sessionId;
    return send({ jsonrpc: "2.0", id: message.id, result: { modes, configOptions: [] } });
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Accepted answer" },
    } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Forbidden late output" },
    } } });
  }
});
`;
    const command = providerId === "gemini"
      ? writeNodeFlagExecutable(root, providerId, source)
      : portableNodeExecutable(root, providerId);
    if (providerId === "kimi") writeNodeSubcommand(root, "acp", source);
    const manager = ProviderManager.createForTests({ commands: { [providerId]: command } },
      new AgentHarnessRegistry([providerId === "gemini"
        ? createGeminiAcpHarness({ cleanupSessionArtifacts: async () => {} })
        : createKimiAcpHarness()]));
    const results: ProviderRunResult[] = [];
    let pending: Promise<ProviderRunResult> | undefined;
    try {
      for (let index = 0; index < 2; index += 1) {
        const runId = `run-${index}`;
        const turnId = `turn-${index}`;
        const statuses: string[] = [];
        const steering: Promise<boolean>[] = [];
        pending = manager.run(nativeProviderRunInput({
          providerId, conversationId: "same-conversation", runId, turnId,
          cwd: root, prompt: index === 0 ? "First request" : "Second request",
          interactionMode: "build", access: "supervised",
          ...(index === 1 && providerId === "kimi" ? { sessionId: results[0]!.sessionId } : {}),
          ...(index === 1 && providerId === "gemini" ? {
            reconstructedHistory: { source: "visible-transcript", truncated: false, messages: [
              { role: "user", content: "First request" },
              { role: "assistant", content: "Accepted answer" },
            ] },
          } : {}),
        }), {
          onStatus: ({ status }) => statuses.push(status),
          onText: () => {
            steering.push(manager.steer("same-conversation", { content: "Unsupported active steer", imagePaths: [] }, { runId, turnId }));
          },
        });
        const result = await pending;
        results.push(result);
        expect(result).toMatchObject({ status: "completed", text: "Accepted answer", cleanupConfirmed: true });
        expect(statuses).toEqual(["starting", "running", "completed"]);
        expect(await Promise.all(steering)).toEqual([false]);
        expect(manager.activeConversationIds()).toEqual([]);
        const observed = readFileSync(capturePath, "utf8").trim().split("\n")
          .map(line => JSON.parse(line) as { pid: number });
        for (const pid of new Set(observed.map(entry => entry.pid))) expect(executableProcessExists(pid)).toBe(false);
      }
      const messages = readFileSync(capturePath, "utf8").trim().split("\n")
        .map(line => JSON.parse(line) as { pid: number; method: string; sessionId?: string; prompt?: Array<{ text: string }> });
      expect(new Set(messages.map(message => message.pid)).size).toBe(2);
      expect(messages.filter(message => message.method === "session/prompt")).toHaveLength(2);
      expect(messages.filter(message => message.method === "session/load")).toEqual([]);
      if (providerId === "kimi") {
        expect(messages.find(message => message.method === "session/resume")?.sessionId).toBe(results[0]!.sessionId);
      } else {
        expect(messages.filter(message => message.method === "session/new")).toHaveLength(2);
        expect(messages.filter(message => message.method === "session/prompt")[1]!.prompt?.[0]?.text)
          .toContain("application-reconstructed conversation context");
      }
    } finally {
      manager.cancel("same-conversation");
      if (pending) await pending;
      await removePortableFixture(root);
    }
  });
});
