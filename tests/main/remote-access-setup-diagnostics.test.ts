import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createReferenceRelay,
  type ReferenceRelay,
} from "../../remote/relay/server.mjs";
import {
  probeRemoteSetup,
  RemoteSetupProbeError,
  validateRemoteCompanionUrl,
} from "../../src/main/remote-access-setup-diagnostics";

const relays: ReferenceRelay[] = [];
const servers: Server[] = [];

async function companionFixture(options: {
  metadata?: string;
  omitHeader?: string;
} = {}): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": "default-src 'none'; connect-src ws: wss:; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (options.omitHeader) delete headers[options.omitHeader];
  const server = createServer((_request, response) => {
    response.writeHead(200, headers);
    response.end(`<!doctype html><meta name="inertia-remote-companion" content="${
      options.metadata ?? "version=0.2.0;relay=2;remote=2"
    }">`);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

async function relayFixture(origin: string): Promise<string> {
  const relay = await createReferenceRelay({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [origin],
  });
  relays.push(relay);
  const address = relay.address();
  if (!address) throw new Error("Relay did not bind.");
  return `ws://127.0.0.1:${address.port}/remote`;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const relay of relays.splice(0)) await relay.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Remote Companion setup diagnostics", () => {
  it("checks browser headers, origin policy, versions, and relay auth without claiming an endpoint", async () => {
    const companionUrl = await companionFixture();
    const relayUrl = await relayFixture(new URL(companionUrl).origin);

    const result = await probeRemoteSetup(
      relayUrl,
      companionUrl,
      "local-development",
      { now: () => new Date("2026-08-02T12:00:00.000Z") },
    );

    expect(result).toMatchObject({
      relayUrl,
      companionUrl,
      diagnostics: {
        status: "passed",
        transport: "loopback-development",
        tls: "not-applicable",
        originPolicy: "accepted",
        relayVersion: "0.2.0",
        browserVersion: "0.2.0",
        relayProtocol: 2,
        remoteProtocol: 2,
        endpointAuthentication: "required",
        persistence: "ephemeral",
        endpointOwnership: "unclaimed",
      },
    });
  });

  it("classifies missing production browser headers without echoing page content", async () => {
    const companionUrl = await companionFixture({
      omitHeader: "Content-Security-Policy",
    });
    await expect(probeRemoteSetup(
      "ws://127.0.0.1:8787/remote",
      companionUrl,
      "local-development",
    )).rejects.toMatchObject({
      failureClass: "browser-headers",
    });
  });

  it("rejects a mismatched browser artifact with structured upgrade guidance", async () => {
    const companionUrl = await companionFixture({
      metadata: "version=0.3.0;relay=3;remote=3",
    });
    await expect(probeRemoteSetup(
      "ws://127.0.0.1:8787/remote",
      companionUrl,
      "local-development",
    )).rejects.toMatchObject({
      failureClass: "compatibility",
      message: expect.stringContaining("matching checksummed browser artifact"),
    });
  });

  it("keeps the setup deadline active while the companion body trickles", async () => {
    vi.useFakeTimers();
    const stalledFetch = (async (
      _input: URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing setup abort signal.");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<!doctype html>"));
          signal.addEventListener("abort", () => {
            controller.error(new Error("Setup body aborted."));
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Security-Policy": "default-src 'none'; connect-src ws: wss:; frame-ancestors 'none'",
          "Content-Type": "text/html; charset=utf-8",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }) as typeof fetch;
    const failure = expect(probeRemoteSetup(
      "ws://127.0.0.1:8787/remote",
      "http://127.0.0.1:4173/",
      "local-development",
      { fetch: stalledFetch },
    )).rejects.toMatchObject({
      failureClass: "network",
      message: "The companion HTTPS page could not be reached.",
    });

    await vi.advanceTimersByTimeAsync(7_001);
    await failure;
  });

  it("classifies a relay origin rejection and keeps self-hosting on HTTPS", async () => {
    const companionUrl = await companionFixture();
    const relayUrl = await relayFixture("https://different.example");
    await expect(probeRemoteSetup(
      relayUrl,
      companionUrl,
      "local-development",
    )).rejects.toMatchObject({
      failureClass: "origin-policy",
    });

    expect(() => validateRemoteCompanionUrl(
      companionUrl,
      "self-hosted",
    )).toThrow(RemoteSetupProbeError);
    expect(() => validateRemoteCompanionUrl(
      "https://user:secret@companion.example/?invitation=leak#pair=leak",
      "self-hosted",
    )).toThrow("cannot contain credentials");
  });

  it("classifies a failed WSS handshake as TLS/certificate failure", async () => {
    const companionUrl = await companionFixture();
    const plaintextRelayUrl = await relayFixture(new URL(companionUrl).origin);
    await expect(probeRemoteSetup(
      plaintextRelayUrl.replace("ws://", "wss://"),
      companionUrl,
      "local-development",
    )).rejects.toMatchObject({
      failureClass: "tls-certificate",
      message: "TLS certificate verification failed.",
    });
  });
});
