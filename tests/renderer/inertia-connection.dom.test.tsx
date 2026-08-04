import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCommandSchema,
  MAX_WORKSPACE_FILE_EDIT_BYTES,
  type ServerEvent,
} from "../../src/shared/contracts";
import {
  AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
  BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS,
  DUO_CANCEL_REQUEST_TIMEOUT_MS,
  DUO_DISPATCH_REQUEST_TIMEOUT_MS,
  GIT_READ_REQUEST_TIMEOUT_MS,
  MESSAGE_SEND_PREPARATION_TIMEOUT_MS,
  MESSAGE_SEND_REQUEST_TIMEOUT_MS,
  WORKSPACE_ENTRY_REQUEST_TIMEOUT_MS,
  WORKSPACE_FILE_REQUEST_TIMEOUT_MS,
  WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS,
} from "../../src/shared/runtime-command-timeouts";
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

  it("does not lose runtime readiness announced during an in-flight connection attempt", async () => {
    let announceReady: (() => void) | undefined;
    let rejectFirstConnection: ((error: Error) => void) | undefined;
    const getRuntimeConnection = vi.fn()
      .mockImplementationOnce(() => new Promise<never>((_resolve, reject) => {
        rejectFirstConnection = reject;
      }))
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

    vi.useFakeTimers();
    announceReady?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(getRuntimeConnection).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectFirstConnection?.(new Error("The local service is unavailable."));
      await Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(getRuntimeConnection).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("retains one startup recovery notice across reconnects and does not recreate it after dismissal", async () => {
    let announceReady: (() => void) | undefined;
    const notice = {
      id: "runtime-1-database-recovery",
      outcome: "created-empty" as const,
      trigger: "primary-corrupt" as const,
      preservedCorruptPrimary: true,
      invalidBackupsSkipped: 1,
      unsupportedBackupsSkipped: 0,
    };
    const getRuntimeConnection = vi.fn()
      .mockResolvedValueOnce({
        websocketUrl: "ws://127.0.0.1:12345/runtime/test",
        databaseRecoveryNotice: notice,
      })
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
    const hook = renderHook(() => useInertiaConnection());
    await waitFor(() => expect(hook.result.current.databaseRecoveryNotice)
      .toEqual(notice));

    FakeWebSocket.instances[0]!.close();
    announceReady?.();
    await waitFor(() => expect(getRuntimeConnection).toHaveBeenCalledTimes(2));
    expect(hook.result.current.databaseRecoveryNotice).toEqual(notice);
    act(() => hook.result.current.dismissDatabaseRecoveryNotice());
    expect(hook.result.current.databaseRecoveryNotice).toBeNull();

    FakeWebSocket.instances[1]!.close();
    announceReady?.();
    await waitFor(() => expect(getRuntimeConnection).toHaveBeenCalledTimes(3));
    expect(hook.result.current.databaseRecoveryNotice).toBeNull();
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

  it("keeps the socket alive when an idempotent refresh times out", async () => {
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

    expect(runtimeCommandDelivery(timeoutError)).toBe("rejected");
    expect(firstSocket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("keeps a bounded workspace repository scan pending without reconnecting", async () => {
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
      type: "git.workspace.refresh",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        projectId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
      },
    });
    let timeoutError: unknown;
    void hook.result.current.sendCommand(command).catch((error: unknown) => {
      timeoutError = error;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(timeoutError).toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS - 15_000,
    );
    expect(runtimeCommandDelivery(timeoutError)).toBe("rejected");
    expect(socket.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it.each([
    {
      name: "local Git reads",
      timeoutMs: GIT_READ_REQUEST_TIMEOUT_MS,
      delivery: "rejected" as const,
      command: {
        type: "git.diff",
        requestId: "11111111-1111-4111-8111-111111111111",
        payload: {
          projectId: "22222222-2222-4222-8222-222222222222",
          conversationId: "33333333-3333-4333-8333-333333333333",
          authorityRef: "44444444-4444-4444-8444-444444444444",
        },
      },
    },
    {
      name: "workspace directory reads",
      timeoutMs: WORKSPACE_ENTRY_REQUEST_TIMEOUT_MS,
      delivery: "rejected" as const,
      command: {
        type: "workspace.entries",
        requestId: "11111111-1111-4111-8111-111111111111",
        payload: {
          projectId: "22222222-2222-4222-8222-222222222222",
          conversationId: "33333333-3333-4333-8333-333333333333",
          directory: "src",
        },
      },
    },
    {
      name: "secure workspace reads",
      timeoutMs: WORKSPACE_FILE_REQUEST_TIMEOUT_MS,
      delivery: "rejected" as const,
      command: {
        type: "workspace.file.read",
        requestId: "11111111-1111-4111-8111-111111111111",
        payload: {
          projectId: "22222222-2222-4222-8222-222222222222",
          conversationId: "33333333-3333-4333-8333-333333333333",
          path: "src/example.ts",
        },
      },
    },
    {
      name: "provider workflow reads",
      timeoutMs: AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
      delivery: "rejected" as const,
      command: {
        type: "agent.workflow.load",
        requestId: "11111111-1111-4111-8111-111111111111",
        payload: {
          conversationId: "33333333-3333-4333-8333-333333333333",
          refresh: true,
        },
      },
    },
    {
      name: "backend compatibility probes",
      timeoutMs: BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS,
      delivery: "ambiguous" as const,
      command: {
        type: "backend.profile.probe",
        requestId: "11111111-1111-4111-8111-111111111111",
        payload: {
          profileId: "custom:test",
          modelId: "model-test",
        },
      },
    },
  ])("keeps $name pending through its server-side bound", async ({
    timeoutMs,
    delivery,
    command: input,
  }) => {
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

    const command = clientCommandSchema.parse(input);
    let timeoutError: unknown;
    void hook.result.current.sendCommand(command).catch((error: unknown) => {
      timeoutError = error;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(timeoutError).toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(timeoutMs - 15_000);
    expect(runtimeCommandDelivery(timeoutError)).toBe(delivery);
    expect(socket.close).toHaveBeenCalledTimes(
      delivery === "ambiguous" ? 1 : 0,
    );
  });

  it("keeps message delivery pending through the server preparation deadline", async () => {
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

    await vi.advanceTimersByTimeAsync(
      MESSAGE_SEND_PREPARATION_TIMEOUT_MS - 15_000,
    );
    expect(timeoutError).toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      MESSAGE_SEND_REQUEST_TIMEOUT_MS
        - MESSAGE_SEND_PREPARATION_TIMEOUT_MS,
    );
    expect(runtimeCommandDelivery(timeoutError)).toBe("ambiguous");
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      type: "duo.dispatch" as const,
      timeoutMs: DUO_DISPATCH_REQUEST_TIMEOUT_MS,
      state: "failed" as const,
    },
    {
      type: "duo.cancel" as const,
      timeoutMs: DUO_CANCEL_REQUEST_TIMEOUT_MS,
      state: "cancelled" as const,
    },
  ])("accepts a slow authoritative $type result within its bounded budget", async ({
    type,
    timeoutMs,
    state,
  }) => {
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
    const requestId = type === "duo.dispatch"
      ? "55555555-5555-4555-8555-555555555555"
      : "66666666-6666-4666-8666-666666666666";
    const launchId = "77777777-7777-4777-8777-777777777777";
    const command = clientCommandSchema.parse({
      type,
      requestId,
      payload: { launchId },
    });
    let outcome: ServerEvent | Error | undefined;
    const pending = hook.result.current.sendCommand(command).then(
      (event) => {
        outcome = event;
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error : new Error("Unknown error");
      },
    );

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(outcome).toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();

    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        type: "request.result",
        requestId,
        result: {
          kind: "duo.status",
          launchId,
          state,
          error: state === "failed" ? "Provider start rejected." : null,
          sides: [
            { ordinal: 0, conversationId: null, turnId: null, dispatchState: state === "failed" ? "failed" : "cancelled" },
            { ordinal: 1, conversationId: null, turnId: null, dispatchState: state === "failed" ? "failed" : "cancelled" },
          ],
        },
      }),
    }));
    await pending;

    expect(outcome).toMatchObject({
      type: "request.result",
      requestId,
    });
    expect(socket.close).not.toHaveBeenCalled();
  });
});
