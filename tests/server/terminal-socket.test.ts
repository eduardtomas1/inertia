import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { sendTerminalSocketEvent } from "../../src/server/terminal-socket";
import { createTerminalOutputBuffer } from "../../src/server/terminal-output-buffer";
import {
  MAX_BUFFERED_RUNTIME_EVENT_BYTES, MAX_QUEUED_RUNTIME_EVENT_BYTES,
  MAX_RUNTIME_EVENT_STALL_MS, sendRuntimeEvent,
} from "../../src/server/runtime-protocol";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function transport(initialBufferedAmount = 0) {
  let bufferedAmount = initialBufferedAmount;
  let readyState: number = WebSocket.OPEN;
  const callbacks: Array<(error?: Error) => void> = [];
  const send = vi.fn((serialized: string, complete?: (error?: Error) => void) => {
    bufferedAmount += Buffer.byteLength(serialized, "utf8");
    if (complete) callbacks.push(complete);
  });
  const terminate = vi.fn(() => { readyState = WebSocket.CLOSED; });
  const socket = {
    get readyState() { return readyState; }, get bufferedAmount() { return bufferedAmount; }, send, terminate,
  } as unknown as WebSocket;
  return { socket, send, terminate, callbacks,
    drainTo: (value: number) => { bufferedAmount = value; },
    close: () => { readyState = WebSocket.CLOSED; },
  };
}

function output(socket: WebSocket) {
  const failure = vi.fn();
  const buffer = createTerminalOutputBuffer({
    terminalId: "fixture", retainHistory: true, flushMs: 25,
    getDeliveryOwner: () => socket, hasAttachedOwner: () => true, onDeliveryFailure: failure,
  });
  return { buffer, failure };
}

describe("terminal output on the shared runtime transport", () => {
  it("delivers terminal output while a legitimate hydration backlog drains", () => {
    vi.useFakeTimers();
    const t = transport();
    sendRuntimeEvent(t.socket, { type: "request.error", requestId: "hydration", message: "x".repeat(MAX_BUFFERED_RUNTIME_EVENT_BYTES + 1) });
    const { buffer, failure } = output(t.socket);
    buffer.queue("terminal output during hydration\n"); buffer.flush();

    expect(t.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(t.send.mock.calls[1]![0])).toMatchObject({ type: "terminal.output", data: "terminal output during hydration\n" });
    expect(failure).not.toHaveBeenCalled();
    expect(t.terminate).not.toHaveBeenCalled();
    t.drainTo(0); vi.advanceTimersByTime(250);
    expect(vi.getTimerCount()).toBe(0);
    buffer.dispose();
  });

  it("retains the shared stall deadline and extends it only for progress", () => {
    vi.useFakeTimers();
    const t = transport(MAX_BUFFERED_RUNTIME_EVENT_BYTES + 4096);
    expect(sendTerminalSocketEvent(t.socket, { type: "terminal.output", terminalId: "fixture", data: "output" })).toBe(true);
    vi.advanceTimersByTime(MAX_RUNTIME_EVENT_STALL_MS - 500);
    expect(t.terminate).not.toHaveBeenCalled();
    t.drainTo(MAX_BUFFERED_RUNTIME_EVENT_BYTES + 1024);
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(MAX_RUNTIME_EVENT_STALL_MS - 250);
    expect(t.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(t.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["closed", "oversized", "throw", "callback"])("preserves immediate terminal delivery failure for %s transports", (kind) => {
    vi.useFakeTimers();
    const t = transport(kind === "oversized" ? MAX_QUEUED_RUNTIME_EVENT_BYTES : 0);
    if (kind === "closed") t.close();
    if (kind === "throw") t.send.mockImplementation(() => { throw new Error("send failed"); });
    if (kind === "callback") t.send.mockImplementation((_serialized, complete) => complete?.(new Error("write failed")));
    const { buffer, failure } = output(t.socket);
    buffer.queue("x".repeat(48 * 1024));

    expect(failure).toHaveBeenCalledExactlyOnceWith(t.socket);
    expect(t.send).toHaveBeenCalledTimes(kind === "closed" || kind === "oversized" ? 0 : 1);
    expect(t.terminate).toHaveBeenCalledTimes(kind === "closed" ? 0 : 1);
    expect(buffer.replay(t.socket)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates after an asynchronous terminal write failure", () => {
    const t = transport();
    expect(sendTerminalSocketEvent(t.socket, { type: "terminal.output", terminalId: "fixture", data: "output" })).toBe(true);
    expect(t.callbacks).toHaveLength(1);
    t.callbacks[0]!(new Error("asynchronous write failure"));
    expect(t.terminate).toHaveBeenCalledOnce();
  });
});
