import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionOption, ToolKind } from "@agentclientprotocol/sdk";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  createCursorAcpHarness,
  cursorAcpProcessInvocation,
  cursorOneShotPermissionOption,
  cursorPermissionDisplayIsSafe,
  isCursorFileMutationKind,
  parseCursorGenerateImageNotification,
  parseCursorQuestionRequest,
  parseCursorTaskNotification,
} from "../../src/server/provider/cursor-acp-harness";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  loopbackPortIsOpen,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function completingCursorAgent(root: string, name: string): string {
  const command = portableNodeExecutable(root, name);
  writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let promptId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-cleanup-session", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "cursor-cleanup-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`);
  return command;
}

function stalledCursorControlAgent(
  root: string,
  name: string,
  stalledMethod: "initialize" | "session/set_config_option",
): string {
  const command = portableNodeExecutable(root, name);
  writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === ${JSON.stringify(stalledMethod)}) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "cursor-stalled-control",
    modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
    configOptions: [{ type: "select", id: "model", name: "Model", category: "model", currentValue: "model-a", options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }] }]
  } });
});
`);
  return command;
}

function compactingCursorAgent(
  root: string,
  name: string,
  capturePath: string,
  advertisedCommands: readonly string[] | null = null,
  advertiseAfterLoadResponse = false,
  advertiseBeforeLoad = false,
  compactionUpdates: readonly object[] = [{
    sessionUpdate: "compaction_update",
    compactionId: "explicit-compact",
    status: "completed",
  }],
): string {
  const command = portableNodeExecutable(root, name);
  writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "cursor-compact-session";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    ${!advertiseBeforeLoad || advertisedCommands === null ? "" : `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: ${JSON.stringify(advertisedCommands.map((entry) => ({ name: entry, description: entry })))} } } });`}
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "test" } } });
    return;
  }
  if (message.method === "session/load") {
    ${advertiseBeforeLoad || advertiseAfterLoadResponse || advertisedCommands === null ? "" : `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: ${JSON.stringify(advertisedCommands.map((entry) => ({ name: entry, description: entry })))} } } });`}
    send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
    ${!advertiseAfterLoadResponse || advertisedCommands === null ? "" : `return setTimeout(() => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: ${JSON.stringify(advertisedCommands.map((entry) => ({ name: entry, description: entry })))} } } }), 10);`}
    return;
  }
  if (message.method === "session/prompt") {
    fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(message.params.prompt));
    for (const update of ${JSON.stringify(compactionUpdates)}) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    }
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
  return command;
}

function permissionSequenceCursorAgent(root: string, name: string): string {
  const command = portableNodeExecutable(root, name);
  writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "66666666-6666-4666-8666-666666666666";
const kinds = ["edit", "delete", "move", "execute"];
let promptId;
let permissionIndex = 0;
const requestNextPermission = () => {
  if (permissionIndex >= kinds.length) {
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
  const index = permissionIndex;
  const kind = kinds[index];
  permissionIndex += 1;
  send({
    jsonrpc: "2.0",
    id: 100 + index,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "tool-" + kind,
        title: "Allow " + kind,
        kind,
        status: "pending",
        rawInput: { kind },
      },
      options: [
        { optionId: "allow-" + kind, name: "Allow once", kind: "allow_once" },
        { optionId: "reject-" + kind, name: "Reject", kind: "reject_once" },
      ],
    },
  });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    return requestNextPermission();
  }
  if (typeof message.id === "number" && message.id >= 100 && message.id < 104) {
    if (message.result?.outcome?.outcome !== "selected") {
      return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "refusal" } });
    }
    return requestNextPermission();
  }
});
`);
  return command;
}

describe.sequential("Cursor ACP harness", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("routes a configured Cursor editor launcher through its agent subcommand", () => {
    expect(cursorAcpProcessInvocation(
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      {},
      "darwin",
    )).toMatchObject({
      command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      args: ["agent", "acp"],
    });
    expect(cursorAcpProcessInvocation(
      "/usr/local/bin/cursor-agent",
      {},
      "linux",
    )).toMatchObject({
      command: "/usr/local/bin/cursor-agent",
      args: ["acp"],
    });
  });

  it.each([
    ["initialize", "initialize", "initialize"],
    ["session/set_config_option", "configuration", "session/configuration"],
  ] as const)("bounds a stalled Cursor %s control RPC", async (
    stalledMethod,
    expectedPhase,
    expectedTerminalEvent,
  ) => {
    const root = portableFixtureRoot(`cursor stalled ${expectedPhase}`);
    roots.push(root);
    const command = stalledCursorControlAgent(root, `cursor-stalled-${expectedPhase}`, stalledMethod);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness({
        controlRpcTimeoutMs: stalledMethod === "initialize" ? 25 : 5_000,
      })]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: `cursor-stalled-${expectedPhase}`,
      cwd: root,
      prompt: "Do not hang",
      model: stalledMethod === "session/set_config_option" ? "model-b" : undefined,
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("RPC deadline exceeded"),
      failure: {
        reason: "rpc-timeout",
        phase: expectedPhase,
        terminalEvent: expectedTerminalEvent,
      },
      cleanupConfirmed: true,
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("rejects question payloads the interaction surface cannot represent", () => {
    const question = (index: number, optionCount = 1) => ({
      id: `question-${index}`,
      prompt: `Prompt ${index}`,
      options: Array.from({ length: optionCount }, (_, optionIndex) => ({
        id: `option-${optionIndex}`,
        label: `Option ${optionIndex}`,
      })),
    });

    expect(parseCursorQuestionRequest({
      toolCallId: "tool-1",
      questions: [question(1), question(2), question(3)],
    }).questions).toHaveLength(3);
    expect(() => parseCursorQuestionRequest({
      toolCallId: "tool-2",
      questions: [question(1), question(2), question(3), question(4)],
    })).toThrow("more than 3 questions");
    expect(() => parseCursorQuestionRequest({
      toolCallId: "tool-3",
      questions: [question(1, 21)],
    })).toThrow("more than 20 options");
    expect(() => parseCursorQuestionRequest({
      toolCallId: "tool-empty",
      questions: [],
    })).toThrow("empty question request");
    expect(() => parseCursorQuestionRequest({
      toolCallId: "tool-duplicate-question",
      questions: [question(1), question(1)],
    })).toThrow("duplicate question ID");
    expect(() => parseCursorQuestionRequest({
      toolCallId: "tool-duplicate-option",
      questions: [{
        ...question(1),
        options: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      }],
    })).toThrow("duplicate option ID");
    expect(() => parseCursorQuestionRequest({
      toolCallId: "tool-unsafe",
      questions: [{
        ...question(1),
        prompt: "Choose\u2066 hidden text",
      }],
    })).toThrow("safe bounded display text");
    expect(() => parseCursorQuestionRequest({
      toolCallId: "tool-duplicate-label",
      questions: [{
        ...question(1),
        options: [
          { id: "one", label: "Café" },
          { id: "two", label: "cafe\u0301" },
        ],
      }],
    })).toThrow("duplicate option labels");
  });

  it("validates Cursor task and generated-image extension notifications", () => {
    expect(parseCursorTaskNotification({
      toolCallId: "task-tool",
      description: "Explore provider events",
      prompt: "Find missing lifecycle events",
      subagentType: { custom: "provider-auditor" },
      model: "cursor-model",
      agentId: "agent-1",
      durationMs: 42,
    })).toMatchObject({
      toolCallId: "task-tool",
      subagentType: "provider-auditor",
      durationMs: 42,
    });
    expect(() => parseCursorTaskNotification({
      toolCallId: "task-tool",
      description: "Explore",
      prompt: "Inspect",
      subagentType: "explore",
      durationMs: -1,
    })).toThrow("durationMs");

    expect(parseCursorGenerateImageNotification({
      toolCallId: "image-tool",
      description: "Provider diagram",
      filePath: "/tmp/provider.png",
      referenceImagePaths: ["/tmp/reference.png"],
    })).toMatchObject({
      toolCallId: "image-tool",
      referenceImagePaths: ["/tmp/reference.png"],
    });
    expect(() => parseCursorGenerateImageNotification({
      toolCallId: "image-tool",
      description: "Provider diagram",
      referenceImagePaths: Array.from({ length: 21 }, () => "/tmp/ref.png"),
    })).toThrow("more than 20");
  });

  it("bridges compaction through Cursor's summarize command without forwarding focus text", async () => {
    const root = portableFixtureRoot("cursor ACP compact");
    roots.push(root);
    const capturePath = join(root, "compact-prompt.json");
    const command = compactingCursorAgent(
      root,
      "cursor-compact",
      capturePath,
      ["summarize"],
    );
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-compact-session",
    }), "remember retrieval exactly")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: false,
      message: expect.stringContaining("was not forwarded"),
    });
    const captured = readFileSync(capturePath, "utf8");
    expect(captured).toContain("/summarize");
    expect(captured).not.toContain("remember retrieval exactly");
  });

  it("requires clean negotiated lifecycle completion for explicit compaction", async () => {
    const cases = [
      {
        name: "no-event",
        updates: [],
        status: "failed",
      },
      {
        name: "failed",
        updates: [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" },
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "failed", error: "limit changed" },
        ],
        status: "failed",
      },
      {
        name: "cancelled",
        updates: [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" },
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "cancelled" },
        ],
        status: "failed",
      },
      {
        name: "incomplete",
        updates: [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" },
        ],
        status: "failed",
      },
      {
        name: "completed",
        updates: [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" },
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" },
        ],
        status: "completed",
      },
      {
        name: "mixed",
        updates: [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" },
          { sessionUpdate: "compaction_update", compactionId: "compact-2", status: "failed", error: "limit changed" },
        ],
        status: "failed",
      },
      {
        name: "future-then-completed",
        updates: [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" },
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "future_paused" },
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" },
        ],
        status: "completed",
      },
      {
        name: "unknown-only",
        updates: [
          { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "future_paused" },
        ],
        status: "failed",
      },
    ] as const;

    for (const fixture of cases) {
      const root = portableFixtureRoot(`cursor ACP compact ${fixture.name}`);
      roots.push(root);
      const command = compactingCursorAgent(
        root,
        `cursor-compact-${fixture.name}`,
        join(root, "prompt.json"),
        ["summarize"],
        false,
        false,
        fixture.updates,
      );
      const manager = new ProviderManager(
        { commands: { cursor: command } },
        new AgentHarnessRegistry([createCursorAcpHarness()]),
      );
      const result = await manager.compact(nativeProviderRunInput({
        providerId: "cursor",
        conversationId: `cursor-compact-${fixture.name}`,
        cwd: root,
        prompt: "/compact",
        interactionMode: "build",
        access: "supervised",
        sessionId: "cursor-compact-session",
      }));
      expect(result.status, fixture.name).toBe(fixture.status);
      if (fixture.status === "failed") {
        expect(result.message).toContain("did not confirm");
      }
    }
  });

  it("waits for Cursor's command advertisement after the load response", async () => {
    const root = portableFixtureRoot("cursor ACP delayed compact capability");
    roots.push(root);
    const capturePath = join(root, "compact-prompt.json");
    const command = compactingCursorAgent(
      root,
      "cursor-compact-delayed-capability",
      capturePath,
      ["summarize"],
      true,
    );
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-compact-delayed-capability",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-compact-session",
    }))).resolves.toMatchObject({ status: "completed" });
    expect(readFileSync(capturePath, "utf8")).toContain("/summarize");
  });

  it("ignores a same-session command advertisement sent before session load", async () => {
    const root = portableFixtureRoot("cursor ACP stale compact capability");
    roots.push(root);
    const capturePath = join(root, "compact-prompt.json");
    const command = compactingCursorAgent(
      root,
      "cursor-compact-stale-capability",
      capturePath,
      ["summarize"],
      false,
      true,
    );
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness({
        commandAdvertisementTimeoutMs: 25,
      })]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-compact-stale-capability",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-compact-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not advertise"),
    });
    expect(() => readFileSync(capturePath, "utf8")).toThrow();
  });

  it("rejects compaction when Cursor explicitly omits summarize", async () => {
    const root = portableFixtureRoot("cursor ACP compact unsupported");
    roots.push(root);
    const capturePath = join(root, "compact-prompt.json");
    const command = compactingCursorAgent(
      root,
      "cursor-compact-unsupported",
      capturePath,
      ["agent_help"],
    );
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-compact-unsupported",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-compact-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("does not advertise"),
    });
    expect(() => readFileSync(capturePath, "utf8")).toThrow();
  });

  it("rejects unproven compaction when Cursor advertises no commands", async () => {
    const root = portableFixtureRoot("cursor ACP compact unproven");
    roots.push(root);
    const capturePath = join(root, "compact-prompt.json");
    const command = compactingCursorAgent(
      root,
      "cursor-compact-unproven",
      capturePath,
    );
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness({
        commandAdvertisementTimeoutMs: 25,
      })]),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-compact-unproven",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-compact-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not advertise"),
    });
    expect(() => readFileSync(capturePath, "utf8")).toThrow();
  });

  it("uses one complete file-mutation classification for ACP permissions", () => {
    expect(([
      "read",
      "edit",
      "delete",
      "move",
      "search",
      "execute",
      "think",
      "fetch",
      "switch_mode",
      "other",
    ] satisfies ToolKind[]).filter(isCursorFileMutationKind)).toEqual([
      "edit",
      "delete",
      "move",
    ]);
  });

  it("never turns a generic approval into a remembered ACP decision", () => {
    const options = [
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
    ] satisfies PermissionOption[];
    expect(cursorOneShotPermissionOption(options, true)).toBeUndefined();
    expect(cursorOneShotPermissionOption(options, false)).toBeUndefined();

    const oneShot = [
      ...options,
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
    ] satisfies PermissionOption[];
    expect(cursorOneShotPermissionOption(oneShot, true)?.optionId).toBe(
      "allow-once",
    );
    expect(cursorOneShotPermissionOption(oneShot, false)?.optionId).toBe(
      "reject-once",
    );
  });

  it("rejects direction-changing or controlled approval copy", () => {
    const request = (title: string, rawInput: unknown) => ({
      toolCall: {
        toolCallId: "tool-approval-copy",
        title,
        kind: "execute" as const,
        status: "pending" as const,
        rawInput,
      },
    });
    expect(cursorPermissionDisplayIsSafe(
      request("Run tests", { command: "npm test" }),
    )).toBe(true);
    expect(cursorPermissionDisplayIsSafe(
      request("Run safe\u202Etxt.exe", { command: "npm test" }),
    )).toBe(false);
    expect(cursorPermissionDisplayIsSafe(
      request("Run\u0000tests", { command: "npm test" }),
    )).toBe(false);
  });

  it.each([
    {
      access: "supervised" as const,
      expectedApprovals: [
        ["Allow edit", "file-change"],
        ["Allow delete", "file-change"],
        ["Allow move", "file-change"],
        ["Allow execute", "command"],
      ],
    },
    {
      access: "auto-edit" as const,
      expectedApprovals: [["Allow execute", "command"]],
    },
    {
      access: "full" as const,
      expectedApprovals: [],
    },
  ])("applies $access access to ACP edit, delete, move, and execute requests", async ({
    access,
    expectedApprovals,
  }) => {
    const root = portableFixtureRoot(`cursor ACP ${access} permissions`);
    roots.push(root);
    const command = permissionSequenceCursorAgent(
      root,
      `cursor-${access}-permissions`,
    );
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const approvals: string[][] = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: `cursor-${access}-permissions`,
      cwd: root,
      prompt: "Apply the requested changes",
      interactionMode: "build",
      access,
    }), {
      onApproval: (event) => {
        approvals.push([event.request.title, event.request.kind]);
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
        )).toBe(true);
      },
    })).resolves.toMatchObject({ status: "completed" });
    expect(approvals).toEqual(expectedApprovals);
  });

  it("fails and terminates an ACP process that floods bounded events", async () => {
    const root = portableFixtureRoot("cursor ACP event flood");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "55555555-5555-4555-8555-555555555555";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    for (let index = 0; index < 20_000; index += 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "build" } } });
    }
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-event-flood",
      cwd: root,
      prompt: "Flood",
      interactionMode: "build",
      access: "full",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Cursor ACP exceeded the bounded event rate for this run.",
      failure: {
        reason: "protocol-overflow",
        phase: "turn",
        terminalEvent: "session/prompt",
      },
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("negotiates capabilities and bridges ACP permissions, questions, plans, thinking, usage, and images", async () => {
    const root = portableFixtureRoot("cursor ACP");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const captured = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(captured));
const sessionId = "44444444-4444-4444-8444-444444444444";
const configOptions = [
  { type: "select", id: "model", name: "Model", category: "model", currentValue: "model-a", options: [{ value: "model-a", name: "Model A" }] },
  { type: "select", id: "effort-before-model", name: "Effort", category: "thought_level", currentValue: "low", options: [{ value: "low", name: "Low" }] }
];
const modelAConfigOptions = [
  configOptions[0],
  { type: "select", id: "effort-model-a", name: "Effort", category: "thought_level", currentValue: "low", options: [{ value: "high", name: "High" }] }
];
let promptRequestId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  captured.push(message);
  save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, agentInfo: { name: "Cursor", version: "9.9.9" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] }, configOptions } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: message.id, result: { configOptions: modelAConfigOptions } });
  if (message.method === "session/prompt") {
    promptRequestId = message.id;
    return send({ jsonrpc: "2.0", id: 100, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute", status: "pending", rawInput: { command: "npm test" } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
  }
  if (message.id === 100) return send({ jsonrpc: "2.0", id: 101, method: "cursor/ask_question", params: { toolCallId: "tool-2", title: "Choose scope", questions: [
    { id: "scope", prompt: "Which scopes?", options: [{ id: "focused", label: "Focused" }, { id: "broad", label: "Broad" }], allowMultiple: true },
    { id: "notes", prompt: "Anything else?", options: [], allowMultiple: false }
  ] } });
  if (message.id === 101) return send({ jsonrpc: "2.0", id: 102, method: "cursor/create_plan", params: { toolCallId: "tool-3", plan: "Inspect then implement", todos: [{ id: "todo-1", content: "Inspect", status: "in_progress" }] } });
  if (message.id === 102) {
    send({ jsonrpc: "2.0", method: "cursor/task", params: { toolCallId: "tool-subagent", description: "Explore provider events", prompt: "Find missing lifecycle events", subagentType: "explore", model: "model-a", agentId: "agent-1", durationMs: 42 } });
    send({ jsonrpc: "2.0", method: "cursor/generate_image", params: { toolCallId: "tool-image", description: "Provider architecture", filePath: ${JSON.stringify(join(root, "generated.png"))}, referenceImagePaths: [${JSON.stringify(imagePath)}] } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stale-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan", entries: [{ content: "Implement", priority: "high", status: "pending" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan_update", plan: { type: "items", planId: "plan-1", entries: [{ content: "Verify", priority: "high", status: "completed" }] } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "plan-1", content: "Review the final diff." } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan_removed", planId: "plan-1" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "session_info_update", title: "Provider audit" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-4", title: "Run command", kind: "execute", status: "in_progress", rawInput: { command: "npm test" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-4", title: "Run command", kind: "execute", status: "completed", rawOutput: "passed" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-5", title: "Already complete", kind: "execute", status: "completed", rawInput: { command: "npm run check" }, rawOutput: "green" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-6", title: "T".repeat(5000), kind: "execute", status: "pending", rawInput: { command: "c".repeat(5000), ignored: "x".repeat(500000) } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-6", status: "completed", rawOutput: "clean" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_summary_chunk", compactionId: "compact-1", content: { type: "text", text: "Retained summary, not assistant output" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "future_paused" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed", summary: [{ type: "text", text: "Final retained summary" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-2", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-2", status: "failed", error: "Context limit changed" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-3", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-3", status: "cancelled" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-4", status: "completed", _meta: { source: "terminal-first" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-4", status: "completed", summary: [{ type: "text", text: "Late retained summary" }], _meta: null } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 321, size: 200000 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Cursor response" } } } });
    return send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn", usage: { totalTokens: 350, inputTokens: 320, outputTokens: 30, thoughtTokens: 5, cachedReadTokens: 20, cachedWriteTokens: 0.5 } } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const approvals: string[] = [];
    const questions: string[] = [];
    const plans: string[] = [];
    const planExplanations: Array<string | null> = [];
    const reasoning: string[] = [];
    const usage: Array<number | null> = [];
    const usageDetails: Array<Record<string, unknown>> = [];
    const metadata: string[][] = [];
    const activities: Array<{ activityId?: string; detail?: string; label: string; phase: string }> = [];
    const subagents: Array<{
      providerTaskId: string | null;
      providerAgentId: string | null;
      status: string;
      description: string | null;
      progress: string | null;
    }> = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-rich",
      cwd: root,
      prompt: "Build this",
      interactionMode: "plan",
      access: "supervised",
      model: "model-a",
      reasoningEffort: "high",
      imagePaths: [imagePath],
    }), {
      onApproval: (event) => {
        approvals.push(event.request.title);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => {
        questions.push(event.request.questions[0]!.question);
        expect(event.request.questions).toMatchObject([
          { id: "scope", allowMultiple: true, options: [{ id: "focused" }, { id: "broad" }] },
          { id: "notes", allowMultiple: false, options: [] },
        ]);
        expect(manager.respondToInput(event.conversationId, event.request.requestId, {
          scope: ["focused", "broad"],
          notes: ["Use the exact free-text answer"],
        })).toBe(true);
      },
      onPlan: (event) => {
        planExplanations.push(event.explanation);
        plans.push(...event.steps.map((step) => step.step));
      },
      onReasoning: (event) => reasoning.push(event.text),
      onActivity: (event) => activities.push(event),
      onSubagent: (event) => subagents.push(event),
      onUsage: (event) => {
        usage.push(event.usage.usedTokens);
        usageDetails.push(event.usage);
      },
      onMetadata: (event) => metadata.push(event.metadata.models?.map((model) => model.id) ?? []),
    });

    expect(result).toMatchObject({ status: "completed", text: "Cursor response", sessionId: "44444444-4444-4444-8444-444444444444" });
    expect(approvals).toEqual(["Run tests"]);
    expect(questions).toEqual(["Which scopes?"]);
    expect(plans).toEqual(expect.arrayContaining(["Inspect", "Implement", "Verify"]));
    expect(planExplanations).toContain("Review the final diff.");
    expect(reasoning).toEqual(["Checking"]);
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-4",
      phase: "completed",
      detail: "Command:\nnpm test\n\nOutput:\npassed",
    }));
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-4",
      phase: "started",
      detail: "Command:\nnpm test",
    }));
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-5",
      phase: "completed",
      detail: "Command:\nnpm run check\n\nOutput:\ngreen",
    }));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activityId: "cursor:compaction:compact-1",
        phase: "started",
        label: "Cursor is compacting session context",
        detail: "Status: in_progress",
      }),
      expect.objectContaining({
        activityId: "cursor:compaction:compact-1",
        phase: "completed",
        label: "Cursor compacted session context",
        detail: "Status: completed",
      }),
      expect.objectContaining({
        phase: "info",
        label: "Cursor reported a context compaction update",
        detail: "Status: future_paused",
      }),
      expect.objectContaining({
        activityId: "cursor:compaction:compact-2",
        phase: "failed",
        label: "Cursor could not compact session context",
        detail: "Status: failed",
      }),
      expect.objectContaining({
        activityId: "cursor:compaction:compact-3",
        phase: "info",
        label: "Cursor cancelled session context compaction",
        detail: "Status: cancelled",
      }),
      expect.objectContaining({
        activityId: "cursor:compaction:compact-4",
        phase: "completed",
        label: "Cursor compacted session context",
        detail: "Status: completed",
      }),
    ]));
    expect(activities.filter(({ activityId }) =>
      activityId === "cursor:compaction:compact-4")).toHaveLength(1);
    const boundedTool = activities.find((activity) =>
      activity.activityId === "tool-6" && activity.phase === "completed");
    expect(boundedTool?.label).toBe("T".repeat(240));
    expect(boundedTool?.detail).toBe(`Command:\n${"c".repeat(4_000)}\n\nOutput:\nclean`);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: "info",
        label: "Cursor switched to plan mode",
      }),
      expect.objectContaining({
        phase: "info",
        label: "Cursor session: Provider audit",
      }),
    ]));
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-image",
      phase: "completed",
      label: "Generated image: Provider architecture",
      detail: `Output: ${join("<workspace>", "generated.png")}\nReferences: ${join("<workspace>", "reference.png")}`,
    }));
    expect(subagents).toEqual([expect.objectContaining({
      providerTaskId: "tool-subagent",
      providerAgentId: "agent-1",
      status: "completed",
      description: "Explore provider events",
      progress: "Completed in 42 ms",
    })]);
    expect(usage).toEqual([321, 321]);
    expect(usageDetails.at(-1)).toMatchObject({
      usedTokens: 321,
      totalProcessedTokens: 350,
      totalProcessedScope: "session",
      maxTokens: 200_000,
      inputTokens: 320,
      cachedInputTokens: 20,
      cacheWriteInputTokens: null,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      compactsAutomatically: null,
    });
    expect(metadata).toContainEqual(["model-a"]);
    expect(manager.cachedMetadata("cursor")).toMatchObject({
      models: [expect.objectContaining({
        id: "model-a",
        inputModalities: ["text", "image"],
        reasoningOptions: [expect.objectContaining({ value: "high" })],
      })],
      metadataState: { models: { freshness: "fresh", provenance: "session" } },
    });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<Record<string, unknown>>;
    expect(captured.find((message) => message.method === "initialize"))
      .toMatchObject({
        params: {
          clientCapabilities: {
            plan: {},
            session: { compaction: {} },
          },
        },
      });
    expect(captured.find((message) => message.id === 100)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(captured.find((message) => message.id === 101)).toMatchObject({
      result: {
        outcome: "answered",
        answers: [
          { questionId: "scope", selectedOptionIds: ["focused", "broad"] },
          { questionId: "notes", selectedOptionIds: ["Use the exact free-text answer"] },
        ],
      },
    });
    expect(captured.find((message) => message.id === 102)).toMatchObject({
      result: { outcome: { outcome: "accepted" } },
    });
    const prompt = captured.find((message) => message.method === "session/prompt") as { params: { prompt: Array<Record<string, unknown>> } };
    expect(prompt.params.prompt).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image", mimeType: "image/png", data: "iVBORw==" }),
      { type: "text", text: "Build this" },
    ]));
    expect(captured.filter((message) => message.method === "session/set_config_option"))
      .toMatchObject([
        { params: { configId: "model", value: "model-a" } },
        { params: { configId: "effort-model-a", value: "high" } },
      ]);
  });

  it("fails closed on terminal authentication without invoking authenticate", async () => {
    const root = portableFixtureRoot("cursor ACP terminal auth");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [{ type: "terminal", id: "cursor_login", name: "Cursor login", args: ["login"] }],
    agentInfo: { name: "Cursor", version: "test" },
  } });
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-terminal-auth",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("terminal authentication"),
      failure: { phase: "initialize", terminalEvent: "initialize" },
    });
    const messages = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      method?: string;
    }>;
    expect(messages.some(({ method }) => method === "authenticate")).toBe(false);
  });

  it("fails closed on malformed ACP frames", async () => {
    const root = portableFixtureRoot("cursor ACP invalid");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `process.stdout.write("not-json\\n"); setTimeout(() => {}, 1000);`);
    const manager = new ProviderManager({ commands: { cursor: command } }, new AgentHarnessRegistry([createCursorAcpHarness()]));
    await expect(manager.run(nativeProviderRunInput({ providerId: "cursor", conversationId: "cursor-invalid", cwd: root, prompt: "Hi", interactionMode: "build", access: "supervised" }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "initialize" },
    });
  });

  it("rejects an object that is not a JSON-RPC envelope before valid Cursor frames", async () => {
    const root = portableFixtureRoot("cursor ACP malformed envelope");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-should-not-run", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-malformed-envelope",
      cwd: root,
      prompt: "Must not reach prompt",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "initialize" },
    });
  });

  it("rejects an oversized Cursor tool identity", async () => {
    const root = portableFixtureRoot("cursor ACP invalid tool identity");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-invalid-tool", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "cursor-invalid-tool", update: { sessionUpdate: "tool_call", toolCallId: "x".repeat(1001), title: "Tool", kind: "execute", status: "pending" } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-invalid-tool",
      cwd: root,
      prompt: "Reject the invalid tool",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "turn" },
    });
  });

  it("fails a Cursor turn when a malformed session update races end_turn", async () => {
    const root = portableFixtureRoot("cursor malformed session update");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-malformed-update", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {} });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-malformed-update",
      cwd: root,
      prompt: "Reject the malformed update",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "turn" },
    });
  });

  it("rejects a session update sent as a JSON-RPC request", async () => {
    const root = portableFixtureRoot("cursor session update request");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-update-request", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: 77, method: "session/update", params: { sessionId: "cursor-update-request", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Must not complete" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-update-request",
      cwd: root,
      prompt: "Reject the wrong message kind",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "turn" },
    });
  });

  it.each([
    ["cursor/update_todos", "todo update"],
    ["cursor/task", "task notification"],
    ["cursor/generate_image", "generated-image notification"],
  ] as const)("fails a Cursor turn when a malformed %s races end_turn", async (
    method,
    label,
  ) => {
    const root = portableFixtureRoot(`cursor malformed ${label}`);
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-malformed-extension", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: ${JSON.stringify(method)}, params: {} });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-malformed-extension",
      cwd: root,
      prompt: "Reject the malformed extension event",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "turn" },
    });
  });

  it.each([
    ["cursor/update_todos", {
      toolCallId: "todo-tool",
      todos: [],
      merge: false,
    }],
    ["cursor/task", {
      toolCallId: "task-tool",
      description: "Inspect provider state",
      prompt: "Inspect",
      subagentType: "explore",
    }],
    ["cursor/generate_image", {
      toolCallId: "image-tool",
      description: "Provider diagram",
      referenceImagePaths: [],
    }],
  ] as const)("rejects %s when it is sent as a JSON-RPC request", async (
    method,
    params,
  ) => {
    const methodLabel = method.replaceAll("/", "-");
    const root = portableFixtureRoot(`cursor request kind ${methodLabel}`);
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-notification-request", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: 88, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: `cursor-request-kind-${methodLabel}`,
      cwd: root,
      prompt: "Reject the wrong message kind",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "turn" },
    });
  });

  it("fails closed on malformed UTF-8 split across ACP stdout chunks", async () => {
    const root = portableFixtureRoot("cursor ACP invalid utf8");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
process.stdout.write(Buffer.from('{"jsonrpc":"2.0","method":"cursor/test","params":{"value":"'));
process.stdout.write(Buffer.from([0xc3]));
setTimeout(() => {
  process.stdout.write(Buffer.concat([Buffer.from([0x28]), Buffer.from('"}}\\n')]));
}, 10);
setTimeout(() => {}, 1000);
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-invalid-utf8",
      cwd: root,
      prompt: "Hi",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/not valid.*utf-8/iu),
      failure: { reason: "malformed-protocol", phase: "initialize" },
    });
  });

  it("loads a resumable ACP session instead of creating a replacement", async () => {
    const root = portableFixtureRoot("cursor ACP resume");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/load") return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Resumed response" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-resume",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-existing-session",
    }))).resolves.toMatchObject({ status: "completed", sessionId: "cursor-existing-session", text: "Resumed response" });
    const messages = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{ method?: string }>;
    expect(messages.some(({ method }) => method === "session/load")).toBe(true);
    expect(messages.some(({ method }) => method === "session/new")).toBe(false);
  });

  it("ignores Cursor task and image notifications before the resumed prompt is active", async () => {
    const root = portableFixtureRoot("cursor ACP extension ownership");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "cursor-extension-session";
const task = (id) => ({ jsonrpc: "2.0", method: "cursor/task", params: { toolCallId: id, description: id, prompt: "Inspect", subagentType: "explore" } });
const image = (id) => ({ jsonrpc: "2.0", method: "cursor/generate_image", params: { toolCallId: id, description: id, referenceImagePaths: [] } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", method: "cursor/task", params: {} });
    send({ jsonrpc: "2.0", method: "cursor/generate_image", params: {} });
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "test" } } });
  }
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", method: "cursor/task", params: { description: "pre-prompt" } });
    send({ jsonrpc: "2.0", method: "cursor/generate_image", params: { description: "pre-prompt" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pre-prompt text" } } } });
    send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "pre-prompt-permission", title: "Pre-prompt permission", kind: "execute", status: "pending", rawInput: { command: "should-not-run" } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } });
    send({ jsonrpc: "2.0", id: 901, method: "cursor/ask_question", params: {} });
    send({ jsonrpc: "2.0", id: 902, method: "cursor/create_plan", params: {} });
    send({ jsonrpc: "2.0", method: "cursor/update_todos", params: {} });
    return setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } }), 20);
  }
  if (message.method === "session/prompt") {
    send(task("live-task"));
    send(image("live-image"));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live text" } } } });
    return setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }), 20);
  }
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const taskIds: Array<string | null> = [];
    const imageIds: Array<string | undefined> = [];
    const approvals: string[] = [];
    const inputs: string[] = [];
    const plans: string[] = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-extension-ownership",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "cursor-extension-session",
    }), {
      onApproval: (event) => approvals.push(event.request.title),
      onInput: (event) => inputs.push(
        event.request.questions[0]?.question ?? "",
      ),
      onPlan: (event) => plans.push(event.explanation ?? ""),
      onSubagent: (event) => taskIds.push(event.providerTaskId),
      onActivity: (event) => {
        if (event.label.startsWith("Generated image:")) {
          imageIds.push(event.activityId);
        }
      },
    })).resolves.toMatchObject({ status: "completed", text: "live text" });
    expect(approvals).toEqual([]);
    expect(inputs).toEqual([]);
    expect(plans).toEqual([]);
    expect(taskIds).toEqual(["live-task"]);
    expect(imageIds).toEqual(["live-image"]);
  });

  it("publishes the terminal ACP status only after owned cleanup settles", async () => {
    const root = portableFixtureRoot("cursor ACP cleanup barrier");
    roots.push(root);
    const command = completingCursorAgent(root, "cursor-cleanup-agent");
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([
        createCursorAcpHarness({
          terminateProcessTree: async (child, force) => {
            expect(force).toBe(true);
            markCleanupStarted();
            await cleanupGate;
            return await terminateProcessTreeAndWait(child, true);
          },
        }),
      ]),
    );
    const statuses: string[] = [];
    const result = manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-cleanup-barrier",
      cwd: root,
      prompt: "Complete after cleanup",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    });
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await cleanupStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(statuses).not.toContain("completed");

    releaseCleanup();
    await expect(result).resolves.toMatchObject({
      status: "completed",
      text: "Done",
    });
    expect(statuses.at(-1)).toBe("completed");
  });

  it("maps unconfirmed ACP cleanup to one failed terminal result", async () => {
    const root = portableFixtureRoot("cursor ACP cleanup failure");
    roots.push(root);
    const command = completingCursorAgent(root, "cursor-cleanup-failure-agent");
    const terminateProcessTree = vi.fn(async (child, _force: boolean) => {
      await terminateProcessTreeAndWait(child, true);
      return false;
    });
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([
        createCursorAcpHarness({ terminateProcessTree }),
      ]),
    );
    const statuses: string[] = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-cleanup-failure",
      cwd: root,
      prompt: "Fail cleanup",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    })).resolves.toMatchObject({
      status: "failed",
      error: "Cursor ACP process tree could not be confirmed stopped.",
      cleanupConfirmed: false,
      failure: {
        reason: "provider-error",
        message: "Cursor ACP process tree could not be confirmed stopped.",
        phase: "cleanup",
        terminalEvent: "process-tree/cleanup",
      },
    });
    expect(statuses).not.toContain("completed");
    expect(statuses.at(-1)).toBe("failed");
    expect(terminateProcessTree.mock.calls.map(([, force]) => force)).toEqual([
      true,
    ]);
  });

  it("makes cleanup failure authoritative while retaining a prior provider failure", async () => {
    const root = portableFixtureRoot("cursor ACP failure after failure");
    roots.push(root);
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-double-failure", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "refusal" } });
});
`);
    const terminateProcessTree = vi.fn(async (child, _force: boolean) => {
      await terminateProcessTreeAndWait(child, true);
      return false;
    });
    const manager = new ProviderManager(
      { commands: { cursor: command } },
      new AgentHarnessRegistry([
        createCursorAcpHarness({ terminateProcessTree }),
      ]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-double-failure",
      cwd: root,
      prompt: "Fail twice",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Cursor ACP process tree could not be confirmed stopped.",
      cleanupConfirmed: false,
      failure: {
        reason: "provider-error",
        message: "Cursor ACP process tree could not be confirmed stopped.",
        phase: "cleanup",
        terminalEvent: "process-tree/cleanup",
        technicalDetail: expect.stringMatching(
          /Prior failure reason: provider-error[\s\S]*refusal/,
        ),
      },
    });
  });

  it("cancels through ACP and closes the owned process socket", async () => {
    const root = portableFixtureRoot("cursor ACP cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const messages = [];
let promptId;
const probe = net.createServer(() => {});
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ port: probe.address()?.port, messages }));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
probe.listen(0, "127.0.0.1", save);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-cancel-session", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") { promptId = message.id; return; }
  if (message.method === "session/cancel") return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-cancel",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }), { onStatus: ({ status }) => { if (status === "running") markRunning(); } });

    await running;
    await waitFor("Cursor fixture capture", () => {
      try { return Boolean(JSON.parse(readFileSync(capturePath, "utf8")).port); } catch { return false; }
    });
    expect(manager.cancel("cursor-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { port: number; messages: Array<{ method?: string }> };
    expect(captured.messages.some(({ method }) => method === "session/cancel")).toBe(true);
    await waitFor("the Cursor child socket to close", async () => !(await loopbackPortIsOpen(captured.port)));
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("does not launch a prompt after cancellation settles session setup", async () => {
    const root = portableFixtureRoot("cursor ACP setup cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "cursor-agent");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
let configRequestId;
const configOptions = [{ type: "select", id: "model", name: "Model", category: "model", currentValue: "default", options: [{ value: "model-a", name: "Model A" }] }];
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-setup-cancel", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions } });
  if (message.method === "session/set_config_option") { configRequestId = message.id; return; }
  if (message.method === "session/cancel" && configRequestId !== undefined) {
    return send({ jsonrpc: "2.0", id: configRequestId, result: { configOptions } });
  }
  if (message.method === "session/prompt") return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});
`);
    const manager = new ProviderManager(
      { commands: { cursor: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const result = manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-setup-cancel",
      cwd: root,
      prompt: "Must not launch",
      model: "model-a",
      interactionMode: "build",
      access: "supervised",
    }));

    await waitFor("Cursor setup request", () => {
      try {
        const messages = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
          method?: string;
        }>;
        return messages.some(({ method }) => method === "session/set_config_option");
      } catch {
        return false;
      }
    });
    expect(manager.cancel("cursor-setup-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const messages = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      method?: string;
    }>;
    expect(messages.some(({ method }) => method === "session/cancel")).toBe(true);
    expect(messages.some(({ method }) => method === "session/prompt")).toBe(false);
  });

  it("rejects oversized ACP frames and unavailable negotiated capabilities", async () => {
    const oversizedRoot = portableFixtureRoot("cursor ACP oversized");
    roots.push(oversizedRoot);
    const oversizedCommand = portableNodeExecutable(oversizedRoot, "cursor-agent");
    writeNodeSubcommand(oversizedRoot, "acp", `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`);
    const oversizedManager = new ProviderManager(
      { commands: { cursor: oversizedCommand } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(oversizedManager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-oversized",
      cwd: oversizedRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("oversized"),
      failure: { reason: "protocol-overflow", phase: "initialize" },
    });

    const capabilityRoot = portableFixtureRoot("cursor ACP capabilities");
    roots.push(capabilityRoot);
    const imagePath = join(capabilityRoot, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const capabilityCommand = portableNodeExecutable(capabilityRoot, "cursor-agent");
    writeNodeSubcommand(capabilityRoot, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-no-images", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
});
`);
    const capabilityManager = new ProviderManager(
      { commands: { cursor: capabilityCommand } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(capabilityManager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-no-resume",
      cwd: capabilityRoot,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "existing",
    }))).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("resume support") });
    await expect(capabilityManager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-no-image",
      cwd: capabilityRoot,
      prompt: "Inspect",
      interactionMode: "build",
      access: "supervised",
      imagePaths: [imagePath],
    }))).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("image prompt support") });
  });

  it("settles startup failure when the ACP executable is missing", async () => {
    const root = portableFixtureRoot("cursor ACP missing");
    roots.push(root);
    const missing = join(root, process.platform === "win32" ? "missing.exe" : "missing");
    const manager = new ProviderManager(
      { commands: { cursor: missing } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-missing",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({ status: "failed" });
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
