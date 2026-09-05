import { describe, expect, it } from "vitest";

import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import type { AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import {
  createOpenCodeEventState,
  emitOpenCodeNextActivity,
  handleOpenCodePart,
  openCodeCanonicalResult,
  rememberOpenCodeMessageRole,
  removeOpenCodePart,
  settleOpenCodePromptOutput,
  type OpenCodeUsageState,
} from "../../src/server/provider/opencode-event-projection";
import { CappedProviderBuffer } from "../../src/server/provider/io";

function usageState(): OpenCodeUsageState {
  return {
    maxTokens: null,
    currentContextTokens: null,
    messages: new Map(),
    totalProcessedTokens: 0,
    unknownTotalMessages: 0,
    last: null,
    compactsAutomatically: null,
  };
}

describe("OpenCode event projection", () => {
  it("reconciles corrected and removed text with item-aware full-turn snapshots", () => {
    const events: AgentHarnessEvent[] = [];
    const emitter = createAgentHarnessEmitter(
      "opencode",
      "conversation",
      { onEvent: (event) => events.push(event) },
      "run",
      "turn",
    );
    const state = createOpenCodeEventState();
    const emittedParts = new Map<string, string>();
    const result = new CappedProviderBuffer(1024);
    rememberOpenCodeMessageRole("assistant", "assistant", state);

    handleOpenCodePart(
      {
        id: "part",
        messageID: "assistant",
        type: "text",
        text: "Draft answer",
      },
      emittedParts,
      result,
      emitter,
      usageState(),
      state,
    );
    handleOpenCodePart(
      {
        id: "part",
        messageID: "assistant",
        type: "text",
        text: "Correct answer",
      },
      emittedParts,
      result,
      emitter,
      usageState(),
      state,
    );
    removeOpenCodePart("part", emittedParts, state, emitter);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        itemId: "part",
        text: "Draft answer",
      }),
      expect.objectContaining({
        type: "text-snapshot",
        itemId: "part",
        text: "Correct answer",
      }),
      expect.objectContaining({
        type: "text-snapshot",
        itemId: "part",
        text: "",
      }),
    ]));
    expect(openCodeCanonicalResult(emittedParts, state)).toEqual({
      text: "",
      truncated: false,
    });
  });

  it("reclaims finalized correlations across arbitrarily long sequential output", () => {
    const emitter = createAgentHarnessEmitter(
      "opencode",
      "conversation",
      undefined,
      "run",
      "turn",
    );
    const state = createOpenCodeEventState();
    const usage = usageState();
    const emittedParts = new Map<string, string>();
    const result = new CappedProviderBuffer(64 * 1024);

    for (let index = 0; index < 5_000; index += 1) {
      const promptId = `prompt-${index}`;
      const assistantId = `assistant-${index}`;
      rememberOpenCodeMessageRole(promptId, "other", state);
      rememberOpenCodeMessageRole(assistantId, "assistant", state);
      usage.messages.set(assistantId, {
        total: 1,
        input: 1,
        cachedRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
      });
      handleOpenCodePart(
        {
          id: `part-${index}`,
          messageID: assistantId,
          type: "text",
          text: "x",
        },
        emittedParts,
        result,
        emitter,
        usage,
        state,
      );
      settleOpenCodePromptOutput(
        promptId,
        [assistantId],
        emittedParts,
        state,
        usage,
      );
    }

    expect(state.messageRoles.size).toBe(0);
    expect(state.parts.size).toBe(0);
    expect(state.pendingDeltas.size).toBe(0);
    expect(emittedParts.size).toBe(0);
    expect(usage.messages.size).toBe(0);
    expect(openCodeCanonicalResult(emittedParts, state).text).toHaveLength(5_000);
  });

  it("keeps progress on one running activity and reclaims terminal calls", () => {
    const events: AgentHarnessEvent[] = [];
    const emitter = createAgentHarnessEmitter(
      "opencode",
      "conversation",
      { onEvent: (event) => events.push(event) },
      "run",
      "turn",
    );
    const state = createOpenCodeEventState();

    for (let index = 0; index < 5_000; index += 1) {
      const properties = {
        callID: `call-${index}`,
        assistantMessageID: "assistant",
        tool: "read",
      };
      emitOpenCodeNextActivity(
        "session.next.tool.called",
        properties,
        emitter,
        state,
      );
      emitOpenCodeNextActivity(
        "session.next.tool.progress",
        { ...properties, content: "working" },
        emitter,
        state,
      );
      emitOpenCodeNextActivity(
        "session.next.tool.success",
        { ...properties, result: "done" },
        emitter,
        state,
      );
    }

    expect(state.activities.size).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "activity",
      activityId: "call-0",
      phase: "started",
    }));
    expect(events.filter((event) =>
      event.type === "activity" && event.activityId === "call-0"))
      .toHaveLength(3);
  });
});
