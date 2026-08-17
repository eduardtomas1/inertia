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
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import {
  continuationIdentityForSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";
import { nativeProviderRunInput } from "./model-route-fixture";

function codexCompactionTierAgent(
  root: string,
  capturePath: string,
  attestedTier: "echo" | "priority" | "default" | null,
): string {
  const command = process.execPath;
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
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId }, serviceTier: ${attestedTier === "echo" ? "message.params.serviceTier" : JSON.stringify(attestedTier)} } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "item/started", params: { threadId: message.params.threadId, turnId: "compact-tier-turn", startedAtMs: Date.now(), item: { id: "compact-tier-item", type: "contextCompaction" } } });
    return send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "compact-tier-turn", completedAtMs: Date.now(), item: { id: "compact-tier-item", type: "contextCompaction" } } });
  }
});
`);
  return command;
}

describe.sequential("provider compaction adapters", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const trackManager = (manager: ProviderManager): ProviderManager => {
    managers.push(manager);
    return manager;
  };
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("uses Codex App Server compaction and waits for its completion item", async () => {
    const root = portableFixtureRoot("Codex compact");
    roots.push(root);
    const capturePath = join(root, "capture.jsonl");
    const command = process.execPath;
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
    send({ method: "item/started", params: { threadId: message.params.threadId, turnId: "compact-turn-1", startedAtMs: Date.now(), item: { id: "compact-1", type: "contextCompaction" } } });
    return send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "compact-turn-1", completedAtMs: Date.now(), item: { id: "compact-1", type: "contextCompaction" } } });
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

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

  it.each([
    ["Fast", "priority", "echo"],
    ["Standard", null, "default"],
  ] as const)("forwards and attests %s mode during Codex compaction", async (
    _label,
    requestedTier,
    attestedTier,
  ) => {
    const root = portableFixtureRoot(`Codex compact ${_label} tier`);
    roots.push(root);
    const capturePath = join(root, "capture.jsonl");
    const command = codexCompactionTierAgent(
      root,
      capturePath,
      attestedTier,
    );
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );
    const base = nativeProviderRunInput({
      providerId: "codex",
      conversationId: `codex-compact-${_label.toLowerCase()}-tier`,
      cwd: root,
      prompt: "/compact",
      model: "model-a",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    });
    const selection = requestedTier === "priority"
      ? withModelSelectionFastMode(base.modelSelection, requestedTier)
      : base.modelSelection;

    await expect(manager.compact({
      ...base,
      supportedFastMode: "priority",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    })).resolves.toMatchObject({ status: "completed" });

    const messages = readFileSync(capturePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as {
        method: string;
        params?: { serviceTier?: "priority" | null };
      });
    expect(messages.find(({ method }) => method === "thread/resume"))
      .toMatchObject({ params: { serviceTier: requestedTier } });
  });

  it("rejects Codex compaction when resume attests a different service tier", async () => {
    const root = portableFixtureRoot("Codex compact tier mismatch");
    roots.push(root);
    const command = codexCompactionTierAgent(
      root,
      join(root, "capture.jsonl"),
      null,
    );
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );
    const base = nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-tier-mismatch",
      cwd: root,
      prompt: "/compact",
      model: "model-a",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    });
    const selection = withModelSelectionFastMode(
      base.modelSelection,
      "priority",
    );

    await expect(manager.compact({
      ...base,
      supportedFastMode: "priority",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    })).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("service tier for compaction"),
    });
  });

  it("does not accept a stale timestamped Codex lifecycle after requesting compaction", async () => {
    const root = portableFixtureRoot("Codex compact stale lifecycle");
    roots.push(root);
    const command = process.execPath;
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
    send({ method: "item/started", params: { threadId: message.params.threadId, turnId: "stale-turn", startedAtMs: 1, item: { id: "compact-stale", type: "contextCompaction" } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "stale-turn", completedAtMs: 2, item: { id: "compact-stale", type: "contextCompaction" } } });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-stale-lifecycle",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it.each([
    ["item whitespace", "compact-proof ", "compact-proof", "compact-turn", "compact-turn"],
    ["turn whitespace", "compact-proof", "compact-proof", "compact-turn ", "compact-turn"],
    ["overlength item", "a".repeat(513), "a".repeat(513), "compact-turn", "compact-turn"],
    ["overlength turn", "compact-proof", "compact-proof", "b".repeat(513), "b".repeat(513)],
  ])("does not correlate normalized Codex lifecycle IDs (%s)", async (
    _label,
    startedItemId,
    completedItemId,
    startedTurnId,
    completedTurnId,
  ) => {
    const root = portableFixtureRoot(`Codex compact invalid lifecycle ${_label}`);
    roots.push(root);
    const command = process.execPath;
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
    send({ method: "item/started", params: { threadId: message.params.threadId, turnId: ${JSON.stringify(startedTurnId)}, startedAtMs: Date.now(), item: { id: ${JSON.stringify(startedItemId)}, type: "contextCompaction" } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: ${JSON.stringify(completedTurnId)}, completedAtMs: Date.now(), item: { id: ${JSON.stringify(completedItemId)}, type: "contextCompaction" } } });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `codex-compact-invalid-lifecycle-${_label}`,
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it("does not accept a same-thread Codex completion without its post-request start", async () => {
    const root = portableFixtureRoot("Codex compact unstarted item");
    roots.push(root);
    const command = process.execPath;
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
    send({ method: "item/completed", params: { threadId: message.params.threadId, item: { id: "compact-stale", type: "contextCompaction" } } });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-unstarted-item",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it("does not accept a Codex compaction item from another thread", async () => {
    const root = portableFixtureRoot("Codex compact wrong thread");
    roots.push(root);
    const command = process.execPath;
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
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

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
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it("does not accept a stale same-thread Codex item before requesting compaction", async () => {
    const root = portableFixtureRoot("Codex compact stale item");
    roots.push(root);
    const command = process.execPath;
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    send({ method: "item/completed", params: { threadId: message.params.threadId, item: { id: "compact-stale", type: "contextCompaction" } } });
    return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-stale-item",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
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
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([harness]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }), "remember retrieval exactly")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: true,
    });
    expect(JSON.stringify(capturedPrompt)).toContain(
      "/compact remember retrieval exactly",
    );

    const unprovenManager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSuccessResult("Ordinary result");
          })(),
        ),
      })]),
    ));
    await expect(unprovenManager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-unproven",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not confirm"),
    });

    const contradictoryManager = trackManager(new ProviderManager(
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
    ));
    await expect(contradictoryManager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-contradictory",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("Compaction rejected"),
    });
  });

  it("rejects a successful provider result for a different session", async () => {
    const root = portableFixtureRoot("Claude compact wrong session");
    roots.push(root);
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("status", {
              status: null,
              compact_result: "success",
            });
            yield claudeSuccessResult("Compacted");
          })(),
        ),
      })]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-wrong-session",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "different-claude-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("exact selected session"),
      cleanupConfirmed: true,
    });
  });

  it("does not accept a foreign Claude proof followed by a selected-session result", async () => {
    const root = portableFixtureRoot("Claude compact foreign proof");
    roots.push(root);
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield {
              ...claudeSystem("status", {
                status: null,
                compact_result: "success",
              }),
              session_id: "foreign-claude-session",
            } as SDKMessage;
            yield claudeSuccessResult("Ordinary selected-session result");
          })(),
        ),
      })]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-foreign-proof",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not confirm"),
      cleanupConfirmed: true,
    });
  });

  it("does not accept Fast attestation from a foreign Claude session", async () => {
    const root = portableFixtureRoot("Claude compact foreign Fast init");
    roots.push(root);
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield {
              ...claudeSystem("init", { fast_mode_state: "on" }),
              session_id: "foreign-claude-session",
            } as SDKMessage;
            yield claudeSystem("status", {
              status: null,
              compact_result: "success",
            });
            yield claudeSuccessResult("Selected-session result");
          })(),
        ),
      })]),
    ));
    const base = nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-foreign-fast-init",
      cwd: root,
      prompt: "/compact",
      model: "claude-opus",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    });
    const selection = withModelSelectionFastMode(base.modelSelection, "fast");

    await expect(manager.compact({
      ...base,
      supportedFastMode: "fast",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    })).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not confirm Fast mode"),
      cleanupConfirmed: true,
    });
  });
});
