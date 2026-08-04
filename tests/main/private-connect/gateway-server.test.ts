import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PrivateConnectGatewayServer,
  type PrivateConnectGatewayHost,
  type PrivateConnectSession,
} from "../../../src/main/private-connect/gateway-server";
import { PRIVATE_CONNECT_LIMITS, type PrivateConnectRequest, type PrivateConnectResponse } from "../../../src/shared/private-connect/protocol";

const session: PrivateConnectSession = {
  id: "11111111-1111-4111-8111-111111111111",
  csrf: "csrf-token",
  expiresAt: "2030-01-01T00:00:00.000Z",
  deviceId: "22222222-2222-4222-8222-222222222222",
};
const hostHeader = (address: { port: number }): string => `127.0.0.1:${address.port}`;

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
    wellKnown: () => ({ pairingAvailable: true }),
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

async function startServer(): Promise<{ server: PrivateConnectGatewayServer; address: { port: number; host: string } }> {
  const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-"));
  writeFileSync(join(root, "index.html"), "<html>ok</html>");
  const server = new PrivateConnectGatewayServer({ host: host(), staticRoot: root, buildVersion: "0.0.24" });
  servers.push(server);
  return { server, address: await server.start() };
}

describe("Private Connect loopback gateway", () => {
  it("serves discovery with defensive headers and rejects invalid hosts", async () => {
    const { address } = await startServer();
    const response = await fetch(`http://${hostHeader(address)}/.well-known/inertia/private-connect`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await response.json()).product).toBe("Inertia Private Connect");
    expect(await requestWithHost(address.port, "bad host")).toBe(400);
  });

  it("serves the PWA root with its self-contained CSP and exposes a guarded session ticket", async () => {
    const { address } = await startServer();
    const host = hostHeader(address);
    const root = await fetch(`http://${host}/`, { headers: { Host: host } });
    expect(root.status).toBe(200);
    expect(root.headers.get("content-security-policy")).toContain("default-src 'self'");
    const origin = `https://${host}`;
    const csrf = await fetch(`http://${host}/api/session/csrf`, { headers: { Host: host, Cookie: "__Host-inertia-private-connect=session-token" } });
    expect(await csrf.json()).toEqual({ csrf: session.csrf });
    const body = "{}";
    const ticket = await fetch(`http://${host}/api/session/ws-ticket`, { method: "POST", headers: { Host: host, Origin: origin, Cookie: "__Host-inertia-private-connect=session-token", "Content-Type": "application/json", "Content-Length": String(body.length), "x-inertia-private-connect-csrf": session.csrf }, body });
    expect(ticket.status).toBe(200);
    expect(await ticket.json()).toEqual({ ticket: "ticket", expiresInMs: 45_000 });
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

  it("bounds pairing and authenticated admissions with a deterministic window", async () => {
    let nowValue = 2_000_000;
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-rate-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const server = new PrivateConnectGatewayServer({ host: host(), staticRoot: root, buildVersion: "0.0.24", now: () => new Date(nowValue) });
    servers.push(server);
    const address = await server.start();
    const hostValue = hostHeader(address);
    const origin = `https://${hostValue}`;
    const invitation = { protocolVersion: 1, hostId: "11111111-1111-4111-8111-111111111111", invitationId: "33333333-3333-4333-8333-333333333333", pairingSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", createdAt: "2029-12-31T23:55:00.000Z", expiresAt: "2030-01-01T00:05:00.000Z" };
    const pairRequest = () => fetch(`http://${hostValue}/api/pair/start`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ invitation, deviceId: session.deviceId, deviceLabel: "browser" }) });
    const pairResponses = await Promise.all(Array.from({ length: 11 }, () => pairRequest()));
    expect(pairResponses.at(-1)?.status).toBe(429);
    const request = (requestId: string) => fetch(`http://${hostValue}/api/request`, { method: "POST", headers: { Origin: origin, Cookie: "__Host-inertia-private-connect=session-token", "Content-Type": "application/json", "x-inertia-private-connect-csrf": session.csrf }, body: JSON.stringify({ protocolVersion: 1, type: "client.ping", requestId }) });
    const responses = await Promise.all(Array.from({ length: 121 }, (_, index) => request(`33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`)));
    expect(responses.at(-1)?.status).toBe(429);
    nowValue += 61_000;
    expect((await request("44444444-4444-4444-8444-444444444444")).status).toBe(200);
  });

  it("bounds concurrent work per authenticated session", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-private-connect-gateway-inflight-"));
    writeFileSync(join(root, "index.html"), "<html>ok</html>");
    const releases: Array<() => void> = [];
    let admitted = 0;
    const blockingHost: PrivateConnectGatewayHost = {
      ...host(),
      handleRequest: async (_session, request) => {
        admitted += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
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
      buildVersion: "0.0.24",
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
    const active = Array.from({ length: 8 }, (_, index) => request(String(index + 1)));
    await expect.poll(() => admitted).toBe(8);
    const overflow = await request("9");
    expect(overflow.status).toBe(200);
    await expect(overflow.json()).resolves.toMatchObject({
      ok: false,
      code: "busy",
    });
    releases.splice(0).forEach((release) => release());
    await expect(Promise.all(active)).resolves.toHaveLength(8);
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
      buildVersion: "0.0.24",
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
});
