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
import { selectGrokAcpAuthMethod } from "../../src/server/provider/grok-acp-auth";
import {
  createGrokAcpHarness,
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

  async function runTurn(
    name: string,
    source: string,
    input: Parameters<typeof nativeProviderRunInput>[0],
  ) {
    const root = portableFixtureRoot(name);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", source);
    const manager = managerFor(root, command);
    const result = await manager.run(nativeProviderRunInput(input));
    return { capturePath, manager, result };
  }

  it("resolves the grok executable without a shell", () => {
    expect(grokAcpProcessInvocation("/usr/local/bin/grok", {}, "linux")).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
    });
    const windows = grokAcpProcessInvocation(
      "C:\\Tools\\grok.cmd",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(windows.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windows.windowsVerbatimArguments).toBe(true);
    expect(windows.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(windows.args[4]).toContain("grok.cmd");
    expect(windows.args[4]).toContain("agent");
    expect(windows.args[4]).toContain("stdio");
    expect(grokAcpProcessInvocation("C:\\Tools\\grok.exe", {}, "win32")).toEqual({
      command: "C:\\Tools\\grok.exe",
      args: ["agent", "stdio"],
    });
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
  });

  it("prefers cached_token, then an advertised API key, and otherwise stays unauthenticated", () => {
    expect(selectGrokAcpAuthMethod(
      [{ id: "xai.api_key" }, { id: "cached_token" }, { id: 4 }, {}],
      { XAI_API_KEY: "present" },
    )).toEqual({ id: "cached_token" });
    expect(selectGrokAcpAuthMethod(
      [{ id: "xai.api_key" }],
      { GROK_CODE_XAI_API_KEY: " present " },
    )).toEqual({ id: "xai.api_key" });
    expect(selectGrokAcpAuthMethod([{ id: "xai.api_key" }], {})).toBeNull();
    expect(selectGrokAcpAuthMethod([{ id: "login" }], { XAI_API_KEY: "present" })).toBeNull();
    expect(selectGrokAcpAuthMethod(undefined, {})).toBeNull();
  });

  it("authenticates with cached_token before an advertised API key", async () => {
    rememberEnv();
    process.env.XAI_API_KEY = "test-xai-key";
    const root = portableFixtureRoot("grok ACP cached auth");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `
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
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `
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

  it("fails the turn when neither advertised auth method can be used", async () => {
    const root = portableFixtureRoot("grok ACP unauthenticated");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", "[]")} });
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
      messages: Array<{ method?: string }>;
    };
    expect(captured.messages.some(({ method }) => method === "authenticate")).toBe(false);
    expect(captured.messages.some(({ method }) => method === "session/new")).toBe(false);
  });

  it("sets yoloMode only for a new full-access session", async () => {
    const modes = `{ currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }`;
    const source = (capturePath: string) => grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-access", modes: ${modes}, configOptions: [] } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-access", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `);
    for (const access of ["full", "supervised", "auto-edit"] as const) {
      const root = portableFixtureRoot(`grok ACP ${access}`);
      roots.push(root);
      const capturePath = join(root, "capture.json");
      const command = portableNodeExecutable(root, "grok");
      writeNodeSubcommand(root, "agent", source(capturePath));
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
        messages: Array<{ method?: string; params?: { _meta?: { yoloMode?: boolean } } }>;
      };
      const created = captured.messages.find(({ method }) => method === "session/new");
      if (access === "full") expect(created?.params?._meta).toEqual({ yoloMode: true });
      else expect(created?.params).not.toHaveProperty("_meta");
      expect(captured.messages.some(({ method }) => method === "session/set_mode")).toBe(false);
    }
  });

  it("does not send yoloMode when loading a full-access session", async () => {
    const root = portableFixtureRoot("grok ACP load");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{ loadSession: true }", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/load") return send({ jsonrpc: "2.0", id: message.id, result: {
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [],
      } });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "saved-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Resumed" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-load",
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
    const loaded = captured.messages.find(({ method }) => method === "session/load");
    expect(loaded?.params).toMatchObject({ sessionId: "saved-session", cwd: root });
    expect(loaded?.params).not.toHaveProperty("_meta");
    expect(captured.messages.some(({ method }) => method === "session/new")).toBe(false);
  });

  it("selects an advertised plan mode and fails when none is advertised", async () => {
    const root = portableFixtureRoot("grok ACP plan");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-plan",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }] },
        configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-plan", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Planned" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const planned = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-plan",
      cwd: root,
      prompt: "Plan",
      interactionMode: "plan",
      access: "supervised",
    }));
    expect(planned.status).toBe("completed");
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      messages: Array<{ method?: string; params?: { modeId?: string } }>;
    };
    expect(captured.messages.find(({ method }) => method === "session/set_mode")?.params).toEqual({
      sessionId: "grok-plan",
      modeId: "plan",
    });

    const missingRoot = portableFixtureRoot("grok ACP missing plan");
    roots.push(missingRoot);
    const missingCommand = portableNodeExecutable(missingRoot, "grok");
    writeNodeSubcommand(missingRoot, "agent", grokAgent(null, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-no-plan",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        configOptions: [],
      } });
    `));
    await expect(managerFor(missingRoot, missingCommand).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-no-plan",
      cwd: missingRoot,
      prompt: "Plan",
      interactionMode: "plan",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "This Grok ACP server does not advertise a plan mode.",
    });
  });

  it("selects accept-edits when advertised and does not turn auto-edit into yoloMode", async () => {
    const root = portableFixtureRoot("grok ACP accept edits");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `
      if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: ${initResult("{}", `[{ id: "cached_token" }]`)} });
      if (message.method === "authenticate") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: {
        sessionId: "grok-edits",
        modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }, { id: "acceptEdits", name: "Accept edits" }] },
        configOptions: [],
      } });
      if (message.method === "session/set_mode") return send({ jsonrpc: "2.0", id: message.id, result: {} });
      if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-edits", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Edited" } } } });
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    `));
    const result = await managerFor(root, command).run(nativeProviderRunInput({
      providerId: "grok",
      conversationId: "grok-edits",
      cwd: root,
      prompt: "Edit",
      interactionMode: "build",
      access: "auto-edit",
    }));
    expect(result.status).toBe("completed");
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      messages: Array<{ method?: string; params?: { modeId?: string; _meta?: unknown } }>;
    };
    expect(captured.messages.find(({ method }) => method === "session/new")?.params).not.toHaveProperty("_meta");
    expect(captured.messages.find(({ method }) => method === "session/set_mode")?.params?.modeId).toBe("acceptEdits");
  });

  it("sets only advertised model and reasoning effort values", async () => {
    const root = portableFixtureRoot("grok ACP config");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `
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
    const missingCommand = portableNodeExecutable(missingRoot, "grok");
    writeNodeSubcommand(missingRoot, "agent", grokAgent(null, `
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
    const effortCommand = portableNodeExecutable(effortRoot, "grok");
    writeNodeSubcommand(effortRoot, "agent", grokAgent(null, `
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
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(null, `
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
    const malformedCommand = portableNodeExecutable(malformedRoot, "grok");
    writeNodeSubcommand(malformedRoot, "agent", grokAgent(null, `
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
    const overflowCommand = portableNodeExecutable(overflowRoot, "grok");
    writeNodeSubcommand(overflowRoot, "agent", `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`);
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
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", grokAgent(capturePath, `process.exit(0);`));
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
    const command = portableNodeExecutable(root, "grok");
    writeNodeSubcommand(root, "agent", `
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
      if (child.exitCode === null && child.signalCode === null) {
        expect(await terminateProcessTreeAndWait(child, true)).toBe(true);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await terminateProcessTreeAndWait(child, true);
      }
    }
  });
});
