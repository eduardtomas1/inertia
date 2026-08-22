import { describe, expect, it, vi } from "vitest";

import { RuntimeAgentBrowserCoordinator } from "../../src/main/runtime-agent-browser-coordinator";
import type { RuntimeProcessRecord } from "../../src/main/runtime-supervisor-types";

const conversationId = "11111111-1111-4111-8111-111111111111";

function record(): RuntimeProcessRecord {
  return { agentBrowserRequestIds: new Set() } as RuntimeProcessRecord;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("runtime agent browser coordinator", () => {
  it("binds one request to the accepted runtime and rejects reused identities", async () => {
    const operation = deferred<{ ok: false; code: "not-found"; message: string }>();
    let signal: AbortSignal | undefined;
    const broker = {
      perform: vi.fn(async (_conversationId, _command, candidate?: AbortSignal) => {
        signal = candidate;
        return await operation.promise;
      }),
    };
    const post = vi.fn();
    const peer = record();
    const coordinator = new RuntimeAgentBrowserCoordinator({
      broker,
      accepts: (candidate) => candidate === peer,
      post,
    });
    const requestId = crypto.randomUUID();
    const event = {
      type: "runtime.agent-browser-request" as const,
      requestId,
      conversationId,
      command: { action: "snapshot" as const },
    };
    coordinator.handle(peer, event);
    coordinator.handle(peer, event);
    expect(signal?.aborted).toBe(true);
    expect(post).toHaveBeenCalledWith(peer, expect.objectContaining({
      requestId,
      result: expect.objectContaining({ ok: false, code: "invalid" }),
    }));
    operation.resolve({ ok: false, code: "not-found", message: "No page" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(post).toHaveBeenCalledOnce();
    expect(broker.perform).toHaveBeenCalledOnce();
  });

  it("aborts exact pending work on cancel and suppresses late replies after clear", async () => {
    const operation = deferred<{ ok: false; code: "not-found"; message: string }>();
    let signal: AbortSignal | undefined;
    const broker = {
      perform: vi.fn(async (_conversationId, _command, candidate?: AbortSignal) => {
        signal = candidate;
        return await operation.promise;
      }),
    };
    const post = vi.fn();
    const peer = record();
    const coordinator = new RuntimeAgentBrowserCoordinator({ broker, accepts: () => true, post });
    const requestId = crypto.randomUUID();
    coordinator.handle(peer, {
      type: "runtime.agent-browser-request",
      requestId,
      conversationId,
      command: { action: "click", ref: "e1" },
    });
    coordinator.handle(peer, {
      type: "runtime.agent-browser-cancel",
      requestId,
      conversationId,
    });
    expect(signal?.aborted).toBe(true);
    coordinator.clear(peer);
    operation.resolve({ ok: false, code: "not-found", message: "late" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(post).not.toHaveBeenCalled();
  });
});
