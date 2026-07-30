import { _electron as electron, expect, test } from "@playwright/test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { once } from "node:events";

import { WebSocket } from "ws";

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
  remoteCipherFrameSchema,
  remotePairingRequestPayloadSchema,
  remoteRequestSchema,
  type RemotePairingInvitation,
} from "../../src/shared/remote-protocol";

let staticServer: Server;
let staticUrl: string;
let relay: ReferenceRelay;
let relayUrl: string;
let desktop: WebSocket;

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
  const electronApp = await electron.launch({
    args: [resolve("tests/fixtures/remote-browser-electron.cjs"), staticUrl],
  });
  const page = await electronApp.firstWindow();
  const hostKeys = await generateRemoteKeyPair();
  const invitation: RemotePairingInvitation = {
    protocolVersion: 1,
    relayUrl,
    endpointId: remoteRandomSecret(24),
    hostId: crypto.randomUUID(),
    hostPublicKey: hostKeys.publicKey,
    invitationId: crypto.randomUUID(),
    pairingSecret: remoteRandomSecret(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  desktop = new WebSocket(relayUrl);
  await once(desktop, "open");
  desktop.send(JSON.stringify({
    protocolVersion: 1,
    type: "relay.register",
    endpointId: invitation.endpointId,
    role: "desktop",
    relayVersion: "0.1.0",
  }));
  await nextDesktopMessage((message) => message.type === "relay.registered");

  try {
    await expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible();
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
      protocolVersion: 1,
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
      protocolVersion: 1,
      type: "relay.frame",
      connectionId: sessionMessage.connectionId,
      frame: {
        protocolVersion: 1,
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
      protocolVersion: 1,
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
      protocolVersion: 1,
      type: "relay.frame",
      connectionId: sessionMessage.connectionId,
      frame: {
        protocolVersion: 1,
        kind: "session.close",
        sessionId,
        reason: "revoked",
      },
    }));
    await expect(page.getByText(/closed the session/u)).toBeVisible();
    await page.getByRole("button", { name: "Reconnect" }).click();
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
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      type: "relay.frame",
      connectionId: reducedMessage.connectionId,
      frame: {
        protocolVersion: 1,
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
          .get("active");
        request.onsuccess = () => resolveProfile(request.result as {
          grantVersion: number;
          scopes: string[];
        });
        request.onerror = () => reject(request.error);
      });
      db.close();
      return profile;
    })).toMatchObject({ grantVersion: 2, scopes: ["view"] });

    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const opening = indexedDB.open("inertia-remote-companion", 1);
        opening.onsuccess = () => resolveDatabase(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      await new Promise<void>((resolveWrite, reject) => {
        const transaction = db.transaction("device", "readwrite");
        transaction.objectStore("device").put({
          version: 1,
          relayUrl: "javascript:alert(1)",
          capabilities: ["full-access"],
        }, "active");
        transaction.oncomplete = () => resolveWrite();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    });
    await page.reload();
    await expect(page.getByText(
      "The stored Remote Companion profile was invalid and has been cleared.",
    )).toBeVisible();
    await expect(page.getByRole("heading", {
      name: "Pair this browser",
    })).toBeVisible();
  } finally {
    await electronApp.close();
  }
});

async function nextDesktopMessage(
  accept: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      desktop.off("message", onMessage);
      reject(new Error("Desktop relay message timed out."));
    }, 5_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!accept(message)) return;
      clearTimeout(timer);
      desktop.off("message", onMessage);
      resolveMessage(message);
    };
    desktop.on("message", onMessage);
  });
}

async function serveBrowserAsset(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const path = request.url === "/"
      ? resolve(root, "index.html")
      : resolve(root, request.url?.replace(/^\/+/u, "") ?? "missing");
    if (!path.startsWith(`${root}/`) && path !== resolve(root, "index.html")) {
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
