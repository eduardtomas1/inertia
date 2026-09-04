import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { projectActionCommand } from "../../src/server/runtime-commands";
import {
  isAllowedRuntimeOrigin,
  MAX_BUFFERED_RUNTIME_EVENT_BYTES,
  MAX_QUEUED_RUNTIME_EVENT_BYTES,
  MAX_RUNTIME_EVENT_STALL_MS,
  parseRuntimeCommand,
  sendRuntimeEvent,
} from "../../src/server/runtime-protocol";
import { initialProviderSnapshots, providerSnapshot } from "../../src/server/runtime-snapshots";

describe("runtime boundary helpers", () => {
  it("accepts only the desktop bundle and local development origins", () => {
    expect(isAllowedRuntimeOrigin("inertia://bundle")).toBe(true);
    expect(isAllowedRuntimeOrigin("inertia-canary://bundle")).toBe(true);
    expect(isAllowedRuntimeOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedRuntimeOrigin("https://127.0.0.1:4173")).toBe(true);
    expect(isAllowedRuntimeOrigin("https://example.com")).toBe(false);
    expect(isAllowedRuntimeOrigin("null")).toBe(false);
  });

  it("keeps wire decoding separate from command execution", () => {
    expect(parseRuntimeCommand(Buffer.from("not json"), false).error).toMatchObject({ message: "Command must be valid JSON." });
    expect(parseRuntimeCommand(Buffer.from("{}"), true).error).toMatchObject({ message: "Binary commands are not supported." });
    expect(parseRuntimeCommand(Buffer.from(JSON.stringify({ requestId: "known", type: "unknown", payload: {} })), false).error).toEqual({
      type: "request.error",
      requestId: "known",
      message: "Invalid command.",
    });
  });

  it("accepts bounded prompt preset commands at the runtime boundary", () => {
    const command = {
      requestId: "11111111-1111-4111-8111-111111111111",
      type: "prompt-preset.create",
      payload: {
        name: "Review",
        body: "Review this patch.",
        route: null,
      },
    };
    expect(parseRuntimeCommand(
      Buffer.from(JSON.stringify(command)),
      false,
    ).command).toEqual(command);
    expect(parseRuntimeCommand(Buffer.from(JSON.stringify({
      ...command,
      payload: { ...command.payload, attachmentPath: "/private/file" },
    })), false).error).toMatchObject({ message: "Invalid command." });

    const escapedOverflowRoute = {
      harnessId: "h".repeat(200),
      backendProfileId: "b".repeat(200),
      modelId: "m".repeat(300),
      reasoningEffort: "\u0001".repeat(43),
    };
    for (const overflowCommand of [
      {
        ...command,
        payload: { ...command.payload, route: escapedOverflowRoute },
      },
      {
        requestId: command.requestId,
        type: "prompt-preset.update",
        payload: {
          presetId: "22222222-2222-4222-8222-222222222222",
          expectedRevision: 1,
          route: escapedOverflowRoute,
        },
      },
    ]) {
      expect(parseRuntimeCommand(
        Buffer.from(JSON.stringify(overflowCommand)),
        false,
      ).error).toMatchObject({
        type: "request.error",
        requestId: command.requestId,
        message: "Invalid command.",
      });
    }
  });

  it("allows a legitimate large hydration frame to drain before later events", () => {
    vi.useFakeTimers();
    let bufferedAmount = 0;
    const socket = {
      readyState: WebSocket.OPEN,
      get bufferedAmount() { return bufferedAmount; },
      send: vi.fn((serialized: string) => {
        bufferedAmount += Buffer.byteLength(serialized, "utf8");
      }),
      terminate: vi.fn(),
    } as unknown as WebSocket;
    const hydration = {
      type: "request.error",
      requestId: "request-1",
      message: "x".repeat(MAX_BUFFERED_RUNTIME_EVENT_BYTES + 1),
    } as const;

    sendRuntimeEvent(socket, hydration);
    sendRuntimeEvent(socket, {
      type: "request.ok",
      requestId: "request-2",
    });

    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
    bufferedAmount = 0;
    vi.advanceTimersByTime(250);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("disconnects only stalled or absolutely bounded runtime event consumers", () => {
    vi.useFakeTimers();
    const event = { type: "request.ok", requestId: "request-1" } as const;
    let bufferedAmount = MAX_BUFFERED_RUNTIME_EVENT_BYTES + 1_024;
    const slowSocket = {
      readyState: WebSocket.OPEN,
      get bufferedAmount() { return bufferedAmount; },
      send: vi.fn(),
      terminate: vi.fn(),
    } as unknown as WebSocket;
    expect(() => sendRuntimeEvent(slowSocket, event)).not.toThrow();
    expect(slowSocket.send).toHaveBeenCalledOnce();
    expect(slowSocket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_RUNTIME_EVENT_STALL_MS);
    expect(slowSocket.terminate).toHaveBeenCalledOnce();

    const boundedSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: MAX_QUEUED_RUNTIME_EVENT_BYTES,
      send: vi.fn(),
      terminate: vi.fn(),
    } as unknown as WebSocket;
    sendRuntimeEvent(boundedSocket, event);
    expect(boundedSocket.send).not.toHaveBeenCalled();
    expect(boundedSocket.terminate).toHaveBeenCalledOnce();

    const failedSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(() => { throw new Error("socket closed"); }),
      terminate: vi.fn(() => { throw new Error("already closed"); }),
    } as unknown as WebSocket;
    expect(() => sendRuntimeEvent(failedSocket, event)).not.toThrow();
    expect(failedSocket.terminate).toHaveBeenCalledOnce();
    bufferedAmount = 0;
    vi.useRealTimers();
  });

  it("extends the backpressure grace period when queued events make progress", () => {
    vi.useFakeTimers();
    let bufferedAmount = MAX_BUFFERED_RUNTIME_EVENT_BYTES + 1_024;
    let acknowledgeSend: ((error?: Error) => void) | undefined;
    const socket = {
      readyState: WebSocket.OPEN,
      get bufferedAmount() { return bufferedAmount; },
      send: vi.fn((_serialized: string, callback: (error?: Error) => void) => {
        acknowledgeSend = callback;
      }),
      terminate: vi.fn(),
    } as unknown as WebSocket;

    sendRuntimeEvent(socket, {
      type: "request.ok",
      requestId: "request-1",
    });
    vi.advanceTimersByTime(MAX_RUNTIME_EVENT_STALL_MS - 1_000);
    bufferedAmount -= 1;
    acknowledgeSend?.();
    vi.advanceTimersByTime(MAX_RUNTIME_EVENT_STALL_MS - 1_000);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(socket.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("builds only allow-listed package script commands", () => {
    expect(projectActionCommand("npm", "test:unit")).toBe("npm run test:unit");
    expect(projectActionCommand("pnpm", "check")).toBe("pnpm run check");
    expect(() => projectActionCommand("npm", "test && whoami")).toThrow("cannot be run safely");
  });

  it("produces deterministic provider placeholders", () => {
    const providers = initialProviderSnapshots(true);
    expect(providers.map(({ id }) => id)).toEqual([
      "codex",
      "claude",
      "cursor",
      "gemini",
      "kimi",
      "opencode",
    ]);
    expect(providers.every(({ canRun, installState, authState }) => !canRun && installState === "checking" && authState === "checking")).toBe(true);
    expect(providers.every(
      ({ agentThreadManagement }) => agentThreadManagement?.state === "supported",
    )).toBe(true);
  });

  it("preserves cached selector metadata while discovery is checking and after a failed refresh", () => {
    const metadata = {
      models: [{
        id: "model-a",
        label: "Model A",
        description: "Cached model",
        isDefault: true,
        inputModalities: ["text" as const],
        reasoningOptions: [],
        defaultReasoningEffort: "",
      }],
      rateLimits: [],
      metadataState: {
        models: { freshness: "stale" as const, provenance: "persistent-cache" as const, updatedAt: "2026-07-22T10:00:00.000Z", lastAttemptedAt: "2026-07-22T10:01:00.000Z", refreshing: false },
        rateLimits: { freshness: "unavailable" as const, provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      },
    };
    const checking = initialProviderSnapshots(true, { codex: metadata }).find(({ id }) => id === "codex");
    expect(checking).toMatchObject({ models: [expect.objectContaining({ id: "model-a" })], metadataState: { models: { freshness: "stale" } } });

    const unavailable = providerSnapshot({
      provider: { id: "codex", name: "Codex", command: "codex" },
      available: false,
      installState: "error",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed: true,
      statusMessage: "Discovery failed",
    }, metadata);
    expect(unavailable).toMatchObject({ models: [expect.objectContaining({ id: "model-a" })], metadataState: { models: { provenance: "persistent-cache" } } });
  });
});
