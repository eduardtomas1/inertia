import { describe, expect, it, vi } from "vitest";

import { RuntimeAgentBrowserBrokerClient } from "../../src/server/runtime/agent-browser-broker-client";
import type { RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

const conversationId = "11111111-1111-4111-8111-111111111111";

describe("runtime agent browser broker client", () => {
  it("correlates one result and ignores a late duplicate", async () => {
    const events: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAgentBrowserBrokerClient((event) => events.push(event), 1_000);
    const result = client.perform(conversationId, { action: "snapshot" });
    const request = events[0]!;
    const reply = {
      type: "runtime.agent-browser-result" as const,
      requestId: (request as { requestId: string }).requestId,
      result: { ok: false as const, code: "not-found" as const, message: "No page" },
    };
    expect(client.handle(reply)).toBe(true);
    await expect(result).resolves.toEqual(reply.result);
    expect(client.handle(reply)).toBe(false);
  });

  it("sends one exact cancellation and rejects late settlement after abort", async () => {
    const events: RuntimeWorkerEvent[] = [];
    const controller = new AbortController();
    const client = new RuntimeAgentBrowserBrokerClient((event) => events.push(event), 1_000);
    const result = client.perform(conversationId, { action: "click", ref: "e1" }, controller.signal);
    const requestId = (events[0] as { requestId: string }).requestId;
    controller.abort();
    await expect(result).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(events).toEqual([
      expect.objectContaining({ type: "runtime.agent-browser-request", requestId, conversationId }),
      { type: "runtime.agent-browser-cancel", requestId, conversationId },
    ]);
    expect(client.handle({
      type: "runtime.agent-browser-result",
      requestId,
      result: { ok: false, code: "unavailable", message: "late" },
    })).toBe(false);
  });

  it("times out with a correlated cancel and settles all pending work on close", async () => {
    vi.useFakeTimers();
    try {
      const events: RuntimeWorkerEvent[] = [];
      const client = new RuntimeAgentBrowserBrokerClient((event) => events.push(event), 20);
      const timedOut = client.perform(conversationId, { action: "snapshot" });
      await vi.advanceTimersByTimeAsync(20);
      await expect(timedOut).resolves.toMatchObject({ ok: false, code: "unavailable" });
      expect(events.at(-1)).toMatchObject({
        type: "runtime.agent-browser-cancel",
        requestId: (events[0] as { requestId: string }).requestId,
      });
      const stopped = client.perform(conversationId, { action: "tabs" });
      const closeRequestId = (events.at(-1) as { requestId: string }).requestId;
      client.close();
      await expect(stopped).resolves.toMatchObject({ ok: false, code: "unavailable" });
      expect(events.at(-1)).toMatchObject({
        type: "runtime.agent-browser-cancel",
        requestId: closeRequestId,
        conversationId,
      });
      await expect(client.perform(conversationId, { action: "tabs" }))
        .resolves.toMatchObject({ ok: false, code: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
});
