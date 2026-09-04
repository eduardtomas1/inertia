import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { buildProviderInvocation } from "../../src/server/provider/adapters";
import {
  createGeminiOuterSessionId,
  createGeminiAcpHarness,
  GEMINI_ACP_CAPABILITIES,
  geminiAcpProcessInvocation,
  permissionDisplayIsSafe,
} from "../../src/server/provider/gemini-acp-harness";
import {
  geminiPrompt,
  geminiSessionModelsFromResponse,
} from "../../src/server/provider/gemini-acp-session";
import { geminiEnvironmentSecretValues } from
  "../../src/server/provider/gemini-acp-redaction";
import { BoundedGeminiJsonLineTransform } from "../../src/server/provider/gemini-acp-support";
import type { GeminiSessionCleanupRequest } from
  "../../src/server/provider/gemini-session-cleanup";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { ProviderRunEventBudget } from "../../src/server/provider/io";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  removePortableFixture,
  writeNodeFlagExecutable,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const hostTools: ProviderHostToolBridge = {
  definitions: [{
    name: "inertia_list_conversations",
    description: "List safe chats.",
    inputSchema: { type: "object", additionalProperties: false },
    readOnly: true,
  }],
  invoke: async () => ({ success: true, text: "{}" }),
};

async function collectGeminiFrames(chunks: readonly Buffer[]): Promise<string> {
  const output: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    new BoundedGeminiJsonLineTransform(
      4 * 1024,
      new ProviderRunEventBudget("Gemini ACP", 4 * 1024, 16, 16 * 1024),
    ),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(output).toString("utf8");
}

function managerFor(
  command: string,
  harness = testGeminiHarness(),
): ProviderManager {
  return new ProviderManager(
    { commands: { gemini: command } },
    new AgentHarnessRegistry([harness]),
  );
}

function testGeminiHarness(
  options: Parameters<typeof createGeminiAcpHarness>[0] = {},
) {
  return createGeminiAcpHarness({
    cleanupSessionArtifacts: async () => {},
    ...options,
  });
}

function geminiInput(
  root: string,
  overrides: Partial<Parameters<typeof nativeProviderRunInput>[0]> = {},
) {
  return nativeProviderRunInput({
    providerId: "gemini",
    conversationId: "gemini-test",
    cwd: root,
    prompt: "Inspect the change",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  });
}

const INITIALIZE_RESULT = `{
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true },
    mcpCapabilities: { http: true },
  },
  authMethods: [{ id: "oauth-personal", name: "Sign in with Google", description: "Existing CLI auth" }],
  agentInfo: { name: "gemini-cli", version: "0.58.0" },
}`;

const SESSION_MODES = `{
  currentModeId: "yolo",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "autoEdit", name: "Auto edit" },
    { id: "yolo", name: "YOLO" },
    { id: "plan", name: "Plan" },
  ],
}`;

const SESSION_MODELS = `{
  currentModelId: "gemini-2.5-pro",
  availableModels: [
    { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Deep reasoning" },
    { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast" },
  ],
}`;

describe("bounded Gemini ACP framing", () => {
  it("preserves a split multibyte JSON-RPC frame", async () => {
    const frame = Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { message: "Gemini ✨" },
    })}\n`);

    await expect(collectGeminiFrames(
      [...frame].map((byte) => Buffer.of(byte)),
    )).resolves.toBe(frame.toString("utf8"));
  });

  it("fails closed on malformed UTF-8, envelopes, updates, and oversized frames", async () => {
    const malformedUtf8 = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]);
    await expect(collectGeminiFrames([malformedUtf8])).rejects.toThrow(
      /not valid.*utf-?8/iu,
    );
    await expect(collectGeminiFrames([Buffer.from("{}\n")])).rejects.toThrow(
      /malformed json-rpc/iu,
    );
    await expect(collectGeminiFrames([Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {},
    })}\n`)])).rejects.toThrow(/malformed session update/iu);
    await expect(collectGeminiFrames([
      Buffer.from(`{"jsonrpc":"2.0","id":1,"result":"${"x".repeat(4_096)}"}\n`),
    ])).rejects.toThrow(/oversized/iu);
  });

  it("charges empty frames to the bounded wire-event budget", async () => {
    await expect(collectGeminiFrames([
      Buffer.from("\n".repeat(17)),
    ])).rejects.toThrow(/bounded event rate/iu);
  });
});

describe("Gemini ACP data negotiation", () => {
  it("classifies only credential-bearing Gemini environment values", () => {
    expect(geminiEnvironmentSecretValues({
      GEMINI_API_KEY: "gemini-secret",
      GOOGLE_API_KEY: "google-secret",
      GOOGLE_CLOUD_ACCESS_TOKEN: "cloud-token",
      SERVICE_TOKEN: "inherited-service-token",
      GOOGLE_APPLICATION_CREDENTIALS: "/credential/path.json",
      SESSION: "conversation-identity",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GEMINI_CLI_CUSTOM_HEADERS:
        "Authorization: Bearer header-token, X-Trace: visible, X-Service-Key: service-secret",
      GOOGLE_CLOUD_PROJECT: "public-project",
    })).toEqual(expect.arrayContaining([
      "gemini-secret",
      "google-secret",
      "cloud-token",
      "inherited-service-token",
      "Authorization: Bearer header-token, X-Trace: visible, X-Service-Key: service-secret",
      "Bearer header-token",
      "header-token",
      "visible",
      "service-secret",
    ]));
    expect(geminiEnvironmentSecretValues({
      SESSION: "conversation-identity",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      AUTH_METHOD: "oauth-personal",
      PWD: "/workspace",
    })).toEqual([]);
    expect(geminiEnvironmentSecretValues({
      GEMINI_API_KEY_AUTH_MECHANISM: "x-goog-api-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/credential/path.json",
      GOOGLE_CLOUD_PROJECT: "public-project",
    })).toEqual([]);
    expect(geminiEnvironmentSecretValues({
      gemini_api_key: "windows-style-key",
      gOoGlE_cLoUd_AcCeSs_ToKeN: "windows-style-token",
      gemini_cli_custom_headers:
        "Authorization: Bearer windows-header-token, X-Trace: windows-trace",
    })).toEqual(expect.arrayContaining([
      "windows-style-key",
      "windows-style-token",
      "Authorization: Bearer windows-header-token, X-Trace: windows-trace",
      "Bearer windows-header-token",
      "windows-header-token",
      "windows-trace",
    ]));
  });

  it("accepts only bounded, coherent experimental model metadata", () => {
    expect(geminiSessionModelsFromResponse({
      models: {
        currentModelId: "gemini-2.5-pro",
        availableModels: [
          { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { modelId: "gemini-2.5-pro", name: "Duplicate" },
          { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast" },
          { modelId: "bad\0id", name: "Rejected" },
          { modelId: "bad-newline", name: "Spoofed\nmodel" },
        ],
      },
    })).toEqual({
      currentModelId: "gemini-2.5-pro",
      availableModels: [
        { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: null },
        { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast" },
      ],
    });
    expect(geminiSessionModelsFromResponse({
      models: { currentModelId: "missing", availableModels: [] },
    })).toBeNull();
  });

  it("negotiates image support and enforces supported formats", async () => {
    const root = portableFixtureRoot("gemini image negotiation");
    const png = join(root, "reference.PNG");
    const text = join(root, "not-an-image.txt");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(text, "not an image");
    try {
      await expect(geminiPrompt("Describe", [png], {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
      })).resolves.toEqual([
        { type: "image", mimeType: "image/png", data: "iVBORw==" },
        { type: "text", text: "Describe" },
      ]);
      await expect(geminiPrompt("Describe", [png], {
        protocolVersion: 1,
        agentCapabilities: {},
      })).rejects.toThrow(/did not advertise image prompt support/iu);
      await expect(geminiPrompt("Describe", [text], {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
      })).rejects.toThrow(/does not support.*image type/iu);
    } finally {
      await removePortableFixture(root);
    }
  });

  it("rejects an oversized image from descriptor metadata before reading it", async () => {
    const root = portableFixtureRoot("gemini oversized image");
    const oversized = join(root, "oversized.png");
    writeFileSync(oversized, "");
    truncateSync(oversized, 10 * 1024 * 1024 + 1);
    try {
      await expect(geminiPrompt("Describe", [oversized], {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true } },
      })).rejects.toThrow(/10 mb safety limit/iu);
    } finally {
      await removePortableFixture(root);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO image without blocking for a writer",
    async () => {
      const root = portableFixtureRoot("gemini fifo image");
      const fifo = join(root, "blocked.png");
      expect(spawnSync("mkfifo", [fifo], { stdio: "ignore" }).status).toBe(0);
      try {
        await expect(geminiPrompt("Describe", [fifo], {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: true } },
        })).rejects.toThrow(/not a regular file/iu);
      } finally {
        await removePortableFixture(root);
      }
    },
  );

  it("aborts attachment preparation before attempting the next image read", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(geminiPrompt("Describe", ["missing.png"], {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: true } },
    }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringMatching(/preparation was cancelled/iu),
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink replacement at the final image descriptor boundary",
    async () => {
      const root = portableFixtureRoot("gemini image symlink replacement");
      const target = join(root, "target.png");
      const selected = join(root, "selected.png");
      writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(selected, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const canonical = realpathSync(selected);
      unlinkSync(selected);
      symlinkSync(target, selected);
      try {
        await expect(geminiPrompt("Describe", [canonical], {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: true } },
        })).rejects.toThrow();
      } finally {
        await removePortableFixture(root);
      }
    },
  );
});

describe.sequential("Gemini ACP harness", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("uses the stable shell-free ACP flag and rejects the legacy adapter", () => {
    expect(geminiAcpProcessInvocation(
      "/usr/local/bin/gemini",
      "inertia-11111111-1111-4111-8111-111111111111",
      {},
      "linux",
    )).toEqual({
      command: "/usr/local/bin/gemini",
      args: [
        "--acp",
        "--session-id",
        "inertia-11111111-1111-4111-8111-111111111111",
      ],
    });
    expect(GEMINI_ACP_CAPABILITIES.extension).toMatchObject({
      protocol: "acp-v1-json-rpc",
      approvals: "native",
      questions: "unavailable-in-current-acp",
      plans: "mode-and-acp-updates",
      usage: "prompt-response-and-acp-updates",
      modelMetadata: "experimental-session-models",
    });
    expect(GEMINI_ACP_CAPABILITIES.session).toEqual({
      resume: "application-context",
      identity: "conversation",
    });
    expect(() => buildProviderInvocation(
      geminiInput("/workspace/project", {
        sessionId: "gemini-session",
        access: "full",
      }),
      "/usr/local/bin/gemini",
    )).toThrow("Gemini requires its native ACP harness");
  });

  it("gives concurrent same-minute runs unique Gemini filename prefixes", () => {
    const sessionIds = [
      createGeminiOuterSessionId(Uint8Array.from({ length: 18 }, () => 0x11)),
      createGeminiOuterSessionId(Uint8Array.from({ length: 18 }, () => 0x22)),
    ];
    expect(sessionIds).toEqual([
      "ERERERERERERERERERERERER-inertia",
      "IiIiIiIiIiIiIiIiIiIiIiIi-inertia",
    ]);
    // Gemini 0.58 uses this truncated prefix plus a minute-resolution timestamp
    // for the outer chat filename, so uniqueness must exist inside this prefix.
    expect(new Set(sessionIds.map((sessionId) => sessionId.slice(0, 8))).size)
      .toBe(sessionIds.length);
  });

  it("maps the official ACP surface without mutating auth or bypassing permissions", async () => {
    const root = portableFixtureRoot("gemini ACP rich mapping");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
if (!process.argv.includes("--acp")) process.exit(91);
const messages = [];
const sessionId = "gemini-rich-session";
let promptId;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32099, message: "authenticate must not be called" } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId,
    modes: ${SESSION_MODES},
    models: ${SESSION_MODELS},
  } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/set_model") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting protocol" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan", entries: [
      { content: "Inspect", priority: "medium", status: "completed" },
      { content: "Implement", priority: "high", status: "in_progress" },
    ] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run tests", kind: "execute", status: "in_progress", rawInput: { command: "npm test" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "green" } },
        { type: "diff", path: "src/file.ts", oldText: "before", newText: "after" },
      ],
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 125, size: 1000 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Gemini response" } } } });
    return send({ jsonrpc: "2.0", id: 501, method: "session/request_permission", params: {
      sessionId,
      toolCall: { toolCallId: "edit-1", title: "Edit source", kind: "edit", status: "pending", rawInput: { path: "src/file.ts" } },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    } });
  }
  if (message.id === 501 && message.result) return send({ jsonrpc: "2.0", id: promptId, result: {
    stopReason: "end_turn",
    _meta: { quota: { token_count: { input_tokens: 90, output_tokens: 35 } } },
  } });
});
`);
    const manager = managerFor(command);
    const thoughts: string[] = [];
    const plans: string[] = [];
    const usages: Array<{
      usedTokens: number | null;
      totalProcessedTokens: number | null;
      maxTokens: number | null;
    }> = [];
    const metadata: Array<{ id: string; isDefault?: boolean; inputModalities?: string[] }> = [];
    const activities: Array<{ activityId?: string; phase: string; detail?: string }> = [];

    const result = await manager.run(geminiInput(root, {
      conversationId: "gemini-rich",
      runId: "run-rich",
      turnId: "turn-rich",
      prompt: "Build this",
      access: "full",
      model: "gemini-2.5-flash",
      imagePaths: [imagePath],
    }), {
      onReasoning: ({ text }) => thoughts.push(text),
      onPlan: ({ steps }) => plans.push(...steps.map(({ step }) => step)),
      onUsage: ({ usage }) => usages.push({
        usedTokens: usage.usedTokens,
        totalProcessedTokens: usage.totalProcessedTokens,
        maxTokens: usage.maxTokens,
      }),
      onMetadata: ({ metadata: value }) => metadata.push(...(value.models ?? [])),
      onActivity: (event) => activities.push(event),
      hostTools,
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "Gemini response",
      cleanupConfirmed: true,
    });
    // Exact-value redaction may retain and later flush a suffix that could be
    // the beginning of the random host-MCP credential. ACP stream boundaries
    // are not semantic; the reconstructed reasoning text is authoritative.
    expect(thoughts.join("")).toBe("Inspecting protocol");
    expect(plans).toEqual(["Inspect", "Implement"]);
    expect(usages).toEqual([
      { usedTokens: 125, totalProcessedTokens: null, maxTokens: 1_000 },
      { usedTokens: 125, totalProcessedTokens: 125, maxTokens: 1_000 },
    ]);
    expect(metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "gemini-2.5-flash",
        isDefault: true,
        inputModalities: ["text", "image"],
      }),
    ]));
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-1",
      phase: "completed",
      detail: [
        "Command:\nnpm test",
        "Output:\ngreen\nFile: src/file.ts\n\nBefore:\nbefore\n\nAfter:\nafter",
      ].join("\n\n"),
    }));

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: { outcome?: { outcome?: string; optionId?: string } };
    }>;
    expect(captured.some(({ method }) => method === "authenticate")).toBe(false);
    expect(captured.find(({ method }) => method === "initialize")).toMatchObject({
      params: { clientCapabilities: { plan: {} } },
    });
    expect(captured.find(({ method }) => method === "initialize")?.params)
      .not.toHaveProperty("clientCapabilities.fs");
    expect(captured.find(({ method }) => method === "initialize")?.params)
      .not.toHaveProperty("clientCapabilities.session");
    expect(captured.find(({ method }) => method === "session/new")).toMatchObject({
      params: {
        cwd: root,
        mcpServers: [expect.objectContaining({
          type: "http",
          name: "inertia-chat-manager",
        })],
      },
    });
    expect(captured.find(({ method }) => method === "session/set_mode"))
      .toMatchObject({ params: { modeId: "default" } });
    expect(captured.find(({ method }) => method === "session/set_model"))
      .toMatchObject({ params: { modelId: "gemini-2.5-flash" } });
    expect(captured.find(({ method }) => method === "session/prompt"))
      .toMatchObject({ params: { prompt: [
        { type: "image", mimeType: "image/png", data: "iVBORw==" },
        { type: "text", text: "Build this" },
      ] } });
    expect(captured.find(({ id }) => id === 501)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("owns both Gemini session identities and cleans them only after process shutdown", async () => {
    const root = portableFixtureRoot("gemini exact session cleanup");
    roots.push(root);
    const argsPath = join(root, "args.json");
    const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "88888888-8888-4888-8888-888888888888",
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "88888888-8888-4888-8888-888888888888", update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done" },
    } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const terminationForces: boolean[] = [];
    let processCleanupSettled = false;
    let cleanupObservedAfterStop = false;
    let cleanedCwd = "";
    let cleanedSessionIds: readonly string[] = [];
    let requiredSessionIds: readonly string[] = [];
    const manager = managerFor(command, testGeminiHarness({
      terminateProcessTree: async (child, force) => {
        terminationForces.push(force);
        const confirmed = await terminateProcessTreeAndWait(child, force);
        processCleanupSettled = true;
        return confirmed;
      },
      cleanupSessionArtifacts: async ({
        cwd,
        sessionIds,
        requiredSessionIds: required,
      }) => {
        cleanupObservedAfterStop = processCleanupSettled;
        cleanedCwd = cwd;
        cleanedSessionIds = sessionIds;
        requiredSessionIds = required ?? [];
      },
    }));

    const result = await manager.run(geminiInput(root, {
      conversationId: "gemini-exact-session-cleanup",
    }));
    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const outerSessionId = args.at(args.indexOf("--session-id") + 1);

    expect(result).toMatchObject({
      status: "completed",
      text: "Done",
      cleanupConfirmed: true,
    });
    expect(terminationForces[0]).toBe(false);
    expect(cleanupObservedAfterStop).toBe(true);
    expect(cleanedCwd).toBe(root);
    expect(cleanedSessionIds).toEqual([
      expect.stringMatching(
        /^[A-Za-z0-9_-]{24}-inertia$/u,
      ),
      "88888888-8888-4888-8888-888888888888",
    ]);
    expect(requiredSessionIds).toEqual(cleanedSessionIds);
    expect(outerSessionId).toBe(cleanedSessionIds[0]);
    for (const sessionId of cleanedSessionIds) {
      expect(JSON.stringify(result)).not.toContain(sessionId);
    }
  });

  it("retains a created session identity before validating the rest of its response", async () => {
    const root = portableFixtureRoot("gemini partial session response cleanup");
    roots.push(root);
    const innerSessionId = "89898989-8989-4989-8989-898989898989";
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: ${JSON.stringify(innerSessionId)},
    modes: { currentModeId: "default", availableModes: [] },
  } });
});
`);
    let cleanupRequest: GeminiSessionCleanupRequest | undefined;
    const manager = managerFor(command, testGeminiHarness({
      cleanupSessionArtifacts: async (request) => {
        cleanupRequest = request;
        throw new Error("fixture could not attest the inner session");
      },
    }));

    await expect(manager.run(geminiInput(root, {
      conversationId: "gemini-partial-session-response",
    }))).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: false,
      failure: {
        phase: "cleanup",
        terminalEvent: "gemini-session/cleanup",
      },
    });
    expect(cleanupRequest?.sessionIds).toEqual([
      expect.stringMatching(/^[A-Za-z0-9_-]{24}-inertia$/u),
      innerSessionId,
    ]);
    expect(cleanupRequest?.requiredSessionIds).toEqual(
      cleanupRequest?.sessionIds,
    );
  });

  it("fails cleanup closed when session creation times out with no returned identity", async () => {
    const root = portableFixtureRoot("gemini ambiguous session creation");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
});
`);
    const manager = managerFor(command, testGeminiHarness({
      controlRpcTimeoutMs: 500,
    }));

    await expect(manager.run(geminiInput(root, {
      conversationId: "gemini-ambiguous-session-creation",
    }))).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: false,
      failure: {
        phase: "cleanup",
        terminalEvent: "gemini-session/cleanup",
      },
    });
  });

  it("redacts split host and environment credentials from every Gemini output surface", async () => {
    const root = portableFixtureRoot("gemini host MCP redaction");
    roots.push(root);
    const capturePath = join(root, "host-secret.json");
    const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
let promptId;
let secretToken;
let secretUrl;
const apiKey = process.env.GEMINI_API_KEY;
const customCredential = process.env.GEMINI_CLI_CUSTOM_HEADERS.match(/Bearer ([^,]+)/)[1];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const chunk = (sessionUpdate, text) => send({ jsonrpc: "2.0", method: "session/update", params: {
  sessionId: "gemini-redaction-session",
  update: { sessionUpdate, content: { type: "text", text } },
} });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") {
    const server = message.params.mcpServers[0];
    secretUrl = server.url;
    secretToken = server.headers.find(({ name }) => name === "Authorization").value.replace(/^Bearer /, "");
    fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      token: secretToken,
      url: secretUrl,
      apiKey,
      customCredential,
    }));
    return send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "gemini-redaction-session",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
    } });
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const tokenBoundary = Math.floor(secretToken.length / 2);
    const urlBoundary = Math.floor(secretUrl.length / 2);
    const keyBoundary = Math.floor(apiKey.length / 2);
    chunk("agent_message_chunk", "Provider echoed " + secretToken.slice(0, tokenBoundary));
    chunk("agent_message_chunk", secretToken.slice(tokenBoundary) + " " + apiKey.slice(0, keyBoundary));
    chunk("agent_message_chunk", apiKey.slice(keyBoundary));
    chunk("agent_thought_chunk", "Bridge " + secretUrl.slice(0, urlBoundary));
    chunk("agent_thought_chunk", secretUrl.slice(urlBoundary));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "gemini-redaction-session", update: {
      sessionUpdate: "tool_call",
      toolCallId: "secret-tool",
      title: "Credential echo",
      kind: "execute",
      status: "failed",
      rawInput: { command: "echo " + customCredential },
      rawOutput: secretUrl,
    } } });
    return send({ jsonrpc: "2.0", id: 903, method: "session/request_permission", params: {
      sessionId: "gemini-redaction-session",
      toolCall: {
        toolCallId: "secret-permission",
        title: "Approve " + secretToken,
        kind: "execute",
        status: "pending",
        rawInput: { command: "curl " + secretUrl },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
      ],
    } });
  }
  if (message.id === 903) return send({
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: "end_turn" },
  });
});
`);
    const apiKey = "gemini-api-key-for-redaction-test";
    const customCredential = "custom-header-token-for-redaction-test";
    const manager = new ProviderManager(
      {
        commands: { gemini: command },
        resolveBackendLaunchOptions: (_input, environment) => ({
          environment: {
            ...environment,
            GEMINI_API_KEY: apiKey,
            GEMINI_CLI_CUSTOM_HEADERS:
              `Authorization: Bearer ${customCredential}, X-Trace: visible`,
          },
        }),
      },
      new AgentHarnessRegistry([testGeminiHarness()]),
    );
    const visibleText: string[] = [];
    const thoughts: string[] = [];
    const activities: unknown[] = [];
    const approvals: unknown[] = [];
    let approvalResolved = false;
    const result = await manager.run(geminiInput(root, {
      conversationId: "gemini-host-redaction",
      runId: "run-gemini-host-redaction",
      turnId: "turn-gemini-host-redaction",
    }), {
      hostTools,
      onText: ({ text }) => visibleText.push(text),
      onReasoning: ({ text }) => thoughts.push(text),
      onActivity: (event) => activities.push(event),
      onApproval: (event) => {
        approvals.push(event);
        approvalResolved = manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "deny",
        );
      },
    });

    const secret = JSON.parse(readFileSync(capturePath, "utf8")) as {
      token: string;
      url: string;
      apiKey: string;
      customCredential: string;
    };
    expect(result).toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(approvalResolved).toBe(true);
    expect(visibleText.join("")).toBe(result.text);
    expect(thoughts.join("")).toContain("[redacted]");
    const exposed = JSON.stringify({ result, visibleText, thoughts, activities, approvals });
    expect(exposed).toContain("[redacted]");
    for (const credential of Object.values(secret)) {
      expect(result.text).not.toContain(credential);
      expect(visibleText.join("")).not.toContain(credential);
      expect(thoughts.join("")).not.toContain(credential);
      expect(exposed).not.toContain(credential);
    }
    expect(await loopbackPortIsOpen(Number(new URL(secret.url).port))).toBe(false);
  });

  it("counts safe output released at a validated stream boundary as completion evidence", async () => {
    const root = portableFixtureRoot("gemini buffered completion evidence");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "gemini-buffered-completion-session",
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "gemini-buffered-completion-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "short" },
      },
    } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      {
        commands: { gemini: command },
        resolveBackendLaunchOptions: (_input, environment) => ({
          environment: { ...environment, GEMINI_API_KEY: "short-secret-value" },
        }),
      },
      new AgentHarnessRegistry([testGeminiHarness()]),
    );
    const visibleText: string[] = [];
    const result = await manager.run(geminiInput(root, {
      conversationId: "gemini-buffered-completion",
    }), {
      onText: ({ text }) => visibleText.push(text),
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "short",
      cleanupConfirmed: true,
    });
    expect(visibleText).toEqual(["short"]);
  });

  it("redacts inherited access tokens from Gemini failure diagnostics", async () => {
    const root = portableFixtureRoot("gemini diagnostic redaction");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const token = process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "gemini-diagnostic-session",
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "gemini-diagnostic-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "safe prefix " + token.slice(0, Math.floor(token.length / 2)) },
      },
    } });
    process.stderr.write("provider diagnostic " + token);
    return send({ jsonrpc: "2.0", id: message.id, error: {
      code: -32000,
      message: "provider rejected token " + token,
    } });
  }
});
`);
    const token = "google-cloud-access-token-for-redaction-test";
    const manager = new ProviderManager(
      {
        commands: { gemini: command },
        resolveBackendLaunchOptions: (_input, environment) => ({
          environment: { ...environment, GOOGLE_CLOUD_ACCESS_TOKEN: token },
        }),
      },
      new AgentHarnessRegistry([testGeminiHarness()]),
    );

    const visibleText: string[] = [];
    const result = await manager.run(geminiInput(root, {
      conversationId: "gemini-diagnostic-redaction",
    }), {
      onText: ({ text }) => visibleText.push(text),
    });
    const secretPrefix = token.slice(0, Math.floor(token.length / 2));
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(result.text).toBe("safe prefix ");
    expect(visibleText.join("")).toBe(result.text);
    expect(result.text).not.toContain(secretPrefix);
    expect(JSON.stringify(result)).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("inventories dotenv credentials before accepting any Gemini output", async () => {
    const root = portableFixtureRoot("gemini dotenv redaction");
    roots.push(root);
    const token = "dotenv-service-token-$-for-redaction";
    writeFileSync(join(root, ".env"), `SERVICE_TOKEN=${token}\n`);
    const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const token = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").trim().split("=")[1];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const chunk = (sessionUpdate, text) => send({ jsonrpc: "2.0", method: "session/update", params: {
  sessionId: "gemini-dotenv-session",
  update: { sessionUpdate, content: { type: "text", text } },
} });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "gemini-dotenv-session",
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  } });
  if (message.method === "session/prompt") {
    const split = Math.floor(token.length / 2);
    chunk("agent_message_chunk", "assistant " + token.slice(0, split));
    chunk("agent_message_chunk", token.slice(split));
    chunk("agent_thought_chunk", "reasoning " + token);
    process.stderr.write("diagnostic " + token.slice(0, split));
    setImmediate(() => {
      process.stderr.write(token.slice(split));
      send({ jsonrpc: "2.0", id: message.id, error: {
        code: -32000,
        message: "provider exposed " + token,
      } });
    });
  }
});
`);
    const texts: string[] = [];
    const thoughts: string[] = [];

    const result = await managerFor(command).run(geminiInput(root, {
      conversationId: "gemini-dotenv-redaction",
    }), {
      onText: ({ text }) => texts.push(text),
      onReasoning: ({ text }) => thoughts.push(text),
    });

    const exposed = JSON.stringify({ result, texts, thoughts });
    expect(result.status).toBe("failed");
    expect(result.text).toBe("assistant [redacted]");
    expect(thoughts.join("")).toBe("reasoning [redacted]");
    expect(exposed).toContain("[redacted]");
    expect(exposed).not.toContain(token);
    expect(exposed).not.toContain(token.slice(0, Math.floor(token.length / 2)));
  });

  it("keeps cancellation authoritative when dotenv preflight rejects", async () => {
    const root = portableFixtureRoot("gemini cancelled dotenv preflight");
    roots.push(root);
    mkdirSync(join(root, ".env"));
    const manager = managerFor(join(root, "must-not-spawn"));
    const statuses: string[] = [];

    const run = manager.run(geminiInput(root, {
      conversationId: "gemini-cancelled-dotenv-preflight",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    });
    expect(manager.cancel("gemini-cancelled-dotenv-preflight")).toBe(true);

    await expect(run).resolves.toMatchObject({
      status: "cancelled",
      text: "",
      cleanupConfirmed: true,
    });
    expect(statuses).toEqual(["starting", "cancelling", "cancelled"]);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("fails the public result when Gemini host-tool cleanup is not confirmed", async () => {
    const root = portableFixtureRoot("gemini host MCP cleanup failure");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "gemini-cleanup-session",
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "gemini-cleanup-session", update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done" },
    } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    let closeAttempts = 0;
    const manager = managerFor(command, testGeminiHarness({
      createHostMcpSession: () => ({
        start: async () => ({
          url: "http://127.0.0.1:9/mcp",
          bearerToken: "fixture-gemini-host-token",
        }),
        close: async () => {
          closeAttempts += 1;
          throw new Error("fixture cleanup failure");
        },
      }),
    }));

    await expect(manager.run(geminiInput(root, {
      conversationId: "gemini-host-cleanup-failure",
      runId: "run-gemini-host-cleanup-failure",
      turnId: "turn-gemini-host-cleanup-failure",
    }), { hostTools })).resolves.toMatchObject({
      status: "failed",
      error: "Gemini Inertia chat tools could not be cleaned up.",
      cleanupConfirmed: false,
      failure: {
        reason: "provider-error",
        phase: "cleanup",
        terminalEvent: "host-tools/cleanup",
      },
    });
    expect(closeAttempts).toBe(1);
  });

  it("fails closed without exposing identities when Gemini session cleanup fails", async () => {
    const root = portableFixtureRoot("gemini session cleanup failure");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "99999999-9999-4999-8999-999999999999",
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "99999999-9999-4999-8999-999999999999", update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done before cleanup" },
    } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const result = await managerFor(command, testGeminiHarness({
      cleanupSessionArtifacts: async () => {
        throw new Error(
          "private cleanup detail 99999999-9999-4999-8999-999999999999",
        );
      },
    })).run(geminiInput(root, {
      conversationId: "gemini-session-cleanup-failure",
    }));

    expect(result).toMatchObject({
      status: "failed",
      error: "Gemini provider session artifacts could not be cleaned up.",
      cleanupConfirmed: false,
      failure: {
        reason: "provider-error",
        phase: "cleanup",
        terminalEvent: "gemini-session/cleanup",
      },
    });
    expect(JSON.stringify(result)).not.toContain("99999999-9999");
    expect(JSON.stringify(result)).not.toContain("private cleanup detail");
  });

  it("enforces Inertia access policy with one-shot Gemini permission options", async () => {
    const cases = [
      {
        name: "full-edit",
        access: "full",
        interactionMode: "build",
        kind: "edit",
        title: "Edit source",
        decision: undefined,
        expected: { outcome: "selected", optionId: "allow-once" },
        approvals: 0,
      },
      {
        name: "auto-edit-file",
        access: "auto-edit",
        interactionMode: "build",
        kind: "move",
        title: "Move source",
        decision: undefined,
        expected: { outcome: "selected", optionId: "allow-once" },
        approvals: 0,
      },
      {
        name: "auto-edit-command",
        access: "auto-edit",
        interactionMode: "build",
        kind: "execute",
        title: "Run tests",
        decision: "approve",
        expected: { outcome: "selected", optionId: "allow-once" },
        approvals: 1,
      },
      {
        name: "supervised-deny",
        access: "supervised",
        interactionMode: "build",
        kind: "execute",
        title: "Run release",
        decision: "deny",
        expected: { outcome: "selected", optionId: "reject-once" },
        approvals: 1,
      },
      {
        name: "plan-cancels",
        access: "full",
        interactionMode: "plan",
        kind: "edit",
        title: "Unexpected write",
        decision: undefined,
        expected: { outcome: "cancelled" },
        approvals: 0,
      },
      {
        name: "unsafe-display-cancels",
        access: "supervised",
        interactionMode: "build",
        kind: "execute",
        title: "Safe title\u202Etxt.exe",
        decision: undefined,
        expected: { outcome: "cancelled" },
        approvals: 0,
      },
    ] as const;

    for (const fixture of cases) {
      const root = portableFixtureRoot(`gemini permission ${fixture.name}`);
      roots.push(root);
      const capturePath = join(root, "permission.json");
      const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
const sessionId = "permission-session";
let promptId;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: ${SESSION_MODES} } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/prompt") {
    promptId = message.id;
    return send({ jsonrpc: "2.0", id: 701, method: "session/request_permission", params: {
      sessionId,
      toolCall: {
        toolCallId: "permission-tool",
        title: ${JSON.stringify(fixture.title)},
        kind: ${JSON.stringify(fixture.kind)},
        status: "pending",
        rawInput: { command: "npm test", path: "src/file.ts" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
        { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
      ],
    } });
  }
  if (message.id === 701 && message.result) {
    fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(message.result.outcome));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission handled" } } } });
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`);
      const manager = managerFor(command);
      let approvalCount = 0;
      const result = await manager.run(geminiInput(root, {
        conversationId: `gemini-${fixture.name}`,
        access: fixture.access,
        interactionMode: fixture.interactionMode,
      }), {
        onApproval: (event) => {
          approvalCount += 1;
          if (fixture.decision) {
            expect(manager.respondToApproval(
              event.conversationId,
              event.request.requestId,
              fixture.decision,
            )).toBe(true);
          }
        },
      });
      expect(result.status, fixture.name).toBe("completed");
      expect(approvalCount, fixture.name).toBe(fixture.approvals);
      expect(JSON.parse(readFileSync(capturePath, "utf8")), fixture.name)
        .toEqual(fixture.expected);
    }
  });

  it("rejects unsafe or hidden approval display details", () => {
    const request = (
      title: string,
      rawInput: unknown,
    ): Pick<RequestPermissionRequest, "toolCall"> => ({
      toolCall: {
        toolCallId: "tool",
        title,
        kind: "execute",
        rawInput,
      },
    });
    expect(permissionDisplayIsSafe(request("Run tests", { command: "npm test" })))
      .toBe(true);
    expect(permissionDisplayIsSafe(request("Run\u202Eexe", { command: "npm test" })))
      .toBe(false);
    expect(permissionDisplayIsSafe(request("Run tests", { command: "npm\u034F test" })))
      .toBe(false);
  });

  it("reconstructs visible history in a fresh session without unsafe session/load", async () => {
    const root = portableFixtureRoot("gemini ACP reconstructed history");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
const sessionId = "gemini-existing-session";
let replayTailSent = false;
const capture = { promptBeforeTail: false, methods: [], prompt: null };
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(capture));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture.methods.push(message.method || "response"); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old transcript" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "help", description: "Show help" }] } } });
    return setTimeout(() => {
      replayTailSent = true;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "delayed old tail" } } } });
    }, 25);
  }
  if (message.method === "session/prompt") {
    capture.promptBeforeTail = !replayTailSent; save();
    capture.prompt = message.params.prompt; save();
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh continuation" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = managerFor(command);

    await expect(manager.run(geminiInput(root, {
      conversationId: "gemini-replay",
      prompt: "Continue",
      reconstructedHistory: {
        source: "visible-transcript",
        truncated: false,
        messages: [
          { role: "user", content: "Earlier request" },
          { role: "assistant", content: "Earlier answer" },
        ],
      },
    }))).resolves.toMatchObject({
      status: "completed",
      text: "fresh continuation",
    });
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      promptBeforeTail: boolean;
      methods: string[];
      prompt: Array<{ type: string; text?: string }>;
    };
    expect(capture.promptBeforeTail).toBe(true);
    expect(capture.methods).toEqual(expect.arrayContaining(["session/new", "session/prompt"]));
    expect(capture.methods).not.toContain("session/load");
    expect(capture.prompt.at(-1)?.text).toContain("Earlier request");
    expect(capture.prompt.at(-1)?.text).toContain("Earlier answer");
    expect(capture.prompt.at(-1)?.text).toContain("[Current request]\nContinue");
  });

  it("rejects unsafe native session loading before spawning Gemini", async () => {
    const root = portableFixtureRoot("gemini ACP native resume rejection");
    roots.push(root);
    mkdirSync(join(root, ".env"));
    const marker = join(root, "spawned.txt");
    const command = writeNodeFlagExecutable(root, "gemini", `
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/load") return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
});
`);
    const manager = managerFor(command);
    await expect(manager.run(geminiInput(root, {
      conversationId: "gemini-replay-timeout",
      sessionId: "existing-session",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "provider-error",
        phase: "configuration",
        terminalEvent: "session/load:unsupported",
      },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects malformed reconstructed history before sending a prompt", async () => {
    const root = portableFixtureRoot("gemini ACP malformed reconstructed history");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const sessionId = "late-replay-session";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
    return send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed old user prompt" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "must not complete" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = managerFor(command);
    await expect(manager.run(geminiInput(root, {
      conversationId: "gemini-late-replay",
      reconstructedHistory: {
        source: "visible-transcript",
        truncated: false,
        messages: Array.from({ length: 65 }, () => ({
          role: "user" as const,
          content: "historical request",
        })),
      },
    }))).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "malformed-protocol",
        phase: "configuration",
        terminalEvent: "transport/frame",
      },
    });
  });

  it("uses session creation as auth authority and never invokes authenticate", async () => {
    const root = portableFixtureRoot("gemini ACP auth authority");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
const methods = [];
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(methods));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); methods.push(message.method); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32099, message: "must not mutate auth" } });
  if (message.method === "session/new") return send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32000,
      message: "Gemini API key is missing or not configured.",
    },
  });
});
`);
    const manager = managerFor(command);
    await expect(manager.run(geminiInput(root, {
      conversationId: "gemini-auth",
    }))).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: true,
      error: "Gemini CLI is not authenticated. Run 'gemini' to connect an account and try again.",
      failure: {
        reason: "provider-error",
        phase: "auth",
        terminalEvent: "session/new:auth",
      },
    });
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
      "initialize",
      "session/new",
    ]);
  });

  it("fails cleanup closed for an identity-less non-auth session error", async () => {
    const root = portableFixtureRoot("gemini ambiguous session error");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32603, message: "Session registration failed unexpectedly." },
  });
});
`);

    await expect(managerFor(command).run(geminiInput(root, {
      conversationId: "gemini-ambiguous-session-error",
    }))).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: false,
      failure: {
        phase: "cleanup",
        terminalEvent: "gemini-session/cleanup",
      },
    });
  });

  it("requires the exact Gemini CLI ACP identity and well-formed capabilities", async () => {
    const cases = [
      {
        name: "wrong identity",
        initialize: `{
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "lookalike-acp", version: "1.0.0" },
        }`,
        expected: /not Gemini CLI/iu,
      },
      {
        name: "malformed capabilities",
        initialize: `{
          protocolVersion: 1,
          agentCapabilities: [],
          agentInfo: { name: "gemini-cli", version: "0.58.0" },
        }`,
        expected: /malformed agent capabilities/iu,
      },
      {
        name: "wrong protocol",
        initialize: `{
          protocolVersion: 2,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "gemini-cli", version: "0.58.0" },
        }`,
        expected: /protocol version/iu,
      },
    ] as const;
    for (const fixture of cases) {
      const root = portableFixtureRoot(`gemini ${fixture.name}`);
      roots.push(root);
      const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const message = JSON.parse(line);
  send({ jsonrpc: "2.0", id: message.id, result: ${fixture.initialize} });
});
`);
      const result = await managerFor(command).run(geminiInput(root, {
        conversationId: `gemini-${fixture.name.replaceAll(" ", "-")}`,
      }));
      expect(result.status, fixture.name).toBe("failed");
      expect(result.failure, fixture.name).toMatchObject({
        reason: "malformed-protocol",
        phase: "initialize",
        terminalEvent: "transport/frame",
      });
      expect(result.failure?.technicalDetail, fixture.name).toMatch(fixture.expected);
    }
  });

  it("rejects unadvertised modes, models, and reasoning controls before prompting", async () => {
    const cases = [
      {
        name: "reasoning",
        overrides: { reasoningEffort: "high" },
        modes: SESSION_MODES,
        models: SESSION_MODELS,
        expected: /does not advertise.*reasoning effort/iu,
      },
      {
        name: "model",
        overrides: { model: "gemini-unadvertised" },
        modes: SESSION_MODES,
        models: SESSION_MODELS,
        expected: /does not advertise.*selected model/iu,
      },
      {
        name: "plan",
        overrides: { interactionMode: "plan" },
        modes: `{
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        }`,
        models: SESSION_MODELS,
        expected: /does not advertise a plan mode/iu,
      },
      {
        name: "default",
        overrides: {},
        modes: `{
          currentModeId: "yolo",
          availableModes: [{ id: "yolo", name: "YOLO" }],
        }`,
        models: SESSION_MODELS,
        expected: /permission-reporting default mode/iu,
      },
    ] as const;
    for (const fixture of cases) {
      const root = portableFixtureRoot(`gemini config ${fixture.name}`);
      roots.push(root);
      const capturePath = join(root, "capture.json");
      const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
const methods = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); methods.push(message.method);
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(methods));
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "config-session",
    modes: ${fixture.modes},
    models: ${fixture.models},
  } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/set_model") return send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`);
      const result = await managerFor(command).run(geminiInput(root, {
        conversationId: `gemini-config-${fixture.name}`,
        ...fixture.overrides,
      }));
      expect(result.status, fixture.name).toBe("failed");
      expect(result.failure, fixture.name).toMatchObject({
        reason: "provider-error",
        phase: "configuration",
        terminalEvent: "session/configuration",
      });
      expect(result.failure?.technicalDetail, fixture.name).toMatch(fixture.expected);
      expect(JSON.parse(readFileSync(capturePath, "utf8")), fixture.name)
        .not.toContain("session/prompt");
    }
  });

  it("requires assistant text and treats non-success stop reasons as failures", async () => {
    const cases = [
      {
        name: "empty",
        stopReason: "end_turn",
        updates: "",
        expected: {
          reason: "provider-error",
          terminalEvent: "session/prompt:empty-end-turn",
        },
      },
      {
        name: "thought-only",
        stopReason: "end_turn",
        updates: `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stop-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking only" } } } });`,
        expected: {
          reason: "provider-error",
          terminalEvent: "session/prompt:empty-end-turn",
        },
      },
      {
        name: "tool-only",
        stopReason: "end_turn",
        updates: `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stop-session", update: { sessionUpdate: "tool_call", toolCallId: "tool-only", title: "Tool only", kind: "other", status: "completed" } } });`,
        expected: {
          reason: "provider-error",
          terminalEvent: "session/prompt:empty-end-turn",
        },
      },
      {
        name: "plan-only",
        stopReason: "end_turn",
        updates: `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stop-session", update: { sessionUpdate: "plan", entries: [{ content: "Only a plan", status: "completed", priority: "medium" }] } } });`,
        expected: {
          reason: "provider-error",
          terminalEvent: "session/prompt:empty-end-turn",
        },
      },
      {
        name: "max-tokens",
        stopReason: "max_tokens",
        updates: "",
        expected: {
          reason: "provider-error",
          terminalEvent: "session/prompt:max_tokens",
          message: "Gemini stopped with reason: max_tokens.",
        },
      },
    ] as const;
    for (const fixture of cases) {
      const root = portableFixtureRoot(`gemini stop ${fixture.name}`);
      roots.push(root);
      const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stop-session", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
  if (message.method === "session/prompt") { ${fixture.updates} return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: ${JSON.stringify(fixture.stopReason)} } }); }
});
`);
      const result = await managerFor(command).run(geminiInput(root, {
        conversationId: `gemini-stop-${fixture.name}`,
      }));
      expect(result).toMatchObject({ status: "failed", failure: fixture.expected });
    }
  });

  it("fails closed when Gemini reports incoherent context usage", async () => {
    const root = portableFixtureRoot("gemini malformed usage update");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "gemini", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "usage-session", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] } } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "usage-session", update: { sessionUpdate: "usage_update", used: 1001, size: 1000 } } });
    setInterval(() => {}, 1000);
  }
});
`);

    const result = await managerFor(command).run(geminiInput(root, {
      conversationId: "gemini-malformed-usage",
    }));
    expect(result).toMatchObject({
      status: "failed",
      failure: {
        reason: "malformed-protocol",
        phase: "turn",
        terminalEvent: "transport/frame",
      },
    });
    expect(result.failure?.technicalDetail).toMatch(/malformed usage update/iu);
  });

  it("classifies malformed, oversized, and timed-out ACP transports", async () => {
    const cases = [
      {
        name: "malformed",
        source: `process.stdout.write("not-json\\n"); setInterval(() => {}, 1000);`,
        harness: testGeminiHarness({ controlRpcTimeoutMs: 500 }),
        reason: "malformed-protocol",
      },
      {
        name: "oversized",
        source: `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`,
        harness: testGeminiHarness({ controlRpcTimeoutMs: 500 }),
        reason: "protocol-overflow",
      },
      {
        name: "timeout",
        source: `process.stdin.resume(); setInterval(() => {}, 1000);`,
        harness: testGeminiHarness({ controlRpcTimeoutMs: 25 }),
        reason: "rpc-timeout",
      },
    ] as const;
    for (const fixture of cases) {
      const root = portableFixtureRoot(`gemini transport ${fixture.name}`);
      roots.push(root);
      const command = writeNodeFlagExecutable(root, "gemini", fixture.source);
      const result = await managerFor(command, fixture.harness).run(geminiInput(root, {
        conversationId: `gemini-transport-${fixture.name}`,
      }));
      expect(result, fixture.name).toMatchObject({
        status: "failed",
        failure: {
          reason: fixture.reason,
          phase: "initialize",
        },
      });
    }
  });

  it("accepts the terminal tool update after cancellation and cleans up the bridge", async () => {
    const root = portableFixtureRoot("gemini ACP cancellation");
    roots.push(root);
    const capturePath = join(root, "cancel-capture.json");
    const command = writeNodeFlagExecutable(root, "gemini", `
const fs = require("node:fs");
const readline = require("node:readline");
const capture = { methods: [], mcpUrl: null };
let promptId;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(capture));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture.methods.push(message.method ?? "response");
  if (message.method === "initialize") {
    save();
    return send({ jsonrpc: "2.0", id: message.id, result: ${INITIALIZE_RESULT} });
  }
  if (message.method === "session/new") {
    capture.mcpUrl = message.params.mcpServers[0].url;
    save();
    return send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "gemini-cancel-session",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
    } });
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    save();
    return send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "gemini-cancel-session", update: {
      sessionUpdate: "tool_call",
      toolCallId: "cancelled-tool",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    } } });
  }
  if (message.method === "session/cancel") {
    save();
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "gemini-cancel-session", update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Late assistant output" },
    } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "gemini-cancel-session", update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "cancelled-tool",
      status: "failed",
      rawOutput: "cancelled by user",
    } } });
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { gemini: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([testGeminiHarness()]),
    );
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const statuses: string[] = [];
    const visibleText: string[] = [];
    const activities: Array<{
      activityId?: string;
      phase: string;
      detail?: string;
    }> = [];
    const run = manager.run(geminiInput(root, {
      conversationId: "gemini-cancel",
      runId: "run-gemini-cancel",
      turnId: "turn-gemini-cancel",
      prompt: "Wait",
    }), {
      hostTools,
      onStatus: ({ status }) => statuses.push(status),
      onText: ({ text }) => visibleText.push(text),
      onActivity: (event) => {
        activities.push(event);
        if (event.activityId === "cancelled-tool" && event.phase === "started") {
          markToolStarted();
        }
      },
    });

    await toolStarted;
    expect(manager.cancel("gemini-cancel")).toBe(true);
    await expect(run).resolves.toMatchObject({
      status: "cancelled",
      text: "",
      cleanupConfirmed: true,
    });
    expect(visibleText).toEqual([]);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activityId: "cancelled-tool",
        phase: "started",
      }),
      expect.objectContaining({
        activityId: "cancelled-tool",
        phase: "failed",
        detail: expect.stringContaining("cancelled by user"),
      }),
    ]));
    expect(statuses).toEqual(["starting", "running", "cancelling", "cancelled"]);
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      methods: string[];
      mcpUrl: string;
    };
    expect(capture.methods).toContain("session/cancel");
    expect(await loopbackPortIsOpen(Number(new URL(capture.mcpUrl).port)))
      .toBe(false);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("reports context compaction as unsupported without starting Gemini", async () => {
    const root = portableFixtureRoot("gemini compaction unsupported");
    roots.push(root);
    mkdirSync(join(root, ".env"));
    const manager = managerFor(join(root, "must-not-spawn"));
    await expect(manager.compact(geminiInput(root, {
      conversationId: "gemini-compact",
      sessionId: "gemini-compact-session",
      access: "full",
    }), "retain facts")).resolves.toMatchObject({
      providerId: "gemini",
      status: "failed",
      instructionForwarded: false,
      message: "Gemini ACP does not expose a context-compaction command.",
      cleanupConfirmed: true,
    });
  });
});
