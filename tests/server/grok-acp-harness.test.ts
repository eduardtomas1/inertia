// @inertia-test-suite portable
// @inertia-harness grok-acp
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry as activateRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import { providerChildEnvironment } from "../../src/server/environment";
import { providerAuthLaunchEnvironment } from "../../src/server/provider/auth";
import { selectGrokAcpAuthMethod } from "../../src/server/provider/grok-acp-auth";
import {
  createGrokAcpHarness,
  grokAcpLaunchArguments,
  grokAcpProcessInvocation,
} from "../../src/server/provider/grok-acp-harness";
import { BoundedGrokJsonLineTransform } from "../../src/server/provider/grok-acp-support";
import { ProviderRunEventBudget } from "../../src/server/provider/io";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { GROK_EXPLICIT_COMPACTION_UNAVAILABLE_REASON } from "../../src/shared/provider";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeFlagExecutable,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const CLOSE_NODE_STDOUT_TRANSPORT_SOURCE = `
const stdoutFd = process.stdout.fd;
const realStdoutDestroy = Object.getPrototypeOf(process.stdout)._destroy;
if (typeof realStdoutDestroy !== "function") throw new Error("Node stdout is not a pipe-backed Socket.");
process.stdout._destroy = realStdoutDestroy;
process.stdout.destroy();
require("node:fs").closeSync(stdoutFd);
`;

async function collectFrames(chunks: readonly Buffer[]): Promise<string> {
  const output: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    new BoundedGrokJsonLineTransform(
      4 * 1024,
      new ProviderRunEventBudget("Grok ACP", 4 * 1024, 16, 16 * 1024),
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

function grokAgent(capturePath: string | null, body: string): string {
  const save = capturePath
    ? `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ messages, observed }));`
    : "";
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const observed = {
  autoupdater: process.env.GROK_DISABLE_AUTOUPDATER ?? null,
  random: Object.prototype.hasOwnProperty.call(process.env, "RANDOM_SECRET"),
  argv: process.argv.slice(2),
};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
${save}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  ${save}
  ${body}
});
`;
}

function initResult(capabilities: string, methods: string): string {
  return `{
    protocolVersion: 1,
    agentCapabilities: ${capabilities},
    authMethods: ${methods},
    agentInfo: { name: "Grok", version: "1.0.70" },
  }`;
}

describe("bounded Grok ACP framing", () => {
  it("decodes a valid multibyte frame split into one-byte chunks", async () => {
    const frame = Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { message: "Grok" },
    })}\n`);
    await expect(collectFrames([...frame].map((byte) => Buffer.of(byte))))
      .resolves.toBe(frame.toString("utf8"));
  });

  it("rejects malformed UTF-8 instead of normalizing replacement characters", async () => {
    const frame = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n'),
    ]);
    await expect(collectFrames([frame])).rejects.toThrow(/not valid.*utf-?8/iu);
  });
});

describe("Grok ACP harness", { concurrent: false }, () => {
  const roots: string[] = [];
  const registryDeactivators: Array<() => void> = [];
  const envKeys = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_DISABLE_AUTOUPDATER", "RANDOM_SECRET"] as const;
  const savedEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    while (registryDeactivators.length > 0) registryDeactivators.pop()?.();
    for (const key of envKeys) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    savedEnv.clear();
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function rememberEnv(): void {
    for (const key of envKeys) {
      if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    }
  }

  function managerFor(root: string, command: string, harness = createGrokAcpHarness()) {
    return ProviderManager.createForTests(
      { commands: { grok: command } },
      new AgentHarnessRegistry([harness]),
    );
  }

  it("resolves the grok executable without a shell", () => {
    const args = ["--permission-mode", "default", "agent", "stdio"];
    expect(grokAcpProcessInvocation("/usr/local/bin/grok", {}, args, "linux")).toEqual({
      command: "/usr/local/bin/grok",
      args,
    });
    const windows = grokAcpProcessInvocation(
      "C:\\Tools\\grok.cmd",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      args,
      "win32",
    );
    expect(windows.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windows.windowsVerbatimArguments).toBe(true);
    expect(windows.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(windows.args[4]).toContain("grok.cmd");
    for (const arg of args) expect(windows.args[4]).toContain(arg);
    expect(grokAcpProcessInvocation("C:\\Tools\\grok.exe", {}, args, "win32")).toEqual({
      command: "C:\\Tools\\grok.exe",
      args,
    });
  });

  it("puts the permission mode on the command line because Grok has no ACP modes", () => {
    expect(grokAcpLaunchArguments({ interactionMode: "build", access: "supervised" }))
      .toEqual(["--permission-mode", "default", "agent", "stdio"]);
    expect(grokAcpLaunchArguments({ interactionMode: "build", access: "auto-edit" }))
      .toEqual(["--permission-mode", "default", "agent", "stdio"]);
    expect(grokAcpLaunchArguments({ interactionMode: "build", access: "full" }))
      .toEqual(["agent", "--always-approve", "stdio"]);
    expect(grokAcpLaunchArguments({ interactionMode: "build", access: "full", readOnlyProfile: "watcher" }))
      .toEqual(["--permission-mode", "default", "agent", "stdio"]);
    expect(grokAcpLaunchArguments({ interactionMode: "plan", access: "full" }))
      .toEqual(["--permission-mode", "plan", "agent", "stdio"]);
  });

  it("keeps Grok credentials and disables the autoupdater without forwarding Inertia secrets", () => {
    const child = providerChildEnvironment("grok", {
      PATH: "C:\\Windows",
      XAI_API_KEY: "secret-xai",
      GROK_CODE_XAI_API_KEY: "secret-grok",
      GROK_HOME: "C:\\grok-home",
      GROK_DISABLE_AUTOUPDATER: "0",
      RANDOM_SECRET: "nope",
    });
    expect(child.GROK_DISABLE_AUTOUPDATER).toBe("1");
    expect(child.XAI_API_KEY).toBe("secret-xai");
    expect(child.GROK_CODE_XAI_API_KEY).toBe("secret-grok");
    expect(child.GROK_HOME).toBe("C:\\grok-home");
    expect(child.RANDOM_SECRET).toBeUndefined();
    expect(providerAuthLaunchEnvironment("grok", { GROK_DISABLE_AUTOUPDATER: "0", TERM: "xterm" }))
      .toMatchObject({ GROK_DISABLE_AUTOUPDATER: "1", TERM: "xterm" });
  });

  it("uses the saved Grok login unless only an API key can authenticate", () => {
    expect(selectGrokAcpAuthMethod(
      [{ id: "xai.api_key" }, { id: "cached_token" }, { id: 4 }, {}],
      { XAI_API_KEY: "present" },
    )).toBe("cached_token");
    expect(selectGrokAcpAuthMethod(
      [{ id: "xai.api_key" }],
      { GROK_CODE_XAI_API_KEY: " present " },
    )).toBe("xai.api_key");
    expect(selectGrokAcpAuthMethod([{ id: "grok.com" }], { XAI_API_KEY: "present" })).toBe("xai.api_key");
    expect(selectGrokAcpAuthMethod([{ id: "xai.api_key" }], {})).toBe("cached_token");
    expect(selectGrokAcpAuthMethod([{ id: "grok.com" }], {})).toBe("cached_token");
    expect(selectGrokAcpAuthMethod(undefined, {})).toBe("cached_token");
  });

  it("authenticates with cached_token before an advertised API key", async () => {
    rememberEnv();
    process.env.XAI_API_KEY = "test-xai-key";
    const root = portableFixtureRoot("grok ACP cached auth");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "xai.api_key" }, { id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-auth",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [],
      } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-auth", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ready" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-cached-auth",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(result).toMatchObject({ status: "completed", text: "Ready" });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      observed: { autoupdater: string | null; random: boolean };
      messages: Array<{ method?: string; params?: { methodId?: string; _meta?: { headless?: boolean } } }>;
    };
    expect(captured.messages.find(({ method }) => method === "authenticate")?.params).toEqual({
      methodId: "cached_token",
      _meta: { headless: true },
    });
    expect(captured.observed.autoupdater).toBe("1");
  });

  it("uses xai.api_key when that is the only advertised method and a key is present", async () => {
    rememberEnv();
    delete process.env.XAI_API_KEY;
    process.env.GROK_CODE_XAI_API_KEY = "test-grok-key";
    const root = portableFixtureRoot("grok ACP api key auth");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "xai.api_key" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-api-auth",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [],
      } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-api-auth", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Keyed" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-api-auth",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(result).toMatchObject({ status: "completed", text: "Keyed" });
    const capturedText = readFileSync(capturePath, "utf8");
    expect(capturedText).not.toContain("test-grok-key");
    const captured = JSON.parse(capturedText) as {
      messages: Array<{ method?: string; params?: { methodId?: string; _meta?: { headless?: boolean } } }>;
    };
    expect(captured.messages.find(({ method }) => method === "authenticate")?.params).toEqual({
      methodId: "xai.api_key",
      _meta: { headless: true },
    });
  });

  it("reports a refused saved login as an authentication failure before any session starts", async () => {
    const root = portableFixtureRoot("grok ACP unauthenticated");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "grok.com" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "No cached credentials" } });
    `));
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-unauthenticated",
      cwd: root,
      prompt: "Hello",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(result).toMatchObject({
      status: "failed",
      error: "Grok is not authenticated. Connect Grok in provider settings, then try again.",
      failure: { reason: "provider-error", phase: "auth" },
    });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      messages: Array<{ method?: string; params?: { methodId?: string } }>;
    };
    expect(captured.messages.find(({ method }) => method === "authenticate")?.params?.methodId)
      .toBe("cached_token");
    expect(captured.messages.some(({ method }) => method === "session/new")).toBe(false);
  });

  it("launches each turn with the permission mode for its access and sends no session overrides", async () => {
    const source = (capturePath: string) => grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-access", configOptions: [] } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-access", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    const cases = [
      ["supervised", ["--permission-mode", "default", "agent", "stdio"]],
      ["auto-edit", ["--permission-mode", "default", "agent", "stdio"]],
      ["full", ["agent", "--always-approve", "stdio"]],
    ] as const;
    for (const [access, argv] of cases) {
      const root = portableFixtureRoot(`grok ACP ${access}`);
      roots.push(root);
      const capturePath = join(root, "capture.json");
      const command = writeNodeFlagExecutable(root, "grok", source(capturePath));
      const result = await managerFor(root, command).run(nativeProviderRunInput({
        providerId: "grok",
        conversationId: `grok-${access}`,
        cwd: root,
        prompt: "Hello",
        interactionMode: "build",
        access,
      }));
      expect(result.status).toBe("completed");
      const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
        observed: { argv: string[] };
        messages: Array<{ method?: string; params?: Record<string, unknown> }>;
      };
      expect(captured.observed.argv).toEqual(argv);
      expect(captured.messages.find(({ method }) => method === "session/new")?.params)
        .not.toHaveProperty("_meta");
      expect(captured.messages.some(({ method }) => method === "session/set_mode")).toBe(false);
    }
  });

  it("resumes a saved session without replaying it, and loads it only when resume is missing", async () => {
    const source = (capturePath: string, capabilities: string) => grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult(capabilities, `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/resume" || message.method === "session/load") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "saved-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old answer" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
      }
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "saved-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Resumed" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    const cases = [
      ["{ loadSession: true, sessionCapabilities: { resume: {} } }", "session/resume"],
      ["{ loadSession: true }", "session/load"],
    ] as const;
    for (const [capabilities, restoreMethod] of cases) {
      const root = portableFixtureRoot(`grok ACP ${restoreMethod.replace("/", " ")}`);
      roots.push(root);
      const capturePath = join(root, "capture.json");
      const command = writeNodeFlagExecutable(root, "grok", source(capturePath, capabilities));
      const result = await managerFor(root, command).run(nativeProviderRunInput({
        providerId: "grok",
        conversationId: `grok-${restoreMethod.replace("/", "-")}`,
        cwd: root,
        prompt: "Continue",
        interactionMode: "build",
        access: "full",
        sessionId: "saved-session",
      }));
      expect(result).toMatchObject({ status: "completed", sessionId: "saved-session", text: "Resumed" });
      const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
        messages: Array<{ method?: string; params?: Record<string, unknown> }>;
      };
      const methods = captured.messages.map(({ method }) => method);
      expect(methods).toContain(restoreMethod);
      expect(methods).not.toContain(restoreMethod === "session/resume" ? "session/load" : "session/resume");
      expect(methods).not.toContain("session/new");
      expect(captured.messages.find(({ method }) => method === restoreMethod)?.params)
        .toEqual({ sessionId: "saved-session", cwd: root, mcpServers: [] });
    }
  });

  it("launches plan turns in Grok's plan mode and hands the proposed plan to the user", async () => {
    const root = portableFixtureRoot("grok ACP plan");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-plan", configOptions: [] } });
      if (message.method === "session/prompt") {
        globalThis.promptId = message.id;
        return send({ jsonrpc: "2.0", id: 900, method: "_x.ai/exit_plan_mode", params: {
          sessionId: "grok-plan",
          toolCallId: "call-exit-plan",
          planContent: "# Add a README\\n\\n1. Create README.md\\n2. Describe the folder",
        } });
      }
      if (message.id === 900 && !message.method) {
        return send({ jsonrpc: "2.0", id: globalThis.promptId, result: { stopReason: "end_turn" } });
      }
    `));
    const plans: Array<{ explanation: string | null; steps: Array<{ step: string }>; handoff?: true }> = [];
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-plan",
      cwd: root,
      prompt: "Plan a README",
      interactionMode: "plan",
      access: "full",
    }), { onPlan: (event) => plans.push(event) });
    expect(result.status).toBe("completed");
    expect(plans).toEqual([{
      explanation: "# Add a README\n\n1. Create README.md\n2. Describe the folder",
      steps: [
        { step: "Create README.md", status: "pending" },
        { step: "Describe the folder", status: "pending" },
      ],
      handoff: true,
    }].map((plan) => expect.objectContaining(plan)));
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      observed: { argv: string[] };
      messages: Array<{ id?: number; method?: string; result?: { outcome?: string } }>;
    };
    expect(captured.observed.argv).toEqual(["--permission-mode", "plan", "agent", "stdio"]);
    expect(captured.messages.find(({ id, method }) => id === 900 && !method)?.result?.outcome)
      .toBe("abandoned");
    expect(captured.messages.some(({ method }) => method === "session/set_mode")).toBe(false);
  });

  it("asks Grok's questions in Inertia and returns the chosen labels and free-text notes", async () => {
    const root = portableFixtureRoot("grok ACP questions");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-questions", configOptions: [] } });
      if (message.method === "session/prompt") {
        globalThis.promptId = message.id;
        send({ jsonrpc: "2.0", id: 800, method: "_x.ai/ask_user_question", params: { sessionId: "grok-questions", toolCallId: "call-bad", questions: [], mode: "default" } });
        return send({ jsonrpc: "2.0", id: 801, method: "_x.ai/ask_user_question", params: {
          sessionId: "grok-questions",
          toolCallId: "call-ask",
          mode: "default",
          questions: [
            { question: "Tabs or spaces?", options: [{ label: "Tabs", description: "Indent with tabs." }, { label: "Spaces" }], multiSelect: null },
            { question: "Indent width?", options: [{ label: "Two" }, { label: "Four" }], multiSelect: false },
          ],
        } });
      }
      if (message.id === 801 && !message.method) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-questions", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Noted" } } } });
        return send({ jsonrpc: "2.0", id: globalThis.promptId, result: { stopReason: "end_turn" } });
      }
    `));
    const manager = managerFor(root, command);
    const asked: Array<{ questions: Array<{ id: string; question: string; isOther: boolean; options: Array<{ id: string; label: string; description: string }> }> }> = [];
    const result = await manager.run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-questions",
      cwd: root,
      prompt: "Ask me",
      interactionMode: "build",
      access: "supervised",
    }), {
      onInput: ({ request }) => {
        asked.push(request);
        manager.respondToInput("grok-questions", request.requestId, {
          "question-1": ["option-2"],
          "question-2": ["Three, please"],
        }, { runId: "run-grok-questions", turnId: "turn-grok-questions" });
      },
    });
    expect(result).toMatchObject({ status: "completed", text: "Noted" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.questions.map(({ id, question, isOther, options }) => ({ id, question, isOther, options })))
      .toEqual([
        {
          id: "question-1",
          question: "Tabs or spaces?",
          isOther: true,
          options: [
            { id: "option-1", label: "Tabs", description: "Indent with tabs." },
            { id: "option-2", label: "Spaces", description: "" },
          ],
        },
        {
          id: "question-2",
          question: "Indent width?",
          isOther: true,
          options: [
            { id: "option-1", label: "Two", description: "" },
            { id: "option-2", label: "Four", description: "" },
          ],
        },
      ]);
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      messages: Array<{ id?: number; method?: string; result?: unknown; error?: unknown }>;
    };
    expect(captured.messages.find(({ id, method }) => id === 800 && !method)?.error).toBeDefined();
    expect(captured.messages.find(({ id, method }) => id === 801 && !method)?.result).toEqual({
      outcome: "accepted",
      answers: { "Tabs or spaces?": ["Spaces"], "Indent width?": ["Other"] },
      annotations: { "Indent width?": { notes: "Three, please" } },
    });
  });

  it("starts a new answer segment when Grok writes again after a tool call", async () => {
    const root = portableFixtureRoot("grok ACP segments");
    roots.push(root);
    const chunk = (text: string) => `send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-segments", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(text)} } } } });`;
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-segments", configOptions: [] } });
      if (message.method === "session/prompt") {
        ${chunk("Checking")}
        ${chunk(" now.")}
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-segments", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "List files", kind: "read", status: "completed" } } });
        ${chunk("Done.")}
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const events: string[] = [];
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-segments",
      cwd: root,
      prompt: "Check",
      interactionMode: "build",
      access: "supervised",
    }), {
      onEvent: (event) => {
        if (event.type === "text") events.push(`text:${event.text}`);
        else if (event.type === "text-boundary") events.push("boundary");
      },
    });
    expect(result).toMatchObject({ status: "completed", text: "Checking now.\n\nDone." });
    expect(events.join("")).toBe("text:Checkingtext: now.boundarytext:Done.");
  });

  it("sets only advertised model and reasoning effort values", async () => {
    const root = portableFixtureRoot("grok ACP config");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(capturePath, `
      if (!globalThis.grokConfigOptions) {
        globalThis.grokConfigOptions = [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "grok-4.7", options: [{ value: "grok-4.7", name: "Grok 4.7" }, { value: "grok-4.6", name: "Grok 4.6" }] },
          { id: "reasoning_effort", name: "Effort", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        ];
      }
      const configOptions = globalThis.grokConfigOptions;
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-config",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions,
      } });
      if (message.method === "session/set_config_option") {
        for (const option of configOptions) {
          if (option.id === message.params.configId) option.currentValue = message.params.value;
        }
        return send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
      }
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-config", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Configured" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const configured = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-config",
      cwd: root,
      prompt: "Configure",
      interactionMode: "build",
      access: "supervised",
      model: "grok-4.6",
      reasoningEffort: "high",
    }));
    expect(configured.status).toBe("completed");
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      messages: Array<{ method?: string; params?: { configId?: string; value?: unknown } }>;
    };
    const updates = captured.messages.filter(({ method }) => method === "session/set_config_option");
    expect(updates.map(({ params }) => params)).toEqual([
      { sessionId: "grok-config", configId: "model", value: "grok-4.6" },
      { sessionId: "grok-config", configId: "reasoning_effort", value: "high" },
    ]);
    expect(updates.every(({ params }) => typeof params?.value === "string")).toBe(true);

    const missingRoot = portableFixtureRoot("grok ACP missing model");
    roots.push(missingRoot);
    const missingCommand = writeNodeFlagExecutable(missingRoot, "grok", grokAgent(null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-missing-model",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "grok-4.7", options: [{ value: "grok-4.7", name: "Grok 4.7" }] }],
      } });
    `));
    await expect(managerFor(missingRoot, missingCommand).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-missing-model",
      cwd: missingRoot,
      prompt: "Configure",
      interactionMode: "build",
      access: "supervised",
      model: "grok-4.5",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Grok ACP does not advertise the selected model 'grok-4.5'.",
    });

    const effortRoot = portableFixtureRoot("grok ACP missing effort");
    roots.push(effortRoot);
    const effortCommand = writeNodeFlagExecutable(effortRoot, "grok", grokAgent(null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-missing-effort",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [{ id: "reasoning_effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] }],
      } });
    `));
    await expect(managerFor(effortRoot, effortCommand).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-missing-effort",
      cwd: effortRoot,
      prompt: "Configure",
      interactionMode: "build",
      access: "supervised",
      reasoningEffort: "xhigh",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Grok ACP does not advertise the selected reasoning effort 'xhigh'.",
    });
  });

  it("refuses image attachments when image prompts are not advertised", async () => {
    const root = portableFixtureRoot("grok ACP images");
    roots.push(root);
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-images",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [],
      } });
    `));
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-images",
      cwd: root,
      prompt: "Look",
      interactionMode: "build",
      access: "supervised",
      imagePaths: ["diagram.png"],
    }));
    expect(result.status).toBe("failed");
    expect(`${result.error ?? ""}\n${result.failure?.message ?? ""}\n${result.failure?.technicalDetail ?? ""}`)
      .toMatch(/did not advertise image/iu);
  });

  it("rejects malformed session updates and oversized frames", async () => {
    const malformedRoot = portableFixtureRoot("grok ACP malformed update");
    roots.push(malformedRoot);
    const malformedCommand = writeNodeFlagExecutable(malformedRoot, "grok", grokAgent(null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-malformed",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [],
      } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: {} });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    await expect(managerFor(malformedRoot, malformedCommand).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-malformed",
      cwd: malformedRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", phase: "turn", terminalEvent: "transport/frame" },
    });

    const overflowRoot = portableFixtureRoot("grok ACP overflow");
    roots.push(overflowRoot);
    const overflowCommand = writeNodeFlagExecutable(overflowRoot, "grok", `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`);
    await expect(managerFor(overflowRoot, overflowCommand).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-overflow",
      cwd: overflowRoot,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "protocol-overflow", terminalEvent: "transport/frame" },
    });
  });

  it("does not spawn for an explicit compaction request", async () => {
    const root = portableFixtureRoot("grok ACP compaction");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = writeNodeFlagExecutable(root, "grok", grokAgent(capturePath, `process.exit(0);`));
    const manager = managerFor(root, command);
    await expect(manager.compact(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "grok-compact-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: GROK_EXPLICIT_COMPACTION_UNAVAILABLE_REASON,
    });
    expect(() => readFileSync(capturePath, "utf8")).toThrow();
  });

  it("cancels the native session and confirms descendant cleanup", async () => {
    const root = portableFixtureRoot("grok ACP cancellation");
    roots.push(root);
    const registryRoot = join(root, "runtime-owned");
    mkdirSync(registryRoot, { recursive: true });
    chmodSync(registryRoot, 0o700);
    const runtimeGenerationId = "61000000-0000-4000-8000-000000000062:1";
    const deactivate = activateRuntimeOwnedProcessRegistry(
      registryRoot,
      runtimeGenerationId,
      "test:61000000-0000-4000-8000-000000000062",
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
    const command = writeNodeFlagExecutable(root, "grok", `
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
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token" }], agentInfo: { name: "Grok", version: "1.0.70" } } });
  if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-cancel-session", modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  if (message.method === "session/prompt") { promptId = message.id; return; }
  if (message.method === "session/cancel") return send({
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: "cancelled" },
  });
});
`);
    const manager = ProviderManager.createForTests(
      { commands: { grok: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createGrokAcpHarness()]),
    );
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => { markRunning = resolve; });
    const result = manager.run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-cancel",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: ({ status }) => { if (status === "running") markRunning(); },
    });
    await running;
    await waitFor("Grok fixture capture", () => {
      try {
        return Boolean(JSON.parse(readFileSync(capturePath, "utf8")).port);
      } catch {
        return false;
      }
    });
    expect(manager.cancel("grok-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled", text: "" });
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
      messages: Array<{ method?: string }>;
    };
    expect(captured.messages.some(({ method }) => method === "session/cancel")).toBe(true);
    await waitFor(
      "the Grok child socket to close",
      async () => !(await loopbackPortIsOpen(captured.port)),
    );
    if (deactivate) {
      await waitFor(
        "the Grok runtime-owned process claim to retire",
        () => journal.records(runtimeGenerationId)?.length === 0,
      );
    }
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("closes the child stdout with the platform-supported lifecycle", async () => {
    const root = portableFixtureRoot("grok ACP stdout close");
    roots.push(root);
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", process.platform === "win32" ? `
process.stdout.end("ready\\n", () => process.exit(0));
` : `
process.stdout.write("ready\\n", () => {
  ${CLOSE_NODE_STDOUT_TRANSPORT_SOURCE}
});
setInterval(() => {}, 1000);
`);
    const { spawn } = await import("node:child_process");
    const child = spawn(command, ["agent", "stdio"], {
      cwd: root,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let stdoutEnded = false;
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdout.once("end", () => { stdoutEnded = true; });
    try {
      await waitFor("the fixture's inherited stdout pipe to close", () => stdoutEnded);
      expect(Buffer.concat(output).toString("utf8")).toBe("ready\n");
      if (process.platform === "win32") {
        await waitFor("the flushed Windows fixture to exit", () => child.exitCode !== null);
        expect(child.exitCode).toBe(0);
      } else {
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(await terminateProcessTreeAndWait(child, true)).toBe(true);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await terminateProcessTreeAndWait(child, true);
      }
    }
  });
});
