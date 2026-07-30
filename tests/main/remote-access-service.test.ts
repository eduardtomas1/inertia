import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { createReferenceRelay, type ReferenceRelay } from "../../remote/relay/server.mjs";
import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  importRemotePublicKey,
  openPairingResponse,
  openSessionData,
  openSessionHandshake,
  remotePairingComparisonCode,
  sealPairingRequest,
  sealSessionData,
  sealSessionHandshake,
  type RemoteSerializedKeyPair,
} from "../../src/shared/remote-crypto";
import {
  REMOTE_PROTOCOL_VERSION,
  remotePairingResponsePayloadSchema,
  remoteResponseSchema,
  remoteSessionAcceptPayloadSchema,
  type RemoteCipherFrame,
  type RemotePairingInvitation,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteSessionAcceptPayload,
} from "../../src/shared/remote-protocol";
import { RemoteAccessService } from "../../src/main/remote-access-service";
import { remotePairingComparisonCode as mainComparisonCode } from "../../src/main/remote-access-policy";
import { RemoteAccessStore } from "../../src/main/remote-access-store";

const remoteCryptoGate = vi.hoisted(() => ({
  afterPairingOpen: null as (() => Promise<void>) | null,
}));

vi.mock("../../src/shared/remote-crypto", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/shared/remote-crypto")
  >();
  return {
    ...actual,
    openPairingRequest: async (
      ...args: Parameters<typeof actual.openPairingRequest>
    ) => {
      const result = await actual.openPairingRequest(...args);
      await remoteCryptoGate.afterPairingOpen?.();
      return result;
    },
  };
});

const relays: ReferenceRelay[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];

afterEach(async () => {
  remoteCryptoGate.afterPairingOpen = null;
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const relay of relays.splice(0)) await relay.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function encryptedStore() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-remote-service-"));
  directories.push(directory);
  return new RemoteAccessStore(join(directory, "remote.vault"), {
    available: () => true,
    encrypt: (plaintext) =>
      new TextEncoder().encode(`encrypted:${btoa(plaintext)}`),
    decrypt: (ciphertext) => atob(
      new TextDecoder().decode(ciphertext).replace("encrypted:", ""),
    ),
  });
}

async function relay() {
  const value = await createReferenceRelay({ host: "127.0.0.1", port: 0 });
  relays.push(value);
  const address = value.address();
  if (!address) throw new Error("Relay did not bind.");
  return `ws://127.0.0.1:${address.port}/remote`;
}

async function browserTunnel(
  relayUrl: string,
  endpointId: string,
): Promise<{ socket: WebSocket; connectionId: string }> {
  const socket = new WebSocket(relayUrl);
  sockets.push(socket);
  await once(socket, "open");
  const response = nextMessage(socket);
  socket.send(JSON.stringify({
    protocolVersion: 1,
    type: "relay.connect",
    endpointId,
    browserVersion: "0.1.0",
  }));
  const connected = await response;
  if (connected.type !== "relay.connected") throw new Error("Browser did not connect.");
  return { socket, connectionId: connected.connectionId as string };
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Message timed out.")), 2_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

async function nextFrame(
  socket: WebSocket,
  kind: RemoteCipherFrame["kind"],
): Promise<RemoteCipherFrame> {
  for (;;) {
    const message = await nextMessage(socket);
    if (
      message.type === "relay.frame"
      && typeof message.frame === "object"
      && message.frame !== null
      && "kind" in message.frame
      && message.frame.kind === kind
    ) return message.frame as RemoteCipherFrame;
  }
}

function nextFrames(
  socket: WebSocket,
  kind: RemoteCipherFrame["kind"],
  count: number,
): Promise<RemoteCipherFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: RemoteCipherFrame[] = [];
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Messages timed out."));
    }, 2_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (
        message.type !== "relay.frame"
        || typeof message.frame !== "object"
        || message.frame === null
        || !("kind" in message.frame)
        || message.frame.kind !== kind
      ) return;
      frames.push(message.frame as RemoteCipherFrame);
      if (frames.length !== count) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frames);
    };
    socket.on("message", onMessage);
  });
}

function sendFrame(
  socket: WebSocket,
  connectionId: string,
  frame: RemoteCipherFrame,
): void {
  socket.send(JSON.stringify({
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    type: "relay.frame",
    connectionId,
    frame,
  }));
}

async function openAuthenticatedSession(input: {
  relayUrl: string;
  invitation: RemotePairingInvitation;
  deviceId: string;
  deviceKeys: RemoteSerializedKeyPair;
  grantVersion: number;
}): Promise<{
  tunnel: Awaited<ReturnType<typeof browserTunnel>>;
  sender: Awaited<ReturnType<typeof createAuthenticatedSessionSender>>;
  recipient: Awaited<ReturnType<typeof createAuthenticatedSessionRecipient>>;
  accepted: RemoteSessionAcceptPayload;
  sessionId: string;
}> {
  const tunnel = await browserTunnel(
    input.relayUrl,
    input.invitation.endpointId,
  );
  const sessionId = crypto.randomUUID();
  const deviceKeyPair = await importRemoteKeyPair(input.deviceKeys);
  const hostPublicKey = await importRemotePublicKey(
    input.invitation.hostPublicKey,
  );
  const sender = await createAuthenticatedSessionSender(
    input.invitation.hostId,
    input.deviceId,
    sessionId,
    deviceKeyPair,
    hostPublicKey,
  );
  const acceptPromise = nextFrame(tunnel.socket, "session.accept");
  sendFrame(tunnel.socket, tunnel.connectionId, {
    protocolVersion: 1,
    kind: "session.open",
    sessionId,
    enc: sender.enc,
    ciphertext: await sealSessionHandshake(
      sender,
      "session.open",
      sessionId,
      {
        type: "session.open",
        sessionId,
        deviceId: input.deviceId,
        grantVersion: input.grantVersion,
        createdAt: new Date().toISOString(),
        browserVersion: "0.1.0",
      },
    ),
  });
  const acceptFrame = await acceptPromise;
  if (acceptFrame.kind !== "session.accept") {
    throw new Error("Missing session response.");
  }
  const recipient = await createAuthenticatedSessionRecipient(
    input.invitation.hostId,
    input.deviceId,
    sessionId,
    deviceKeyPair,
    hostPublicKey,
    acceptFrame.enc,
  );
  const accepted = remoteSessionAcceptPayloadSchema.parse(
    await openSessionHandshake(
      recipient,
      "session.accept",
      sessionId,
      acceptFrame.ciphertext,
    ),
  );
  return { tunnel, sender, recipient, accepted, sessionId };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Remote Companion outbound encrypted service", () => {
  it("defers first-time identity creation until Remote Companion is enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-service-"));
    directories.push(directory);
    const file = join(directory, "remote.vault");
    const store = new RemoteAccessStore(file, {
      available: () => true,
      encrypt: (plaintext) => new TextEncoder().encode(plaintext),
      decrypt: (ciphertext) => new TextDecoder().decode(ciphertext),
    });
    const service = await RemoteAccessService.create({
      store,
      runtime: { remoteRequest: async () => {
        throw new Error("unused");
      } },
    });

    expect(service.state()).toMatchObject({
      available: true,
      enabled: false,
    });
    expect(existsSync(file)).toBe(false);
    await service.setEnabled(false);
    expect(existsSync(file)).toBe(false);
    await service.setEnabled(true, "ws://127.0.0.1:8787");
    expect(existsSync(file)).toBe(true);
    await service.shutdown();
  });

  it("does not commit a pairing after its relay route disconnects", async () => {
    const relayUrl = await relay();
    let opened = (): void => undefined;
    const pairingOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let release = (): void => undefined;
    const pairingReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    remoteCryptoGate.afterPairingOpen = async () => {
      opened();
      await pairingReleased;
    };
    let released = false;
    let observeState = (_state: unknown): void => undefined;
    const stateAfterRelease = new Promise<ReturnType<RemoteAccessService["state"]>>(
      (resolve) => {
        observeState = (state) => {
          if (released) {
            resolve(state as ReturnType<RemoteAccessService["state"]>);
          }
        };
      },
    );
    const service = await RemoteAccessService.create({
      store: encryptedStore(),
      runtime: { remoteRequest: async () => {
        throw new Error("unused");
      } },
      onStateChange: (state) => observeState(state),
    });
    await service.setEnabled(true, relayUrl);
    await waitFor(() => service.state().connection === "online");
    const invitation = await service.createInvitation();
    const deviceKeys = await generateRemoteKeyPair();
    const tunnel = await browserTunnel(relayUrl, invitation.endpointId);
    sendFrame(
      tunnel.socket,
      tunnel.connectionId,
      await sealPairingRequest(invitation, {
        type: "pair.request",
        requestId: crypto.randomUUID(),
        invitationId: invitation.invitationId,
        deviceId: crypto.randomUUID(),
        deviceLabel: "Disconnected browser",
        devicePublicKey: deviceKeys.publicKey,
        createdAt: new Date().toISOString(),
        browserVersion: "0.1.0",
      }),
    );
    await pairingOpened;
    tunnel.socket.send(JSON.stringify({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "relay.disconnect",
      connectionId: tunnel.connectionId,
    }));
    expect((await nextMessage(tunnel.socket)).type).toBe(
      "relay.peer-disconnected",
    );
    released = true;
    release();
    expect(await stateAfterRelease).toMatchObject({
      activeSessions: 0,
      pendingPairings: [],
    });
    await service.shutdown();
  });

  it("pairs, scopes, authenticates, delivers exactly once, and revokes", async () => {
    const relayUrl = await relay();
    const store = encryptedStore();
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    let runtimeCalls = 0;
    let holdStateRequests = false;
    let stateRequestsStarted = 0;
    let releaseStateRequests = (): void => undefined;
    const stateRequestsReleased = new Promise<void>((resolve) => {
      releaseStateRequests = resolve;
    });
    const runtime = {
      remoteRequest: async (
        _subject: unknown,
        request: RemoteRequest,
      ): Promise<RemoteResponse> => {
        runtimeCalls += 1;
        if (request.type === "state.get" && holdStateRequests) {
          stateRequestsStarted += 1;
          await stateRequestsReleased;
        }
        if (request.type === "prompt.send") {
          return {
            type: "response",
            requestId: request.requestId,
            ok: true,
            result: {
              kind: "prompt.accepted",
              deliveryId: request.deliveryId,
              turnId: crypto.randomUUID(),
            },
          };
        }
        return {
          type: "response",
          requestId: request.requestId,
          ok: true,
          result: {
            kind: "state",
            state: {
              generatedAt: new Date().toISOString(),
              projects: [{ id: projectId, name: "Safe project" }],
              conversations: [],
              runs: [],
            },
          },
        };
      },
    };
    const service = await RemoteAccessService.create({ store, runtime });
    await service.setEnabled(true, relayUrl);
    await waitFor(() => service.state().connection === "online");
    const invitation = await service.createInvitation();
    const deviceKeys = await generateRemoteKeyPair();
    const deviceId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const tunnel = await browserTunnel(relayUrl, invitation.endpointId);
    const pendingFrame = nextFrame(tunnel.socket, "pair.response");
    sendFrame(
      tunnel.socket,
      tunnel.connectionId,
      await sealPairingRequest(invitation, {
        type: "pair.request",
        requestId,
        invitationId: invitation.invitationId,
        deviceId,
        deviceLabel: "\u202eTest\u202c\u0000 browser\u2066",
        devicePublicKey: deviceKeys.publicKey,
        createdAt: new Date().toISOString(),
        browserVersion: "0.1.0",
      }),
    );
    await waitFor(() => service.state().pendingPairings.length === 1);
    expect(service.state().pendingPairings[0]?.deviceLabel).toBe(
      "Test browser",
    );
    expect(service.state().pendingPairings[0]?.comparisonCode).toBe(
      await remotePairingComparisonCode(
        invitation.hostPublicKey,
        deviceKeys.publicKey,
        invitation.invitationId,
      ),
    );
    expect(service.state().pendingPairings[0]?.comparisonCode).toBe(
      mainComparisonCode(
        invitation.hostPublicKey,
        deviceKeys.publicKey,
        invitation.invitationId,
      ),
    );
    await service.approvePairing(
      requestId,
      ["view", "prompt"],
      [projectId],
    );
    const pairingFrame = await pendingFrame;
    if (pairingFrame.kind !== "pair.response") throw new Error("Missing pairing response.");
    const pairing = remotePairingResponsePayloadSchema.parse(
      await openPairingResponse(
        await importRemoteKeyPair(deviceKeys),
        await importRemotePublicKey(invitation.hostPublicKey),
        pairingFrame,
      ),
    );
    expect(pairing).toMatchObject({
      type: "pair.accepted",
      scopes: ["view", "prompt"],
      projectIds: [projectId],
    });

    tunnel.socket.terminate();
    const session = await openAuthenticatedSession({
      relayUrl,
      invitation,
      deviceId,
      deviceKeys,
      grantVersion: 1,
    });
    const { sender, recipient } = session;
    const sessionTunnel = session.tunnel;
    expect(session.accepted).toMatchObject({
      scopes: ["view", "prompt"],
      projectIds: [projectId],
      grantVersion: 1,
    });
    expect(service.state().activeSessions).toBe(1);

    const deliveryId = crypto.randomUUID();
    const prompt = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId,
      conversationId,
      content: "Continue safely",
    };
    const responsePromise = nextFrame(sessionTunnel.socket, "session.data");
    sendFrame(
      sessionTunnel.socket,
      sessionTunnel.connectionId,
      await sealSessionData(sender, session.sessionId, prompt),
    );
    const responseFrame = await responsePromise;
    if (responseFrame.kind !== "session.data") throw new Error("Missing response.");
    expect(remoteResponseSchema.parse(
      await openSessionData(recipient, responseFrame),
    )).toMatchObject({ ok: true });
    expect(runtimeCalls).toBe(1);

    const duplicatePromise = nextFrame(sessionTunnel.socket, "session.data");
    sendFrame(
      sessionTunnel.socket,
      sessionTunnel.connectionId,
      await sealSessionData(sender, session.sessionId, {
        ...prompt,
        requestId: crypto.randomUUID(),
      }),
    );
    const duplicateFrame = await duplicatePromise;
    if (duplicateFrame.kind !== "session.data") throw new Error("Missing duplicate response.");
    expect(remoteResponseSchema.parse(
      await openSessionData(recipient, duplicateFrame),
    )).toMatchObject({ ok: true });
    expect(runtimeCalls).toBe(1);

    holdStateRequests = true;
    const firstStateRequest = {
      type: "state.get" as const,
      requestId: crypto.randomUUID(),
    };
    const secondStateRequest = {
      type: "state.get" as const,
      requestId: crypto.randomUUID(),
    };
    const stateResponses = nextFrames(
      sessionTunnel.socket,
      "session.data",
      2,
    );
    const firstStateFrame = await sealSessionData(
      sender,
      session.sessionId,
      firstStateRequest,
    );
    const secondStateFrame = await sealSessionData(
      sender,
      session.sessionId,
      secondStateRequest,
    );
    sendFrame(
      sessionTunnel.socket,
      sessionTunnel.connectionId,
      firstStateFrame,
    );
    sendFrame(
      sessionTunnel.socket,
      sessionTunnel.connectionId,
      secondStateFrame,
    );
    await waitFor(() => stateRequestsStarted === 2);
    expect(service.state().activeSessions).toBe(1);
    releaseStateRequests();
    const concurrentResponses = await stateResponses;
    const responseIds: string[] = [];
    for (const frame of concurrentResponses) {
      if (frame.kind !== "session.data") {
        throw new Error("Missing concurrent response.");
      }
      responseIds.push(remoteResponseSchema.parse(
        await openSessionData(recipient, frame),
      ).requestId);
    }
    expect(new Set(responseIds)).toEqual(new Set([
      firstStateRequest.requestId,
      secondStateRequest.requestId,
    ]));

    const reducedClose = nextFrame(sessionTunnel.socket, "session.close");
    await service.updateDevice(
      deviceId,
      ["view"],
      [projectId],
      new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    );
    expect(await reducedClose).toMatchObject({
      kind: "session.close",
      reason: "revoked",
    });
    const reduced = await openAuthenticatedSession({
      relayUrl,
      invitation,
      deviceId,
      deviceKeys,
      grantVersion: 1,
    });
    expect(reduced.accepted).toMatchObject({
      scopes: ["view"],
      projectIds: [projectId],
      grantVersion: 2,
    });

    const closePromise = nextFrame(reduced.tunnel.socket, "session.close");
    await service.revokeDevice(deviceId);
    expect(await closePromise).toMatchObject({
      kind: "session.close",
      reason: "revoked",
    });
    expect(service.state().activeSessions).toBe(0);
    expect(service.state().audit.map(({ type }) => type)).toContain(
      "device.revoked",
    );
    await expect(openAuthenticatedSession({
      relayUrl,
      invitation,
      deviceId,
      deviceKeys,
      grantVersion: 2,
    })).rejects.toThrow("Message timed out.");
    await service.shutdown();
  });
});
