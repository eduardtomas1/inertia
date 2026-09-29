import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vitest";

import { attachRuntimeWebSocketBoundary, type RuntimeWebSocketBoundaryOptions } from "../../src/server/runtime/websocket-boundary";

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

it("reports a rejected command dispatch to its client instead of leaving the rejection unhandled", async () => {
  const server = createServer();
  servers.push(server);
  const dispatchCommand = vi.fn(async () => {
    throw new Error("Dispatch failed with /Users/private/path");
  });
  attachRuntimeWebSocketBoundary({
    server,
    websocketPath: "/runtime/token",
    runtimeSync: { connectionCount: 0, connect: () => undefined, disconnect: () => undefined },
    terminals: { disposeOwner: () => undefined },
    isolatedRuns: { stopOwned: () => undefined },
    dispatchCommand,
    currentSnapshot: () => ({}),
    approvals: () => [],
    inputs: () => [],
    plans: () => [],
  } as unknown as RuntimeWebSocketBoundaryOptions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime/token`, { origin: "http://localhost:5173" });
  sockets.push(socket);
  const events: unknown[] = [];
  socket.on("message", (data: Buffer) => events.push(JSON.parse(data.toString("utf8"))));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const requestId = randomUUID();

  socket.send(JSON.stringify({ type: "message.queue.get", requestId, payload: { conversationId: randomUUID() } }));

  await vi.waitFor(() => expect(events).toContainEqual({
    type: "request.error",
    requestId,
    message: "The request could not be completed.",
  }));
  expect(dispatchCommand).toHaveBeenCalledOnce();
});
