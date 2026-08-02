import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  endpointProofTranscript,
  type EndpointChallenge,
} from "../remote/relay/endpoint-auth.mjs";
import {
  RELAY_PROTOCOL_VERSION,
  REMOTE_BROWSER_COMPATIBILITY,
  REMOTE_DESKTOP_COMPATIBILITY,
} from "../src/shared/remote-protocol";

import {
  createReferenceRelay,
  type ReferenceRelay,
} from "../remote/relay/server.mjs";

const relays: ReferenceRelay[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories: string[] = [];
const TEST_ORIGIN = "http://127.0.0.1:4173";

async function relayFixture(options = {}) {
  const relay = await createReferenceRelay({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [TEST_ORIGIN],
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
  const hello = nextMessage(value);
  await once(value, "open");
  expect(await hello).toMatchObject({ type: "relay.hello" });
  return value;
}

async function browserSocket(
  url: string,
  origin: string,
): Promise<WebSocket> {
  const value = new WebSocket(url, { origin });
  sockets.push(value);
  const hello = nextMessage(value);
  await once(value, "open");
  expect(await hello).toMatchObject({ type: "relay.hello" });
  return value;
}

async function registerDesktop(
  desktop: WebSocket,
  endpointId: string,
  options: {
    keys?: ReturnType<typeof endpointKeys>;
    purpose?: "claim" | "register";
  } = {},
): Promise<Record<string, unknown>> {
  const { publicKey, privateKey } = options.keys ?? endpointKeys();
  desktop.send(JSON.stringify(options.purpose === "register" ? {
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.register.begin",
    endpointId,
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
  } : {
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.claim.begin",
    endpointId,
    endpointPublicKey: publicKey,
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
  }));
  const challenge = await nextMessage(desktop) as unknown as EndpointChallenge;
  desktop.send(JSON.stringify({
    type: "relay.register.proof",
    purpose: challenge.purpose,
    relayIdentity: challenge.relayIdentity,
    endpointId: challenge.endpointId,
    endpointPublicKey: challenge.endpointPublicKey,
    nonce: challenge.nonce,
    epoch: challenge.epoch,
    expiresAt: challenge.expiresAt,
    signature: sign(
      "sha256",
      endpointProofTranscript(challenge),
      { key: privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url"),
  }));
  return await nextMessage(desktop);
}

function endpointKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    publicKey: publicKey.export({
      format: "der",
      type: "spki",
    }).toString("base64url"),
    privateKey,
  };
}

async function connectBrowser(
  url: string,
  endpointId: string,
  origin = TEST_ORIGIN,
): Promise<{ socket: WebSocket; connected: Record<string, unknown> }> {
  const browser = await browserSocket(url, origin);
  browser.send(JSON.stringify({
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.connect",
    endpointId,
    browser: REMOTE_BROWSER_COMPATIBILITY,
  }));
  return { socket: browser, connected: await nextMessage(browser) };
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
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion reference relay", () => {
  it("routes only bounded opaque frames without durable queuing", async () => {
    const url = await relayFixture();
    const desktop = await socket(url);
    expect(await registerDesktop(desktop, "opaque_endpoint")).toMatchObject({
      type: "relay.registered",
    });

    const { socket: browser, connected } = await connectBrowser(
      url,
      "opaque_endpoint",
    );
    const connectionId = connected.connectionId as string;
    const endpointEpoch = connected.endpointEpoch as number;
    expect(connected).toMatchObject({ type: "relay.connected" });
    expect(await nextMessage(desktop)).toMatchObject({
      type: "relay.peer-connected",
      connectionId,
    });

    const stranger = await socket(url);
    stranger.send(JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.disconnect",
      connectionId,
    }));
    expect(await nextMessage(stranger)).toMatchObject({
      type: "relay.error",
      code: "connection-missing",
    });

    const frame = {
      protocolVersion: 2,
      kind: "pair.request",
      invitationId: crypto.randomUUID(),
      enc: "opaque_encapsulation",
      ciphertext: "opaque_ciphertext",
    };
    browser.send(JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId,
      frame,
    }));
    expect(await nextMessage(desktop)).toEqual({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId,
      endpointEpoch,
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
    await registerDesktop(desktop, "aggregate_endpoint");

    const browsers: WebSocket[] = [];
    const connectionIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const { socket: browser, connected } = await connectBrowser(
        url,
        "aggregate_endpoint",
      );
      browsers.push(browser);
      connectionIds.push(connected.connectionId as string);
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
      protocolVersion: 2,
      kind: "session.close",
      sessionId: crypto.randomUUID(),
      reason: "shutdown",
    };
    // Four normal sessions each emit 60 state/detail responses per minute.
    // Include lifecycle margin that exceeded the old shared 240-message cap.
    for (let index = 0; index < 244; index += 1) {
      desktop.send(JSON.stringify({
        relayProtocolVersion: 2,
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
        relayProtocolVersion: 2,
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
    const { socket: browser, connected } = await connectBrowser(
      url,
      "offline_endpoint",
    );
    expect(connected).toMatchObject({
      type: "relay.error",
      code: "desktop-offline",
    });

    const desktop = await socket(url);
    expect(await registerDesktop(desktop, "offline_endpoint")).toMatchObject({
      type: "relay.registered",
    });
    expect(browser.readyState).toBe(WebSocket.OPEN);
  });

  it("terminates a destination whose bounded send buffer is exhausted", async () => {
    const url = await relayFixture({ maxBufferedBytes: 1_024 });
    const desktop = await socket(url);
    await registerDesktop(desktop, "slow_endpoint");
    const { socket: browser, connected } = await connectBrowser(
      url,
      "slow_endpoint",
    );
    const connectionId = connected.connectionId as string;
    await nextMessage(desktop);
    const desktopClosed = once(desktop, "close");
    const peerDisconnected = nextMessage(browser);

    browser.send(JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId,
      frame: {
        protocolVersion: 2,
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
    await registerDesktop(desktop, "bounded_endpoint");
    const { socket: browser, connected } = await connectBrowser(
      url,
      "bounded_endpoint",
    );
    const connectionId = connected.connectionId as string;
    await nextMessage(desktop);

    browser.send(JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId,
      frame: {
        protocolVersion: 2,
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

  it("preserves relay identity and endpoint ownership across a durable restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-relay-restart-"));
    temporaryDirectories.push(directory);
    const keys = endpointKeys();
    const first = await createReferenceRelay({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [TEST_ORIGIN],
      stateDirectory: directory,
      initializeState: true,
    });
    relays.push(first);
    const firstAddress = first.address();
    if (!firstAddress) throw new Error("Relay did not bind.");
    const firstUrl = `ws://127.0.0.1:${firstAddress.port}/remote`;
    const firstDesktop = new WebSocket(firstUrl);
    sockets.push(firstDesktop);
    const firstHello = nextMessage(firstDesktop);
    await once(firstDesktop, "open");
    const relayIdentity = (await firstHello).relayIdentity;
    const claimed = await registerDesktop(firstDesktop, "durable_endpoint", {
      keys,
    });
    expect(claimed).toMatchObject({
      type: "relay.registered",
      ownership: "claimed",
      endpointEpoch: 1,
    });
    firstDesktop.terminate();
    await first.close();
    relays.splice(relays.indexOf(first), 1);

    const restarted = await createReferenceRelay({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [TEST_ORIGIN],
      stateDirectory: directory,
    });
    relays.push(restarted);
    const restartedAddress = restarted.address();
    if (!restartedAddress) throw new Error("Restarted relay did not bind.");
    const restartedUrl = `ws://127.0.0.1:${restartedAddress.port}/remote`;
    const desktop = new WebSocket(restartedUrl);
    sockets.push(desktop);
    const restartedHello = nextMessage(desktop);
    await once(desktop, "open");
    expect((await restartedHello).relayIdentity).toBe(relayIdentity);
    const registered = await registerDesktop(desktop, "durable_endpoint", {
      keys,
      purpose: "register",
    });
    expect(registered).toMatchObject({
      type: "relay.registered",
      ownership: "verified",
      endpointEpoch: 2,
    });
  });

  it("rejects endpoint squatting, fences stale routes on takeover, and reports mixed versions", async () => {
    const url = await relayFixture();
    const keys = endpointKeys();
    const firstDesktop = await socket(url);
    await registerDesktop(firstDesktop, "owned_endpoint", { keys });

    const attacker = await socket(url);
    expect(await registerDesktop(attacker, "owned_endpoint", {
      keys: endpointKeys(),
      purpose: "register",
    })).toMatchObject({
      type: "relay.error",
      code: "proof-invalid",
    });

    const { socket: browser, connected } = await connectBrowser(
      url,
      "owned_endpoint",
    );
    await nextMessage(firstDesktop);
    const disconnected = nextMessage(browser);
    const oldOwnerClosed = once(firstDesktop, "close");
    const replacement = await socket(url);
    expect(await registerDesktop(replacement, "owned_endpoint", {
      keys,
      purpose: "register",
    })).toMatchObject({
      type: "relay.registered",
      ownership: "taken-over",
      endpointEpoch: 2,
    });
    await oldOwnerClosed;
    expect(await disconnected).toMatchObject({
      type: "relay.peer-disconnected",
      connectionId: connected.connectionId,
      endpointEpoch: 1,
    });

    const mixed = await browserSocket(url, TEST_ORIGIN);
    mixed.send(JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.connect",
      endpointId: "owned_endpoint",
      browser: {
        ...REMOTE_BROWSER_COMPATIBILITY,
        remoteProtocol: { minimum: 3, maximum: 3 },
      },
    }));
    expect(await nextMessage(mixed)).toMatchObject({
      type: "relay.incompatible",
      axis: "remote-protocol",
      component: "browser",
      reason: "client-too-new",
      guidance: expect.arrayContaining([
        expect.objectContaining({ action: "upgrade", component: "desktop" }),
      ]),
    });
  });

  it("keeps health output safe and reports migration mode as degraded", async () => {
    const url = await relayFixture({ allowLegacyRegistration: true });
    const response = await fetch(url.replace("ws://", "http://").replace(
      "/remote",
      "/health",
    ));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      status: "degraded",
      relayVersion: "0.2.0",
      endpointAuthentication: "migration",
      originPolicy: "configured",
    });
    expect(text).not.toMatch(/endpointId|connectionId|publicKey|nonce|owner/iu);
  });
});
