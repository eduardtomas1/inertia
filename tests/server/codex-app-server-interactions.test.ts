import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerEvents,
  type CodexAppServerEventHost,
} from "../../src/server/codex/app-server-events";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import { CappedTextBuffer, type JsonObject } from "../../src/server/codex/protocol";
import type { AgentInputRequest } from "../../src/server/provider/interactions";

const ROOT_THREAD_ID = "interaction-root";
const ROOT_TURN_ID = "interaction-turn";

function inputParams(
  threadId = ROOT_THREAD_ID,
  turnId = ROOT_TURN_ID,
  itemId = "input-item",
): JsonObject {
  return {
    threadId,
    turnId,
    itemId,
    questions: [{
      id: "choice",
      header: "Direction",
      question: "Which path should Codex take?",
      options: [{ label: "Safe", description: "Use the bounded path." }],
    }],
  };
}

function interactionHarness() {
  let phase: CodexRunPhase = "running";
  let activeTurnId: string | undefined = ROOT_TURN_ID;
  const inputs: AgentInputRequest[] = [];
  const writes: JsonObject[] = [];
  const cancel = vi.fn();
  const rememberFailure = vi.fn();
  const host: CodexAppServerEventHost = {
    options: {
      executable: "/fake/codex",
      environment: {},
      cwd: "/workspace",
      prompt: "Exercise interactions",
      planMode: false,
      access: "full",
      onInputRequest: (request) => inputs.push(request),
    },
    resultText: new CappedTextBuffer(1_024),
    isSettled: () => phase === "settled",
    phase: () => phase,
    setPhase: (value) => {
      phase = value;
    },
    providerThreadId: () => ROOT_THREAD_ID,
    activeTurnId: () => activeTurnId,
    setActiveTurnId: (value) => {
      activeTurnId = value;
    },
    cancelRequested: () => false,
    lastError: () => undefined,
    setLastError: vi.fn(),
    setLastProtocolMethod: vi.fn(),
    setLastActivityId: vi.fn(),
    setTerminalEvent: vi.fn(),
    writeMessage: (message) => {
      writes.push(message);
      return true;
    },
    cancel,
    finish: vi.fn(),
    rememberFailure,
  };
  return {
    cancel,
    events: new CodexAppServerEvents(host),
    inputs,
    rememberFailure,
    writes,
  };
}

describe("Codex App Server interaction ownership", () => {
  it.each([
    ["foreign-thread", ROOT_TURN_ID],
    [ROOT_THREAD_ID, "foreign-turn"],
  ])("rejects user input outside the owned turn: %s/%s", (threadId, turnId) => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "foreign-input",
        "item/tool/requestUserInput",
        inputParams(threadId, turnId),
      );

      expect(harness.inputs).toEqual([]);
      expect(harness.writes).toContainEqual({
        id: "foreign-input",
        error: {
          code: -32602,
          message: "Codex sent a user-input request for a different provider turn.",
        },
      });
      expect(harness.cancel).toHaveBeenCalledOnce();
    } finally {
      harness.events.dispose();
    }
  });

  it("accepts input only for the exact active turn of an owned child", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleNotification("item/completed", {
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: {
          type: "subAgentActivity",
          id: "child-call",
          kind: "started",
          agentThreadId: "input-child",
          agentPath: "/root/input-child",
        },
      });
      harness.events.handleNotification("turn/started", {
        threadId: "input-child",
        turn: { id: "input-child-turn", status: "inProgress" },
      });
      harness.events.handleServerRequest(
        "child-input",
        "item/tool/requestUserInput",
        inputParams("input-child", "input-child-turn"),
      );

      expect(harness.inputs).toHaveLength(1);
      expect(harness.cancel).not.toHaveBeenCalled();
    } finally {
      harness.events.dispose();
    }
  });

  it("fails closed when a pending server request id is reused", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "duplicate-id",
        "item/tool/requestUserInput",
        inputParams(),
      );
      harness.events.handleServerRequest(
        "duplicate-id",
        "item/tool/requestUserInput",
        inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, "second-item"),
      );

      expect(harness.inputs).toHaveLength(1);
      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(harness.rememberFailure).toHaveBeenCalledWith(
        "malformed-protocol",
        "Codex sent an ambiguous server request.",
        "Codex reused an outstanding JSON-RPC request id.",
      );
      expect(harness.writes).toEqual([]);
    } finally {
      harness.events.dispose();
    }
  });

  it("bounds concurrent server requests and releases resolved ids", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "reusable-id",
        "item/tool/requestUserInput",
        inputParams(),
      );
      harness.events.handleNotification("serverRequest/resolved", {
        requestId: "reusable-id",
      });
      harness.events.handleServerRequest(
        "reusable-id",
        "item/tool/requestUserInput",
        inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, "replacement-item"),
      );
      for (let index = 0; index < 31; index += 1) {
        harness.events.handleServerRequest(
          `bounded-${index}`,
          "item/tool/requestUserInput",
          inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, `item-${index}`),
        );
      }
      harness.events.handleServerRequest(
        "overflow-request",
        "item/tool/requestUserInput",
        inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, "overflow-item"),
      );

      expect(harness.inputs).toHaveLength(33);
      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(harness.writes).toContainEqual({
        id: "overflow-request",
        error: {
          code: -32600,
          message: "Codex exceeded the 32-request interaction limit.",
        },
      });
    } finally {
      harness.events.dispose();
    }
  });
});
