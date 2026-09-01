import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCommandSchema,
  defaultSettings,
} from "../../src/shared/contracts";
import { useInertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

const parserLoad = vi.hoisted(() => ({ attempts: 0 }));

vi.mock("@shared/contracts/server-event-schema", async () => {
  parserLoad.attempts += 1;
  if (parserLoad.attempts === 1) throw new Error("temporary chunk failure");
  return vi.importActual("@shared/contracts/server-event-schema");
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    this.readyState = 2;
  });

  finishClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  Reflect.deleteProperty(window, "inertia");
});

describe("connection parser recovery", () => {
  it("reconnects after a transient parser load failure without a zero-delay spin", async () => {
    const getRuntimeConnection = vi.fn(async () => ({
      websocketUrl: "ws://127.0.0.1:12345/runtime/test",
    }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getRuntimeConnection },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const hook = renderHook(() => useInertiaConnection());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0]!;
    const listener = vi.fn();
    const unsubscribe = hook.result.current.subscribe(listener);
    let pendingOutcome = "pending";
    void hook.result.current.sendCommand(clientCommandSchema.parse({
      type: "app.refresh",
      requestId: "11111111-1111-4111-8111-111111111111",
    })).then(
      () => { pendingOutcome = "resolved"; },
      () => { pendingOutcome = "rejected"; },
    );

    vi.useFakeTimers();
    act(() => {
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "runtime.ready" }),
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(firstSocket.close).toHaveBeenCalledOnce();
    expect(hook.result.current.status).not.toBe("online");
    expect(parserLoad.attempts).toBe(1);

    const ignoredSync = {
      runtimeGeneration: "runtime-condemned-socket",
      latestSequence: 0,
    };
    act(() => {
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "server.welcome",
          protocolVersion: 1,
          snapshot: {
            projects: [],
            conversations: [],
            runs: [],
            providers: [],
            settings: defaultSettings,
            activeProjectId: null,
            activeConversationId: null,
            sync: ignoredSync,
          },
          sync: ignoredSync,
        }),
      }));
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "runtime.sync.completed", sync: ignoredSync }),
      }));
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "request.ok",
          requestId: "11111111-1111-4111-8111-111111111111",
        }),
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.snapshot).toBeNull();
    expect(hook.result.current.status).not.toBe("online");
    expect(listener).not.toHaveBeenCalled();
    expect(pendingOutcome).toBe("pending");
    firstSocket.finishClose();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.status).toBe("offline");
    expect(pendingOutcome).toBe("rejected");

    await act(async () => vi.advanceTimersByTimeAsync(599));
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(parserLoad.attempts).toBe(1);

    const secondSocket = FakeWebSocket.instances[1]!;
    const sync = { runtimeGeneration: "runtime-parser-recovery", latestSequence: 0 };
    act(() => {
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "server.welcome",
          protocolVersion: 1,
          snapshot: {
            projects: [],
            conversations: [],
            runs: [],
            providers: [],
            settings: defaultSettings,
            activeProjectId: null,
            activeConversationId: null,
            sync,
          },
          sync,
        }),
      }));
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ type: "runtime.sync.completed", sync }),
      }));
    });
    await vi.waitFor(() => expect(hook.result.current.status).toBe("online"));
    expect(hook.result.current.error).toBeNull();
    expect(parserLoad.attempts).toBe(2);

    const listenerCallsBeforeGap = listener.mock.calls.length;
    let gapRequestOutcome = "pending";
    void hook.result.current.sendCommand(clientCommandSchema.parse({
      type: "app.refresh",
      requestId: "22222222-2222-4222-8222-222222222222",
    })).then(
      () => { gapRequestOutcome = "resolved"; },
      () => { gapRequestOutcome = "rejected"; },
    );
    act(() => {
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "runtime.cursor",
          sync: {
            runtimeGeneration: sync.runtimeGeneration,
            latestSequence: 2,
          },
        }),
      }));
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "request.ok",
          requestId: "22222222-2222-4222-8222-222222222222",
        }),
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(secondSocket.close).toHaveBeenCalledOnce();
    expect(gapRequestOutcome).toBe("pending");
    expect(listener).toHaveBeenCalledTimes(listenerCallsBeforeGap);
    secondSocket.finishClose();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(gapRequestOutcome).toBe("rejected");
    expect(FakeWebSocket.instances).toHaveLength(3);
    const authoritativeSocket = FakeWebSocket.instances[2]!;
    expect(authoritativeSocket.url)
      .toBe("ws://127.0.0.1:12345/runtime/test");
    const authoritativeSync = {
      runtimeGeneration: "runtime-authoritative-refresh",
      latestSequence: 0,
    };
    act(() => {
      authoritativeSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "server.welcome",
          protocolVersion: 1,
          snapshot: {
            projects: [],
            conversations: [],
            runs: [],
            providers: [],
            settings: defaultSettings,
            activeProjectId: null,
            activeConversationId: null,
            sync: authoritativeSync,
          },
          sync: authoritativeSync,
        }),
      }));
      authoritativeSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "runtime.sync.completed",
          sync: authoritativeSync,
        }),
      }));
    });
    await vi.waitFor(() => expect(hook.result.current.status).toBe("online"));
    expect(hook.result.current.runtimeGeneration)
      .toBe(authoritativeSync.runtimeGeneration);

    act(() => {
      authoritativeSocket.dispatchEvent(new MessageEvent("message", { data: "{" }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(authoritativeSocket.close).toHaveBeenCalledOnce();
    authoritativeSocket.finishClose();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(599));
    expect(FakeWebSocket.instances).toHaveLength(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(4);

    const thirdSocket = FakeWebSocket.instances[3]!;
    act(() => {
      thirdSocket.dispatchEvent(new MessageEvent("message", { data: "{" }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(thirdSocket.close).toHaveBeenCalledOnce();
    thirdSocket.finishClose();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(1_199));
    expect(FakeWebSocket.instances).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(FakeWebSocket.instances).toHaveLength(5);

    const fourthSocket = FakeWebSocket.instances[4]!;
    const acceptedGeneration = hook.result.current.runtimeGeneration;
    const listenerCalls = listener.mock.calls.length;
    const ignoredAfterError = {
      runtimeGeneration: "runtime-after-socket-error",
      latestSequence: 0,
    };
    act(() => {
      fourthSocket.dispatchEvent(new Event("error"));
      fourthSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "server.welcome",
          protocolVersion: 1,
          snapshot: {
            projects: [],
            conversations: [],
            runs: [],
            providers: [],
            settings: defaultSettings,
            activeProjectId: null,
            activeConversationId: null,
            sync: ignoredAfterError,
          },
          sync: ignoredAfterError,
        }),
      }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fourthSocket.close).toHaveBeenCalledOnce();
    expect(hook.result.current.runtimeGeneration).toBe(acceptedGeneration);
    expect(listener).toHaveBeenCalledTimes(listenerCalls);
    fourthSocket.finishClose();
    unsubscribe();
  });
});
