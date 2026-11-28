import { once } from "node:events";
import WebSocket from "ws";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PrivateConnectGatewayServer,
  secretsMatch,
  type PrivateConnectGatewayHost,
  type PrivateConnectSession,
} from "../../../src/main/private-connect/gateway-server";
import { PRIVATE_CONNECT_LIMITS, PRIVATE_CONNECT_SOCKET_CLOSE, type PrivateConnectRequest, type PrivateConnectResponse } from "../../../src/shared/private-connect/protocol";

const session: PrivateConnectSession = {
  id: "11111111-1111-4111-8111-111111111111",
  csrf: "csrf-token",
  expiresAt: "2030-01-01T00:00:00.000Z",
  deviceId: "22222222-2222-4222-8222-222222222222",
};
const hostHeader = (address: { port: number }): string => `127.0.0.1:${address.port}`;

function rootResponseWithHost(
  port: number,
  host: string,
): Promise<{ status: number; csp: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        csp: String(response.headers["content-security-policy"] ?? ""),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function requestWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

const servers: PrivateConnectGatewayServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function host(): PrivateConnectGatewayHost {
  return {
    pairingAllowed: () => true,
    pairingCapabilityLive: () => true,
    pairStart: async () => ({ requestId: "33333333-3333-4333-8333-333333333333", expiresAt: "2030-01-01T00:05:00.000Z", comparisonCode: "123456" }),
    pairStatus: async () => ({ status: "pending", requestId: "33333333-3333-4333-8333-333333333333", expiresAt: "2030-01-01T00:05:00.000Z", comparisonCode: "123456" }),
    session: (cookie) => cookie === "session-token" ? session : null,
    csrf: () => session.csrf,
    issueWebSocketTicket: () => "ticket",
    consumeWebSocketTicket: () => session,
    handleRequest: async (_session, request) => ({ type: "response", requestId: request.requestId, ok: true, result: { kind: "pong", at: "2030-01-01T00:00:00.000Z" } } as PrivateConnectResponse),
    logout: async () => undefined,
    closeSession: async () => undefined,
  };
}

async function startServer(gatewayHost: PrivateConnectGatewayHost = host()): Promise<{ server: PrivateConnectGatewayServer; address: { port: number; host: string } }> {
  const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-"));
  writeFileSync(join(root, "index.html"), "<html>ok</html>");
  writeFileSync(join(root, "manifest.webmanifest"), "{}");
  writeFileSync(join(root, "service-worker.js"), "self.addEventListener('fetch', () => undefined);");
  const server = new PrivateConnectGatewayServer({ host: gatewayHost, staticRoot: root });
  servers.push(server);
  return { server, address: await server.start() };
}

describe("Private Connect loopback gateway", () => {
  it.each([false, true])("rejects a held request body before reading it when session exists: %s", async (hasSession) => {
    const { address } = await startServer();
    const response = await new Promise<{ status: number; connection: string }>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/api/request", method: "POST",
        headers: { Origin: `https://${hostHeader(address)}`, "Content-Type": "application/json", "Content-Length": "131072",
          ...(hasSession ? { Cookie: "__Host-inertia-private-connect=session-token" } : {}) },
      }, (response) => {
        response.resume();
        response.once("end", () => {
          resolve({ status: response.statusCode ?? 0, connection: String(response.headers.connection) });
          request.destroy();
        });
      });
      request.once("error", reject);
      request.setTimeout(1_000, () => { request.destroy(new Error("The gateway waited for an unauthorized body.")); });
      request.flushHeaders();
    });
    expect(response).toEqual({ status: hasSession ? 403 : 401, connection: "close" });
  });

  it.each(["start", "status"])("rejects pairing %s before JSON parsing when no pairing is available", async (stage) => {
    const gatewayHost = Object.assign(host(), { pairingAllowed: () => false });
    const { address } = await startServer(gatewayHost);
    const response = await fetch(`http://${hostHeader(address)}/api/pair/${stage}`, {
      method: "POST", headers: { Origin: `https://${hostHeader(address)}`, "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("connection")).toBe("close");
  });
  it("closes its loopback listener when stopped", async () => {
    const { server, address } = await startServer();
    await server.stop();
    expect(server.address()).toBeNull();
    const socket = connect({ host: "127.0.0.1", port: address.port });
    const [error] = await once(socket, "error") as [NodeJS.ErrnoException];
    expect(error.code).toBe("ECONNREFUSED");
  });
  it("closes a listener that was still binding when stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const server = new PrivateConnectGatewayServer({ host: host(), staticRoot: root });
    servers.push(server);
    const started = server.start();
    const startFailure = expect(started).rejects.toThrow("The Private Connect gateway stopped before it started.");
    await server.stop();
    await startFailure;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.address()).toBeNull();
  });
  it("caps sockets per device and shares the request quota across its sockets", async () => {
    const gatewayHost = host();
    gatewayHost.consumeWebSocketTicket = (ticket) => ticket === "other"
      ? { ...session, id: "44444444-4444-4444-8444-444444444444", deviceId: "55555555-5555-4555-8555-555555555555" }
      : session;
    const { address } = await startServer(gatewayHost);
    const sockets: WebSocket[] = [];
    const connectSocket = async (ticket: string): Promise<WebSocket> => {
      const socket = new WebSocket(`ws://${hostHeader(address)}/api/ws?ticket=${ticket}`, {
        origin: `https://${hostHeader(address)}`,
      });
      sockets.push(socket);
      await once(socket, "open");
      return socket;
    };
    const ping = async (socket: WebSocket): Promise<PrivateConnectResponse> => {
      const response = once(socket, "message");
      socket.send(JSON.stringify({ protocolVersion: 1, type: "client.ping", requestId: "33333333-3333-4333-8333-333333333333" }));
      const [data] = await response;
      return JSON.parse(String(data)) as PrivateConnectResponse;
    };
    try {
      const first = await connectSocket("first");
      const second = await connectSocket("second");
      await expect(connectSocket("third")).rejects.toThrow();
      const other = await connectSocket("other");
      for (let count = 0; count < PRIVATE_CONNECT_LIMITS.requestsPerMinute; count += 1) {
        expect((await ping(count % 2 ? first : second)).ok).toBe(true);
      }
      expect(await ping(second)).toMatchObject({ ok: false, code: "rate-limited" });
      expect((await ping(other)).ok).toBe(true);
    } finally {
      for (const socket of sockets) socket.terminate();
    }
  });
  it("serves discovery with defensive headers and rejects invalid hosts", async () => {
    const { server, address } = await startServer();
    const response = await fetch(`http://${hostHeader(address)}/.well-known/inertia/private-connect`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await response.json()).toEqual({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 }, endpointId: server.endpointId });
    expect(server.endpointId).not.toBe((await startServer()).server.endpointId);
    expect(await requestWithHost(address.port, "bad host")).toBe(400);
  });

  it("serves the PWA root with its self-contained CSP and exposes a guarded session ticket", async () => {
    const { address } = await startServer();
    const host = hostHeader(address);
    const root = await fetch(`http://${host}/`, { headers: { Host: host } });
    expect(root.status).toBe(200);
    expect(root.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(root.headers.get("content-security-policy")).toContain("worker-src 'self'");
    const manifest = await fetch(`http://${host}/manifest.webmanifest`, { headers: { Host: host } });
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    const worker = await fetch(`http://${host}/service-worker.js`, { headers: { Host: host } });
    expect(worker.headers.get("content-type")).toContain("text/javascript");
    expect(worker.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(worker.headers.get("content-security-policy")).not.toContain("default-src 'none'");
    const origin = `https://${host}`;
    const csrf = await fetch(`http://${host}/api/session/csrf`, { headers: { Host: host, Cookie: "__Host-inertia-private-connect=session-token" } });
    expect(await csrf.json()).toEqual({ csrf: session.csrf });
    const body = "{}";
    const ticket = await fetch(`http://${host}/api/session/ws-ticket`, { method: "POST", headers: { Host: host, Origin: origin, Cookie: "__Host-inertia-private-connect=session-token", "Content-Type": "application/json", "Content-Length": String(body.length), "x-inertia-private-connect-csrf": session.csrf }, body });
    expect(ticket.status).toBe(200);
    expect(await ticket.json()).toEqual({ ticket: "ticket", expiresInMs: 45_000 });
  });

  it("scopes browser socket sources to the validated host instead of every wss origin", async () => {
    const { address } = await startServer();
    const hostValue = hostHeader(address);
    const policy = (await fetch(`http://${hostValue}/`, { headers: { Host: hostValue } }))
      .headers.get("content-security-policy") ?? "";
    expect(policy).toContain(`connect-src 'self' wss://${hostValue} ws://${hostValue}`);
    expect(policy).not.toMatch(/connect-src[^;]*\swss:(?!\/\/)/u);
    const rejected = await rootResponseWithHost(address.port, `127.0.0.1:${address.port + 1}`);
    expect(rejected.status).toBe(400);
    expect(rejected.csp).not.toContain("wss://");
    expect(rejected.csp).not.toContain("ws://");
  });

  it("compares the CSRF guard without leaking a prefix match", async () => {
    expect(secretsMatch("csrf-token", "csrf-token")).toBe(true);
    expect(secretsMatch("csrf-tokenX", "csrf-token")).toBe(false);
    expect(secretsMatch("csrf-toke", "csrf-token")).toBe(false);
    expect(secretsMatch("", "csrf-token")).toBe(false);
    expect(secretsMatch("anything", "")).toBe(false);
    const { address } = await startServer();
    const hostValue = hostHeader(address);
    const request = JSON.stringify({ protocolVersion: 1, type: "client.ping", requestId: "33333333-3333-4333-8333-333333333333" } satisfies PrivateConnectRequest);
    for (const presented of ["csrf-tok", "csrf-tokenX"]) {
      const response = await fetch(`http://${hostValue}/api/request`, {
        method: "POST",
        headers: {
          Host: hostValue,
          Origin: `https://${hostValue}`,
          Cookie: "__Host-inertia-private-connect=session-token",
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(request)),
          "x-inertia-private-connect-csrf": presented,
        },
        body: request,
      });
      expect(response.status).toBe(403);
    }
  });

  it("requires strict pairing schemas, same-origin mutations, and CSRF", async () => {
    const { address } = await startServer();
    const origin = `https://${hostHeader(address)}`;
    const body = JSON.stringify({ deviceId: "22222222-2222-4222-8222-222222222222", deviceLabel: "phone", invitation: { protocolVersion: 1, hostId: "11111111-1111-4111-8111-111111111111", invitationId: "33333333-3333-4333-8333-333333333333", pairingSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", createdAt: "2029-12-31T23:55:00.000Z", expiresAt: "2030-01-01T00:05:00.000Z", extra: true } });
    const invalid = await fetch(`http://${hostHeader(address)}/api/pair/start`, { method: "POST", headers: { Host: hostHeader(address), Origin: origin, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }, body });
    expect(invalid.status).toBe(400);
    const request = JSON.stringify({ protocolVersion: 1, type: "client.ping", requestId: "33333333-3333-4333-8333-333333333333" } satisfies PrivateConnectRequest);
    const crossOrigin = await fetch(`http://${hostHeader(address)}/api/request`, { method: "POST", headers: { Host: hostHeader(address), Origin: "https://other.example", Cookie: "__Host-inertia-private-connect=session-token", "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(request)), "x-inertia-private-connect-csrf": session.csrf }, body: request });
    expect(crossOrigin.status).toBe(403);
    const noCsrf = await fetch(`http://${hostHeader(address)}/api/request`, { method: "POST", headers: { Host: hostHeader(address), Origin: origin, Cookie: "__Host-inertia-private-connect=session-token", "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(request)) }, body: request });
    expect(noCsrf.status).toBe(403);
    const accepted = await fetch(`http://${hostHeader(address)}/api/request`, { method: "POST", headers: { Host: hostHeader(address), Origin: origin, Cookie: "__Host-inertia-private-connect=session-token", "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(request)), "x-inertia-private-connect-csrf": session.csrf }, body: request });
    expect(accepted.status).toBe(200);
  });

  it("closes clients that hold a declared request body open", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-timeout-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const server = new PrivateConnectGatewayServer({
      host: host(),
      staticRoot: root,
      transportTimeoutMs: 25,
    });
    servers.push(server);
    const address = await server.start();
    const hostValue = hostHeader(address);

    await expect(new Promise<void>((resolve, reject) => {
      const socket = connect(address.port, "127.0.0.1", () => {
        socket.write([
          "POST /api/pair/start HTTP/1.1",
          `Host: ${hostValue}`,
          `Origin: https://${hostValue}`,
          "Content-Type: application/json",
          "Content-Length: 100",
          "Connection: close",
          "",
          "{",
        ].join("\r\n"));
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("The partial request socket stayed open."));
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => undefined);
    })).resolves.toBeUndefined();
    expect((await fetch(`http://${hostValue}/.well-known/inertia/private-connect`, {
      headers: { Host: hostValue },
    })).status).toBe(200);
  });

  it("returns a structured application timeout before the transport deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-application-timeout-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const blockingHost: PrivateConnectGatewayHost = {
      ...host(),
      handleRequest: async () => await new Promise<PrivateConnectResponse>(() => undefined),
    };
    const server = new PrivateConnectGatewayServer({
      host: blockingHost,
      staticRoot: root,
      requestTimeoutMs: 25,
      transportTimeoutMs: 25,
    });
    servers.push(server);
    const address = await server.start();
    const hostValue = hostHeader(address);
    const request = JSON.stringify({
      protocolVersion: 1,
      type: "client.ping",
      requestId: "33333333-3333-4333-8333-333333333333",
    } satisfies PrivateConnectRequest);
    const response = await fetch(`http://${hostValue}/api/request`, {
      method: "POST",
      headers: {
        Host: hostValue,
        Origin: `https://${hostValue}`,
        Cookie: "__Host-inertia-private-connect=session-token",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(request)),
        "x-inertia-private-connect-csrf": session.csrf,
      },
      body: request,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      type: "response",
      requestId: "33333333-3333-4333-8333-333333333333",
      ok: false,
      code: "unavailable",
    });
  });

  it("bounds pairing and authenticated admissions with a deterministic window", async () => {
    let nowValue = 2_000_000;
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-rate-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const server = new PrivateConnectGatewayServer({ host: host(), staticRoot: root, now: () => new Date(nowValue) });
    servers.push(server);
    const address = await server.start();
    const hostValue = hostHeader(address);
    const origin = `https://${hostValue}`;
    const invitation = { protocolVersion: 1, hostId: "11111111-1111-4111-8111-111111111111", invitationId: "33333333-3333-4333-8333-333333333333", pairingSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", createdAt: "2029-12-31T23:55:00.000Z", expiresAt: "2030-01-01T00:05:00.000Z" };
    const pairRequest = () => fetch(`http://${hostValue}/api/pair/start`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ invitation, deviceId: session.deviceId, deviceLabel: "browser", browserNonce: "a".repeat(43) }) });
    const pairStatuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await pairRequest();
      pairStatuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(pairStatuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 202));
    expect(pairStatuses.at(-1)).toBe(429);
    // Serve proxies every peer through loopback. A different invitation ID
    // must not inherit this exhausted invitation's pairing quota.
    const otherPair = await fetch(`http://${hostValue}/api/pair/start`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        invitation: {
          ...invitation,
          invitationId: "44444444-4444-4444-8444-444444444444",
          pairingSecret: "B".repeat(43),
        },
        deviceId: session.deviceId, deviceLabel: "another browser", browserNonce: "b".repeat(43),
      }),
    });
    expect(otherPair.status).toBe(202);
    const request = (requestId: string) => fetch(`http://${hostValue}/api/request`, { method: "POST", headers: { Origin: origin, Cookie: "__Host-inertia-private-connect=session-token", "Content-Type": "application/json", "x-inertia-private-connect-csrf": session.csrf }, body: JSON.stringify({ protocolVersion: 1, type: "client.ping", requestId }) });
    const requestStatuses: number[] = [];
    for (let index = 0; index < 121; index += 1) {
      const response = await request(`33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`);
      requestStatuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(requestStatuses.slice(0, 120)).toEqual(Array.from({ length: 120 }, () => 200));
    expect(requestStatuses.at(-1)).toBe(429);
    nowValue += 61_000;
    expect((await request("44444444-4444-4444-8444-444444444444")).status).toBe(200);
  });

  it("keeps timed-out runtime work inside the in-flight bound until it settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-timeout-inflight-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const releases: Array<() => void> = [];
    let admitted = 0;
    let completed = 0;
    const blockingHost: PrivateConnectGatewayHost = {
      ...host(),
      handleRequest: async (_session, request) => {
        admitted += 1;
        if (admitted <= PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession) {
          await new Promise<void>((resolve) => releases.push(resolve));
        }
        completed += 1;
        return {
          type: "response",
          requestId: request.requestId,
          ok: true,
          result: { kind: "pong", at: "2030-01-01T00:00:00.000Z" },
        };
      },
    };
    const server = new PrivateConnectGatewayServer({
      host: blockingHost,
      staticRoot: root,
      requestTimeoutMs: 25,
    });
    servers.push(server);
    const address = await server.start();
    const hostValue = hostHeader(address);
    const origin = `https://${hostValue}`;
    const request = (suffix: string) => fetch(`http://${hostValue}/api/request`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "__Host-inertia-private-connect=session-token",
        "Content-Type": "application/json",
        "x-inertia-private-connect-csrf": session.csrf,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        type: "client.ping",
        requestId: `33333333-3333-4333-8333-${suffix.padStart(12, "0")}`,
      }),
    });

    const timedOut = await Promise.all(
      Array.from(
        { length: PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession },
        (_, index) => request(String(index + 1)),
      ),
    );
    expect(timedOut.every((response) => response.status === 503)).toBe(true);
    expect(admitted).toBe(PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession);
    const overflow = await request("9");
    await expect(overflow.json()).resolves.toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(admitted).toBe(PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession);

    releases.splice(0).forEach((release) => release());
    await expect.poll(() => completed).toBe(PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession);
    const afterDrain = await request("10");
    expect(afterDrain.status).toBe(200);
    expect(admitted).toBe(PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession + 1);
  });

  it("keeps its port bound while quarantined and answers every request with 503", async () => {
    const opened: string[] = [];
    const { server, address } = await startServer({ ...host(), openSession: (value) => { opened.push(value.id); } });
    const hostValue = hostHeader(address);
    const socket = new WebSocket(`ws://${hostValue}/api/ws?ticket=ticket`, { headers: { Host: hostValue, Origin: `https://${hostValue}` } });
    await once(socket, "open");
    const closed = once(socket, "close");

    server.quarantine();

    const [code] = await closed as [number];
    expect(code).toBe(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable);
    expect(server.address()).toEqual(address);
    const cookie = "__Host-inertia-private-connect=session-token";
    for (const [path, headers] of [
      ["/", {}],
      ["/service-worker.js", { "Service-Worker": "script" }],
      ["/rogue-worker.js", { "Service-Worker": "script" }],
      ["/.well-known/inertia/private-connect", {}],
      ["/api/session/csrf", { Cookie: cookie }],
    ] as const) {
      const response = await fetch(`http://${hostValue}${path}`, { headers: { Host: hostValue, ...headers } });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).not.toContain(session.csrf);
    }
    const mutation = await fetch(`http://${hostValue}/api/session/ws-ticket`, { method: "POST", headers: { Host: hostValue, Origin: `https://${hostValue}`, Cookie: cookie, "Content-Type": "application/json", "x-inertia-private-connect-csrf": session.csrf }, body: "{}" });
    expect(mutation.status).toBe(503);
    const rejected = new WebSocket(`ws://${hostValue}/api/ws?ticket=ticket`, { headers: { Host: hostValue, Origin: `https://${hostValue}` } });
    await expect(once(rejected, "open")).rejects.toBeInstanceOf(Error);
    expect(opened).toHaveLength(1);
  });

  it("binds a requested loopback port", async () => {
    const { server, address } = await startServer();
    await server.stop();
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-"));
    const holder = new PrivateConnectGatewayServer({ host: host(), staticRoot: root });
    servers.push(holder);
    holder.quarantine();
    await expect(holder.start(address.port)).resolves.toEqual({ port: address.port, host: "127.0.0.1" });
    const response = await fetch(`http://${hostHeader(address)}/`, { headers: { Host: hostHeader(address) } });
    expect(response.status).toBe(503);
    const other = new PrivateConnectGatewayServer({ host: host(), staticRoot: root });
    servers.push(other);
    await expect(other.start(70_000)).rejects.toThrow("port is invalid");
  });

  it("retires a service worker registered from any script other than the packaged worker", async () => {
    const { address } = await startServer();
    const hostValue = hostHeader(address);
    const rogue = await fetch(`http://${hostValue}/assets/evil-worker.js?v=1`, { headers: { Host: hostValue, "Service-Worker": "script" } });
    expect(rogue.status).toBe(200);
    expect(rogue.headers.get("content-type")).toContain("text/javascript");
    expect(rogue.headers.get("service-worker-allowed")).toBe("/");
    expect(rogue.headers.get("cache-control")).toBe("no-store");
    const source = await rogue.text();
    expect(source).toContain("self.registration.unregister()");
    expect(source).toContain("skipWaiting");
    const packaged = await fetch(`http://${hostValue}/service-worker.js`, { headers: { Host: hostValue, "Service-Worker": "script" } });
    expect(await packaged.text()).toBe("self.addEventListener('fetch', () => undefined);");
    const ordinary = await fetch(`http://${hostValue}/assets/evil-worker.js`, { headers: { Host: hostValue } });
    expect(ordinary.status).toBe(404);
    const invalidHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/assets/evil-worker.js", headers: { Host: "attacker.example", "Service-Worker": "script" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.end();
    });
    expect(invalidHost).toBe(400);
  });

  it("enforces pairing rate limits across distinct secret guesses and isolates authenticated session buckets from pairing floods", async () => {
    const nowValue = 5_000_000;
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-sec5-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const server = new PrivateConnectGatewayServer({
      host: host(),
      staticRoot: root,
      now: () => new Date(nowValue),
    });
    servers.push(server);
    const address = await server.start();
    const hostValue = hostHeader(address);
    const origin = `https://${hostValue}`;
    const baseInvitation = {
      protocolVersion: 1,
      hostId: "11111111-1111-4111-8111-111111111111",
      invitationId: "33333333-3333-4333-8333-333333333333",
      createdAt: "2029-12-31T23:55:00.000Z",
      expiresAt: "2030-01-01T00:05:00.000Z",
    };

    // 1. Varying pairingSecret on the same invitationId cannot bypass pairingAttemptsPerMinute.
    const guessStatuses: number[] = [];
    for (let index = 0; index < PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute + 1; index += 1) {
      const secret = `S${String(index).padStart(42, "0")}`;
      const response = await fetch(`http://${hostValue}/api/pair/start`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          invitation: { ...baseInvitation, pairingSecret: secret },
          deviceId: session.deviceId,
          deviceLabel: "attacker",
          browserNonce: `N${String(index).padStart(42, "0")}`,
        }),
      });
      guessStatuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(guessStatuses.slice(0, PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute))
      .toEqual(Array.from({ length: PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute }, () => 202));
    expect(guessStatuses.at(-1)).toBe(429);

    // 2. Exhaust authenticated request quota, flood 135 distinct unauthenticated pairing requests,
    // and verify the authenticated session's bucket was NOT evicted.
    const authedPing = (index: number) => fetch(`http://${hostValue}/api/request`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: "__Host-inertia-private-connect=session-token",
        "Content-Type": "application/json",
        "x-inertia-private-connect-csrf": session.csrf,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        type: "client.ping",
        requestId: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`,
      }),
    });
    for (let index = 0; index < PRIVATE_CONNECT_LIMITS.requestsPerMinute; index += 1) {
      const response = await authedPing(index);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect((await authedPing(999)).status).toBe(429);

    for (let index = 0; index < 135; index += 1) {
      const response = await fetch(`http://${hostValue}/api/pair/start`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          invitation: {
            ...baseInvitation,
            invitationId: `66666666-6666-4666-8666-${String(index + 1).padStart(12, "0")}`,
            pairingSecret: `P${String(index).padStart(42, "0")}`,
          },
          deviceId: session.deviceId,
          deviceLabel: "flood",
          browserNonce: `M${String(index).padStart(42, "0")}`,
        }),
      });
      await response.arrayBuffer();
    }
    expect((await authedPing(1000)).status).toBe(429);
  });

  it("bounds failed pairing verification before host calls while isolating legitimate invitations and approval polling", async () => {
    const nowValue = 6_000_000;
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-s5-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const validInvitationId = "77777777-7777-4777-8777-777777777777";
    const validSecret = "S".repeat(43);
    const validRequestId = "88888888-8888-4888-8888-888888888888";
    const validNonce = "N".repeat(43);
    let pairStartCalls = 0;
    let pairStatusCalls = 0;
    const verifyingHost: PrivateConnectGatewayHost = {
      ...host(),
      async pairStart(request) {
        pairStartCalls += 1;
        if (request.invitation.invitationId !== validInvitationId || request.invitation.pairingSecret !== validSecret) {
          throw new Error("Invalid invitation.");
        }
        return { requestId: validRequestId, expiresAt: "2030-01-01T00:05:00.000Z", comparisonCode: "123-456" };
      },
      async pairStatus(requestId, browserNonce) {
        pairStatusCalls += 1;
        if (requestId !== validRequestId || browserNonce !== validNonce) {
          throw new Error("Invalid status request.");
        }
        return { status: "pending", requestId, expiresAt: "2030-01-01T00:05:00.000Z", comparisonCode: "123-456" };
      },
    };
    const server = new PrivateConnectGatewayServer({
      host: verifyingHost,
      staticRoot: root,
      now: () => new Date(nowValue),
    });
    servers.push(server);
    const address = await server.start();
    const hostValue = hostHeader(address);
    const origin = `https://${hostValue}`;

    // Flood invalid pairStart guesses as an attacker peer beyond the failure limit.
    const invalidStartStatuses: number[] = [];
    for (let i = 0; i < PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute + 5; i += 1) {
      const response = await fetch(`http://${hostValue}/api/pair/start`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "Tailscale-User-Login": "attacker@example.com",
        },
        body: JSON.stringify({
          invitation: {
            protocolVersion: 1,
            hostId: "11111111-1111-4111-8111-111111111111",
            invitationId: validInvitationId,
            pairingSecret: `X${String(i).padStart(42, "0")}`,
            createdAt: "2029-12-31T23:55:00.000Z",
            expiresAt: "2030-01-01T00:05:00.000Z",
          },
          deviceId: session.deviceId,
          deviceLabel: "attacker",
          browserNonce: `B${String(i).padStart(42, "0")}`,
        }),
      });
      invalidStartStatuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(invalidStartStatuses.slice(0, PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute))
      .toEqual(Array.from({ length: PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute }, () => 400));
    expect(invalidStartStatuses.slice(PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute))
      .toEqual([429, 429, 429, 429, 429]);
    // Requests past the failure limit were rejected before calling host.pairStart.
    expect(pairStartCalls).toBe(PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute);

    // Legitimate pairStart from another peer with the real secret still succeeds.
    const validStart = await fetch(`http://${hostValue}/api/pair/start`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
      },
      body: JSON.stringify({
        invitation: {
          protocolVersion: 1,
          hostId: "11111111-1111-4111-8111-111111111111",
          invitationId: validInvitationId,
          pairingSecret: validSecret,
          createdAt: "2029-12-31T23:55:00.000Z",
          expiresAt: "2030-01-01T00:05:00.000Z",
        },
        deviceId: session.deviceId,
        deviceLabel: "legit",
        browserNonce: validNonce,
      }),
    });
    expect(validStart.status).toBe(202);
    await validStart.arrayBuffer();

    // Flood invalid pairStatus guesses as the attacker peer beyond the failure limit.
    const invalidPollStatuses: number[] = [];
    for (let i = 0; i < PRIVATE_CONNECT_LIMITS.requestsPerMinute + 5; i += 1) {
      const response = await fetch(`http://${hostValue}/api/pair/status`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "Tailscale-User-Login": "attacker@example.com",
        },
        body: JSON.stringify({
          requestId: validRequestId,
          browserNonce: `W${String(i).padStart(42, "0")}`,
        }),
      });
      invalidPollStatuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(invalidPollStatuses.slice(0, PRIVATE_CONNECT_LIMITS.requestsPerMinute))
      .toEqual(Array.from({ length: PRIVATE_CONNECT_LIMITS.requestsPerMinute }, () => 400));
    expect(invalidPollStatuses.slice(PRIVATE_CONNECT_LIMITS.requestsPerMinute))
      .toEqual([429, 429, 429, 429, 429]);
    // Requests past the failure limit were rejected before calling host.pairStatus.
    expect(pairStatusCalls).toBe(PRIVATE_CONNECT_LIMITS.requestsPerMinute);

    // Legitimate approval polling from the owner peer with the real browserNonce still succeeds.
    const validPoll = await fetch(`http://${hostValue}/api/pair/status`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Tailscale-User-Login": "owner@example.com",
      },
      body: JSON.stringify({
        requestId: validRequestId,
        browserNonce: validNonce,
      }),
    });
    expect(validPoll.status).toBe(200);
    await validPoll.arrayBuffer();

    // Overlapping concurrent invalid pairStatus requests from a fresh attacker cannot exceed requestsPerMinute.
    let concurrentCalls = 0;
    const slowHost: PrivateConnectGatewayHost = {
      ...host(),
      async pairStatus() {
        concurrentCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        throw new Error("Invalid status request.");
      },
    };
    const concurrentServer = new PrivateConnectGatewayServer({
      host: slowHost,
      staticRoot: root,
      now: () => new Date(nowValue),
    });
    servers.push(concurrentServer);
    const concurrentAddress = await concurrentServer.start();
    const concurrentHost = hostHeader(concurrentAddress);
    const concurrentOrigin = `https://${concurrentHost}`;
    const concurrentResults = await Promise.all(
      Array.from({ length: PRIVATE_CONNECT_LIMITS.requestsPerMinute + 10 }, async (_, index) => {
        const response = await fetch(`http://${concurrentHost}/api/pair/status`, {
          method: "POST",
          headers: {
            Origin: concurrentOrigin,
            "Content-Type": "application/json",
            "Tailscale-User-Login": "burst-attacker@example.com",
          },
          body: JSON.stringify({
            requestId: validRequestId,
            browserNonce: `C${String(index).padStart(42, "0")}`,
          }),
        });
        await response.arrayBuffer();
        return response.status;
      }),
    );
    expect(concurrentCalls).toBe(PRIVATE_CONNECT_LIMITS.requestsPerMinute);
    expect(concurrentResults.filter((status) => status === 400)).toHaveLength(PRIVATE_CONNECT_LIMITS.requestsPerMinute);
    expect(concurrentResults.filter((status) => status === 429)).toHaveLength(10);
  });

  function pairingFixture(nowValue: () => number) {
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-quota-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const valid = {
      invitationId: "77777777-7777-4777-8777-777777777777",
      secret: "S".repeat(43),
      requestId: "88888888-8888-4888-8888-888888888888",
      nonce: "N".repeat(43),
    };
    const calls = { start: new Map<string, number>(), status: new Map<string, number>() };
    const verifyingHost: PrivateConnectGatewayHost = {
      ...host(),
      pairingCapabilityLive: (stage, id) => id === (stage === "start" ? valid.invitationId : valid.requestId),
      async pairStart(request) {
        const id = request.invitation.invitationId;
        calls.start.set(id, (calls.start.get(id) ?? 0) + 1);
        if (id !== valid.invitationId || request.invitation.pairingSecret !== valid.secret) throw new Error("Invalid invitation.");
        return { requestId: valid.requestId, expiresAt: "2030-01-01T00:05:00.000Z", comparisonCode: "123-456" };
      },
      async pairStatus(requestId, browserNonce) {
        calls.status.set(requestId, (calls.status.get(requestId) ?? 0) + 1);
        if (requestId !== valid.requestId || browserNonce !== valid.nonce) throw new Error("Invalid status request.");
        return { status: "pending", requestId, expiresAt: "2030-01-01T00:05:00.000Z", comparisonCode: "123-456" };
      },
    };
    const server = new PrivateConnectGatewayServer({ host: verifyingHost, staticRoot: root, now: () => new Date(nowValue()) });
    servers.push(server);
    const post = async (address: { port: number }, stage: "start" | "status", body: unknown, login?: string) => {
      const response = await fetch(`http://${hostHeader(address)}/api/pair/${stage}`, {
        method: "POST",
        headers: {
          Origin: `https://${hostHeader(address)}`,
          "Content-Type": "application/json",
          ...(login ? { "Tailscale-User-Login": login } : {}),
        },
        body: JSON.stringify(body),
      });
      await response.arrayBuffer();
      return response.status;
    };
    const start = (address: { port: number }, invitationId: string, secret: string, nonce: string, login?: string) => post(address, "start", {
      invitation: {
        protocolVersion: 1,
        hostId: "11111111-1111-4111-8111-111111111111",
        invitationId,
        pairingSecret: secret,
        createdAt: "2029-12-31T23:55:00.000Z",
        expiresAt: "2030-01-01T00:05:00.000Z",
      },
      deviceId: session.deviceId,
      deviceLabel: "browser",
      browserNonce: nonce,
    }, login);
    const status = (address: { port: number }, requestId: string, nonce: string, login?: string) =>
      post(address, "status", { requestId, browserNonce: nonce }, login);
    return { server, valid, calls, start, status };
  }

  it("keeps a valid pairing available after a header-less loopback peer fails against other invitations", async () => {
    const { server, valid, start, status } = pairingFixture(() => 7_000_000);
    const address = await server.start();
    const unrelated = (index: number) => `99999999-9999-4999-8999-${String(index + 1).padStart(12, "0")}`;
    const failedStarts: number[] = [];
    for (let index = 0; index < PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute + 5; index += 1) {
      failedStarts.push(await start(address, unrelated(index), "X".repeat(43), "B".repeat(43)));
    }
    expect(new Set(failedStarts)).toEqual(new Set([400]));
    expect(await start(address, valid.invitationId, valid.secret, valid.nonce)).toBe(202);
    const failedPolls: number[] = [];
    for (let index = 0; index < PRIVATE_CONNECT_LIMITS.requestsPerMinute + 5; index += 1) {
      failedPolls.push(await status(address, unrelated(index), "W".repeat(43)));
    }
    expect(new Set(failedPolls)).toEqual(new Set([400]));
    expect(await status(address, valid.requestId, valid.nonce)).toBe(200);
  });

  it("bounds secret checks against one invitation when callers rotate the identity header", async () => {
    let nowValue = 8_000_000;
    const { server, valid, calls, start, status } = pairingFixture(() => nowValue);
    const address = await server.start();
    const startCap = PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute * 2;
    const startStatuses: number[] = [];
    for (let index = 0; index < 400; index += 1) {
      startStatuses.push(await start(address, valid.invitationId, `X${String(index).padStart(42, "0")}`, "B".repeat(43), `rotating-${index}@example.com`));
    }
    expect(calls.start.get(valid.invitationId)).toBe(startCap);
    expect(startStatuses.slice(0, startCap)).toEqual(Array.from({ length: startCap }, () => 400));
    expect(new Set(startStatuses.slice(startCap))).toEqual(new Set([429]));
    expect(await start(address, valid.invitationId, valid.secret, valid.nonce, "owner@example.com")).toBe(429);
    nowValue += 61_000;
    expect(await start(address, valid.invitationId, valid.secret, valid.nonce, "owner@example.com")).toBe(202);

    const statusCap = PRIVATE_CONNECT_LIMITS.requestsPerMinute * 2;
    const pollStatuses: number[] = [];
    for (let index = 0; index < statusCap + 5; index += 1) {
      pollStatuses.push(await status(address, valid.requestId, `W${String(index).padStart(42, "0")}`, `rotating-${index}@example.com`));
    }
    expect(calls.status.get(valid.requestId)).toBe(statusCap);
    expect(new Set(pollStatuses.slice(statusCap))).toEqual(new Set([429]));
  });
});
