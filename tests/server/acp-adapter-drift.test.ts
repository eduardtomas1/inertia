// @inertia-test-suite portable
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { portableFixtureRoot, portableNodeExecutable, removePortableFixture,
  waitFor, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

function fixture(providerId: "cursor" | "kimi", stalledMethod?: string, update?: object) {
  const root = portableFixtureRoot(`${providerId} adapter drift`);
  roots.push(root);
  const marker = join(root, "requests.jsonl");
  const command = portableNodeExecutable(root, `${providerId}-drift`);
  writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "drift-session";
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(message.method) + "\\n");
  if (message.method === ${JSON.stringify(stalledMethod ?? "never")}) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true },
    agentInfo: { name: ${JSON.stringify(providerId === "kimi" ? "Kimi Code" : "Cursor")}, version: "test" }
  } });
  if (message.method === "session/load") return send({ jsonrpc: "2.0", id: message.id, result: {
    modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: []
  } });
  if (message.method === "session/prompt") {
    const update = ${JSON.stringify(update ?? null)};
    if (update) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" }
    } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
  const harness = providerId === "cursor"
    ? createCursorAcpHarness({ controlRpcTimeoutMs: 5_000 })
    : createKimiAcpHarness({ controlRpcTimeoutMs: 5_000 });
  return { marker, start: () => harness.start({ executable: command, environment: process.env, callbacks: {}, providerNativeToolsAvailable: false, input: nativeProviderRunInput({
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
        const timer = setTimeout(() => resolve("still running"), 1_000); timer.unref();
      })])).resolves.toMatchObject({ status: "cancelled", cleanupConfirmed: true });
      expect(readFileSync(marker, "utf8")).not.toContain('"session/cancel"');
    } finally {
      run.cancel(true);
      await result;
    }
  });

  it.each([
    { used: 1001, size: 1000 }, { used: 1.5, size: 1000 }, { used: 1, size: -1 },
  ])("rejects incoherent usage $used / $size", async (usage) => {
    const { start } = fixture(providerId, undefined, { sessionUpdate: "usage_update", ...usage });
    const result = await start().result;
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(JSON.stringify(result.failure)).toMatch(/malformed usage update/iu);
  });

  it("rejects a tool identity containing NUL", async () => {
    const { start } = fixture(providerId, undefined, {
      sessionUpdate: "tool_call", toolCallId: "tool\0other", title: "Test tool", kind: "read", status: "completed",
    });
    expect(await start().result).toMatchObject({ status: "failed", cleanupConfirmed: true });
  });
});
