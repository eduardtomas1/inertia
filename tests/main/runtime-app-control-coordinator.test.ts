import { describe, expect, it, vi } from "vitest";

import { RuntimeAppControlCoordinator, type RuntimeAppControlMainBroker } from "../../src/main/runtime-app-control-coordinator";
import { isRuntimeSecureFileBrokerEvent, RuntimeSecureFileCoordinator } from "../../src/main/runtime-secure-file-coordinator";
import type { RuntimeProcessRecord } from "../../src/main/runtime-supervisor-types";
import type { AppControlResult, RuntimeAppControlEvent } from "../../src/node/runtime-app-control-protocol";

const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  launchId: "44444444-4444-4444-8444-444444444444",
  pid: 4_321,
  processStartedAt: 1_760_000_000_000,
};
const window = "a".repeat(32);

function record(childPid: number | null = 7_000): RuntimeProcessRecord {
  return {
    appControlRequestIds: new Set(), agentBrowserRequestIds: new Set(), child: childPid === null ? undefined : { pid: childPid },
  } as unknown as RuntimeProcessRecord;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function request(requestId = crypto.randomUUID()): Extract<RuntimeAppControlEvent, { type: "runtime.app-control-request" }> {
  return { type: "runtime.app-control-request", requestId, identity, command: { command: "snapshot", window } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(accepts: (candidate: RuntimeProcessRecord) => boolean = () => true) {
  const operations: Array<{ signal: AbortSignal; settle: (result: AppControlResult) => void }> = [];
  const broker: RuntimeAppControlMainBroker = {
    perform: vi.fn(async (_identity, _command, signal: AbortSignal) => {
      const work = deferred<AppControlResult>();
      operations.push({ signal, settle: work.resolve });
      return await work.promise;
    }),
  };
  const post = vi.fn();
  return { broker, post, operations, coordinator: new RuntimeAppControlCoordinator({ broker, accepts, post }) };
}

describe("runtime App control coordinator", () => {
  it("performs one request with its exact identity and replies once", async () => {
    const { broker, post, operations, coordinator } = fixture();
    const peer = record();
    const event = request();
    coordinator.handle(peer, event);
    // Main names the asking runtime's own pid as the only parent the launch root may have.
    expect(broker.perform).toHaveBeenCalledWith(identity, { command: "snapshot", window }, expect.any(AbortSignal), { parentPids: [7_000] });
    operations[0]!.settle({ ok: true, value: { kind: "perform", rootKey: null, windowClosed: false } });
    await tick();
    expect(post).toHaveBeenCalledExactlyOnceWith(peer, {
      type: "runtime.app-control-result", requestId: event.requestId, result: { ok: true, value: { kind: "perform", rootKey: null, windowClosed: false } },
    });
  });

  it("refuses a reused request id, aborting the work it named, and remembers 512 ids per record", async () => {
    const { broker, post, operations, coordinator } = fixture();
    const peer = record();
    const event = request();
    coordinator.handle(peer, event);
    coordinator.handle(peer, event);
    expect(operations[0]!.signal.aborted).toBe(true);
    expect(post).toHaveBeenCalledExactlyOnceWith(peer, expect.objectContaining({ requestId: event.requestId, result: expect.objectContaining({ code: "invalid" }) }));
    operations[0]!.settle({ ok: false, code: "timeout", reason: null, dispatched: false });
    await tick();
    expect(post).toHaveBeenCalledOnce();
    expect(broker.perform).toHaveBeenCalledOnce();
    for (let index = 0; index < 600; index += 1) coordinator.handle(peer, request());
    expect(peer.appControlRequestIds.size).toBe(512);
    // Another runtime record keeps its own replay set.
    const other = record();
    coordinator.handle(other, event);
    expect(broker.perform).toHaveBeenCalledTimes(602);
    coordinator.clear(peer);
    coordinator.clear(other);
  });

  it("cancels only when the record and every identity field match", async () => {
    const { post, operations, coordinator } = fixture();
    const peer = record();
    const event = request();
    coordinator.handle(peer, event);
    for (const key of ["conversationId", "runId", "turnId", "launchId"] as const) {
      coordinator.handle(peer, { type: "runtime.app-control-cancel", requestId: event.requestId, identity: { ...identity, [key]: "66666666-6666-4666-8666-666666666666" } });
    }
    coordinator.handle(peer, { type: "runtime.app-control-cancel", requestId: event.requestId, identity: { ...identity, pid: 99 } });
    coordinator.handle(peer, { type: "runtime.app-control-cancel", requestId: event.requestId, identity: { ...identity, processStartedAt: 1 } });
    coordinator.handle(record(), { type: "runtime.app-control-cancel", requestId: event.requestId, identity });
    expect(operations[0]!.signal.aborted).toBe(false);
    coordinator.handle(peer, { type: "runtime.app-control-cancel", requestId: event.requestId, identity });
    expect(operations[0]!.signal.aborted).toBe(true);
    operations[0]!.settle({ ok: false, code: "cancelled", reason: null, dispatched: false });
    await tick();
    // A cancelled request gets no late reply.
    expect(post).not.toHaveBeenCalled();
  });

  it("drops late results after clear and after the runtime was replaced", async () => {
    let current = record();
    const { post, operations, coordinator } = fixture((candidate) => candidate === current);
    const first = current;
    coordinator.handle(first, request());
    coordinator.handle(first, request());
    coordinator.clear(first);
    expect(operations.map(({ signal }) => signal.aborted)).toEqual([true, true]);
    operations[0]!.settle({ ok: false, code: "timeout", reason: null, dispatched: false });
    await tick();
    expect(post).not.toHaveBeenCalled();
    coordinator.handle(first, request());
    current = record();
    operations[2]!.settle({ ok: true, value: { kind: "windows", windows: [], omitted: 0 } });
    await tick();
    expect(post).not.toHaveBeenCalled();
    // A replaced runtime is told the service is unavailable without reaching it.
    coordinator.handle(first, request());
    expect(post).toHaveBeenCalledWith(first, expect.objectContaining({ result: expect.objectContaining({ code: "unavailable" }) }));
    expect(operations).toHaveLength(3);
  });

  it("passes each runtime record's own pid, and none for a record without a live child", () => {
    const { broker, coordinator } = fixture();
    coordinator.handle(record(8_123), request());
    coordinator.handle(record(null), request());
    coordinator.handle(record(-1), request());
    expect((broker.perform as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[3])).toEqual([
      { parentPids: [8_123] }, { parentPids: [] }, { parentPids: [] },
    ]);
  });

  it("answers a malformed command invalid and a missing broker unavailable", () => {
    const post = vi.fn();
    const peer = record();
    new RuntimeAppControlCoordinator({ accepts: () => true, post }).handle(peer, request());
    expect(post).toHaveBeenLastCalledWith(peer, expect.objectContaining({ result: { ok: false, code: "unavailable", reason: null, dispatched: false } }));
    const { coordinator, broker } = fixture();
    coordinator.handle(peer, { ...request(), command: null });
    expect(broker.perform).not.toHaveBeenCalled();
  });

  it("is registered with the secure-file coordinator and cleared with it", async () => {
    const operations: AbortSignal[] = [];
    const appControlBroker: RuntimeAppControlMainBroker = {
      perform: async (_identity, _command, signal) => {
        operations.push(signal);
        return await new Promise<AppControlResult>(() => undefined);
      },
    };
    const coordinator = new RuntimeSecureFileCoordinator({ appControlBroker, accepts: () => true, post: vi.fn() });
    const peer = record();
    const event = request();
    expect(isRuntimeSecureFileBrokerEvent(event)).toBe(true);
    expect(isRuntimeSecureFileBrokerEvent({ type: "runtime.app-control-cancel", requestId: event.requestId, identity })).toBe(true);
    coordinator.handle(peer, event);
    expect(operations).toHaveLength(1);
    coordinator.clear(peer);
    expect(operations[0]!.aborted).toBe(true);
  });
});
