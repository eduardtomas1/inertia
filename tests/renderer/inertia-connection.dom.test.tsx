import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCommandSchema,
  MAX_WORKSPACE_FILE_EDIT_BYTES,
} from "../../src/shared/contracts";
import { useInertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";
import { runtimeCommandDelivery } from "../../src/renderer/src/utils/connectionMessages";

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "inertia");
});

describe("useInertiaConnection", () => {
  it("reconnects immediately when the utility runtime announces readiness", async () => {
    let announceReady: (() => void) | undefined;
    const getRuntimeConnection = vi.fn()
      .mockRejectedValueOnce(new Error("The local service is starting."))
      .mockResolvedValue({
        websocketUrl: "ws://127.0.0.1:12345/runtime/test",
      });
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRuntimeConnection,
        onRuntimeReady: vi.fn((listener: () => void) => {
          announceReady = listener;
          return vi.fn();
        }),
      },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);

    renderHook(() => useInertiaConnection());
    await waitFor(() => expect(getRuntimeConnection).toHaveBeenCalledTimes(1));
    expect(FakeWebSocket.instances).toHaveLength(0);

    announceReady?.();

    await waitFor(() => expect(getRuntimeConnection).toHaveBeenCalledTimes(2));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("rejects an escaped oversized command without sending or closing", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRuntimeConnection: vi.fn(async () => ({
          websocketUrl: "ws://127.0.0.1:12345/runtime/test",
        })),
      },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const hook = renderHook(() => useInertiaConnection());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const command = clientCommandSchema.parse({
      type: "workspace.file.write",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        projectId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        path: "src/example.ts",
        authorityRef: "44444444-4444-4444-8444-444444444444",
        expectedDigest: "a".repeat(64),
        content: "\0".repeat(
          Math.min(MAX_WORKSPACE_FILE_EDIT_BYTES, 50_000),
        ),
      },
    });

    await expect(hook.result.current.sendCommand(command))
      .rejects.toThrow("The request is too large to send.");
    expect(FakeWebSocket.instances[0]?.send).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]?.close).not.toHaveBeenCalled();
  });

  it("forces authoritative reconciliation after an ambiguous timeout", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRuntimeConnection: vi.fn(async () => ({
          websocketUrl: "ws://127.0.0.1:12345/runtime/test",
        })),
      },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const hook = renderHook(() => useInertiaConnection());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0]!;
    vi.useFakeTimers();

    const command = clientCommandSchema.parse({
      type: "app.refresh",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    let timeoutError: unknown;
    void hook.result.current.sendCommand(command).catch((error: unknown) => {
      timeoutError = error;
    });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runtimeCommandDelivery(timeoutError)).toBe("ambiguous");
    expect(firstSocket.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("keeps message delivery pending through bounded document preparation", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRuntimeConnection: vi.fn(async () => ({
          websocketUrl: "ws://127.0.0.1:12345/runtime/test",
        })),
      },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const hook = renderHook(() => useInertiaConnection());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    vi.useFakeTimers();

    const command = clientCommandSchema.parse({
      type: "message.send",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        conversationId: "22222222-2222-4222-8222-222222222222",
        content: "Inspect the attached document.",
        attachments: [],
      },
    });
    let timeoutError: unknown;
    void hook.result.current.sendCommand(command).catch((error: unknown) => {
      timeoutError = error;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(timeoutError).toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtimeCommandDelivery(timeoutError)).toBe("ambiguous");
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
