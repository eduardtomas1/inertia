import { describe, expect, it, vi } from "vitest";

import type { AgentTurn } from "../../src/shared/contracts";
import { CHECKPOINT_CAPTURE_EFFECT_KIND } from "../../src/server/orchestration-v2/effect-runtime";
import { checkpointCaptureExecutor } from "../../src/server/runtime/checkpoint-capture-executor";

function makeTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: "turn-1",
    conversationId: "conv-1",
    runId: "run-1",
    checkpointId: "cp-1",
    terminalAssistantMessageId: "msg-1",
    ...overrides,
  } as AgentTurn;
}

describe("checkpointCaptureExecutor D.6 post-capture hooks", () => {
  it("invokes onAfterCapture and retryDelegatedBookkeeping after finalize and invalidate", async () => {
    const order: string[] = [];
    let handler: ((request: { conversationId: string; runId: string; turnId: string }) => Promise<void>) | undefined;
    const turn = makeTurn();

    const register = checkpointCaptureExecutor({
      effects: {
        register: (kind, fn) => {
          expect(kind).toBe(CHECKPOINT_CAPTURE_EFFECT_KIND);
          handler = fn as typeof handler;
          return () => undefined;
        },
      },
      store: { agentTurn: () => turn },
      artifacts: {
        finalize: async () => { order.push("finalize"); },
      },
      invalidate: () => { order.push("invalidate"); },
      onAfterCapture: async (ctx) => {
        expect(ctx).toEqual({ conversationId: "conv-1", runId: "run-1", turnId: "turn-1", turn });
        order.push("onAfterCapture");
      },
      retryDelegatedBookkeeping: async (ctx) => {
        expect(ctx.turnId).toBe("turn-1");
        order.push("retryDelegatedBookkeeping");
      },
    });

    register();
    await handler!({ conversationId: "conv-1", runId: "run-1", turnId: "turn-1" });
    expect(order).toEqual(["finalize", "invalidate", "onAfterCapture", "retryDelegatedBookkeeping"]);
  });

  it("isolates errors from post-capture hooks so checkpoint capture settles cleanly", async () => {
    let handler: ((request: { conversationId: string; runId: string; turnId: string }) => Promise<void>) | undefined;
    const onAfterCaptureError = vi.fn();
    const retryDelegatedBookkeeping = vi.fn(async () => undefined);
    const turn = makeTurn();

    const register = checkpointCaptureExecutor({
      effects: {
        register: (_kind, fn) => { handler = fn as typeof handler; return () => undefined; },
      },
      store: { agentTurn: () => turn },
      artifacts: { finalize: vi.fn(async () => undefined) },
      invalidate: vi.fn(),
      onAfterCapture: async () => { throw new Error("transient bookkeeping error"); },
      retryDelegatedBookkeeping,
      onAfterCaptureError,
    });

    register();
    await expect(handler!({ conversationId: "conv-1", runId: "run-1", turnId: "turn-1" })).resolves.toBeUndefined();
    expect(onAfterCaptureError).toHaveBeenCalledOnce();
    expect(retryDelegatedBookkeeping).toHaveBeenCalledOnce();
  });

  it("skips post-capture hooks when turn lookup fails or identity mismatches", async () => {
    let handler: ((request: { conversationId: string; runId: string; turnId: string }) => Promise<void>) | undefined;
    const onAfterCapture = vi.fn();
    const finalize = vi.fn(async () => undefined);

    const register = checkpointCaptureExecutor({
      effects: {
        register: (_kind, fn) => { handler = fn as typeof handler; return () => undefined; },
      },
      store: { agentTurn: () => makeTurn({ runId: "other-run" }) },
      artifacts: { finalize },
      invalidate: vi.fn(),
      onAfterCapture,
    });

    register();
    await handler!({ conversationId: "conv-1", runId: "run-1", turnId: "turn-1" });
    expect(finalize).not.toHaveBeenCalled();
    expect(onAfterCapture).not.toHaveBeenCalled();
  });
});
