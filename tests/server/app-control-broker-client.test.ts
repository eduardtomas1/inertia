import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAppControlEvent } from "../../src/node/runtime-app-control-protocol";
import { RuntimeAppControlBrokerClient } from "../../src/server/runtime/app-under-test/app-control-broker-client";

const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  launchId: "44444444-4444-4444-8444-444444444444",
  pid: 4_321,
  processStartedAt: 1_760_000_000_000,
};
const window = "a".repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function channel() {
  const posted: RuntimeAppControlEvent[] = [];
  return { posted, post: (event: RuntimeAppControlEvent) => { posted.push(event); } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime App control broker client", () => {
  it("posts one fresh request id per call over the runtime channel and resolves its result once", async () => {
    const { posted, post } = channel();
    const client = new RuntimeAppControlBrokerClient(post);
    const first = client.perform(identity, { command: "snapshot", window });
    const second = client.perform(identity, { command: "windows" });
    expect(posted).toHaveLength(2);
    const [a, b] = posted as Extract<RuntimeAppControlEvent, { type: "runtime.app-control-request" }>[];
    expect(a).toEqual({ type: "runtime.app-control-request", requestId: expect.stringMatching(UUID), identity, command: { command: "snapshot", window } });
    expect(b!.requestId).not.toBe(a!.requestId);
    expect(client.handle({ type: "runtime.app-control-result", requestId: b!.requestId, result: { ok: true, value: { kind: "windows", windows: [], omitted: 0 } } })).toBe(true);
    await expect(second).resolves.toEqual({ ok: true, value: { kind: "windows", windows: [], omitted: 0 } });
    // A result of the wrong kind is never handed to another command.
    expect(client.handle({ type: "runtime.app-control-result", requestId: a!.requestId, result: { ok: true, value: { kind: "windows", windows: [], omitted: 0 } } })).toBe(true);
    await expect(first).resolves.toEqual({ ok: false, code: "native-failure", reason: null, dispatched: false });
    // Late and repeated results are dropped.
    expect(client.handle({ type: "runtime.app-control-result", requestId: a!.requestId, result: { ok: false, code: "timeout", reason: null, dispatched: false } })).toBe(false);
    expect(client.pendingCount).toBe(0);
  });

  it("keeps at most 16 requests pending", async () => {
    const { posted, post } = channel();
    const client = new RuntimeAppControlBrokerClient(post);
    for (let index = 0; index < 16; index += 1) void client.perform(identity, { command: "windows" });
    await expect(client.perform(identity, { command: "windows" })).resolves.toMatchObject({ ok: false, code: "busy", dispatched: false });
    expect(posted).toHaveLength(16);
    client.close();
  });

  it("cancels in main when the call is aborted, and reports a possibly dispatched action", async () => {
    const { posted, post } = channel();
    const client = new RuntimeAppControlBrokerClient(post);
    const controller = new AbortController();
    const pending = client.perform(identity, {
      command: "perform", window, element: window, action: "press", text: null, expect: null,
    }, controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, code: "cancelled", reason: null, dispatched: true });
    expect(posted.at(-1)).toEqual({ type: "runtime.app-control-cancel", requestId: posted[0]!.requestId, identity });
    expect(client.handle({ type: "runtime.app-control-result", requestId: posted[0]!.requestId, result: { ok: true, value: { kind: "perform", rootKey: null, windowClosed: false } } })).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    await expect(client.perform(identity, { command: "windows" }, aborted.signal)).resolves.toMatchObject({ code: "cancelled" });
    expect(posted).toHaveLength(2);
  });

  it("gives up after the 90-second backstop, cancelling the request in main", async () => {
    vi.useFakeTimers();
    const { posted, post } = channel();
    const client = new RuntimeAppControlBrokerClient(post, 1_000_000);
    const pending = client.perform(identity, { command: "snapshot", window });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(posted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, code: "timeout", reason: null, dispatched: false });
    expect(posted[1]).toMatchObject({ type: "runtime.app-control-cancel", requestId: posted[0]!.requestId });
  });

  it("answers everything unavailable once closed", async () => {
    const { posted, post } = channel();
    const client = new RuntimeAppControlBrokerClient(post);
    const pending = client.perform(identity, { command: "windows" });
    client.close();
    await expect(pending).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(posted.at(-1)).toMatchObject({ type: "runtime.app-control-cancel" });
    await expect(client.perform(identity, { command: "windows" })).resolves.toMatchObject({ code: "unavailable" });
  });
});
