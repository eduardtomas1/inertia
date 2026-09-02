import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  PermissionOption,
  RequestPermissionRequest,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeOwnedProcessJournal,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry as activateRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";
import { buildProviderInvocation } from "../../src/server/provider/adapters";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  createKimiAcpHarness,
  kimiAcpProcessInvocation,
  kimiInputOptions,
} from "../../src/server/provider/kimi-acp-harness";
import { BoundedKimiJsonLineTransform } from "../../src/server/provider/kimi-acp-support";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { ProviderRunEventBudget } from "../../src/server/provider/io";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

// Node protects process.stdout with a no-op _destroy. POSIX uv_pipe_open owns
// fd 1, so restoring the pipe-backed Socket implementation delivers EOF while
// the fixture remains alive. Windows deliberately duplicates stdio handles
// and refuses to close fd 0-2; its fixture must flush and exit instead.
const CLOSE_NODE_STDOUT_TRANSPORT_SOURCE = `
const stdoutFd = process.stdout.fd;
const realStdoutDestroy = Object.getPrototypeOf(process.stdout)._destroy;
if (typeof realStdoutDestroy !== "function") throw new Error("Node stdout is not a pipe-backed Socket.");
process.stdout._destroy = realStdoutDestroy;
process.stdout.destroy();
require("node:fs").closeSync(stdoutFd);
`;

const hostTools: ProviderHostToolBridge = {
  definitions: [{
    name: "inertia_list_conversations",
    description: "List safe chats.",
    inputSchema: { type: "object", additionalProperties: false },
    readOnly: true,
  }],
  invoke: async () => ({ success: true, text: "{}" }),
};

async function collectKimiFrames(chunks: readonly Buffer[]): Promise<string> {
  const output: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    new BoundedKimiJsonLineTransform(
      4 * 1024,
      new ProviderRunEventBudget("Kimi ACP", 4 * 1024, 16, 16 * 1024),
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

describe("bounded Kimi ACP framing", () => {
  it("decodes a valid multibyte frame split into one-byte chunks", async () => {
    const frame = Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { message: "Kimi 🌙" },
    })}\n`);

    await expect(collectKimiFrames(
      [...frame].map((byte) => Buffer.of(byte)),
    )).resolves.toBe(frame.toString("utf8"));
  });

  it("rejects malformed UTF-8 instead of normalizing replacement characters", async () => {
    const frame = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]);

    await expect(collectKimiFrames([frame])).rejects.toThrow(
      /not valid.*utf-?8/iu,
    );
  });
});

describe.sequential("Kimi ACP harness", () => {
  const roots: string[] = [];
  const registryDeactivators: Array<() => void> = [];

  afterEach(async () => {
    while (registryDeactivators.length > 0) registryDeactivators.pop()?.();
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it(
    "delivers EOF with the platform-supported stdout lifecycle",
    async () => {
      const root = portableFixtureRoot("Kimi ACP stdout close");
      roots.push(root);
      const command = portableNodeExecutable(root, "kimi");
      writeNodeSubcommand(root, "acp", process.platform === "win32" ? `
process.stdout.end("ready\\n", () => process.exit(0));
` : `
process.stdout.write("ready\\n", () => {
  ${CLOSE_NODE_STDOUT_TRANSPORT_SOURCE}
});
setInterval(() => {}, 1000);
`);
      const child = spawn(command, ["acp"], {
        cwd: root,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output: Buffer[] = [];
      let stdoutEnded = false;
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stdout.once("end", () => {
        stdoutEnded = true;
      });
      try {
        await waitFor("the fixture's inherited stdout pipe to close", () => stdoutEnded);
        expect(Buffer.concat(output).toString("utf8")).toBe("ready\n");
        if (process.platform === "win32") {
          await waitFor("the flushed Windows fixture to exit", () => child.exitCode !== null);
          expect(child.exitCode).toBe(0);
        } else {
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          expect(await terminateProcessTreeAndWait(child, true)).toBe(true);
        }
      }
    },
  );

  it("uses shell-free native ACP and rejects the incompatible legacy CLI path", () => {
    expect(kimiAcpProcessInvocation("/usr/local/bin/kimi", {}, "linux"))
      .toEqual({ command: "/usr/local/bin/kimi", args: ["acp"] });

    const input = nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-invocation",
      cwd: "/workspace/project",
      prompt: "Inspect the change",
      interactionMode: "plan",
      access: "full",
      model: "kimi-for-coding",
      sessionId: "kimi-session",
    });
    expect(() => buildProviderInvocation(input, "/usr/local/bin/kimi"))
      .toThrow("Kimi Code requires its native ACP harness");
  });

  it("recognizes only coherent Kimi question and plan-review envelopes as input", () => {
    const request = (
      title: string,
      options: PermissionOption[],
      kind: ToolKind | null | undefined = "other",
      question = "Which implementation?",
    ): Pick<RequestPermissionRequest, "options" | "toolCall"> => ({
      toolCall: {
        toolCallId: "tool",
        title,
        kind,
        content: [{
          type: "content",
          content: { type: "text", text: question },
        }],
      },
      options,
    });
    expect(kimiInputOptions(request("AskUserQuestion", [
      { optionId: "q0_opt_0", name: "Focused", kind: "allow_once" },
      { optionId: "q0_opt_1", name: "Broad", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ]))).toEqual({
      kind: "question",
      prompt: "Kimi Code is requesting permission through AskUserQuestion. Selecting an option authorizes this request.\n\nWhich implementation?\n\nOperation details:\nNo additional operation details were provided.",
      options: [
        { id: "q0_opt_0", label: "Focused" },
        { id: "q0_opt_1", label: "Broad" },
      ],
    });
    expect(kimiInputOptions(request("ExitPlanMode", [
      { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
      { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
      { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
    ]))).toMatchObject({ kind: "plan" });
    expect(kimiInputOptions(request("ExitPlanMode", [
      { optionId: "plan_opt_0", name: "Focused", kind: "allow_once" },
      { optionId: "plan_opt_1", name: "Broad", kind: "allow_once" },
      { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
      { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
    ]))).toMatchObject({ kind: "plan" });
    expect(kimiInputOptions(request("AskUserQuestion", [
      { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]))).toBeNull();
  });

  it("rejects adversarial Kimi input lookalikes before they reach the input UI", () => {
    const questionOptions = (): PermissionOption[] => [
      { optionId: "q0_opt_0", name: "Café", kind: "allow_once" },
      { optionId: "q0_opt_1", name: "Broad", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ];
    const request = (
      overrides: Partial<Pick<RequestPermissionRequest["toolCall"], "title" | "kind" | "content" | "rawInput">> = {},
      options = questionOptions(),
    ): Pick<RequestPermissionRequest, "options" | "toolCall"> => ({
      toolCall: {
        toolCallId: "tool",
        title: "AskUserQuestion",
        kind: "other",
        content: [{
          type: "content",
          content: { type: "text", text: "Choose safely" },
        }],
        ...overrides,
      },
      options,
    });

    for (const kind of [
      "read",
      "search",
      "fetch",
      "think",
      "switch_mode",
      "edit",
      "delete",
      "move",
      "execute",
    ] satisfies ToolKind[]) {
      expect(kimiInputOptions(request({ kind }))).toBeNull();
    }
    expect(kimiInputOptions(request({ title: "Write" }))).toBeNull();
    expect(kimiInputOptions(request({ title: "askuserquestion" }))).toBeNull();
    expect(kimiInputOptions(request({}, [
      ...questionOptions(),
      { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
    ]))).toBeNull();
    expect(kimiInputOptions(request({}, [
      { optionId: "q0_opt_0", name: "Focused", kind: "reject_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ]))).toBeNull();
    expect(kimiInputOptions(request({}, [
      { optionId: "q0_opt_0", name: "Focused", kind: "allow_once" },
      { optionId: "q1_opt_1", name: "Broad", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ]))).toBeNull();
    expect(kimiInputOptions(request({}, [
      { optionId: "q0_opt_0", name: "Café", kind: "allow_once" },
      { optionId: "q0_opt_1", name: "cafe\u0301", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ]))).toBeNull();
    expect(kimiInputOptions(request({}, [
      { optionId: "q0_opt_0", name: "Focused\u202Etxt.exe", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ]))).toBeNull();
    expect(kimiInputOptions(request({
      content: [{
        type: "content",
        content: { type: "text", text: "Choose\u2066 hidden operation" },
      }],
    }))).toBeNull();
    const coherentForgedEnvelope = kimiInputOptions(request({
      rawInput: { command: "hidden mutation" },
    }));
    expect(coherentForgedEnvelope?.prompt).toContain(
      "Selecting an option authorizes this request.",
    );
    expect(coherentForgedEnvelope?.prompt).toContain(
      'Operation details:\n{"command":"hidden mutation"}',
    );
    expect(kimiInputOptions(request({
      rawInput: { command: "hidden\u034Fmutation" },
    }))).toBeNull();

    const incompletePlan = request({ title: "ExitPlanMode" }, [
      { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
      { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
    ]);
    expect(kimiInputOptions(incompletePlan)).toBeNull();
    expect(kimiInputOptions(request({ title: "ExitPlanMode" }, [
      { optionId: "plan_opt_0", name: "Only approach", kind: "allow_once" },
      { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
      { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
    ]))).toBeNull();
    expect(kimiInputOptions(request({ title: "ExitPlanMode" }, [
      { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
      { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
      { optionId: "plan_reject_and_exit", name: "Exit", kind: "allow_once" },
    ]))).toBeNull();
  });

  it("maps negotiated text, thought, tools, plans, usage, metadata, and Kimi questions", async () => {
    const root = portableFixtureRoot("kimi ACP rich mapping");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "kimi");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const sessionId = "kimi-rich-session";
let promptId;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
const configOptions = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "kimi-model", options: [{ value: "kimi-model", name: "Kimi model", description: "Coding model" }, { value: "kimi-no-thinking", name: "Kimi no thinking", description: "Fast model" }] },
  { id: "effort", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
    authMethods: [{ id: "login", name: "Kimi login", description: "Use the current Kimi login" }],
    agentInfo: { name: "Kimi Code CLI", version: "test" },
  } });
  if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId,
    modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] },
    configOptions,
  } });
  if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "medium", status: "completed" }, { content: "Implement", priority: "high", status: "in_progress" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run checks", kind: "execute", status: "in_progress", rawInput: { command: "npm test" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: "green" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_summary_chunk", compactionId: "compact-1", content: { type: "text", text: "Retained summary, not assistant output" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed", summary: [{ type: "text", text: "Final retained summary" }] } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 125, size: 1000 } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Kimi response" } } } });
    return send({
      jsonrpc: "2.0",
      id: 101,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "ask-1", title: "AskUserQuestion", kind: "other", status: "pending", content: [{ type: "content", content: { type: "text", text: "Which implementation?" } }] },
        options: [
          { optionId: "q0_opt_0", name: "Focused", kind: "allow_once" },
          { optionId: "q0_opt_1", name: "Broad", kind: "allow_once" },
          { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
        ],
      },
    });
  }
  if (message.id === 101 && message.result) {
    return send({
      jsonrpc: "2.0",
      id: 102,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "write-1", title: "Write file", kind: "edit", status: "pending", rawInput: { path: "src/file.ts" } },
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  }
  if (message.id === 102 && message.result) {
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", usage: { totalTokens: 140, inputTokens: 100, outputTokens: 40, thoughtTokens: 10, cachedReadTokens: 5 } } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { kimi: command } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    const questions: string[] = [];
    const approvals: string[] = [];
    const plans: string[] = [];
    const thoughts: string[] = [];
    const usage: Array<number | null> = [];
    const metadata: Array<Array<{
      id: string;
      reasoningOptions?: Array<{ value: string }>;
      defaultReasoningEffort?: string;
    }>> = [];
    const activities: Array<{ activityId?: string; phase: string; detail?: string }> = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-rich",
      cwd: root,
      prompt: "Build this",
      interactionMode: "plan",
      access: "full",
      model: "kimi-model",
      reasoningEffort: "high",
    }), {
      onApproval: ({ request }) => approvals.push(request.title),
      onInput: (event) => {
        questions.push(event.request.questions[0]!.question);
        expect(event.request.questions[0]!.options.map(({ id }) => id))
          .toEqual(["q0_opt_0", "q0_opt_1"]);
        expect(manager.respondToInput(
          event.conversationId,
          event.request.requestId,
          { selection: ["q0_opt_0"] },
        )).toBe(true);
      },
      onPlan: ({ steps }) => plans.push(...steps.map(({ step }) => step)),
      onReasoning: ({ text }) => thoughts.push(text),
      onUsage: ({ usage: value }) => usage.push(value.usedTokens),
      onMetadata: ({ metadata: value }) => {
        metadata.push(value.models ?? []);
      },
      onActivity: (event) => activities.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "Kimi response",
      sessionId: "kimi-rich-session",
    });
    expect(questions).toEqual([
      "Kimi Code is requesting permission through AskUserQuestion. Selecting an option authorizes this request.\n\nWhich implementation?\n\nOperation details:\nNo additional operation details were provided.",
    ]);
    expect(approvals).toEqual([]);
    expect(plans).toEqual(["Inspect", "Implement"]);
    expect(thoughts).toEqual(["Inspecting"]);
    expect(usage).toEqual([125, 125]);
    expect(metadata.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "kimi-model",
        reasoningOptions: [expect.objectContaining({ value: "high" })],
        defaultReasoningEffort: "high",
      }),
      expect.objectContaining({
        id: "kimi-no-thinking",
        reasoningOptions: [],
        defaultReasoningEffort: "",
      }),
    ]));
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-1",
      phase: "completed",
      detail: "Command:\nnpm test\n\nOutput:\ngreen",
    }));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activityId: "kimi:compaction:compact-1",
        phase: "started",
        detail: "Status: in_progress",
      }),
      expect.objectContaining({
        activityId: "kimi:compaction:compact-1",
        phase: "completed",
        detail: "Status: completed",
      }),
    ]));
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: { outcome?: { outcome?: string; optionId?: string } };
    }>;
    expect(captured.find(({ method }) => method === "initialize"))
      .toMatchObject({
        params: {
          clientCapabilities: {
            plan: {},
            session: { compaction: {} },
          },
        },
      });
    expect(captured.find(({ id }) => id === 101)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "q0_opt_0" },
    });
    expect(captured.find(({ id }) => id === 102)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "approve_once" },
    });
    expect(captured.some(({ method }) => method === "authenticate")).toBe(true);
    expect(captured.some(({ method }) => method === "session/set_mode")).toBe(true);
  });

  it("prefers negotiated session/resume and rejects malformed frames", async () => {
    const resumeRoot = portableFixtureRoot("kimi ACP resume");
    roots.push(resumeRoot);
    const capturePath = join(resumeRoot, "capture.json");
    const resumeCommand = portableNodeExecutable(resumeRoot, "kimi");
    writeNodeSubcommand(resumeRoot, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); messages.push(message);
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/resume") return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "kimi-existing-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Continued" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { kimi: resumeCommand } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-resume",
      cwd: resumeRoot,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "kimi-existing-session",
    }))).resolves.toMatchObject({
      status: "completed",
      sessionId: "kimi-existing-session",
    });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      method?: string;
    }>;
    expect(captured.some(({ method }) => method === "session/resume")).toBe(true);
    expect(captured.some(({ method }) => method === "session/load")).toBe(false);
    expect(captured.some(({ method }) => method === "session/new")).toBe(false);

    const loadRoot = portableFixtureRoot("kimi ACP load replay");
    roots.push(loadRoot);
    const loadCommand = portableNodeExecutable(loadRoot, "kimi");
    writeNodeSubcommand(loadRoot, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "kimi-load-session";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old replayed transcript" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  }
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fresh continuation" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const loadManager = new ProviderManager(
      { commands: { kimi: loadCommand } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    await expect(loadManager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-load",
      cwd: loadRoot,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "kimi-load-session",
    }))).resolves.toMatchObject({
      status: "completed",
      text: "Fresh continuation",
    });

    const invalidRoot = portableFixtureRoot("kimi ACP invalid");
    roots.push(invalidRoot);
    const invalidCommand = portableNodeExecutable(invalidRoot, "kimi");
    writeNodeSubcommand(
      invalidRoot,
      "acp",
      `process.stdout.write("not-json\\n"); setInterval(() => {}, 1000);`,
    );
    const invalidManager = new ProviderManager(
      { commands: { kimi: invalidCommand } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    await expect(invalidManager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-invalid",
      cwd: invalidRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "malformed-protocol",
        phase: "initialize",
        terminalEvent: "transport/frame",
      },
    });
  });

  it("cancels pre-prompt permissions and projects only the active prompt", async () => {
    const root = portableFixtureRoot("kimi ACP prompt ownership");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "kimi");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const sessionId = "kimi-owned-session";
let initializeId;
let resumeId;
let promptId;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const malformedOptions = Array.from({ length: 21 }, (_, index) => ({
  optionId: "q0_opt_" + index,
  name: "Option " + index,
  kind: "allow_once",
}));
const permission = (id, title, options) => ({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params: {
    sessionId,
    toolCall: {
      toolCallId: "permission-" + id,
      title,
      kind: "edit",
      status: "pending",
      rawInput: { path: "src/owned.ts" },
    },
    options,
  },
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message); save();
  if (message.method === "initialize") {
    initializeId = message.id;
    return send(permission(81, "Initialize replay", malformedOptions));
  }
  if (message.id === 81) {
    return send({ jsonrpc: "2.0", id: initializeId, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      agentInfo: { name: "Kimi Code CLI", version: "test" },
    } });
  }
  if (message.method === "session/resume") {
    resumeId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Replayed transcript" } },
    } });
    return send(permission(82, "Resume replay", malformedOptions));
  }
  if (message.id === 82) {
    return send({ jsonrpc: "2.0", id: resumeId, result: {
      modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
      configOptions: [],
    } });
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    return send(permission(83, "Live write", [
      { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]));
  }
  if (message.id === 83) {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fresh answer" } },
    } });
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { kimi: command } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    const approvals: string[] = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-prompt-ownership",
      cwd: root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
      sessionId: "kimi-owned-session",
    }), {
      onApproval: (event) => {
        approvals.push(event.request.title);
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
        )).toBe(true);
      },
    })).resolves.toMatchObject({
      status: "completed",
      sessionId: "kimi-owned-session",
      text: "Fresh answer",
    });
    expect(approvals).toEqual(["Live write"]);
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      id?: number;
      result?: { outcome?: { outcome?: string; optionId?: string } };
    }>;
    expect(captured.find(({ id }) => id === 81)?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(captured.find(({ id }) => id === 82)?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(captured.find(({ id }) => id === 83)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "approve_once" },
    });
  });

  it("forwards a bounded compaction focus through the advertised slash command", async () => {
    const root = portableFixtureRoot("kimi ACP compaction");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "kimi");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "kimi-compact-session";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/resume") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact context", input: { hint: "focus" } }] } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  }
  if (message.method === "session/prompt") {
    fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(message.params.prompt));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "explicit-compact", status: "in_progress" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_summary_chunk", compactionId: "explicit-compact", content: { type: "text", text: "Retained context" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "explicit-compact", status: "completed", summary: [{ type: "text", text: "Retained context" }] } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { kimi: command } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    await expect(manager.compact(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "full",
      sessionId: "kimi-compact-session",
    }), "  preserve exact retrieval facts  ")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: true,
      message: "Context compacted with the focus instruction.",
    });
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
      { type: "text", text: "/compact preserve exact retrieval facts" },
    ]);
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
      const root = portableFixtureRoot(`kimi ACP compact ${fixture.name}`);
      roots.push(root);
      const command = portableNodeExecutable(root, "kimi");
      writeNodeSubcommand(root, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "kimi-compact-session";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/resume") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact context" }] } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  }
  if (message.method === "session/prompt") {
    for (const update of ${JSON.stringify(fixture.updates)}) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    }
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
      const manager = new ProviderManager(
        { commands: { kimi: command } },
        new AgentHarnessRegistry([createKimiAcpHarness()]),
      );
      const result = await manager.compact(nativeProviderRunInput({
        providerId: "kimi",
        conversationId: `kimi-compact-${fixture.name}`,
        cwd: root,
        prompt: "/compact",
        interactionMode: "build",
        access: "supervised",
        sessionId: "kimi-compact-session",
      }));
      expect(result.status, fixture.name).toBe(fixture.status);
      if (fixture.status === "failed") {
        expect(result.message).toContain("did not confirm");
      }
    }
  });

  it("classifies authentication and authoritative prompt stop failures", async () => {
    const authRoot = portableFixtureRoot("kimi ACP auth failure");
    roots.push(authRoot);
    const authCommand = portableNodeExecutable(authRoot, "kimi");
    writeNodeSubcommand(authRoot, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [{ id: "login", name: "Kimi login", description: "Login" }],
    agentInfo: { name: "Kimi Code CLI", version: "test" },
  } });
  if (message.method === "authenticate") return send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32000, message: "AUTH_REQUIRED: login first" },
  });
});
`);
    const authManager = new ProviderManager(
      { commands: { kimi: authCommand } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    await expect(authManager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-auth-failure",
      cwd: authRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Kimi Code is not authenticated. Run 'kimi login' and try again.",
      failure: {
        reason: "provider-error",
        message: "Kimi Code is not authenticated. Run 'kimi login' and try again.",
        phase: "auth",
        terminalEvent: "authenticate",
      },
    });

    const stopRoot = portableFixtureRoot("kimi ACP stop reason");
    roots.push(stopRoot);
    const stopCommand = portableNodeExecutable(stopRoot, "kimi");
    writeNodeSubcommand(stopRoot, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "Kimi Code CLI", version: "test" },
  } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "kimi-stop-session",
    modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
    configOptions: [],
  } });
  if (message.method === "session/prompt") return send({
    jsonrpc: "2.0",
    id: message.id,
    result: { stopReason: "max_tokens" },
  });
});
`);
    const stopManager = new ProviderManager(
      { commands: { kimi: stopCommand } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    await expect(stopManager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-stop-reason",
      cwd: stopRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "provider-error",
        message: "Kimi Code stopped with reason: max_tokens.",
        technicalDetail: "Stop reason: max_tokens",
        phase: "turn",
        terminalEvent: "session/prompt:max_tokens",
      },
    });
  });

  it("fails closed on terminal authentication without invoking authenticate", async () => {
    const root = portableFixtureRoot("kimi ACP terminal auth");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "kimi");
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
    authMethods: [{ type: "terminal", id: "login", name: "Kimi login", args: ["login"] }],
    agentInfo: { name: "Kimi Code CLI", version: "test" },
  } });
});
setInterval(() => {}, 1000);
`);
    const manager = new ProviderManager(
      { commands: { kimi: command } },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );

    const terminalResult = await manager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-terminal-auth",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(terminalResult).toMatchObject({
      status: "failed",
      error: "Kimi ACP advertised unsupported terminal authentication.",
      failure: { phase: "initialize", terminalEvent: "initialize" },
    });
    const messages = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      method?: string;
    }>;
    expect(messages.some(({ method }) => method === "authenticate")).toBe(false);
  });

  it("classifies bounded protocol, transport, process, and cleanup failures", async () => {
    const runFailure = async (
      name: string,
      source: string,
      harness = createKimiAcpHarness(),
    ) => {
      const root = portableFixtureRoot(name);
      roots.push(root);
      const command = portableNodeExecutable(root, "kimi");
      writeNodeSubcommand(root, "acp", source);
      const manager = new ProviderManager(
        { commands: { kimi: command } },
        new AgentHarnessRegistry([harness]),
      );
      const activities: Array<{ activityId?: string }> = [];
      const result = await manager.run(nativeProviderRunInput({
        providerId: "kimi",
        conversationId: name.replaceAll(" ", "-"),
        cwd: root,
        prompt: "Start",
        interactionMode: "build",
        access: "supervised",
      }), {
        onActivity: (event) => activities.push(event),
      });
      return { activities, manager, result };
    };

    const overflow = await runFailure(
      "kimi ACP overflow",
      `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`,
    );
    expect(overflow.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "protocol-overflow",
        terminalEvent: "transport/frame",
      },
    });

    const malformedEnvelope = await runFailure(
      "kimi ACP malformed envelope",
      `process.stdout.write("{}\\n"); setInterval(() => {}, 1000);`,
    );
    expect(malformedEnvelope.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "malformed-protocol",
        terminalEvent: "transport/frame",
      },
    });

    const mixedEnvelope = await runFailure(
      "kimi ACP mixed request response envelope",
      `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "unknown", result: {} }) + "\\n"); setInterval(() => {}, 1000);`,
    );
    expect(mixedEnvelope.result).toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", terminalEvent: "transport/frame" },
    });

    const malformedSessionUpdate = await runFailure(
      "kimi ACP malformed session update",
      `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-malformed-update", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {} });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`,
    );
    expect(malformedSessionUpdate.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "malformed-protocol",
        phase: "turn",
        terminalEvent: "transport/frame",
      },
    });

    const sessionUpdateRequest = await runFailure(
      "kimi ACP session update request",
      `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-update-request", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: 77, method: "session/update", params: { sessionId: "kimi-update-request", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Must not complete" } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`,
    );
    expect(sessionUpdateRequest.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "malformed-protocol",
        phase: "turn",
        terminalEvent: "transport/frame",
      },
    });

    const invalidUtf8 = await runFailure("kimi ACP invalid UTF-8", `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":' + message.id + ',"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"Kimi '),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('","version":"test"}}}\\n'),
  ]));
});
setInterval(() => {}, 1000);
`);
    expect(invalidUtf8.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "malformed-protocol",
        phase: "initialize",
        terminalEvent: "transport/frame",
      },
    });

    const oversizedTail = await runFailure("kimi ACP oversized tail", `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
  const message = JSON.parse(line);
  const initialized = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  process.stdout.write(initialized + "\\n" + "x".repeat(1024 * 1024 + 1));
});
setInterval(() => {}, 1000);
`);
    expect(oversizedTail.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "protocol-overflow",
        terminalEvent: "transport/frame",
      },
    });

    const deadline = await runFailure(
      "kimi ACP control deadline",
      `process.stdin.resume(); setInterval(() => {}, 1000);`,
      createKimiAcpHarness({ controlRpcTimeoutMs: 25 }),
    );
    expect(deadline.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "rpc-timeout",
        phase: "initialize",
        terminalEvent: "initialize",
      },
    });

    const configRoot = portableFixtureRoot("kimi ACP config deadline");
    roots.push(configRoot);
    const configCommand = portableNodeExecutable(configRoot, "kimi");
    writeNodeSubcommand(configRoot, "acp", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "config-timeout", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "model-a", options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] }] } });
});
`);
    const configManager = new ProviderManager(
      { commands: { kimi: configCommand } },
      new AgentHarnessRegistry([
        createKimiAcpHarness({ controlRpcTimeoutMs: 5_000 }),
      ]),
    );
    await expect(configManager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-config-deadline",
      cwd: configRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
      model: "model-b",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "rpc-timeout",
        phase: "configuration",
        terminalEvent: "session/configuration",
      },
    });

    const emptyEndTurn = await runFailure("kimi ACP empty end turn", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "empty", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "empty", update: { sessionUpdate: "compaction_update", compactionId: "ordinary-compact", status: "completed", _meta: { source: "terminal-first" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "empty", update: { sessionUpdate: "compaction_update", compactionId: "ordinary-compact", status: "completed", summary: [{ type: "text", text: "Late retained context" }], _meta: null } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
    expect(emptyEndTurn.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "provider-error",
        phase: "turn",
        terminalEvent: "session/prompt:empty-end-turn",
      },
    });
    expect(emptyEndTurn.activities.filter(({ activityId }) =>
      activityId === "kimi:compaction:ordinary-compact")).toHaveLength(1);

    const incompleteCompactionCases = [
      {
        name: "in progress",
        updates: `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" } } });`,
      },
      {
        name: "failed",
        updates: `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" } } });
send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "failed", error: "limit changed" } } });`,
      },
      {
        name: "cancelled",
        updates: `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" } } });
send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "cancelled" } } });`,
      },
      {
        name: "summary chunk",
        updates: `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" } } });
send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "compaction_summary_chunk", compactionId: "compact-1", content: { type: "text", text: "Retained context" } } } });`,
      },
    ];
    for (const compactionCase of incompleteCompactionCases) {
      const result = await runFailure(`kimi ACP ${compactionCase.name} evidence`, `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "empty-compaction";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    ${compactionCase.updates}
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`);
      expect(result.result).toMatchObject({
        status: "failed",
        failure: { terminalEvent: "session/prompt:empty-end-turn" },
      });
    }

    const toolOverflow = await runFailure("kimi ACP tool state overflow", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sessionId = "tool-overflow";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") {
    for (let index = 0; index < 1025; index += 1) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-" + index, title: "tool", status: "in_progress", rawInput: { command: "x".repeat(10000) } } } });
  }
});
`);
    expect(toolOverflow.result).toMatchObject({
      status: "failed",
      failure: {
        reason: "protocol-overflow",
        terminalEvent: "transport/frame",
      },
    });

    const transport = await runFailure("kimi ACP transport", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "Kimi Code CLI", version: "test" },
  } });
  if (message.method === "session/new") {
    ${process.platform === "win32"
      ? "process.stdout.end(() => process.exit(0));"
      : `${CLOSE_NODE_STDOUT_TRANSPORT_SOURCE}\n    setInterval(() => {}, 1000);`}
  }
});
`);
    expect(transport.result).toMatchObject({
      status: "failed",
      failure: {
        reason: process.platform === "win32" ? "process-exit" : "transport-closed",
        terminalEvent: process.platform === "win32" ? "process/exit" : "transport/closed",
      },
    });

    const processExit = await runFailure(
      "kimi ACP process exit",
      `process.exit(7);`,
    );
    expect(processExit.result).toMatchObject({
      status: "failed",
      exitCode: 7,
      failure: {
        reason: "process-exit",
        terminalEvent: "process/exit",
      },
    });

    const cleanupSource = `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "Kimi Code CLI", version: "test" },
  } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
    sessionId: "kimi-cleanup-session",
    modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
    configOptions: [],
  } });
  if (message.method === "session/prompt") return send({
    jsonrpc: "2.0",
    id: message.id,
    result: { stopReason: "end_turn" },
  });
});
`;
    const cleanup = await runFailure(
      "kimi ACP cleanup",
      cleanupSource,
      createKimiAcpHarness({
        terminateProcessTree: async (child, force) => {
          await terminateProcessTreeAndWait(child, force);
          return false;
        },
      }),
    );
    expect(cleanup.result).toMatchObject({
      status: "failed",
      cleanupConfirmed: false,
      failure: {
        reason: "process-exit",
        phase: "cleanup",
        terminalEvent: "process/cleanup",
      },
    });
    await cleanup.manager.disposeAll().catch(() => undefined);
  }, 90_000);

  it("cancels the native session and confirms descendant cleanup", async () => {
    const root = portableFixtureRoot("kimi ACP cancellation");
    roots.push(root);
    const registryRoot = join(root, "runtime-owned");
    mkdirSync(registryRoot, { recursive: true });
    chmodSync(registryRoot, 0o700);
    const runtimeGenerationId = "61000000-0000-4000-8000-000000000061:1";
    const deactivate = activateRuntimeOwnedProcessRegistry(
      registryRoot,
      runtimeGenerationId,
      "test:61000000-0000-4000-8000-000000000061",
      process.platform === "darwin" || process.platform === "linux"
        ? {
            darwinGuardianPath: join(
              process.cwd(),
              "resources/generated/runtime-process-guardian/runtime-process-guardian",
            ),
          }
        : {},
    );
    if (deactivate) registryDeactivators.push(deactivate);
    const journal = new RuntimeOwnedProcessJournal(registryRoot);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "kimi");
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
  const message = JSON.parse(line); messages.push(message); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Kimi Code CLI", version: "test" } } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "kimi-cancel-session", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") { promptId = message.id; return; }
  if (message.method === "session/cancel") return send({
    jsonrpc: "2.0",
    id: 201,
    method: "session/request_permission",
    params: {
      sessionId: "kimi-cancel-session",
      toolCall: { toolCallId: "late-write", title: "Late write", kind: "edit", status: "pending" },
      options: [{ optionId: "approve_once", name: "Approve once", kind: "allow_once" }],
    },
  });
  if (message.id === 201) {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "kimi-cancel-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Late output" } },
    } });
    return send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
  }
});
`);
    const manager = new ProviderManager(
      { commands: { kimi: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-cancel",
      runId: "run-kimi-cancel",
      turnId: "turn-kimi-cancel",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }), {
      hostTools,
      onStatus: ({ status }) => { if (status === "running") markRunning(); },
    });
    await running;
    if (deactivate) {
      expect(journal.records(runtimeGenerationId)).toMatchObject([{
        state: "owned",
        process: {
          processGroupId: process.platform === "win32"
            ? null
            : expect.any(Number),
        },
      }]);
    }
    await waitFor("Kimi fixture capture", () => {
      try {
        return Boolean(JSON.parse(readFileSync(capturePath, "utf8")).port);
      } catch {
        return false;
      }
    });
    expect(manager.cancel("kimi-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({
      status: "cancelled",
      text: "",
    });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
      messages: Array<{
        id?: number;
        method?: string;
        params?: {
          mcpServers?: Array<{
            url?: string;
            env?: Array<{ name: string; value: string }>;
          }>;
        };
        result?: { outcome?: { outcome?: string } };
      }>;
    };
    expect(captured.messages.some(({ method }) => method === "session/cancel"))
      .toBe(true);
    expect(captured.messages.find(({ id }) => id === 201)?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    const mcpServer = captured.messages.find(
      ({ method }) => method === "session/new",
    )?.params?.mcpServers?.[0];
    const mcpUrl = mcpServer?.url ?? mcpServer?.env?.find(
      ({ name }) => name === "INERTIA_HOST_MCP_URL",
    )?.value;
    expect(mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    expect(await loopbackPortIsOpen(Number(new URL(mcpUrl!).port))).toBe(false);
    await waitFor(
      "the Kimi child socket to close",
      async () => !(await loopbackPortIsOpen(captured.port)),
    );
    if (deactivate) {
      await waitFor(
        "the Kimi runtime-owned process claim to retire",
        () => journal.records(runtimeGenerationId)?.length === 0,
      );
    }
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("does not start a prompt after cancellation during session resume", async () => {
    const root = portableFixtureRoot("kimi ACP pre-prompt cancellation");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "kimi");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
let resumeId;
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(messages));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message); save();
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { resume: {} } },
    agentInfo: { name: "Kimi Code CLI", version: "test" },
  } });
  if (message.method === "session/resume") {
    resumeId = message.id;
    return;
  }
  if (message.method === "session/cancel") return send({ jsonrpc: "2.0", id: resumeId, result: {
    modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
    configOptions: [],
  } });
  if (message.method === "session/prompt") return send({
    jsonrpc: "2.0",
    id: message.id,
    result: { stopReason: "cancelled" },
  });
});
setInterval(() => {}, 1000);
`);
    const manager = new ProviderManager(
      { commands: { kimi: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createKimiAcpHarness()]),
    );
    const result = manager.run(nativeProviderRunInput({
      providerId: "kimi",
      conversationId: "kimi-pre-prompt-cancel",
      cwd: root,
      prompt: "Do not start",
      interactionMode: "build",
      access: "supervised",
      sessionId: "kimi-pre-prompt-session",
    }));
    await waitFor("Kimi resume request", () => {
      try {
        const messages = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
          method?: string;
        }>;
        return messages.some(({ method }) => method === "session/resume");
      } catch {
        return false;
      }
    });

    expect(manager.cancel("kimi-pre-prompt-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as Array<{
      method?: string;
    }>;
    expect(captured.some(({ method }) => method === "session/cancel")).toBe(true);
    expect(captured.some(({ method }) => method === "session/prompt")).toBe(false);
  });
});
