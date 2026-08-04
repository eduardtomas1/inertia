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
import type { PrivateConnectRequest, PrivateConnectResponse } from "../../../src/shared/private-connect/protocol";

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
});
