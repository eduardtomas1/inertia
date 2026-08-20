import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  ClaudeRunEventBudget,
  MAX_CLAUDE_EVENT_MEDIA_BYTES,
  MAX_CLAUDE_MEDIA_BURST_BYTES,
  MAX_CLAUDE_MEDIA_BURST_ENCODED_BYTES,
  projectClaudeSdkEventMedia,
} from "../../src/server/provider/claude-event-budget";
import { ProviderRunEventBudget } from "../../src/server/provider/io";
import { CLAUDE_ISOLATED_SKILL_PLUGIN_NAME } from "../../src/server/provider/claude-skill-plugin";
import {
  fakeClaudeChild,
  writeClaudeSkill,
} from "../helpers/claude-harness-fixture";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import {
  portableFixtureRoot,
  removePortableFixture,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function claudeReadMediaResult(options: {
  base64: string;
  bytes: number;
  kind?: "image" | "pdf";
  toolUseId?: string;
}): SDKUserMessage {
  const kind = options.kind ?? "image";
  return {
    type: "user",
    session_id: "77777777-7777-4777-8777-777777777777",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: options.toolUseId ?? "tool-read-media",
        content: kind === "image"
          ? [{
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: options.base64,
              },
            }]
          : [{
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: options.base64,
              },
            }],
      }],
    },
    tool_use_result: kind === "image"
      ? {
          type: "image",
          file: {
            base64: options.base64,
            type: "image/png",
            originalSize: options.bytes,
            dimensions: {
              originalWidth: 100,
              originalHeight: 100,
              displayWidth: 100,
              displayHeight: 100,
            },
          },
        }
      : {
          type: "pdf",
          file: {
            filePath: "/workspace/report.pdf",
            base64: options.base64,
            originalSize: options.bytes,
          },
        },
  } satisfies SDKUserMessage;
}

function claudeEventBudget(): ClaudeRunEventBudget {
  return new ClaudeRunEventBudget(new ProviderRunEventBudget(
    "Claude",
    1024 * 1024,
    8_192,
    32 * 1024 * 1024,
  ));
}

describe("Claude Agent SDK large event boundary", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(
    roots.splice(0).map(removePortableFixture),
  ));

  it.each(["image", "pdf"] as const)(
    "accepts the exact duplicated oversized Read %s result without exposing media",
    async (kind) => {
      const root = portableFixtureRoot(`Claude SDK ${kind} result`);
      roots.push(root);
      const raw = Buffer.alloc(512 * 1024, kind === "image" ? 0xa5 : 0x5a);
      const base64 = raw.toString("base64");
      // Claude may resize/optimize an image for the model while retaining the
      // source file's byte count in `originalSize`.
      const originalSize = kind === "image" ? 768 * 1024 : raw.byteLength;
      const mediaEvent = claudeReadMediaResult({
        base64,
        bytes: originalSize,
        kind,
      });
      expect(Buffer.byteLength(JSON.stringify(mediaEvent), "utf8"))
        .toBeGreaterThan(1024 * 1024);
      if (kind === "image") {
        const topology = mediaEvent as unknown as {
          message: { content: Array<{ content: Array<{ source: Record<string, unknown> }> }> };
          tool_use_result: { file: Record<string, unknown> };
        };
        expect(Object.keys(topology.message.content[0]!).sort())
          .toEqual(["content", "tool_use_id", "type"]);
        expect(Object.keys(topology.message.content[0]!.content[0]!.source).sort())
          .toEqual(["data", "media_type", "type"]);
        expect(Object.keys(topology.tool_use_result).sort()).toEqual(["file", "type"]);
        expect(Object.keys(topology.tool_use_result.file).sort())
          .toEqual(["base64", "dimensions", "originalSize", "type"]);
        expect("toolUseResult" in topology).toBe(false);
      }
      const activities: unknown[] = [];
      let closeCalls = 0;
      const harness = createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield {
              type: "assistant",
              session_id: "77777777-7777-4777-8777-777777777777",
              parent_tool_use_id: null,
              message: {
                role: "assistant",
                content: [{
                  type: "tool_use",
                  id: "tool-read-media",
                  name: "Read",
                  input: { file_path: kind === "image" ? "scan.png" : "report.pdf" },
                }],
              },
            } as unknown as SDKMessage;
            yield mediaEvent;
            yield claudeSuccessResult("Read completed", "completed");
          })(),
          { close: () => { closeCalls += 1; } },
        ),
      });
      const manager = new ProviderManager(
        { commands: { claude: process.execPath } },
        new AgentHarnessRegistry([harness]),
      );

      const result = await manager.run(nativeProviderRunInput({
        providerId: "claude",
        conversationId: `claude-${kind}-result`,
        cwd: root,
        prompt: "Read the media",
        interactionMode: "build",
        access: "full",
      }), { onActivity: (event) => activities.push(event) });

      expect(result).toMatchObject({ status: "completed", text: "Read completed" });
      expect(activities).toEqual([
        expect.objectContaining({ label: "Read", phase: "started" }),
        expect.objectContaining({ label: "Read", phase: "completed" }),
      ]);
      expect(JSON.stringify({ result, activities })).not.toContain(base64.slice(0, 128));
      expect(closeCalls).toBe(1);
      expect(manager.activeConversationIds()).toEqual([]);
    },
  );

  it("enforces payload bounds while treating source size as independent metadata", () => {
    const largeBytes = 16.5 * 1024 * 1024;
    const largeBase64 = Buffer.alloc(largeBytes, 0xa5).toString("base64");
    const large = projectClaudeSdkEventMedia(claudeReadMediaResult({
      base64: largeBase64,
      bytes: largeBytes,
    }));
    expect(large.mediaBytes).toBe(largeBytes);
    expect(large.mediaEncodedBytes).toBe(largeBase64.length * 2);
    expect(JSON.stringify(large.value)).not.toContain(largeBase64.slice(0, 128));

    const atLimit = Buffer.alloc(MAX_CLAUDE_EVENT_MEDIA_BYTES, 0xa5).toString("base64");
    expect(projectClaudeSdkEventMedia(claudeReadMediaResult({
      base64: atLimit,
      bytes: MAX_CLAUDE_EVENT_MEDIA_BYTES,
    })).mediaBytes).toBe(MAX_CLAUDE_EVENT_MEDIA_BYTES);
    const overLimit = Buffer.alloc(MAX_CLAUDE_EVENT_MEDIA_BYTES + 1, 0xa5)
      .toString("base64");
    expect(() => projectClaudeSdkEventMedia(claudeReadMediaResult({
      base64: overLimit,
      bytes: MAX_CLAUDE_EVENT_MEDIA_BYTES + 1,
    }))).toThrow("Claude sent oversized tool-result media.");

    for (const base64 of ["YQ", "AB==", "%%%="]) {
      expect(() => projectClaudeSdkEventMedia(claudeReadMediaResult({
        base64,
        bytes: 1,
      }))).toThrow(/non-canonical base64|malformed tool-result media/u);
    }
    expect(projectClaudeSdkEventMedia(claudeReadMediaResult({
      base64: "YQ==",
      bytes: 2,
    })).mediaBytes).toBe(1);
    for (const originalSize of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => projectClaudeSdkEventMedia(claudeReadMediaResult({
        base64: "YQ==",
        bytes: originalSize,
      }))).toThrow("Claude sent malformed structured tool-result media.");
    }
    expect(projectClaudeSdkEventMedia(claudeReadMediaResult({
      base64: "YQ==",
      bytes: MAX_CLAUDE_EVENT_MEDIA_BYTES + 1,
    })).mediaBytes).toBe(1);
    const transformedPdf = projectClaudeSdkEventMedia(claudeReadMediaResult({
      base64: "YQ==",
      bytes: 2,
      kind: "pdf",
    }));
    expect(transformedPdf.mediaBytes).toBe(1);
    expect(JSON.stringify(transformedPdf.value)).not.toContain("YQ==");
    expect(() => claudeEventBudget().observe(claudeReadMediaResult({
      base64: "YQ==",
      bytes: 2,
      kind: "pdf",
    }))).not.toThrow();
  // V8 coverage instruments the intentional 16.5/64 MiB boundary scans. The
  // exact CI case took 15.916s, so bound only this CPU-heavy test explicitly.
  }, 30_000);

  it("keeps malformed, mismatched, unknown, and non-media data on strict bounds", () => {
    const wrongMime = claudeReadMediaResult({ base64: "YQ==", bytes: 1 }) as unknown as {
      message: { content: Array<{ content: Array<{ source: { media_type: string } }> }> };
    };
    wrongMime.message.content[0]!.content[0]!.source.media_type = "application/octet-stream";
    expect(() => projectClaudeSdkEventMedia(wrongMime))
      .toThrow("Claude sent malformed tool-result media.");

    const malformedStructured = claudeReadMediaResult({
      base64: "YQ==",
      bytes: 1,
    }) as unknown as { tool_use_result: { file: { base64: string } } };
    malformedStructured.tool_use_result.file.base64 = "AB==";
    expect(() => projectClaudeSdkEventMedia(malformedStructured))
      .toThrow("Claude sent non-canonical base64 tool-result media.");

    const pairedBytes = 512 * 1024;
    const firstCopy = Buffer.alloc(pairedBytes, 0xa5).toString("base64");
    const mismatchedCopy = Buffer.alloc(pairedBytes, 0x5a).toString("base64");
    const mismatched = claudeReadMediaResult({
      base64: firstCopy,
      bytes: pairedBytes,
    }) as unknown as { tool_use_result: { file: { base64: string } } };
    mismatched.tool_use_result.file.base64 = mismatchedCopy;
    expect(projectClaudeSdkEventMedia(mismatched).mediaBytes).toBe(0);
    expect(() => claudeEventBudget().observe(mismatched))
      .toThrow("Claude sent an oversized event.");

    expect(() => claudeEventBudget().observe({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          content: [{ type: "json", base64: "a".repeat(1024 * 1024) }],
        }],
      },
      tool_use_result: { type: "custom", base64: "a".repeat(1024 * 1024) },
    })).toThrow("Claude sent an oversized event.");
    expect(() => claudeEventBudget().observe({
      type: "status",
      message: "é".repeat(600 * 1024),
    })).toThrow("Claude sent an oversized event.");
  });

  it("accounts duplicate occurrences atomically across burst and run ceilings", () => {
    let now = 0;
    const bytes = 15 * 1024 * 1024;
    const base64 = Buffer.alloc(bytes, 0x5a).toString("base64");
    const event = claudeReadMediaResult({ base64, bytes });
    const budget = new ClaudeRunEventBudget(new ProviderRunEventBudget(
      "Claude",
      1024 * 1024,
      8_192,
      32 * 1024 * 1024,
      { windowMs: 1_000, now: () => now },
    ), {
      windowMs: 1_000,
      now: () => now,
      maxRunMediaBytes: MAX_CLAUDE_MEDIA_BURST_BYTES + bytes,
      maxRunMediaEncodedBytes:
        MAX_CLAUDE_MEDIA_BURST_ENCODED_BYTES + base64.length * 2,
    });
    expect(() => budget.observe({
      ...event as unknown as Record<string, unknown>,
      unrelated: "x".repeat(1024 * 1024),
    })).toThrow("Claude sent an oversized event.");
    for (let index = 0; index < 3; index += 1) budget.observe(event);
    const remainingBytes = MAX_CLAUDE_MEDIA_BURST_BYTES - 3 * bytes;
    const remainingBase64 = Buffer.alloc(remainingBytes, 0xa5).toString("base64");
    expect(3 * base64.length * 2 + remainingBase64.length * 2)
      .toBe(MAX_CLAUDE_MEDIA_BURST_ENCODED_BYTES);
    budget.observe(claudeReadMediaResult({
      base64: remainingBase64,
      bytes: remainingBytes,
    }));
    expect(() => budget.observe(claudeReadMediaResult({
      base64: "YQ==",
      bytes: 1,
    }))).toThrow("Claude exceeded the bounded media event rate for this run.");
    now = 1_000;
    expect(() => budget.observe(claudeReadMediaResult({
      base64,
      bytes,
    }))).not.toThrow();
    expect(() => budget.observe(claudeReadMediaResult({
      base64: "YQ==",
      bytes: 1,
    }))).toThrow("Claude exceeded the bounded media event budget for this run.");
  // V8 coverage instruments each scan of the intentional 48 MiB production
  // boundary. This takes ~13s locally versus <1s without coverage, so keep the
  // production-sized proof while bounding only this CPU-heavy test explicitly.
  }, 30_000);

  it("retains decoded and encoded media ceilings across refill windows", () => {
    let now = 0;
    const createBudget = (maxRunMediaBytes: number, maxRunMediaEncodedBytes: number) =>
      new ClaudeRunEventBudget(new ProviderRunEventBudget(
        "Claude",
        1024,
        16,
        16 * 1024,
        { windowMs: 1_000, now: () => now },
      ), {
        windowMs: 1_000,
        now: () => now,
        maxRunMediaBytes,
        maxRunMediaEncodedBytes,
      });
    const event = claudeReadMediaResult({ base64: "YQ==", bytes: 1 });

    const decodedBudget = createBudget(2, 64);
    decodedBudget.observe(event);
    now = 1_000;
    decodedBudget.observe(event);
    now = 2_000;
    expect(() => decodedBudget.observe(event)).toThrow(
      "Claude exceeded the bounded media event budget for this run.",
    );

    now = 0;
    const encodedBudget = createBudget(8, 16);
    encodedBudget.observe(event);
    now = 1_000;
    encodedBudget.observe(event);
    now = 2_000;
    expect(() => encodedBudget.observe(event)).toThrow(
      "Claude exceeded the bounded encoded-media event budget for this run.",
    );

    expect(() => createBudget(0, 16)).toThrow(
      "The Claude media event budget is invalid.",
    );
    expect(() => createBudget(8, 0)).toThrow(
      "The Claude media event budget is invalid.",
    );
  });

  it("cancels and releases an owned SDK process after accepted media", async () => {
    const root = portableFixtureRoot("Claude SDK media cancellation");
    roots.push(root);
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const terminateProcessTree = vi.fn(async () => true);
    const base64 = Buffer.alloc(512 * 1024, 0xa5).toString("base64");
    let markAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve; });
    let release!: () => void;
    const interrupted = new Promise<void>((resolve) => { release = resolve; });
    let closeCalls = 0;
    let iteratorReturns = 0;
    const harness = createClaudeAgentSdkHarness({
      spawnProcess,
      terminateProcessTree,
      createQuery: ({ options }) => {
        options?.spawnClaudeCodeProcess?.({
          command: "/sdk/final/claude",
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        });
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            try {
              yield claudeReadMediaResult({ base64, bytes: 512 * 1024 });
              markAccepted();
              await interrupted;
            } finally {
              iteratorReturns += 1;
            }
          })(),
          {
            interrupt: async () => { release(); },
            close: () => { closeCalls += 1; release(); },
          },
        );
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([harness]),
    );
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-media-cancel",
      cwd: root,
      prompt: "Read then wait",
      interactionMode: "build",
      access: "full",
    }));

    await accepted;
    expect(manager.cancel("claude-media-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
    expect(closeCalls).toBe(1);
    expect(iteratorReturns).toBe(1);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("cleans rejected state and starts the next media run with a fresh budget", async () => {
    const root = portableFixtureRoot("Claude SDK media overflow recovery");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "media-review");
    const children = [fakeClaudeChild(4_242), fakeClaudeChild(4_243)];
    const spawnProcess = vi.fn(() => children.shift()!) as unknown as typeof import("node:child_process").spawn;
    const terminateProcessTree = vi.fn(async () => true);
    const stagedPluginPaths: string[] = [];
    const closeCalls: number[] = [];
    let iteratorReturns = 0;
    let pendingPermission: Promise<PermissionResult | null> | undefined;
    let queryIndex = 0;
    const recoveryBase64 = Buffer.alloc(512 * 1024, 0x5a).toString("base64");
    const harness = createClaudeAgentSdkHarness({
      spawnProcess,
      terminateProcessTree,
      createQuery: ({ options }) => {
        const current = queryIndex;
        queryIndex += 1;
        stagedPluginPaths.push(options?.plugins?.[0]?.path ?? "");
        options?.spawnClaudeCodeProcess?.({
          command: "/sdk/final/claude",
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        });
        if (current === 0) {
          pendingPermission = options?.canUseTool?.("Read", {
            file_path: "large.txt",
          }, {
            signal: new AbortController().signal,
            toolUseID: "pending-read",
            requestId: "pending-read-request",
          });
          return fixtureClaudeQuery(
            (async function* (): AsyncGenerator<SDKMessage> {
              try {
                yield {
                  type: "status",
                  payload: "x".repeat(1024 * 1024 + 1),
                } as unknown as SDKMessage;
              } finally {
                iteratorReturns += 1;
              }
            })(),
            { close: () => { closeCalls.push(current); } },
          );
        }
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("init", {
              plugins: [{
                name: CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
                path: stagedPluginPaths[current],
              }],
              skills: options?.skills,
            });
            yield claudeReadMediaResult({
              base64: recoveryBase64,
              bytes: 512 * 1024,
            });
            yield claudeSuccessResult("Recovered", "completed");
          })(),
          { close: () => { closeCalls.push(current); } },
        );
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const skills = [{
      source: "claude-native" as const,
      name: "media-review",
      path: skillPath,
    }];

    await expect(manager.run({
      ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-media-overflow",
        cwd: root,
        prompt: "Overflow",
        interactionMode: "build",
        access: "supervised",
      }),
      skills,
    })).resolves.toMatchObject({
      status: "failed",
      error: "Claude sent an oversized event.",
      failure: { reason: "protocol-overflow" },
    });
    await expect(pendingPermission).resolves.toMatchObject({
      behavior: "deny",
      interrupt: true,
    });
    expect(iteratorReturns).toBe(1);
    expect(stagedPluginPaths[0]).not.toBe("");
    expect(existsSync(stagedPluginPaths[0]!)).toBe(false);
    expect(manager.activeConversationIds()).toEqual([]);

    await expect(manager.run({
      ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-media-recovered",
        cwd: root,
        prompt: "Recover",
        interactionMode: "build",
        access: "full",
      }),
      skills,
    })).resolves.toMatchObject({ status: "completed", text: "Recovered" });
    expect(stagedPluginPaths[1]).not.toBe("");
    expect(existsSync(stagedPluginPaths[1]!)).toBe(false);
    expect(closeCalls).toEqual([0, 1]);
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
