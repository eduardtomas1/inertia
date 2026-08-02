import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { once } from "node:events";

import { WebSocket, WebSocketServer } from "ws";

import {
  createReferenceRelay,
  type ReferenceRelay,
} from "../../remote/relay/server.mjs";
import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  importRemotePublicKey,
  openSessionData,
  openSessionHandshake,
  openPairingRequest,
  remoteRandomSecret,
  sealPairingResponse,
  sealSessionData,
  sealSessionHandshake,
} from "../../src/shared/remote-crypto";
import {
  REMOTE_DESKTOP_COMPATIBILITY,
  RELAY_PROTOCOL_VERSION,
  remoteCipherFrameSchema,
  remotePairingRequestPayloadSchema,
  remoteRequestSchema,
  type RemotePairingInvitation,
} from "../../src/shared/remote-protocol";
import {
  closeRemoteBrowserRelayResources,
  launchRemoteBrowser,
} from "./support/remote-browser-electron-fixture";
import { registerRelayDesktop } from "./support/remote-relay-v2";

let staticServer: Server;
let staticUrl: string;
let relay: ReferenceRelay;
let relayUrl: string;
let desktop: WebSocket;
let navigationSequence = 0;

test.beforeAll(async () => {
  const root = resolve("remote/browser/dist");
  staticServer = createServer((request, response) => {
    void serveBrowserAsset(root, request, response);
  });
  staticServer.listen(0, "127.0.0.1");
  await once(staticServer, "listening");
  const staticAddress = staticServer.address();
  if (!staticAddress || typeof staticAddress === "string") {
    throw new Error("Browser test server did not bind.");
  }
  staticUrl = `http://127.0.0.1:${staticAddress.port}`;

  relay = await createReferenceRelay({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: [staticUrl],
  });
  const relayAddress = relay.address();
  if (!relayAddress) throw new Error("Relay did not bind.");
  relayUrl = `ws://127.0.0.1:${relayAddress.port}/remote`;
});

test.afterAll(async () => {
  desktop?.terminate();
  await relay.close();
  await new Promise<void>((resolveClose) =>
    staticServer.close(() => resolveClose()));
});

test("runs HPKE pairing in a real strict-CSP browser bundle", async () => {
  const browser = await launchRemoteBrowser({
    staticUrl,
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Pair this browser" }))
        .toBeVisible();
    },
  });
  const { page } = browser;
  const hostKeys = await generateRemoteKeyPair();
  const endpointId = remoteRandomSecret(24);
  const registration = await registerRelayDesktop(endpointId, relayUrl);
  desktop = registration.socket;
  const invitation: RemotePairingInvitation = {
    protocolVersion: 2,
    relayUrl,
    relayIdentity: registration.relayIdentity,
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
    endpointId,
    hostId: crypto.randomUUID(),
    hostPublicKey: hostKeys.publicKey,
    invitationId: crypto.randomUUID(),
    pairingSecret: remoteRandomSecret(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  try {
    await expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole("button", { name: "Pair", exact: true }))
      .toBeDisabled();
    await page.context().setOffline(false);
    await expect(page.getByRole("button", { name: "Pair", exact: true }))
      .toBeEnabled();
    await page.getByLabel("Browser name").fill("Playwright browser");
    await page.getByLabel("Invitation").fill(JSON.stringify(invitation));
    const pairingRequestPromise = nextDesktopMessage(
      (message) =>
        message.type === "relay.frame"
        && typeof message.frame === "object"
        && message.frame !== null
        && "kind" in message.frame
        && message.frame.kind === "pair.request",
    );
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    const relayed = await pairingRequestPromise;
    const serialized = JSON.stringify(relayed);
    expect(serialized).not.toContain("Playwright browser");
    expect(serialized).not.toContain(invitation.pairingSecret);
    if (
      relayed.type !== "relay.frame"
      || typeof relayed.frame !== "object"
      || relayed.frame === null
    ) throw new Error("Missing encrypted pairing frame.");
    const payload = remotePairingRequestPayloadSchema.parse(
      await openPairingRequest(
        invitation,
        await importRemoteKeyPair(hostKeys),
        relayed.frame as Parameters<typeof openPairingRequest>[2],
      ),
    );
    expect(payload.deviceLabel).toBe("Playwright browser");
    await expect(page.getByText(/Comparison code: \d{6}/u)).toBeVisible();

    const sessionOpenPromise = nextDesktopMessage(
      (message) =>
        message.type === "relay.frame"
        && typeof message.frame === "object"
        && message.frame !== null
        && "kind" in message.frame
        && message.frame.kind === "session.open",
    );
    const devicePublicKey = await importRemotePublicKey(
      payload.devicePublicKey,
    );
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: relayed.connectionId,
      frame: await sealPairingResponse(
        await importRemoteKeyPair(hostKeys),
        devicePublicKey,
        payload.requestId,
        {
          type: "pair.accepted",
          requestId: payload.requestId,
          deviceId: payload.deviceId,
          hostId: invitation.hostId,
          scopes: ["view", "prompt"],
          projectIds: ["safe-project"],
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          grantVersion: 1,
        },
      ),
    }));
    const sessionMessage = await sessionOpenPromise;
    if (
      sessionMessage.type !== "relay.frame"
      || typeof sessionMessage.connectionId !== "string"
      || typeof sessionMessage.frame !== "object"
      || sessionMessage.frame === null
      || !("kind" in sessionMessage.frame)
      || sessionMessage.frame.kind !== "session.open"
    ) throw new Error("Missing encrypted session opening.");
    const sessionFrame = remoteCipherFrameSchema.parse(sessionMessage.frame);
    if (sessionFrame.kind !== "session.open") {
      throw new Error("Invalid encrypted session opening.");
    }
    const { sessionId, enc: encapsulation, ciphertext } = sessionFrame;
    const recipient = await createAuthenticatedSessionRecipient(
      invitation.hostId,
      payload.deviceId,
      sessionId,
      await importRemoteKeyPair(hostKeys),
      devicePublicKey,
      encapsulation,
    );
    expect(await openSessionHandshake(
      recipient,
      "session.open",
      sessionId,
      ciphertext,
    )).toMatchObject({
      deviceId: payload.deviceId,
      grantVersion: 1,
    });
    const sender = await createAuthenticatedSessionSender(
      invitation.hostId,
      payload.deviceId,
      sessionId,
      await importRemoteKeyPair(hostKeys),
      devicePublicKey,
    );
    const requestPromise = nextDesktopMessage(
      (message) =>
        message.type === "relay.frame"
        && typeof message.frame === "object"
        && message.frame !== null
        && "kind" in message.frame
        && message.frame.kind === "session.data",
    );
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: sessionMessage.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.accept",
        sessionId,
        enc: sender.enc,
        ciphertext: await sealSessionHandshake(
          sender,
          "session.accept",
          sessionId,
          {
            type: "session.accept",
            sessionId,
            hostId: invitation.hostId,
            grantVersion: 1,
            scopes: ["view", "prompt"],
            projectIds: ["safe-project"],
            expiresAt: new Date(
              Date.now() + 24 * 60 * 60 * 1_000,
            ).toISOString(),
            serverTime: new Date().toISOString(),
          },
        ),
      },
    }));
    const requestMessage = await requestPromise;
    if (
      requestMessage.type !== "relay.frame"
      || typeof requestMessage.frame !== "object"
      || requestMessage.frame === null
    ) throw new Error("Missing encrypted state request.");
    const requestFrame = remoteCipherFrameSchema.parse(requestMessage.frame);
    if (requestFrame.kind !== "session.data") {
      throw new Error("Invalid encrypted state request.");
    }
    const request = remoteRequestSchema.parse(
      await openSessionData(
        recipient,
        requestFrame,
      ),
    );
    expect(request.type).toBe("state.get");
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: sessionMessage.connectionId,
      frame: await sealSessionData(sender, sessionId, {
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "state",
          state: {
            generatedAt: new Date().toISOString(),
            projects: [{ id: "safe-project", name: "Safe project" }],
            conversations: [],
            runs: [],
          },
        },
      }),
    }));
    await expect(page.getByText("Safe project")).toBeVisible();

    const reducedSessionPromise = nextDesktopMessage(
      (message) =>
        message.type === "relay.frame"
        && typeof message.frame === "object"
        && message.frame !== null
        && "kind" in message.frame
        && message.frame.kind === "session.open",
    );
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: sessionMessage.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.close",
        sessionId,
        reason: "revoked",
      },
    }));
    const reducedMessage = await reducedSessionPromise;
    if (
      reducedMessage.type !== "relay.frame"
      || typeof reducedMessage.connectionId !== "string"
      || typeof reducedMessage.frame !== "object"
      || reducedMessage.frame === null
    ) throw new Error("Missing reduced-grant session.");
    const reducedOpen = remoteCipherFrameSchema.parse(reducedMessage.frame);
    if (reducedOpen.kind !== "session.open") {
      throw new Error("Invalid reduced-grant session.");
    }
    const reducedRecipient = await createAuthenticatedSessionRecipient(
      invitation.hostId,
      payload.deviceId,
      reducedOpen.sessionId,
      await importRemoteKeyPair(hostKeys),
      devicePublicKey,
      reducedOpen.enc,
    );
    expect(await openSessionHandshake(
      reducedRecipient,
      "session.open",
      reducedOpen.sessionId,
      reducedOpen.ciphertext,
    )).toMatchObject({ grantVersion: 1 });
    const reducedSender = await createAuthenticatedSessionSender(
      invitation.hostId,
      payload.deviceId,
      reducedOpen.sessionId,
      await importRemoteKeyPair(hostKeys),
      devicePublicKey,
    );
    await expect(page.getByText("Safe project")).toBeVisible();
    await expect(page.locator("[data-remote-key]")).not.toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Playwright browser" }))
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toHaveCount(0);
    const reducedRequestPromise = nextDesktopMessage(
      (message) =>
        message.type === "relay.frame"
        && message.connectionId === reducedMessage.connectionId
        && typeof message.frame === "object"
        && message.frame !== null
        && "kind" in message.frame
        && message.frame.kind === "session.data",
    );
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: reducedMessage.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.accept",
        sessionId: reducedOpen.sessionId,
        enc: reducedSender.enc,
        ciphertext: await sealSessionHandshake(
          reducedSender,
          "session.accept",
          reducedOpen.sessionId,
          {
            type: "session.accept",
            sessionId: reducedOpen.sessionId,
            hostId: invitation.hostId,
            grantVersion: 2,
            scopes: ["view"],
            projectIds: ["safe-project"],
            expiresAt: new Date(
              Date.now() + 12 * 60 * 60 * 1_000,
            ).toISOString(),
            serverTime: new Date().toISOString(),
          },
        ),
      },
    }));
    const reducedRequestMessage = await reducedRequestPromise;
    await expect(page.getByText("Safe project")).toHaveCount(0);
    await expect(page.locator("[data-remote-key]")).toHaveCount(0);
    const reducedRequestFrame = remoteCipherFrameSchema.parse(
      reducedRequestMessage.frame,
    );
    if (reducedRequestFrame.kind !== "session.data") {
      throw new Error("Missing reduced state request.");
    }
    const reducedRequest = remoteRequestSchema.parse(
      await openSessionData(reducedRecipient, reducedRequestFrame),
    );
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: reducedMessage.connectionId,
      frame: await sealSessionData(reducedSender, reducedOpen.sessionId, {
        type: "response",
        requestId: reducedRequest.requestId,
        ok: true,
        result: {
          kind: "state",
          state: {
            generatedAt: new Date().toISOString(),
            projects: [{ id: "safe-project", name: "Safe project" }],
            conversations: [],
            runs: [],
          },
        },
      }),
    }));
    await expect(page.getByText("Safe project")).toBeVisible();
    await expect.poll(async () => await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const opening = indexedDB.open("inertia-remote-companion", 1);
        opening.onsuccess = () => resolveDatabase(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const profile = await new Promise<{
        grantVersion: number;
        scopes: string[];
      }>((resolveProfile, reject) => {
        const request = db.transaction("device").objectStore("device")
          .get("active-sealed");
        request.onsuccess = () => resolveProfile(request.result as {
          grantVersion: number;
          scopes: string[];
        });
        request.onerror = () => reject(request.error);
      });
      db.close();
      return profile;
    })).toMatchObject({ grantVersion: 2, scopes: ["view"] });

    const revokedSessionPromise = nextDesktopMessage(
      (message) =>
        message.type === "relay.frame"
        && typeof message.frame === "object"
        && message.frame !== null
        && "kind" in message.frame
        && message.frame.kind === "session.open",
    );
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: reducedMessage.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.close",
        sessionId: reducedOpen.sessionId,
        reason: "revoked",
      },
    }));
    await expect(page.getByText(/fresh authenticated session/u)).toBeVisible();
    await expect(page.getByText("Safe project")).toBeVisible();
    await expect(page.locator("[data-remote-key]")).not.toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Playwright browser" }))
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toHaveCount(0);

    const revokedMessage = await revokedSessionPromise;
    if (
      typeof revokedMessage.connectionId !== "string"
      || typeof revokedMessage.frame !== "object"
      || revokedMessage.frame === null
    ) throw new Error("Missing revoked session opening.");
    const revokedOpen = remoteCipherFrameSchema.parse(revokedMessage.frame);
    if (revokedOpen.kind !== "session.open") {
      throw new Error("Invalid revoked session opening.");
    }
    const revokedSender = await createAuthenticatedSessionSender(
      invitation.hostId,
      payload.deviceId,
      revokedOpen.sessionId,
      await importRemoteKeyPair(hostKeys),
      devicePublicKey,
    );
    desktop.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId: revokedMessage.connectionId,
      frame: {
        protocolVersion: 2,
        kind: "session.accept",
        sessionId: revokedOpen.sessionId,
        enc: revokedSender.enc,
        ciphertext: await sealSessionHandshake(
          revokedSender,
          "session.accept",
          revokedOpen.sessionId,
          {
            type: "session.reject",
            sessionId: revokedOpen.sessionId,
            hostId: invitation.hostId,
            reason: "revoked",
            serverTime: new Date().toISOString(),
          },
        ),
      },
    }));
    await expect(page.getByText(/revoked on the desktop/u)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toBeVisible();
    await expect(page.getByText("Safe project")).toHaveCount(0);
    await expect(page.getByText("Playwright browser")).toHaveCount(0);
    await expect(page.locator("[data-remote-key]")).toHaveCount(0);
  } finally {
    await page.context().setOffline(false).catch(() => undefined);
    await browser.close();
  }
});

test("stops automatic retries on a terminal relay protocol mismatch", async () => {
  const mismatchRelay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let browser: Awaited<ReturnType<typeof launchRemoteBrowser>> | null = null;
  try {
    await once(mismatchRelay, "listening");
    const address = mismatchRelay.address();
    if (!address || typeof address === "string") {
      throw new Error("Mismatch relay did not bind.");
    }
    const mismatchIdentity = crypto.randomUUID();
    let connections = 0;
    mismatchRelay.on("connection", (socket) => {
      connections += 1;
      socket.send(JSON.stringify({
        relayProtocolVersion: RELAY_PROTOCOL_VERSION,
        type: "relay.hello",
        relayVersion: "0.2.0",
        relayIdentity: mismatchIdentity,
        relayProtocol: { minimum: 2, maximum: 2 },
        remoteProtocol: { minimum: 2, maximum: 2 },
        endpointAuthentication: "required",
        persistence: "ephemeral",
      }));
      socket.once("message", () => {
        socket.send(JSON.stringify({
          relayProtocolVersion: RELAY_PROTOCOL_VERSION,
          type: "relay.incompatible",
          axis: "remote-protocol",
          reason: "client-too-new",
          component: "browser",
          received: { minimum: 3, maximum: 3 },
          supported: { minimum: 2, maximum: 2 },
          guidance: [{
            action: "downgrade",
            component: "browser",
            requiredProtocol: { minimum: 2, maximum: 2 },
          }],
        }));
      });
    });
    const hostKeys = await generateRemoteKeyPair();
    browser = await launchRemoteBrowser({
      staticUrl,
      ready: async (page) => {
        await expect(page.getByRole("heading", { name: "Pair this browser" }))
          .toBeVisible();
      },
    });
    const { page } = browser;
    await seedBrowserProfile(page, {
      hostPublicKey: hostKeys.publicKey,
      relayUrl: `ws://127.0.0.1:${address.port}/remote`,
      relayIdentity: mismatchIdentity,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    connections = 0;
    await navigateRemoteBrowser(page, "terminal-protocol-mismatch");
    await expect(page.getByText(/Remote Companion versions are incompatible/u))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Retry connection" }))
      .toBeVisible();
    const terminalConnectionCount = connections;
    await page.waitForTimeout(2_000);
    expect(connections).toBe(terminalConnectionCount);
  } finally {
    await closeRemoteBrowserRelayResources(browser, mismatchRelay);
  }
});

test("expires a browser grant while a real socket attempt is in flight", async () => {
  const silentRelay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let browser: Awaited<ReturnType<typeof launchRemoteBrowser>> | null = null;
  try {
    await once(silentRelay, "listening");
    const address = silentRelay.address();
    if (!address || typeof address === "string") {
      throw new Error("Silent relay did not bind.");
    }
    const hostKeys = await generateRemoteKeyPair();
    browser = await launchRemoteBrowser({
      staticUrl,
      ready: async (page) => {
        await expect(page.getByRole("heading", { name: "Pair this browser" }))
          .toBeVisible();
      },
    });
    const { page } = browser;
    await seedBrowserProfile(page, {
      hostPublicKey: hostKeys.publicKey,
      relayUrl: `ws://127.0.0.1:${address.port}/remote`,
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    await navigateRemoteBrowser(page, "grant-expiry");
    await expect(page.getByText("This device grant expired. Pair it again."))
      .toBeVisible();
    await expect(page.getByRole("heading", { name: "Pair this browser" }))
      .toBeVisible();
  } finally {
    await closeRemoteBrowserRelayResources(browser, silentRelay);
  }
});

async function navigateRemoteBrowser(page: Page, label: string): Promise<void> {
  navigationSequence += 1;
  await page.goto(
    `${staticUrl}/?fixture=${encodeURIComponent(label)}-${navigationSequence}`,
    { waitUntil: "load" },
  );
}

async function seedBrowserProfile(
  page: Page,
  input: {
    hostPublicKey: string;
    relayUrl: string;
    expiresAt: string;
    hostId?: string;
    deviceId?: string;
    endpointId?: string;
    relayIdentity?: string;
    scopes?: Array<"view" | "prompt">;
  },
): Promise<{
  hostId: string;
  deviceId: string;
  endpointId: string;
  publicKey: string;
  expiresAt: string;
}> {
  return await page.evaluate(async ({
    hostPublicKey,
    relayUrl: url,
    expiresAt,
    hostId: requestedHostId,
    deviceId: requestedDeviceId,
    endpointId: requestedEndpointId,
    relayIdentity: requestedRelayIdentity,
    scopes,
    desktop,
  }) => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ) as CryptoKeyPair;
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    );
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    const publicKey = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const hostId = requestedHostId ?? crypto.randomUUID();
    const deviceId = requestedDeviceId ?? crypto.randomUUID();
    const endpointId = requestedEndpointId ?? "lifecycle_endpoint";
    const relayIdentity = requestedRelayIdentity ?? crypto.randomUUID();
    const db = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const opening = indexedDB.open("inertia-remote-companion", 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("device");
      };
      opening.onsuccess = () => resolveDatabase(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await new Promise<void>((resolveWrite, reject) => {
      const transaction = db.transaction("device", "readwrite");
      transaction.objectStore("device").put({
        version: 2,
        deviceId,
        deviceLabel: "Lifecycle browser",
        publicKey,
        privateKey: keys.privateKey,
        lastUsedAt: new Date().toISOString(),
        hostId,
        hostPublicKey,
        relayUrl: url,
        relayIdentity,
        desktop,
        endpointId,
        scopes: scopes ?? ["view"],
        projectIds: ["safe-project"],
        grantVersion: 1,
        expiresAt,
      }, "active-sealed");
      transaction.oncomplete = () => resolveWrite();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return { hostId, deviceId, endpointId, publicKey, expiresAt };
  }, { ...input, desktop: REMOTE_DESKTOP_COMPATIBILITY });
}

async function nextDesktopMessage(
  accept: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await nextSocketMessage(desktop, accept);
}

async function nextSocketMessage(
  socket: WebSocket,
  accept: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Desktop relay message timed out."));
    }, 15_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!accept(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolveMessage(message);
    };
    socket.on("message", onMessage);
  });
}

async function serveBrowserAsset(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const requestPath = new URL(
      request.url ?? "/missing",
      "http://remote-companion.invalid",
    ).pathname;
    const path = requestPath === "/"
      ? resolve(root, "index.html")
      : resolve(root, requestPath.replace(/^\/+/u, ""));
    const nested = relative(root, path);
    if (
      nested === ".."
      || nested.startsWith(`..${sep}`)
      || isAbsolute(nested)
    ) {
      throw new Error("outside root");
    }
    const bytes = await readFile(path);
    const contentType = extname(path) === ".html"
      ? "text/html; charset=utf-8"
      : extname(path) === ".css"
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src ws: wss:",
        "img-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}
