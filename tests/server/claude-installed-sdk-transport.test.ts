// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { PassThrough } from "node:stream";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";

import { ClaudePromptChannel } from "../../src/server/provider/claude-prompt-channel";
import { fakeClaudeChild } from "../helpers/claude-harness-fixture";
import { claudeSuccessResult, claudeSystem } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";

it("keeps the installed SDK permission and follow-up stream open after a provisional result", async () => {
  // Real pinned SDK, synthetic stdio only: no CLI, model API, authentication,
  // or native cleanup claim. Adapter/native lifecycle tests own those layers.
  const root = portableFixtureRoot("installed Claude SDK transport");
  const child = fakeClaudeChild();
  const channel = new ClaudePromptChannel();
  const received: Array<Record<string, unknown>> = [];
  const send = (message: unknown): void => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
  };
  const lines = createInterface({ input: child.stdin as PassThrough });
  let userCount = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    received.push(message);
    if (message.type === "control_request") {
      send({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id,
        response: { commands: [], models: [], agents: [], account: {} },
      } });
    } else if (message.type === "user") {
      userCount += 1;
      if (userCount === 1) send(claudeSystem("init", { capabilities: ["interrupt_receipt_v1"] }));
      send({
        ...claudeSuccessResult(userCount === 1 ? "Provisional result" : "Follow-up result",
          userCount === 1 ? "background_requested" : "completed"),
        user_message_uuid: message.uuid,
      });
    }
  });
  let permissions = 0;
  const sdk = query({
    prompt: channel,
    options: {
      cwd: root, env: {}, settingSources: [], pathToClaudeCodeExecutable: process.execPath,
      spawnClaudeCodeProcess: () => child,
      canUseTool: async (_name, input) => {
        permissions += 1;
        return { behavior: "allow", updatedInput: input };
      },
    },
  });
  const enqueue = (text: string): string => {
    const uuid = randomUUID();
    const message: SDKUserMessage = {
      type: "user", uuid, parent_tool_use_id: null,
      message: { role: "user", content: text },
    };
    const reservation = channel.reserve(1024);
    expect(reservation).not.toBeNull();
    expect(channel.push(message, reservation!)).toBe(true);
    return uuid;
  };
  const results: SDKMessage[] = [];
  const consume = (async () => {
    for await (const message of sdk) {
      if (message.type === "result") results.push(message);
      if (results.length === 2) break;
    }
  })();
  try {
    const firstId = enqueue("Synthetic initial request");
    await expect.poll(() => results.length).toBe(1);
    expect(results[0]).toMatchObject({ user_message_uuid: firstId });
    send({ type: "control_request", request_id: "permission-after-result", request: {
      subtype: "can_use_tool", tool_name: "Read", input: { file_path: "synthetic.txt" }, tool_use_id: "synthetic-tool",
    } });
    await expect.poll(() => permissions).toBe(1);
    await expect.poll(() => received.some((message) => message.type === "control_response"
      && (message.response as { request_id?: string })?.request_id === "permission-after-result")).toBe(true);
    const secondId = enqueue("Synthetic follow-up request");
    await expect.poll(() => results.length).toBe(2);
    expect(results[1]).toMatchObject({ user_message_uuid: secondId, result: "Follow-up result" });
    await consume;
  } finally {
    channel.cancel();
    sdk.close();
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await removePortableFixture(root);
  }
});
