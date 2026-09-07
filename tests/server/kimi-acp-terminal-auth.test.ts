// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { executableProcessExists } from "../helpers/executable-process";
import {
  portableFixtureRoot, portableNodeExecutable, removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Kimi ACP terminal authentication", () => {
  it.each([false, true])("uses existing credentials without sending terminal authenticate (resume=%s)", async (resume) => {
    const { result, messages } = await runTerminalAuthFixture({ resume });
    expect(result).toMatchObject({ status: "completed", text: "Already signed in", cleanupConfirmed: true });
    expect(messages[0]).toMatchObject({
      method: "initialize", params: { clientCapabilities: { auth: { terminal: true } } },
    });
    expect(messages.filter(({ method }) => method === "authenticate")).toEqual([]);
    expect(messages.filter(({ method }) => method === "session/prompt")).toHaveLength(1);
    expect(messages.find(({ method }) => method === (resume ? "session/resume" : "session/new")))
      .toMatchObject({ params: resume ? { sessionId: "retained-session" } : { cwd: expect.any(String) } });
  });

  it.each([false, true])("reports Connect recovery without launching login or retrying an unauthenticated operation (resume=%s)", async (resume) => {
    const { result, messages } = await runTerminalAuthFixture({ resume, authRequired: true });
    expect(result).toMatchObject({
      status: "failed", cleanupConfirmed: true,
      error: "Kimi Code is not authenticated. Connect Kimi Code in provider settings, then try again.",
      failure: { phase: "auth", terminalEvent: resume ? "session/resume" : "session/new" },
    });
    expect(messages.map(({ method }) => method)).toEqual([
      "initialize", resume ? "session/resume" : "session/new",
    ]);
  });

  it.each([{ env: { NODE_OPTIONS: 123 } }, { type: "other" }])(
    "rejects malformed wire auth metadata before any session or authenticate request (%j)", async (authMethod) => {
      const { result, messages } = await runTerminalAuthFixture({ resume: false, authMethod });
      expect(result).toMatchObject({
        status: "failed", cleanupConfirmed: true,
        error: "Kimi ACP returned an unsupported or invalid terminal authentication descriptor.",
      });
      expect(messages.map(({ method }) => method)).toEqual(["initialize"]);
    },
  );
});

async function runTerminalAuthFixture(options: {
  resume: boolean; authRequired?: boolean; authMethod?: Record<string, unknown>;
}) {
  const root = portableFixtureRoot("Kimi terminal auth existing credentials");
  const capturePath = join(root, "wire.jsonl");
  const command = portableNodeExecutable(root, "kimi");
  writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv.includes("--login")) throw new Error("A turn must not launch interactive login.");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ pid: process.pid, ...message }) + "\\n");
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } },
    authMethods: [{ id: "login", type: "terminal", name: "Kimi login", args: ["--login"], env: {},
      _meta: { "terminal-auth": { command: "never-execute-this-legacy-command", args: ["login"] } },
      ...${JSON.stringify(options.authMethod ?? {})} }],
    agentInfo: { name: "Kimi Code CLI", version: "fixture" },
  } });
  if (message.method === "authenticate") throw new Error("Terminal auth IDs are forbidden in authenticate.");
  if (message.method === "session/new" || message.method === "session/resume") {
    if (${options.authRequired === true}) return send({ jsonrpc: "2.0", id: message.id,
      error: { code: -32000, message: "Authentication required" } });
    return send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "retained-session",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }, configOptions: [],
    } });
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "retained-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Already signed in" },
    } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
  const manager = ProviderManager.createForTests({ commands: { kimi: command } },
    new AgentHarnessRegistry([createKimiAcpHarness()]));
  let pending: ReturnType<typeof manager.run> | undefined;
  try {
    pending = manager.run(nativeProviderRunInput({
      providerId: "kimi", conversationId: "terminal-auth", cwd: root,
      prompt: "Start", interactionMode: "build", access: "supervised",
      ...(options.resume ? { sessionId: "retained-session" } : {}),
    }));
    const result = await pending;
    const messages = readFileSync(capturePath, "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { pid: number; method: string; params: unknown });
    for (const pid of new Set(messages.map(({ pid }) => pid))) expect(executableProcessExists(pid)).toBe(false);
    expect(manager.activeConversationIds()).toEqual([]);
    return { result, messages };
  } finally {
    manager.cancel("terminal-auth");
    if (pending) await pending;
    await removePortableFixture(root);
  }
}
