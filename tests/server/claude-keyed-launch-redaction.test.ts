// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import type {
  CanUseTool,
  Options as ClaudeOptions,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  claudeHarnessBackendCompatibility,
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
  modelBackendProfileForClaudeProfile,
} from "../../src/shared/claude-backend-profiles";
import { continuationIdentityForSelection } from "../../src/shared/model-routing";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  CLAUDE_CREDENTIAL_COMMAND_HOOK_MATCHER,
  CLAUDE_KEYED_LAUNCH_COMMAND_REFUSAL,
  claudeCommandExposesLaunchCredentials,
} from "../../src/server/provider/claude-credential-commands";
import {
  ClaudeLaunchRedactor,
  claudeKeyedLaunchSecrets,
} from "../../src/server/provider/claude-launch-redaction";
import {
  claudeBackendProfileRegistrations,
  createClaudeBackendLaunchResolver,
} from "../../src/server/runtime/backends/claude-compatible-adapter";
import type { ProviderRunResult } from "../../src/server/provider/contracts";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import {
  claudeErrorResult,
  claudeModelUsage,
  claudeSuccessResult,
  claudeUsage,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

const SECRET = "kimi-launch-key-7Q2p9Zr4Xv8Lm3Ns";
const LONG_KEY = "sk-ant-api03-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5mN7pQ9rS1tU3vW5xY7zA9bC1dE3fG5hJ7k";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";

function streamDelta(
  index: number,
  delta: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string },
): SDKMessage {
  return {
    type: "stream_event",
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index, delta },
  } as unknown as SDKMessage;
}

function blockStop(index: number): SDKMessage {
  return {
    type: "stream_event",
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: "content_block_stop", index },
  } as unknown as SDKMessage;
}

function toolExchange(id: string, command: string, output: unknown): SDKMessage[] {
  return [
    {
      type: "assistant",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    } as unknown as SDKMessage,
    {
      type: "user",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
    } as unknown as SDKMessage,
  ];
}

interface KeyedRun {
  result: ProviderRunResult;
  events: unknown[];
  options: ClaudeOptions | undefined;
}

async function runKeyed(
  root: string,
  messages: (options: ClaudeOptions | undefined) => AsyncGenerator<SDKMessage>,
  access: "supervised" | "full" = "supervised",
): Promise<KeyedRun> {
  const profile = createKimiClaudeBackendProfile({
    id: "kimi:keyed-redaction",
    secretReference: "secret:kimi-keyed-redaction",
    primaryModelId: "k3",
    contextWindowTokens: 262_144,
  });
  const backendProfile = modelBackendProfileForClaudeProfile(profile);
  const modelSelection = createKimiClaudeModelSelection({ profile, reasoningEffort: "high" });
  let captured: ClaudeOptions | undefined;
  const harness = createClaudeAgentSdkHarness({
    createQuery: ({ options }) => {
      captured = options;
      return Object.assign(messages(options), {
        supportedModels: async () => [],
        getContextUsage: async () => ({ totalTokens: 10, maxTokens: 262_144, isAutoCompactEnabled: true }) as never,
        interrupt: async () => undefined,
        close: () => undefined,
      }) as unknown as Query;
    },
  });
  const manager = ProviderManager.createForTests({
    commands: { claude: "/fake/claude" },
    ...claudeBackendProfileRegistrations([profile]),
    resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
      profiles: [profile],
      resolveSecret: async () => SECRET,
    }),
  }, new AgentHarnessRegistry([harness]));
  const events: unknown[] = [];
  const result = await manager.run({
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    backendProfile,
    backendCompatibility: claudeHarnessBackendCompatibility(profile),
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection, backendProfile.endpointIdentity, true),
    conversationId: "keyed-redaction",
    runId: "keyed-redaction-run",
    turnId: "keyed-redaction-turn",
    cwd: root,
    prompt: "Inspect the environment",
    model: modelSelection.modelId,
    reasoningEffort: modelSelection.reasoningEffort ?? undefined,
    interactionMode: "build",
    access,
  }, {
    onEvent: (event) => events.push(event),
    onApproval: (event) => {
      events.push(event);
      manager.respondToApproval(event.conversationId, event.request.requestId, "deny", {
        runId: event.runId,
        turnId: event.turnId,
      });
    },
  });
  return { result, events, options: captured };
}

function wrap(value: string, width: number): string {
  return value.replace(new RegExp(`.{${width}}(?=.)`, "gu"), "$&\n");
}

function expectNoFragments(value: string): void {
  const compact = value.replace(/\s/gu, "");
  for (const form of claudeKeyedLaunchSecrets({ ANTHROPIC_API_KEY: LONG_KEY })) {
    for (let start = 0; start + 16 <= form.length; start += 8) {
      expect(compact).not.toContain(form.slice(start, start + 16));
    }
  }
}

function expectNoSecret(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const encoding of claudeKeyedLaunchSecrets({ ANTHROPIC_API_KEY: SECRET })) {
    expect(serialized).not.toContain(encoding);
  }
  expect(serialized).not.toContain(SECRET.slice(0, 12));
}

describe("keyed Claude launch redaction", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("masks a key split across two stream chunks without delaying unrelated text", () => {
    const redactor = new ClaudeLaunchRedactor(claudeKeyedLaunchSecrets({ ANTHROPIC_AUTH_TOKEN: SECRET }));
    const output = [
      streamDelta(0, { type: "text_delta", text: `The key is ${SECRET.slice(0, 14)}` }),
      streamDelta(0, { type: "text_delta", text: `${SECRET.slice(14)} and more.` }),
      blockStop(0),
      streamDelta(1, { type: "thinking_delta", thinking: `trailing ${SECRET.slice(0, 20)}` }),
    ].flatMap((message) => redactor.messages(message)).concat(redactor.finish());
    const texts = output.map((message) => {
      const event = (message as { event?: { delta?: { text?: string; thinking?: string } } }).event;
      return event?.delta?.text ?? event?.delta?.thinking ?? "";
    });

    expect(texts.join("")).toBe("The key is [redacted] and more.trailing [redacted]");
    expect(texts[0]).toBe("The key is ");
    expectNoSecret(output);
  });

  it.each([
    ["base64 of the key and a newline, wrapped at 76 columns", `${wrap(Buffer.from(`${LONG_KEY}\n`).toString("base64"), 76)}\n`],
    ["base64 of the key and a Windows line ending", Buffer.from(`${LONG_KEY}\r\n`).toString("base64")],
    ["base64url of the key", Buffer.from(LONG_KEY).toString("base64url")],
    ["lower-case hex wrapped like xxd -p", wrap(Buffer.from(LONG_KEY).toString("hex"), 60)],
    ["upper-case hex", Buffer.from(LONG_KEY).toString("hex").toUpperCase()],
    ["the key split by a line break", `${LONG_KEY.slice(0, 40)}\n${LONG_KEY.slice(40)}`],
    ["the key split by spaces", `${LONG_KEY.slice(0, 20)} ${LONG_KEY.slice(20, 70)}  ${LONG_KEY.slice(70)}`],
  ])("masks %s with one mask", (_case, encoded) => {
    const redactor = new ClaudeLaunchRedactor(claudeKeyedLaunchSecrets({ ANTHROPIC_API_KEY: LONG_KEY }));
    const masked = redactor.text(`before ${encoded} after`);

    expect(masked.match(/\[redacted\]/gu)).toHaveLength(1);
    expect(masked.startsWith("before [redacted]")).toBe(true);
    expect(masked.trimEnd().endsWith("after")).toBe(true);
    expectNoFragments(masked);
    expectNoFragments(JSON.stringify(redactor.payload({ output: [{ text: encoded }] })));
  });

  it("masks wrapped base64 streamed across chunks and holds no more than the encoded form", () => {
    const redactor = new ClaudeLaunchRedactor(claudeKeyedLaunchSecrets({ ANTHROPIC_API_KEY: LONG_KEY }));
    const encoded = `${wrap(Buffer.from(`${LONG_KEY}\n`).toString("base64"), 76)}\n`;
    const chunks = ["Output: ", encoded.slice(0, 50), encoded.slice(50, 90), `${encoded.slice(90)}done.`];
    const output = chunks
      .map((text) => streamDelta(0, { type: "text_delta", text }))
      .flatMap((message) => redactor.messages(message))
      .concat(redactor.messages(blockStop(0)));
    const texts = output.map((message) =>
      (message as { event?: { delta?: { text?: string } } }).event?.delta?.text ?? "");

    expect(texts[0]).toBe("Output: ");
    expect(texts.join("")).toBe("Output: [redacted]\ndone.");
    expectNoFragments(texts.join(""));
  });

  it("returns no redactor for a launch without an Anthropic key", () => {
    expect(ClaudeLaunchRedactor.forEnvironment({ PATH: "/bin" })).toBeNull();
    expect(claudeKeyedLaunchSecrets({ ANTHROPIC_API_KEY: SECRET })).toContain(SECRET);
  });

  it("removes the launch key from tool results, JSON, streamed text and the final answer", async () => {
    const root = portableFixtureRoot("Keyed Claude redaction");
    roots.push(root);
    const { result, events } = await runKeyed(root, async function* () {
      yield streamDelta(0, { type: "text_delta", text: `Found ${SECRET.slice(0, 10)}` });
      yield streamDelta(0, { type: "text_delta", text: `${SECRET.slice(10)} in the environment.` });
      yield blockStop(0);
      yield* toolExchange("tool-echo", "echo $KEY", [{ type: "text", text: `${SECRET}\n` }]);
      yield* toolExchange("tool-json", "cat config.json", JSON.stringify({ auth: { token: SECRET } }));
      yield {
        ...claudeSuccessResult(`Found ${SECRET} in the environment.`),
        session_id: SESSION_ID,
        usage: claudeUsage({ input_tokens: 5, output_tokens: 5 }),
        modelUsage: { k3: claudeModelUsage({ contextWindow: 262_144 }) },
      };
    });

    expect(result.status).toBe("completed");
    expect(result.text).toContain("[redacted]");
    expect(JSON.stringify(events)).toContain("[redacted]");
    expectNoSecret(events);
    expectNoSecret(result);
  });

  it("removes the launch key from a provider error", async () => {
    const root = portableFixtureRoot("Keyed Claude error redaction");
    roots.push(root);
    const thrown = await runKeyed(root, async function* () {
      yield streamDelta(0, { type: "text_delta", text: "Starting" });
      throw new Error(`401 Unauthorized: invalid x-api-key ${SECRET}`);
    });
    expect(thrown.result.status).toBe("failed");
    expectNoSecret(thrown.result);
    expectNoSecret(thrown.events);

    const reported = await runKeyed(root, async function* () {
      yield {
        ...claudeErrorResult("error_during_execution", [`Request rejected for key ${SECRET}`]),
        session_id: SESSION_ID,
      };
    });
    expect(reported.result.status).toBe("failed");
    expectNoSecret(reported.result);
    expectNoSecret(reported.events);
  });

  it("refuses credential-revealing shell commands through a PreToolUse hook in every permission mode", async () => {
    const root = portableFixtureRoot("Keyed Claude command refusal");
    roots.push(root);
    const hookOutputs: unknown[] = [];
    const decisions: PermissionResult[] = [];
    const { options, events } = await runKeyed(root, async function* (options) {
      const matcher = options?.hooks?.PreToolUse?.[0];
      for (const [toolName, command] of [
        ["Bash", "printenv"],
        ["PowerShell", "Get-ChildItem Env:"],
        ["Bash", "ls -la"],
        ["Read", "printenv"],
      ] as const) {
        hookOutputs.push(await matcher!.hooks[0]!({
          hook_event_name: "PreToolUse",
          session_id: SESSION_ID,
          transcript_path: "/tmp/transcript.jsonl",
          cwd: root,
          tool_name: toolName,
          tool_input: { command },
          tool_use_id: `hook-${hookOutputs.length}`,
        } as never, `hook-${hookOutputs.length}`, { signal: new AbortController().signal }));
      }
      const canUseTool = options?.canUseTool as CanUseTool;
      for (const command of ["echo $ANTHROPIC_AUTH_TOKEN", "npm test"]) {
        decisions.push((await canUseTool("Bash", { command }, {
          signal: new AbortController().signal,
          toolUseID: `tool-${decisions.length}`,
          requestId: `permission-${decisions.length}`,
        }))!);
      }
      yield { ...claudeSuccessResult("Done"), session_id: SESSION_ID };
    }, "full");

    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.hooks?.PreToolUse).toHaveLength(1);
    expect(options?.hooks?.PreToolUse?.[0]?.matcher).toBe(CLAUDE_CREDENTIAL_COMMAND_HOOK_MATCHER);
    const refusal = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: CLAUDE_KEYED_LAUNCH_COMMAND_REFUSAL,
      },
    };
    expect(hookOutputs).toEqual([refusal, refusal, {}, {}]);
    expect(decisions.map((decision) => decision.behavior)).toEqual(["deny", "allow"]);
    expect(decisions[0]).toMatchObject({ message: CLAUDE_KEYED_LAUNCH_COMMAND_REFUSAL });
    expectNoSecret(events);
  });

  it("registers no command hook on the native account route", async () => {
    const root = portableFixtureRoot("Native Claude without credential hook");
    roots.push(root);
    let captured: ClaudeOptions | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        captured = options;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSuccessResult("Done");
        })());
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    await manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "native-no-credential-hook",
      cwd: root,
      prompt: "Finish",
      interactionMode: "build",
      access: "full",
    }));

    expect(captured?.hooks).toBeUndefined();
    expect(captured?.permissionMode).toBe("bypassPermissions");
  });

  it("redacts approval display text while keeping the command Claude runs", async () => {
    const root = portableFixtureRoot("Keyed Claude approval display");
    roots.push(root);
    const decisions: PermissionResult[] = [];
    const { events } = await runKeyed(root, async function* (options) {
      const canUseTool = options?.canUseTool as CanUseTool;
      decisions.push((await canUseTool("Bash", { command: `deploy --token ${SECRET}` }, {
        signal: new AbortController().signal,
        title: "Deploy",
        description: `Runs deploy with ${SECRET}`,
        toolUseID: "tool-deploy",
        requestId: "permission-deploy",
      }))!);
      yield { ...claudeSuccessResult("Done"), session_id: SESSION_ID };
    });

    expect(decisions[0]).toMatchObject({ behavior: "deny" });
    const approvals = events.filter((event) => (event as { type?: string }).type === "approval");
    expect(JSON.stringify(approvals)).toContain("deploy --token [redacted]");
    expectNoSecret(events);
  });
});

describe("credential-revealing command detection", () => {
  it.each([
    "env",
    "env | sort",
    "env -0",
    "FOO=1 env",
    "/usr/bin/env",
    "env -u PATH",
    "printenv",
    "printenv | grep -i key",
    "set",
    "export -p",
    "export",
    "declare -x",
    "typeset -p",
    "echo $ANTHROPIC_API_KEY",
    "printenv anthropic_auth_token",
    "cat /proc/self/environ",
    "bash -c \"env\"",
    "sh -lc 'printenv'",
    "cmd /c set",
    "npm test && env",
    "echo $(printenv)",
    "Get-ChildItem Env:",
    "gci env:",
    "[System.Environment]::GetEnvironmentVariables()",
    "sudo env",
  ])("refuses %s", (command) => {
    expect(claudeCommandExposesLaunchCredentials(command)).toBe(true);
  });

  it.each([
    "npm test",
    "env NODE_ENV=test npm test",
    "/usr/bin/env node script.js",
    "printenv HOME",
    "set -euo pipefail",
    "export PATH=$PATH:/opt/bin",
    "declare -A map",
    "git commit -m \"set up env files\"",
    "cat .env.example",
    "ls environment",
  ])("allows %s", (command) => {
    expect(claudeCommandExposesLaunchCredentials(command)).toBe(false);
  });
});
