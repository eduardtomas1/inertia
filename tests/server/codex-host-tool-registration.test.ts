// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import {
  openCodexTurn,
} from "../../src/server/codex/app-server-run";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import type { JsonObject } from "../../src/server/codex/protocol";
import type { CodexAppServerOptions } from "../../src/server/codex/types";
import { AGENT_BROWSER_TOOL_DEFINITIONS } from "../../src/server/runtime/agent-browser-host-tools";

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

function turnHarness(sessionId?: string, tools = hostTools): {
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
    prompt: sessionId ? "Continue" : "Inspect chats",
    planMode: false,
    access: "supervised",
    hostTools: tools,
    ...(sessionId ? { sessionId } : {}),
  };
  return {
    calls,
    run: () => openCodexTurn({
      options,
      modelProvider: undefined,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "initialize") return { userAgent: "fake" };
        if (method === "thread/start" || method === "thread/resume") {
          return { thread: { id: sessionId ?? THREAD_ID }, model: "fake" };
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
