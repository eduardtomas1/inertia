import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import { RuntimeEventQueue } from "../support/runtime-event-queue";

describe("runtime event test queue", () => {
  afterEach(() => vi.useRealTimers());

  it("correlates request responses without consuming unrelated events", async () => {
    const socket = new EventEmitter();
    const events = new RuntimeEventQueue(socket as unknown as WebSocket);
    const requestId = randomUUID();
    const unrelatedRequestId = randomUUID();
    const response = events.nextForRequest(
      requestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok",
      Date.now() + 1_000,
    );
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "request.ok",
      requestId: unrelatedRequestId,
    } satisfies ServerEvent)));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "request.ok",
      requestId,
    } satisfies ServerEvent)));

    await expect(response).resolves.toMatchObject({ requestId });
    await expect(events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok"
        && event.requestId === unrelatedRequestId,
    )).resolves.toMatchObject({ requestId: unrelatedRequestId });

    const rejectedRequestId = randomUUID();
    const rejected = expect(events.nextForRequest(
      rejectedRequestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok",
      Date.now() + 1_000,
    )).rejects.toThrow("The request failed immediately.");
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "request.error",
      requestId: rejectedRequestId,
      message: "The request failed immediately.",
    } satisfies ServerEvent)));
    await rejected;
  });

  it.each([
    { label: "ordinary event", timeoutMs: 6_000, request: false },
    { label: "request deadline", timeoutMs: 30_000, request: true },
  ])("keeps the $label timeout exact", async ({ timeoutMs, request }) => {
    vi.useFakeTimers();
    const socket = new EventEmitter();
    const events = new RuntimeEventQueue(socket as unknown as WebSocket);
    const requestId = randomUUID();
    const pending = request
      ? events.nextForRequest(
          requestId,
          (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
            event.type === "request.ok",
          Date.now() + timeoutMs,
        )
      : events.next(
          (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
            event.type === "request.ok",
        );
    let settled = false;
    const rejection = pending.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      request
        ? `Timed out waiting for request ${requestId}.`
        : "Timed out waiting for a server event.",
    );
  });
});
