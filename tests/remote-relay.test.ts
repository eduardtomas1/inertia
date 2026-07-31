import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  createReferenceRelay,
  type ReferenceRelay,
} from "../remote/relay/server.mjs";

const relays: ReferenceRelay[] = [];
const sockets: WebSocket[] = [];

async function relayFixture(options = {}) {
  const relay = await createReferenceRelay({
    host: "127.0.0.1",
    port: 0,
    ...options,
  });
  relays.push(relay);
  const address = relay.address();
  if (!address) throw new Error("Relay did not bind.");
  return `ws://127.0.0.1:${address.port}/remote`;
}

async function socket(url: string): Promise<WebSocket> {
  const value = new WebSocket(url, {
    perMessageDeflate: false,
    maxPayload: 140 * 1024,
  });
  sockets.push(value);
  await once(value, "open");
  return value;
}

async function browserSocket(
  url: string,
  origin: string,
): Promise<WebSocket> {
  const value = new WebSocket(url, { origin });
  sockets.push(value);
  await once(value, "open");
  return value;
}

function nextMessage(value: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      value.off("message", onMessage);
      reject(error);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      value.off("error", onError);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    };
    value.once("error", onError);
    value.once("message", onMessage);
  });
}

afterEach(async () => {
  for (const value of sockets.splice(0)) value.terminate();
  for (const relay of relays.splice(0)) await relay.close();
});

describe("Remote Companion reference relay", () => {
  it("routes only bounded opaque frames without durable queuing", async () => {
    const url = await relayFixture();
    const desktop = await socket(url);
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.register",
      endpointId: "opaque_endpoint",
      role: "desktop",
      relayVersion: "0.1.0",
    }));
    expect(await nextMessage(desktop)).toMatchObject({
      type: "relay.registered",
    });

    const browser = await socket(url);
    browser.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.connect",
      endpointId: "opaque_endpoint",
      browserVersion: "0.1.0",
    }));
    const connected = await nextMessage(browser);
    const connectionId = connected.connectionId as string;
    expect(connected).toMatchObject({ type: "relay.connected" });
    expect(await nextMessage(desktop)).toMatchObject({
      type: "relay.peer-connected",
      connectionId,
    });

    const stranger = await socket(url);
    stranger.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.disconnect",
      connectionId,
    }));
    expect(await nextMessage(stranger)).toMatchObject({
      type: "relay.error",
      code: "connection-missing",
    });

    const frame = {
      protocolVersion: 1,
      kind: "pair.request",
      invitationId: crypto.randomUUID(),
      enc: "opaque_encapsulation",
      ciphertext: "opaque_ciphertext",
    };
    browser.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.frame",
      connectionId,
      frame,
    }));
    expect(await nextMessage(desktop)).toEqual({
      protocolVersion: 1,
      type: "relay.frame",
      connectionId,
      frame,
    });

    browser.terminate();
    expect(await nextMessage(desktop)).toMatchObject({
      type: "relay.peer-disconnected",
      connectionId,
    });
  });

  it("budgets aggregate desktop responses separately from each browser", async () => {
    const url = await relayFixture({ now: () => 10_000 });
    const desktop = await socket(url);
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.register",
      endpointId: "aggregate_endpoint",
      role: "desktop",
      relayVersion: "0.1.0",
    }));
    await nextMessage(desktop);

    const browsers: WebSocket[] = [];
    const connectionIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const browser = await socket(url);
      browser.send(JSON.stringify({
        protocolVersion: 1,
        type: "relay.connect",
        endpointId: "aggregate_endpoint",
        browserVersion: "0.1.0",
      }));
      browsers.push(browser);
      connectionIds.push((await nextMessage(browser)).connectionId as string);
      await nextMessage(desktop);
    }

    let delivered = 0;
    let resolveDelivered = (): void => undefined;
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });
    for (const browser of browsers) {
      browser.on("message", () => {
        delivered += 1;
        if (delivered === 244) resolveDelivered();
      });
    }
    const frame = {
      protocolVersion: 1,
      kind: "session.close",
      sessionId: crypto.randomUUID(),
      reason: "shutdown",
    };
    // Four normal sessions each emit 60 state/detail responses per minute.
    // Include lifecycle margin that exceeded the old shared 240-message cap.
    for (let index = 0; index < 244; index += 1) {
      desktop.send(JSON.stringify({
        protocolVersion: 1,
        type: "relay.frame",
        connectionId: connectionIds[index % connectionIds.length],
        frame,
      }));
    }
    await deliveredAll;
    expect(delivered).toBe(244);
    expect(desktop.readyState).toBe(WebSocket.OPEN);

    const browserClosed = once(browsers[0]!, "close");
    for (let index = 0; index < 240; index += 1) {
      browsers[0]!.send(JSON.stringify({
        protocolVersion: 1,
        type: "relay.frame",
        connectionId: connectionIds[0],
        frame,
      }));
    }
    const [closeCode] = await browserClosed;
    expect(closeCode).toBe(1008);
    expect(desktop.readyState).toBe(WebSocket.OPEN);
  });

  it("reports an offline desktop and never queues a later connection", async () => {
    const url = await relayFixture();
    const browser = await socket(url);
    browser.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.connect",
      endpointId: "offline_endpoint",
      browserVersion: "0.1.0",
    }));
    expect(await nextMessage(browser)).toMatchObject({
      type: "relay.error",
      code: "desktop-offline",
    });

    const desktop = await socket(url);
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.register",
      endpointId: "offline_endpoint",
      role: "desktop",
      relayVersion: "0.1.0",
    }));
    expect(await nextMessage(desktop)).toMatchObject({
      type: "relay.registered",
    });
    expect(browser.readyState).toBe(WebSocket.OPEN);
  });

  it("terminates a destination whose bounded send buffer is exhausted", async () => {
    const url = await relayFixture({ maxBufferedBytes: 1_024 });
    const desktop = await socket(url);
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.register",
      endpointId: "slow_endpoint",
      role: "desktop",
      relayVersion: "0.1.0",
    }));
    await nextMessage(desktop);
    const browser = await socket(url);
    browser.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.connect",
      endpointId: "slow_endpoint",
      browserVersion: "0.1.0",
    }));
    const connectionId = (await nextMessage(browser)).connectionId as string;
    await nextMessage(desktop);
    const desktopClosed = once(desktop, "close");
    const peerDisconnected = nextMessage(browser);

    browser.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.frame",
      connectionId,
      frame: {
        protocolVersion: 1,
        kind: "pair.request",
        invitationId: crypto.randomUUID(),
        enc: "valid_encapsulation",
        ciphertext: "x".repeat(2_048),
      },
    }));

    await desktopClosed;
    expect(await peerDisconnected).toMatchObject({
      type: "relay.peer-disconnected",
      connectionId,
    });
  });

  it("allows only explicitly configured browser origins", async () => {
    const url = await relayFixture({
      allowedOrigins: ["http://127.0.0.1:4173"],
    });
    const browser = await browserSocket(url, "http://127.0.0.1:4173");
    expect(browser.readyState).toBe(WebSocket.OPEN);

    const rejected = new WebSocket(url, {
      origin: "https://pairing-phish.example",
    });
    sockets.push(rejected);
    await expect(once(rejected, "error")).resolves.toBeDefined();
  });

  it("normalizes an IPv6 loopback browser origin", async () => {
    const url = await relayFixture({
      allowedOrigins: ["http://[::1]:4173"],
    });
    const browser = await browserSocket(url, "http://[::1]:4173");
    expect(browser.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects malformed frames instead of forwarding them", async () => {
    const url = await relayFixture();
    const desktop = await socket(url);
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.register",
      endpointId: "bounded_endpoint",
      role: "desktop",
      relayVersion: "0.1.0",
    }));
    await nextMessage(desktop);
    const browser = await socket(url);
    browser.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.connect",
      endpointId: "bounded_endpoint",
      browserVersion: "0.1.0",
    }));
    const connectionId = (await nextMessage(browser)).connectionId as string;
    await nextMessage(desktop);

    browser.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.frame",
      connectionId,
      frame: {
        protocolVersion: 1,
        kind: "session.data",
        sessionId: crypto.randomUUID(),
        sequence: -1,
        ciphertext: "opaque",
      },
    }));
    expect(await nextMessage(browser)).toMatchObject({
      type: "relay.error",
      code: "invalid-message",
    });
  });
});
