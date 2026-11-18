import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vitest";

import {
  attachRuntimeWebSocketBoundary,
  createRuntimeHttpServer,
  RUNTIME_HTTP_SERVER_LIMITS,
  RUNTIME_WEBSOCKET_LIMITS,
  type RuntimeWebSocketBoundaryOptions,
} from "../../src/server/runtime/websocket-boundary";

const servers: Server[] = [];
const sockets: WebSocket[] = [];
const rawSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const socket of rawSockets.splice(0)) socket.destroy();
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

function boundaryOptions(
  server: Server,
  overrides: Partial<RuntimeWebSocketBoundaryOptions> = {},
): RuntimeWebSocketBoundaryOptions {
  return {
    server,
    websocketPath: "/runtime/token",
    runtimeSync: { connectionCount: 0, connect: () => undefined, disconnect: () => undefined },
    terminals: { disposeOwner: () => undefined },
    isolatedRuns: { stopOwned: () => undefined },
    dispatchCommand: async () => undefined,
    consumeDetachedCapability: () => null,
    currentSnapshot: () => ({}),
    approvals: () => [],
    inputs: () => [],
    plans: () => [],
    ...overrides,
  } as unknown as RuntimeWebSocketBoundaryOptions;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function connectionCount(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.getConnections((error, connections) => error ? reject(error) : resolve(connections));
  });
}

async function rawUpgradeThenReset(
  port: number,
  path: string,
  origin: string,
  resetAfterMs: number,
): Promise<string> {
  return await new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    rawSockets.push(socket);
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.on("error", () => resolve(response));
    socket.once("connect", () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Origin: ${origin}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"));
      setTimeout(() => {
        socket.resetAndDestroy();
        resolve(response);
      }, resetAfterMs);
    });
  });
}

async function openRuntimeSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/runtime/token`, { origin: "http://localhost:5173" });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

it("survives clients that reset rejected and accepted upgrades before the runtime finishes with them", async () => {
  const uncaught = vi.fn();
  process.on("uncaughtException", uncaught);
  try {
    const server = createRuntimeHttpServer();
    servers.push(server);
    const serverErrors = vi.fn();
    server.on("error", serverErrors);
    attachRuntimeWebSocketBoundary(boundaryOptions(server));
    const port = await listen(server);

    const responses: string[] = [];
    for (const resetAfterMs of [0, 1, 5, 20]) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        responses.push(await rawUpgradeThenReset(port, "/runtime/token", "https://attacker.example", resetAfterMs));
        responses.push(await rawUpgradeThenReset(port, "/runtime/wrong-token", "http://localhost:5173", resetAfterMs));
        await rawUpgradeThenReset(port, "/runtime/token", "http://localhost:5173", resetAfterMs);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(responses.some((response) => response.startsWith("HTTP/1.1 403 Forbidden"))).toBe(true);
    expect(responses.some((response) => response.startsWith("HTTP/1.1 404 Not Found"))).toBe(true);
    expect(uncaught).not.toHaveBeenCalled();
    expect(serverErrors).not.toHaveBeenCalled();
    const socket = await openRuntimeSocket(port);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    process.off("uncaughtException", uncaught);
  }
});

it("closes a rejected upgrade after answering it instead of leaving the socket half open", async () => {
  const server = createRuntimeHttpServer();
  servers.push(server);
  attachRuntimeWebSocketBoundary(boundaryOptions(server));
  const port = await listen(server);
  const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  rawSockets.push(socket);
  let response = "";
  socket.on("data", (chunk: Buffer) => {
    response += chunk.toString("latin1");
  });
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.once("connect", () => {
    socket.write(`GET /runtime/token HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: https://attacker.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  });

  await vi.waitFor(() => expect(response).toBe("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  await vi.waitFor(async () => expect(await connectionCount(server)).toBe(0));
  socket.end();
  await closed;
});

it("configures the runtime HTTP server with bounded connections, header and request timeouts", () => {
  const server = createRuntimeHttpServer();
  servers.push(server);

  expect(RUNTIME_HTTP_SERVER_LIMITS.maxConnections).toBe(RUNTIME_WEBSOCKET_LIMITS.maxClients * 4);
  expect(RUNTIME_HTTP_SERVER_LIMITS.connectionsCheckingIntervalMs).toBe(1_000);
  expect(server.maxConnections).toBe(64);
  expect(server.headersTimeout).toBe(5_000);
  expect(server.requestTimeout).toBe(10_000);
  expect(server.keepAliveTimeout).toBe(1_000);
  expect(server.maxHeadersCount).toBe(32);
});

function idleConnection(port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  rawSockets.push(socket);
  socket.on("error", () => undefined);
  socket.resume();
  return new Promise((resolve) => socket.once("connect", () => resolve(socket)));
}

function plainRequest(port: number): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  rawSockets.push(socket);
  let response = "";
  return new Promise((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => { response += chunk.toString("latin1"); });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
    socket.once("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
  });
}

it("drops connections over the cap and reclaims idle sockets through the header timeout so new connections succeed", async () => {
  const server = createRuntimeHttpServer({
    ...RUNTIME_HTTP_SERVER_LIMITS,
    maxConnections: 4,
    connectionsCheckingIntervalMs: 50,
    headersTimeoutMs: 200,
    requestTimeoutMs: 400,
  });
  servers.push(server);
  const port = await listen(server);
  const idle = await Promise.all(Array.from({ length: server.maxConnections }, () => idleConnection(port)));
  await vi.waitFor(async () => expect(await connectionCount(server)).toBe(idle.length));

  const dropped = vi.fn();
  server.on("drop", dropped);
  const extra = await idleConnection(port);
  await new Promise<void>((resolve) => extra.once("close", () => resolve()));
  await vi.waitFor(() => expect(dropped).toHaveBeenCalledOnce());

  await Promise.all(idle.map((socket) => new Promise<void>((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  })));
  await vi.waitFor(async () => expect(await connectionCount(server)).toBe(0));
  expect(await plainRequest(port)).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/u);
  expect(dropped).toHaveBeenCalledOnce();
});
