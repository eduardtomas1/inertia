// @inertia-test-suite portable
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import type { AgentHarnessCallbacks } from "../../src/server/provider/agent-harness";
import { portableFixtureRoot, portableNodeExecutable, removePortableFixture,
  waitFor, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

function fixture(
  providerId: "cursor" | "kimi",
  stalledMethod?: string,
  update?: object | object[],
  replay?: object,
) {
  const root = portableFixtureRoot(`${providerId} adapter drift`);
  roots.push(root);
  const marker = join(root, "requests.jsonl");
  const command = portableNodeExecutable(root, `${providerId}-drift`);
  writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const frame = (value) => JSON.stringify(value) + "\\n";
const send = (value) => process.stdout.write(frame(value));
const sessionId = "drift-session";
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(message) + "\\n");
  if (message.method === ${JSON.stringify(stalledMethod ?? "never")}) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true },
    agentInfo: { name: ${JSON.stringify(providerId === "kimi" ? "Kimi Code" : "Cursor")}, version: "test" }
  } });
  if (message.method === "session/load") {
    const replay = ${JSON.stringify(replay ?? null)};
    if (replay) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: replay } });
    return send({ jsonrpc: "2.0", id: message.id, result: {
      modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: []
    } });
  }
  if (message.method === "session/prompt") {
    const updates = [${JSON.stringify(update ?? null)}].flat().filter(Boolean);
    let burst = updates.map((value) => frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } })).join("");
    burst += frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" }
    } } });
    burst += frame({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return process.stdout.write(burst);
  }
});
`);
  const harness = providerId === "cursor"
    ? createCursorAcpHarness({ controlRpcTimeoutMs: 5_000 })
    : createKimiAcpHarness({ controlRpcTimeoutMs: 5_000 });
  return { marker, start: (callbacks: AgentHarnessCallbacks = {}) => harness.start({ executable: command, environment: process.env, callbacks, providerNativeToolsAvailable: false, input: nativeProviderRunInput({
    providerId, conversationId: "drift-test", cwd: root, prompt: "Test",
    sessionId: "drift-session", interactionMode: "build", access: "supervised",
  }) }) };
}

describe.each(["cursor", "kimi"] as const)("%s ACP drift regressions", (providerId) => {
  it.each(["initialize", "session/load"])("cancels a resumed session stalled at %s", async (method) => {
    const { start, marker } = fixture(providerId, method);
    const run = start();
    const result = run.result;
    try {
      await waitFor(`stalled ${method}`, () => existsSync(marker) && readFileSync(marker, "utf8").includes(JSON.stringify(method)));
      run.cancel(false);
      await expect(Promise.race([result, new Promise((resolve) => {
        const timer = setTimeout(() => resolve("still running"), 4_000); timer.unref();
      })])).resolves.toMatchObject({ status: "cancelled", cleanupConfirmed: true });
      expect(readFileSync(marker, "utf8")).not.toContain('"session/cancel"');
    } finally {
      run.cancel(true);
      await result;
    }
  });

  it.each([
    { used: 1.5, size: 1000 }, { used: 1, size: -1 },
  ])("rejects malformed usage $used / $size", async (usage) => {
    const { start } = fixture(providerId, undefined, { sessionUpdate: "usage_update", ...usage });
    const result = await start().result;
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(JSON.stringify(result.failure)).toMatch(/malformed usage update/iu);
  });

  it("ignores a usage update whose used tokens exceed the context size and completes the turn", async () => {
    const { start } = fixture(providerId, undefined, [
      { sessionUpdate: "usage_update", used: 1001, size: 1000 },
      { sessionUpdate: "usage_update", used: 10, size: 1000 },
    ]);
    const usage: Array<number | null> = [];
    const result = await start({ onEvent: (event) => {
      if (event.type === "extension" && "event" in event && event.event.type === "usage") {
        usage.push(event.event.usage.usedTokens);
      }
    } }).result;
    expect(result).toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
    expect(usage).toEqual([10]);
  });

  it("ignores a session update kind newer than the pinned ACP schema", async () => {
    const { start } = fixture(providerId, undefined, [
      { sessionUpdate: "future_kind_from_newer_agent", value: 1 },
    ], { sessionUpdate: "future_replay_kind", value: 2 });
    const result = await start().result;
    expect(result).toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
    expect(result.error).toBeUndefined();
  });

  it.each([
    { sessionUpdate: "future\nkind" },
    { sessionUpdate: "x".repeat(1_001) },
    { sessionUpdate: "agent_message_chunk", content: { type: "future_content" } },
  ])("still rejects a malformed session update $sessionUpdate", async (update) => {
    const { start } = fixture(providerId, undefined, [update]);
    const result = await start().result;
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(result.failure?.reason).toBe("malformed-protocol");
  });

  it("rejects an unnegotiated ACP 1.5 notice and confirms cleanup", async () => {
    const { start, marker } = fixture(providerId, undefined, {
      sessionUpdate: "notice", severity: "warning", title: "Fixture advisory",
    });
    const result = await start().result;
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(result.failure?.reason).toBe("malformed-protocol");
    expect(JSON.stringify(result.failure)).toMatch(/malformed session update envelope/iu);
    const requests = readFileSync(marker, "utf8").trim().split("\n").map((line) => (
      JSON.parse(line) as { method: string; params?: { clientCapabilities?: object } }
    ));
    expect(requests.find((request) => request.method === "initialize")?.params?.clientCapabilities)
      .not.toHaveProperty("session.notices");
  });

  it.each([
    { sessionUpdate: "subagent_update", sessionId: "child-session", title: "Fixture child" },
    { sessionUpdate: "session_message", messageId: "message-1", content: [{ type: "text", text: "Hello" }] },
    { sessionUpdate: "session_message_chunk", messageId: "message-1", content: { type: "text", text: "Hello" } },
  ])("rejects an unnegotiated ACP 1.7 $sessionUpdate and confirms cleanup", async (update) => {
    const { start, marker } = fixture(providerId, undefined, update);
    const result = await start().result;
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(result.failure?.reason).toBe("malformed-protocol");
    const requests = readFileSync(marker, "utf8").trim().split("\n").map((line) => (
      JSON.parse(line) as { method: string; params?: { clientCapabilities?: object } }
    ));
    expect(requests.find((request) => request.method === "initialize")?.params?.clientCapabilities)
      .not.toHaveProperty("subagents");
  });

  it("rejects a tool identity containing NUL", async () => {
    const { start } = fixture(providerId, undefined, {
      sessionUpdate: "tool_call", toolCallId: "tool\0other", title: "Test tool", kind: "read", status: "completed",
    });
    expect(await start().result).toMatchObject({ status: "failed", cleanupConfirmed: true });
  });
});
