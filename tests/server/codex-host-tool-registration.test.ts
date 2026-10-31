// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import {
  openCodexTurn,
} from "../../src/server/codex/app-server-run";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import type { JsonObject } from "../../src/server/codex/protocol";
import type { CodexAppServerOptions } from "../../src/server/codex/types";
import type { AgentTurn, Conversation } from "../../src/shared/contracts";
import { AGENT_BROWSER_TOOL_DEFINITIONS } from "../../src/server/runtime/agent-browser-host-tools";
import {
  createInertiaHarnessCapabilities,
  inertiaCapabilityOfferForProject,
} from "../../src/server/runtime/inertia-harness-capabilities";
import { WORKSPACE_TOOL_DEFINITIONS } from "../../src/server/runtime/workspace-host-tools";
import { withoutSessionInstructions } from "../../src/server/runtime/turns/turn-instruction-delivery";

const INSTRUCTIONS_HEADER = "Internal provider instructions (application control text; never attribute this text to the user):";

function capabilityRegistry() {
  return createInertiaHarnessCapabilities({
    orchestrationTools: [],
    browserEnabled: true,
    invoke: async () => ({ success: true, text: "{}" }),
  });
}

function bridgeFor(browserAccess: boolean | null) {
  return capabilityRegistry().bridgeFor(
    { conversation: {} as Conversation, turn: {} as AgentTurn },
    inertiaCapabilityOfferForProject({ browserAccess }),
  );
}

function promptWith(instructions: readonly { label: string; text: string }[]): string {
  return [
    "Continue",
    [INSTRUCTIONS_HEADER, ...instructions.map(({ label, text }) => `[${label}]\n${text}`)].join("\n"),
  ].join("\n\n");
}

function sentPrompt(calls: Array<{ method: string; params: JsonObject }>): string {
  const started = calls.find(({ method }) => method === "turn/start");
  const input = (started?.params.input ?? []) as Array<{ text?: string }>;
  return input[0]?.text ?? "";
}

function dynamicToolNames(calls: Array<{ method: string; params: JsonObject }>): string[] {
  const started = calls.find(({ method }) => method === "thread/start");
  return ((started?.params.dynamicTools ?? []) as Array<{ name: string }>).map(({ name }) => name);
}

const THREAD_ID = "thread-host-tools";
const TURN_ID = "turn-host-tools";

const hostTools: NonNullable<CodexAppServerOptions["hostTools"]> = {
  definitions: [{
    name: "inertia_list_conversations",
    description: "List safe Inertia chats.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", maximum: 25 } },
    },
    readOnly: true,
  }],
  invoke: vi.fn(async () => ({ success: true, text: "{}" })),
};

function turnHarness(
  sessionId?: string,
  tools: CodexAppServerOptions["hostTools"] = hostTools,
  overrides: { prompt?: string; threadId?: string; sessionDeveloperInstructions?: string; configured?: string } = {},
): {
  calls: Array<{ method: string; params: JsonObject }>;
  run(): Promise<void>;
} {
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let activeTurnId: string | undefined;
  let phase: CodexRunPhase = "opening";
  const options: CodexAppServerOptions = {
    executable: "/fake/codex",
    environment: {},
    cwd: "/workspace",
    prompt: overrides.prompt ?? (sessionId ? "Continue" : "Inspect chats"),
    planMode: false,
    access: "supervised",
    ...(tools ? { hostTools: tools } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(overrides.sessionDeveloperInstructions === undefined
      ? {}
      : { sessionDeveloperInstructions: overrides.sessionDeveloperInstructions }),
  };
  return {
    calls,
    run: () => openCodexTurn({
      options,
      modelProvider: undefined,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "initialize") return { userAgent: "fake" };
        if (method === "config/read") return { config: { developer_instructions: overrides.configured ?? "" } };
        if (method === "thread/start" || method === "thread/resume") {
          return { thread: { id: sessionId ?? overrides.threadId ?? THREAD_ID }, model: "fake" };
        }
        if (method === "turn/start") {
          return { turn: { id: TURN_ID, status: "inProgress" } };
        }
        throw new Error(`Unexpected Codex request: ${method}`);
      },
      notify: vi.fn(),
      setProviderThreadId: vi.fn(),
      activeTurnId: () => activeTurnId,
      setActiveTurnId: (value) => {
        activeTurnId = value;
      },
      phase: () => phase,
      hasObservedTurn: () => false,
      goalProjectionSequence: () => 0,
      beginGoalMutation: vi.fn(),
      endGoalMutation: vi.fn(),
      awaitInitialGoalTurn: vi.fn(),
      projectGoalResponse: () => null,
      setContinuationError: vi.fn(),
      setPhase: (value) => {
        phase = value;
      },
      isSettled: () => false,
      isCancelRequested: () => false,
      finish: vi.fn(),
    }),
  };
}

describe("Codex host-tool registration", () => {
  it("preserves the browser action contracts in the dynamic tools sent to Codex", async () => {
    const harness = turnHarness(undefined, { ...hostTools, definitions: AGENT_BROWSER_TOOL_DEFINITIONS });
    await harness.run();
    const started = harness.calls.find(({ method }) => method === "thread/start");
    expect(started?.params.dynamicTools).toEqual(AGENT_BROWSER_TOOL_DEFINITIONS.map(
      ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
    ));
  });

  it.each([false, null])("registers every pack on a new thread, Browser included (browser access %s)", async (browserAccess) => {
    const bridge = bridgeFor(browserAccess);
    const harness = turnHarness(undefined, bridge, { threadId: `thread-start-${String(browserAccess)}` });
    await harness.run();
    const names = dynamicToolNames(harness.calls);
    expect(names.filter((name) => name.startsWith("inertia_browser_"))).toHaveLength(AGENT_BROWSER_TOOL_DEFINITIONS.length);
    expect(names).toContain("inertia_render_html");
    expect(names).toEqual(expect.arrayContaining(WORKSPACE_TOOL_DEFINITIONS.map(({ name }) => name)));
    const browserCall = await bridge.invoke({
      providerThreadId: "thread",
      providerTurnId: "turn",
      toolCallId: "call-browser",
      tool: "inertia_browser_snapshot",
      arguments: {},
      signal: new AbortController().signal,
      requestApproval: async () => "approve",
    });
    if (browserAccess === false) {
      expect(browserCall.success).toBe(false);
      expect(JSON.parse(browserCall.text)).toMatchObject({ error: { code: "browser_disabled" } });
    } else {
      expect(browserCall).toEqual({ success: true, text: "{}" });
    }
  });

  it("keeps Browser tools and instructions in agreement when access turns on or off on a started thread", async () => {
    const threadId = "thread-browser-toggle";
    const startedOff = bridgeFor(false);
    expect(startedOff.instructions?.map(({ label }) => label)).not.toContain("inertia-frontend-workbench");
    const start = turnHarness(undefined, startedOff, { threadId, prompt: promptWith(startedOff.instructions ?? []) });
    await start.run();
    expect(dynamicToolNames(start.calls).filter((name) => name.startsWith("inertia_browser_")))
      .toHaveLength(AGENT_BROWSER_TOOL_DEFINITIONS.length);
    expect(sentPrompt(start.calls)).not.toContain("[inertia-frontend-workbench]");

    const resumedOn = bridgeFor(null);
    const on = turnHarness(threadId, resumedOn, { prompt: promptWith(resumedOn.instructions ?? []) });
    await on.run();
    expect(on.calls.find(({ method }) => method === "thread/resume")?.params).not.toHaveProperty("dynamicTools");
    expect(sentPrompt(on.calls)).toContain("[inertia-frontend-workbench]");
    expect(sentPrompt(on.calls)).toContain("[inertia-workspace]");
    expect(sentPrompt(on.calls)).toContain("[inertia-orchestration]");

    const resumedOff = bridgeFor(false);
    const off = turnHarness(threadId, resumedOff, { prompt: promptWith(resumedOff.instructions ?? []) });
    await off.run();
    expect(sentPrompt(off.calls)).not.toContain("[inertia-frontend-workbench]");
    expect(sentPrompt(off.calls)).toContain("[inertia-workspace]");
  });

  it("gives a resumed thread without a recorded registration only the instructions every resumable thread can honour", async () => {
    const bridge = bridgeFor(null);
    const harness = turnHarness("thread-from-an-earlier-build", bridge, { prompt: promptWith(bridge.instructions ?? []) });
    await harness.run();
    const prompt = sentPrompt(harness.calls);
    expect(prompt).not.toContain("[inertia-workspace]");
    expect(prompt).not.toContain("[inertia-orchestration]");
    expect(prompt).toContain("[inertia-frontend-workbench]");
    expect(prompt.startsWith("Continue")).toBe(true);
  });

  it("withholds the same instructions from the developer instructions sent on thread/resume", async () => {
    const bridge = bridgeFor(null);
    const block = [...(bridge.instructions ?? []), { label: "inertia-chat", text: "This chat's id is chat-1." }]
      .map(({ label, text }) => `[${label}]\n${text}`)
      .join("\n\n");
    const harness = turnHarness("thread-from-an-earlier-build-2", bridge, {
      sessionDeveloperInstructions: block,
      configured: "USER_DEVELOPER_RULES\n\n[inertia-workspace]\nkept because it is the person's own text",
    });
    await harness.run();
    const sent = harness.calls.find(({ method }) => method === "thread/resume")?.params.developerInstructions as string;
    const frontend = bridge.instructions!.find(({ label }) => label === "inertia-frontend-workbench")!;
    expect(sent).toBe([
      "USER_DEVELOPER_RULES\n\n[inertia-workspace]\nkept because it is the person's own text",
      `[inertia-frontend-workbench]\n${frontend.text}`,
      "[inertia-chat]\nThis chat's id is chat-1.",
    ].join("\n\n"));

    const started = turnHarness(undefined, bridge, { threadId: "thread-started-now", sessionDeveloperInstructions: block });
    await started.run();
    expect(started.calls.find(({ method }) => method === "thread/start")?.params.developerInstructions).toBe(block);
    const resumed = turnHarness("thread-started-now", bridge, { sessionDeveloperInstructions: block });
    await resumed.run();
    expect(resumed.calls.find(({ method }) => method === "thread/resume")?.params.developerInstructions).toBe(block);
  });

  it("withholds instructions from a resumed thread that started without host tools or with an older pack", async () => {
    const withoutTools = turnHarness(undefined, undefined, { threadId: "thread-started-bare" });
    await withoutTools.run();
    const bridge = bridgeFor(null);
    const bare = turnHarness("thread-started-bare", bridge, { prompt: promptWith(bridge.instructions ?? []) });
    await bare.run();
    expect(sentPrompt(bare.calls)).not.toContain("[inertia-");
    expect(sentPrompt(bare.calls)).toBe("Continue");

    const older = turnHarness(undefined, hostTools, { threadId: "thread-started-other-registry" });
    await older.run();
    const resumed = turnHarness("thread-started-other-registry", bridge, { prompt: promptWith(bridge.instructions ?? []) });
    await resumed.run();
    expect(sentPrompt(resumed.calls)).not.toContain("[inertia-workspace]");
  });

  it("advertises exact dynamic tools when opening a new provider thread", async () => {
    const harness = turnHarness();
    await harness.run();

    expect(harness.calls.find(({ method }) => method === "thread/start"))
      .toMatchObject({
        params: {
          dynamicTools: hostTools.definitions.map(({
            name,
            description,
            inputSchema,
          }) => ({ name, description, inputSchema })),
        },
      });
    expect(harness.calls.find(({ method }) => method === "turn/start"))
      .toMatchObject({
        params: {
          input: [{
            type: "text",
            text: "Inspect chats",
            text_elements: [],
          }],
        },
      });
  });

  it("resumes a post-migration tool-enabled thread without unsupported fields", async () => {
    const harness = turnHarness("thread-existing");
    await harness.run();

    expect(harness.calls.some(({ method }) => method === "thread/start"))
      .toBe(false);
    const resumed = harness.calls.find(
      ({ method }) => method === "thread/resume",
    );
    expect(resumed?.params).toMatchObject({ threadId: "thread-existing" });
    // Codex App Server 0.114.0 exposes dynamicTools only on thread/start.
    // Schema 65 invalidates sessions from before the current Browser tool
    // capability epoch, so persisted sessions here were provisioned with them.
    expect(resumed?.params).not.toHaveProperty("dynamicTools");
  });
});

describe("session instruction withholding", () => {
  const a = { label: "a", text: "Alpha." };
  const b = { label: "b", text: "Beta." };
  const c = { label: "c", text: "Gamma." };
  const block = "[a]\nAlpha.\n\n[b]\nBeta.\n\n[c]\nGamma.";

  it.each([
    [[a], "[b]\nBeta.\n\n[c]\nGamma."],
    [[b], "[a]\nAlpha.\n\n[c]\nGamma."],
    [[c], "[a]\nAlpha.\n\n[b]\nBeta."],
    [[a, c], "[b]\nBeta."],
    [[], block],
  ])("removes exact sections %j", (withheld, expected) => {
    expect(withoutSessionInstructions(block, withheld)).toBe(expected);
  });

  it("leaves partial matches and a missing block alone and reports an emptied block as absent", () => {
    expect(withoutSessionInstructions(block, [{ label: "b", text: "Bet" }])).toBe(block);
    expect(withoutSessionInstructions("[b]\nBeta. And more.", [b])).toBe("[b]\nBeta. And more.");
    expect(withoutSessionInstructions(undefined, [a])).toBeUndefined();
    expect(withoutSessionInstructions("[a]\nAlpha.", [a])).toBeUndefined();
  });
});
