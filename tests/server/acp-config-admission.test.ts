// @inertia-test-suite portable
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { nativeProviderRunInput } from "./model-route-fixture";

const processFixture = vi.hoisted(() => ({
  child: undefined as ChildProcessWithoutNullStreams | undefined,
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => {
    if (!processFixture.child) throw new Error("Missing ACP stream fixture.");
    return processFixture.child;
  },
}));
vi.mock("../../src/node/runtime-owned-processes", async (original) => ({
  ...await original<typeof import("../../src/node/runtime-owned-processes")>(),
  runtimeOwnedProcessInvocation: (command: string, args: string[]) => ({ command, args }),
  spawnRuntimeOwnedProcess: (spawnChild: () => ChildProcessWithoutNullStreams) => spawnChild(),
  confirmRuntimeOwnedProcessStopped: () => true,
}));

type Category = "model" | "thought_level" | "mode";
type ResponseKind = "applied" | "unchanged" | "missing" | "wrong-type" | "category-omitted";

function providerFixture(provider: "cursor" | "kimi", category: Category, responseKind: ResponseKind) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const methods: string[] = [];
  const desired = category === "model" ? "model-b" : category === "thought_level" ? "high" : "plan";
  const previous = category === "model" ? "model-a" : category === "thought_level" ? "low" : "build";
  const option = {
    id: `config-${category}`, name: category, category, type: "select",
    currentValue: previous,
    options: [{ value: previous, name: previous }, { value: desired, name: desired }],
  };
  const send = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  let pending = "";
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      pending += String(chunk);
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(pending.slice(0, newline)) as {
          id?: number; method: string; params?: { value?: string };
        };
        pending = pending.slice(newline + 1);
        methods.push(message.method);
        let result: unknown;
        if (message.method === "initialize") result = {
          protocolVersion: 1, agentCapabilities: {}, authMethods: [],
          agentInfo: { name: provider },
        };
        else if (message.method === "session/new") result = {
          sessionId: "config-session", configOptions: [option],
          ...(category === "mode" ? {} : {
            modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
          }),
        };
        else if (message.method === "session/set_config_option") {
          if (responseKind === "applied" || responseKind === "category-omitted") {
            option.currentValue = message.params!.value!;
          }
          const { category: _category, ...withoutCategory } = option;
          result = { configOptions: responseKind === "missing" ? []
            : responseKind === "wrong-type" ? [{
                id: option.id, name: option.name, type: "boolean", currentValue: true,
              }]
            : [responseKind === "category-omitted" ? withoutCategory : option] };
        } else if (message.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "config-session", update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ran the selected route" },
            },
          } });
          result = { stopReason: "end_turn" };
        }
        if (result) queueMicrotask(() => send({ jsonrpc: "2.0", id: message.id, result }));
      }
      callback();
    },
  });
  const child = Object.assign(new ChildProcess(), {
    stdin, stdout, stderr, exitCode: null, signalCode: null,
  }) as ChildProcessWithoutNullStreams;
  return {
    child, desired, methods,
    dispose: () => { stdin.destroy(); stdout.destroy(); stderr.destroy(); },
  };
}

describe.each([
  ["cursor", createCursorAcpHarness],
  ["kimi", createKimiAcpHarness],
] as const)("%s authoritative ACP configuration", (provider, createHarness) => {
  it.each(["model", "thought_level", "mode"] as const)(
    "does not send a prompt when the authoritative %s response contradicts the requested selection",
    async (category) => { await verify(category, "unchanged"); },
  );
  it.each(["model", "thought_level", "mode"] as const)(
    "accepts an authoritative applied %s selection",
    async (category) => { await verify(category, "applied"); },
  );
  it.each(["missing", "wrong-type"] as const)(
    "rejects a %s requested config entry in the full response",
    async (responseKind) => { await verify("model", responseKind); },
  );
  it("accepts the applied value when optional category metadata is omitted", async () => {
    await verify("model", "category-omitted");
  });
  it("keeps provider-default selection without sending a configuration mutation", async () => {
    await verify("model", "unchanged", false);
  });

  async function verify(category: Category, responseKind: ResponseKind, requestSelection = true) {
    const fixture = providerFixture(provider, category, responseKind);
    const applied = !requestSelection || responseKind === "applied" || responseKind === "category-omitted";
    processFixture.child = fixture.child;
    const terminate = vi.fn(async () => true);
    const run = createHarness({ terminateProcessTree: terminate }).start({
      input: nativeProviderRunInput({
        providerId: provider, conversationId: "config-admission", cwd: process.cwd(),
        prompt: "Use the selected configuration", access: "supervised",
        interactionMode: category === "mode" ? "plan" : "build",
        ...(category === "model" && requestSelection ? { model: fixture.desired } : {}),
        ...(category === "thought_level" ? { reasoningEffort: fixture.desired } : {}),
      }),
      executable: "/synthetic/acp", environment: {}, providerNativeToolsAvailable: true,
    });
    try {
      const result = await run.result;
      expect(result).toMatchObject({
        status: applied ? "completed" : "failed", cleanupConfirmed: true,
      });
      expect(fixture.methods.includes("session/set_config_option")).toBe(requestSelection);
      expect(fixture.methods.includes("session/prompt")).toBe(applied);
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      fixture.dispose();
    }
  }
});
