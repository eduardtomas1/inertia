import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  AgentHarnessRegistry,
  ProviderManager,
} from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

describe.sequential("provider compaction adapters", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(
    roots.splice(0).map(removePortableFixture),
  ));

  it("uses Codex App Server compaction and waits for its completion item", async () => {
    const root = portableFixtureRoot("Codex compact");
    roots.push(root);
    const capturePath = join(root, "capture.jsonl");
    const command = portableNodeExecutable(root, "codex");
    writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const capture = (value) => fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    return send({ method: "item/completed", params: { threadId: message.params.threadId, item: { id: "compact-1", type: "contextCompaction" } } });
  }
});
`);
    const manager = new ProviderManager({ commands: { codex: command } });

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }), "remember retrieval exactly")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: false,
      message: expect.stringContaining("was not forwarded"),
    });
    const messages = readFileSync(capturePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { method: string });
    expect(messages.some(({ method }) => method === "thread/compact/start"))
      .toBe(true);
    expect(messages.some(({ method }) => method === "turn/start")).toBe(false);
  });

  it("does not accept a Codex compaction item from another thread", async () => {
    const root = portableFixtureRoot("Codex compact wrong thread");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "item/completed", params: { threadId: "different-thread", item: { id: "compact-wrong", type: "contextCompaction" } } });
    return setTimeout(() => process.exit(0), 10);
  }
});
`);
    const manager = new ProviderManager({ commands: { codex: command } });

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-wrong-thread",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("early"),
    });
  });

  it("forwards Claude focus text and requires native completion proof", async () => {
    const root = portableFixtureRoot("Claude compact");
    roots.push(root);
    let capturedPrompt: SDKUserMessage | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          capturedPrompt = (await iterator.next()).value;
          yield claudeSystem("status", { status: null, compact_result: "success" });
          yield claudeSuccessResult("Compacted");
        })(),
      ),
    });
    const manager = new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "claude-session",
    }), "remember retrieval exactly")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: true,
    });
    expect(JSON.stringify(capturedPrompt)).toContain(
      "/compact remember retrieval exactly",
    );

    const unprovenManager = new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSuccessResult("Ordinary result");
          })(),
        ),
      })]),
    );
    await expect(unprovenManager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-unproven",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "claude-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not confirm"),
    });

    const contradictoryManager = new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("status", {
              status: null,
              compact_result: "failed",
              compact_error: "Compaction rejected",
            });
            yield claudeSystem("compact_boundary", {
              compact_metadata: {
                trigger: "manual",
                pre_tokens: 1_000,
              },
            });
            yield claudeSuccessResult("Ordinary result");
          })(),
        ),
      })]),
    );
    await expect(contradictoryManager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-contradictory",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "claude-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("Compaction rejected"),
    });
  });
});
