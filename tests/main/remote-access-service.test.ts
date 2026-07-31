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
  REMOTE_LIMITS,
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
import type { RemoteAccessServiceOptions } from "../../src/main/remote-access-service-types";
import {
  DEFAULT_REMOTE_RELAY_URL,
  remotePairingComparisonCode as mainComparisonCode,
} from "../../src/main/remote-access-policy";
import { RemoteAccessStore } from "../../src/main/remote-access-store";

const remoteCryptoGate = vi.hoisted(() => ({
  afterPairingOpen: null as (() => Promise<void>) | null,
  beforeSessionRecipient: null as ((
    sessionId: string,
  ) => Promise<void>) | null,
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
    createAuthenticatedSessionRecipient: async (
      ...args: Parameters<typeof actual.createAuthenticatedSessionRecipient>
    ) => {
      await remoteCryptoGate.beforeSessionRecipient?.(args[2]);
      return await actual.createAuthenticatedSessionRecipient(...args);
    },
  };
});

const relays: ReferenceRelay[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];

afterEach(async () => {
  remoteCryptoGate.afterPairingOpen = null;
  remoteCryptoGate.beforeSessionRecipient = null;
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

async function pendingPairingFixture(options: {
  createSocket?: (url: string) => WebSocket;
  devicePublicKey?: string;
  runtime?: RemoteAccessServiceOptions["runtime"];
  onStateChange?: (
    state: ReturnType<RemoteAccessService["state"]>,
  ) => void;
} = {}) {
  const relayUrl = await relay();
  const store = encryptedStore();
  const service = await RemoteAccessService.create({
    store,
    runtime: options.runtime ?? {
      remoteRequest: async () => {
        throw new Error("unused");
      },
    },
    createSocket: options.createSocket,
    onStateChange: options.onStateChange,
  });
  await service.setEnabled(true, relayUrl);
  await waitFor(() => service.state().connection === "online");
  const invitation = await service.createInvitation();
  const deviceKeys = await generateRemoteKeyPair();
  const deviceId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const tunnel = await browserTunnel(relayUrl, invitation.endpointId);
  sendFrame(
    tunnel.socket,
    tunnel.connectionId,
    await sealPairingRequest(invitation, {
      type: "pair.request",
      requestId,
      invitationId: invitation.invitationId,
      deviceId,
      deviceLabel: "Persistence test browser",
      devicePublicKey: options.devicePublicKey ?? deviceKeys.publicKey,
      createdAt: new Date().toISOString(),
      browserVersion: "0.1.0",
    }),
  );
  await waitFor(() => service.state().pendingPairings.length === 1);
  return {
    relayUrl,
    store,
    service,
    invitation,
    deviceKeys,
    deviceId,
    requestId,
    tunnel,
  };
}

async function pairedDeviceFixture(options: {
  createSocket?: (url: string) => WebSocket;
  runtime?: RemoteAccessServiceOptions["runtime"];
  onStateChange?: (
    state: ReturnType<RemoteAccessService["state"]>,
  ) => void;
  scopes?: Array<"view" | "prompt">;
} = {}) {
  const pairing = await pendingPairingFixture(options);
  const projectId = crypto.randomUUID();
  const response = nextFrame(pairing.tunnel.socket, "pair.response");
  await pairing.service.approvePairing(
    pairing.requestId,
    options.scopes ?? ["view"],
    [projectId],
  );
  expect(await response).toMatchObject({ kind: "pair.response" });
  pairing.tunnel.socket.terminate();
  return { ...pairing, projectId };
}

async function pairedServiceFixture(options: {
  createSocket?: (url: string) => WebSocket;
  runtime?: RemoteAccessServiceOptions["runtime"];
  onStateChange?: (
    state: ReturnType<RemoteAccessService["state"]>,
  ) => void;
  scopes?: Array<"view" | "prompt">;
} = {}) {
  const pairing = await pairedDeviceFixture(options);
  const session = await openAuthenticatedSession({
    relayUrl: pairing.relayUrl,
    invitation: pairing.invitation,
    deviceId: pairing.deviceId,
    deviceKeys: pairing.deviceKeys,
    grantVersion: 1,
  });
  return { ...pairing, session };
}

async function createSessionOpenFrame(input: {
  invitation: RemotePairingInvitation;
  deviceId: string;
  deviceKeys: RemoteSerializedKeyPair;
  sessionId: string;
}): Promise<Extract<RemoteCipherFrame, { kind: "session.open" }>> {
  const deviceKeyPair = await importRemoteKeyPair(input.deviceKeys);
  const hostPublicKey = await importRemotePublicKey(
    input.invitation.hostPublicKey,
  );
  const sender = await createAuthenticatedSessionSender(
    input.invitation.hostId,
    input.deviceId,
    input.sessionId,
    deviceKeyPair,
    hostPublicKey,
  );
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    kind: "session.open",
    sessionId: input.sessionId,
    enc: sender.enc,
    ciphertext: await sealSessionHandshake(
      sender,
      "session.open",
      input.sessionId,
      {
        type: "session.open",
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        grantVersion: 1,
        createdAt: new Date().toISOString(),
        browserVersion: "0.1.0",
      },
    ),
  };
}

describe("Remote Companion outbound encrypted service", () => {
  it("connects to the reference relay with the product default URL", async () => {
    const value = await createReferenceRelay();
    relays.push(value);
    expect(value.address()).toMatchObject({ port: 8787 });
    const service = await RemoteAccessService.create({
      store: encryptedStore(),
      runtime: { remoteRequest: async () => {
        throw new Error("unused");
      } },
    });

    await service.setEnabled(true);
    await waitFor(() => service.state().connection === "online");

    expect(service.state()).toMatchObject({
      enabled: true,
      relayUrl: DEFAULT_REMOTE_RELAY_URL,
      connection: "online",
    });
    await service.shutdown();
  });

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
    await service.setEnabled(true, DEFAULT_REMOTE_RELAY_URL);
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

  it("reserves a session ID before crypto and releases it on disconnect", async () => {
    const paired = await pairedDeviceFixture();
    const sessionId = crypto.randomUUID();
    let releaseCrypto = (): void => undefined;
    const cryptoReleased = new Promise<void>((resolve) => {
      releaseCrypto = resolve;
    });
    const recipientCalls: string[] = [];
    remoteCryptoGate.beforeSessionRecipient = async (value) => {
      recipientCalls.push(value);
      await cryptoReleased;
    };
    const first = await browserTunnel(
      paired.relayUrl,
      paired.invitation.endpointId,
    );
    const duplicate = await browserTunnel(
      paired.relayUrl,
      paired.invitation.endpointId,
    );
    const replacement = await browserTunnel(
      paired.relayUrl,
      paired.invitation.endpointId,
    );
    const openFrame = await createSessionOpenFrame({
      invitation: paired.invitation,
      deviceId: paired.deviceId,
      deviceKeys: paired.deviceKeys,
      sessionId,
    });

    sendFrame(first.socket, first.connectionId, openFrame);
    await waitFor(() => recipientCalls.length === 1);
    sendFrame(duplicate.socket, duplicate.connectionId, await createSessionOpenFrame({
      invitation: paired.invitation,
      deviceId: paired.deviceId,
      deviceKeys: paired.deviceKeys,
      sessionId,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recipientCalls).toEqual([sessionId]);

    (
      paired.service as unknown as {
        relayMessages: { receive(raw: Buffer): void };
      }
    ).relayMessages.receive(Buffer.from(JSON.stringify({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "relay.peer-disconnected",
      connectionId: first.connectionId,
    })));
    first.socket.terminate();
    sendFrame(
      replacement.socket,
      replacement.connectionId,
      await createSessionOpenFrame({
        invitation: paired.invitation,
        deviceId: paired.deviceId,
        deviceKeys: paired.deviceKeys,
        sessionId,
      }),
    );
    await waitFor(() => recipientCalls.length === 2);
    remoteCryptoGate.beforeSessionRecipient = null;
    releaseCrypto();

    await waitFor(() => paired.service.state().activeSessions === 1);
    expect(recipientCalls).toEqual([sessionId, sessionId]);
    expect(paired.service.state().audit.filter(
      ({ type }) => type === "session.connected",
    )).toHaveLength(1);
    await paired.service.shutdown();
  });

  it("holds four atomic admissions through deferred persistence", async () => {
    const paired = await pairedDeviceFixture();
    const originalSave = paired.store.save.bind(paired.store);
    let releaseSave = (): void => undefined;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let enteredSave = (): void => undefined;
    const saveEntered = new Promise<void>((resolve) => {
      enteredSave = resolve;
    });
    let holdFirstSave = true;
    const save = vi.spyOn(paired.store, "save").mockImplementation(
      async (value) => {
        if (holdFirstSave) {
          holdFirstSave = false;
          enteredSave();
          await saveReleased;
        }
        await originalSave(value);
      },
    );
    const recipientCalls: string[] = [];
    remoteCryptoGate.beforeSessionRecipient = async (sessionId) => {
      recipientCalls.push(sessionId);
    };
    const attempts = await Promise.all(
      Array.from({ length: REMOTE_LIMITS.sessions + 1 }, async () => {
        const tunnel = await browserTunnel(
          paired.relayUrl,
          paired.invitation.endpointId,
        );
        const sessionId = crypto.randomUUID();
        return {
          tunnel,
          frame: await createSessionOpenFrame({
            invitation: paired.invitation,
            deviceId: paired.deviceId,
            deviceKeys: paired.deviceKeys,
            sessionId,
          }),
        };
      }),
    );
    for (const { tunnel, frame } of attempts.slice(0, REMOTE_LIMITS.sessions)) {
      sendFrame(tunnel.socket, tunnel.connectionId, frame);
    }
    await saveEntered;
    await waitFor(() => recipientCalls.length === REMOTE_LIMITS.sessions);

    const excess = attempts.at(-1)!;
    sendFrame(excess.tunnel.socket, excess.tunnel.connectionId, excess.frame);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recipientCalls).toHaveLength(REMOTE_LIMITS.sessions);
    expect(paired.service.state().activeSessions).toBe(0);

    releaseSave();
    await waitFor(
      () => paired.service.state().activeSessions === REMOTE_LIMITS.sessions,
    );
    expect(paired.service.state().activeSessions).toBe(REMOTE_LIMITS.sessions);
    save.mockRestore();
    await paired.service.shutdown();
  });

  it("does not activate an admission revoked during persistence", async () => {
    const paired = await pairedDeviceFixture();
    const originalSave = paired.store.save.bind(paired.store);
    let releaseSave = (): void => undefined;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let enteredSave = (): void => undefined;
    const saveEntered = new Promise<void>((resolve) => {
      enteredSave = resolve;
    });
    let holdFirstSave = true;
    vi.spyOn(paired.store, "save").mockImplementation(async (value) => {
      if (holdFirstSave) {
        holdFirstSave = false;
        enteredSave();
        await saveReleased;
      }
      await originalSave(value);
    });
    const tunnel = await browserTunnel(
      paired.relayUrl,
      paired.invitation.endpointId,
    );
    const accepted: RemoteCipherFrame[] = [];
    tunnel.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        frame?: RemoteCipherFrame;
      };
      if (message.type === "relay.frame"
        && message.frame?.kind === "session.accept") {
        accepted.push(message.frame);
      }
    });
    sendFrame(tunnel.socket, tunnel.connectionId, await createSessionOpenFrame({
      invitation: paired.invitation,
      deviceId: paired.deviceId,
      deviceKeys: paired.deviceKeys,
      sessionId: crypto.randomUUID(),
    }));
    await saveEntered;

    const revoked = paired.service.revokeDevice(paired.deviceId);
    expect(paired.service.state().devices).toEqual([
      expect.objectContaining({
        id: paired.deviceId,
        revokedAt: expect.any(String),
      }),
    ]);
    releaseSave();
    await revoked;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(paired.service.state().activeSessions).toBe(0);
    expect(accepted).toEqual([]);
    expect((await paired.store.load())?.devices).toEqual([
      expect.objectContaining({
        id: paired.deviceId,
        revokedAt: expect.any(String),
      }),
    ]);
    await paired.service.shutdown();
  });

  it.each(["disable", "lock", "revoke", "reduce"] as const)(
    "does not commit a prepared prompt after %s removes authority",
    async (transition) => {
      let enterPrepare = (): void => undefined;
      const prepareEntered = new Promise<void>((resolve) => {
        enterPrepare = resolve;
      });
      let releasePrepare = (): void => undefined;
      const prepareReleased = new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      const commitRemotePrompt = vi.fn(async (
        _subject: unknown,
        request: Extract<RemoteRequest, { type: "prompt.send" }>,
      ): Promise<RemoteResponse> => ({
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "prompt.accepted",
          deliveryId: request.deliveryId,
          turnId: crypto.randomUUID(),
        },
      }));
      const paired = await pairedServiceFixture({
        scopes: ["view", "prompt"],
        runtime: {
          remoteRequest: async () => {
            throw new Error("unused");
          },
          prepareRemotePrompt: async () => {
            enterPrepare();
            await prepareReleased;
            return { preparationId: crypto.randomUUID() };
          },
          commitRemotePrompt,
        },
      });
      sendFrame(
        paired.session.tunnel.socket,
        paired.session.tunnel.connectionId,
        await sealSessionData(
          paired.session.sender,
          paired.session.sessionId,
          {
            type: "prompt.send",
            requestId: crypto.randomUUID(),
            deliveryId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            content: "Do not queue after authority changes",
          },
        ),
      );
      await prepareEntered;

      if (transition === "disable") {
        await paired.service.setEnabled(false);
      } else if (transition === "lock") {
        paired.service.setPrivacyLocked(true);
      } else if (transition === "revoke") {
        await paired.service.revokeDevice(paired.deviceId);
      } else {
        await paired.service.updateDevice(
          paired.deviceId,
          ["view"],
          [paired.projectId],
          new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        );
      }
      expect(paired.service.state().activeSessions).toBe(0);
      releasePrepare();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(commitRemotePrompt).not.toHaveBeenCalled();
      await paired.service.shutdown();
      expect((await paired.store.load())?.receipts).toEqual([]);
      expect(paired.service.state().audit).not.toContainEqual(
        expect.objectContaining({ type: "prompt.uncertain" }),
      );
    },
  );

  it("keeps runtime loss before commit posting as known non-delivery", async () => {
    const commitRemotePrompt = vi.fn(async (): Promise<RemoteResponse> => {
      throw new Error("The supervised runtime is stopping.");
    });
    const paired = await pairedServiceFixture({
      scopes: ["view", "prompt"],
      runtime: {
        remoteRequest: async () => {
          throw new Error("unused");
        },
        prepareRemotePrompt: async () => ({
          preparationId: crypto.randomUUID(),
        }),
        commitRemotePrompt,
      },
    });
    const response = nextFrame(
      paired.session.tunnel.socket,
      "session.data",
    );
    sendFrame(
      paired.session.tunnel.socket,
      paired.session.tunnel.connectionId,
      await sealSessionData(
        paired.session.sender,
        paired.session.sessionId,
        {
          type: "prompt.send",
          requestId: crypto.randomUUID(),
          deliveryId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          content: "Do not queue without a posted commit",
        },
      ),
    );
    const frame = await response;
    if (frame.kind !== "session.data") throw new Error("Missing response.");

    expect(remoteResponseSchema.parse(
      await openSessionData(paired.session.recipient, frame),
    )).toMatchObject({ ok: false, code: "unavailable" });
    expect(commitRemotePrompt).toHaveBeenCalledOnce();
    await paired.service.shutdown();
    expect((await paired.store.load())?.receipts).toEqual([]);
    expect(paired.service.state().audit).not.toContainEqual(
      expect.objectContaining({ type: "prompt.uncertain" }),
    );
  });

  it("linearizes an accepted prompt at the synchronous commit send", async () => {
    const order: string[] = [];
    let enterPrepare = (): void => undefined;
    const prepareEntered = new Promise<void>((resolve) => {
      enterPrepare = resolve;
    });
    let releasePrepare = (): void => undefined;
    const prepareReleased = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let enterCommit = (): void => undefined;
    const commitEntered = new Promise<void>((resolve) => {
      enterCommit = resolve;
    });
    let releaseCommit = (): void => undefined;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const paired = await pairedServiceFixture({
      scopes: ["view", "prompt"],
      runtime: {
        remoteRequest: async () => {
          throw new Error("unused");
        },
        prepareRemotePrompt: async () => {
          order.push("prepared");
          enterPrepare();
          await prepareReleased;
          return { preparationId: crypto.randomUUID() };
        },
        commitRemotePrompt: (
          _subject,
          request,
          _preparationId,
          onPosted,
        ) => {
          order.push("commit-sent");
          onPosted?.();
          enterCommit();
          return commitReleased.then((): RemoteResponse => ({
            type: "response",
            requestId: request.requestId,
            ok: true,
            result: {
              kind: "prompt.accepted",
              deliveryId: request.deliveryId,
              turnId: crypto.randomUUID(),
            },
          }));
        },
      },
    });
    sendFrame(
      paired.session.tunnel.socket,
      paired.session.tunnel.connectionId,
      await sealSessionData(
        paired.session.sender,
        paired.session.sessionId,
        {
          type: "prompt.send",
          requestId: crypto.randomUUID(),
          deliveryId: crypto.randomUUID(),
          conversationId: crypto.randomUUID(),
          content: "Queue before later revocation",
        },
      ),
    );
    await prepareEntered;
    releasePrepare();
    await commitEntered;
    order.push("revoke");
    await paired.service.revokeDevice(paired.deviceId);
    releaseCommit();

    await waitFor(() => paired.service.state().audit.some(
      ({ type }) => type === "prompt.accepted",
    ));
    expect(order).toEqual(["prepared", "commit-sent", "revoke"]);
    await paired.service.shutdown();
  });

  it("fails closed when disabling cannot be persisted with a live session", async () => {
    const createSocket = vi.fn((url: string) => new WebSocket(url));
    const states: Array<ReturnType<RemoteAccessService["state"]>> = [];
    const paired = await pairedServiceFixture({
      createSocket,
      onStateChange: (state) => states.push(state),
    });
    expect(paired.service.state().activeSessions).toBe(1);
    const socketCount = createSocket.mock.calls.length;
    const save = vi.spyOn(paired.store, "save").mockRejectedValueOnce(
      new Error("vault write failed"),
    );

    await expect(paired.service.setEnabled(false)).rejects.toThrow(
      "vault write failed",
    );
    expect(paired.service.state()).toMatchObject({
      available: false,
      enabled: false,
      connection: "disabled",
      activeSessions: 0,
      pendingPairings: [],
      invitation: null,
    });
    expect(states.at(-1)).toMatchObject({
      available: false,
      enabled: false,
      activeSessions: 0,
    });
    paired.service.startConnections();
    paired.service.setPrivacyLocked(true);
    paired.service.setPrivacyLocked(false);
    expect(createSocket).toHaveBeenCalledTimes(socketCount);
    save.mockRestore();
    expect((await paired.store.load())?.enabled).toBe(true);
    await paired.service.shutdown();
  });

  it("does not admit a device when pairing persistence fails", async () => {
    const createSocket = vi.fn((url: string) => new WebSocket(url));
    const pairing = await pendingPairingFixture({ createSocket });
    const projectId = crypto.randomUUID();
    const save = vi.spyOn(pairing.store, "save").mockRejectedValueOnce(
      new Error("pairing vault write failed"),
    );

    await expect(pairing.service.approvePairing(
      pairing.requestId,
      ["view", "prompt"],
      [projectId],
    )).rejects.toThrow("pairing vault write failed");
    expect(pairing.service.state()).toMatchObject({
      available: false,
      enabled: false,
      connection: "disabled",
      activeSessions: 0,
      pendingPairings: [],
      invitation: null,
    });
    await expect(openAuthenticatedSession({
      relayUrl: pairing.relayUrl,
      invitation: pairing.invitation,
      deviceId: pairing.deviceId,
      deviceKeys: pairing.deviceKeys,
      grantVersion: 1,
    })).rejects.toThrow();
    save.mockRestore();
    expect((await pairing.store.load())?.devices).toEqual([]);
    await pairing.service.shutdown();
  });

  it("rejects an invalid device public key before mutating durable grants", async () => {
    const pairing = await pendingPairingFixture({
      devicePublicKey: "AA",
    });
    const projectId = crypto.randomUUID();

    await expect(pairing.service.approvePairing(
      pairing.requestId,
      ["view", "prompt"],
      [projectId],
    )).rejects.toThrow();

    expect(pairing.service.state()).toMatchObject({
      available: true,
      enabled: true,
      devices: [],
      pendingPairings: [{ requestId: pairing.requestId }],
    });
    expect(pairing.service.state().audit.map(({ type }) => type)).not.toContain(
      "pairing.accepted",
    );
    const durable = await pairing.store.load();
    expect(durable?.devices).toEqual([]);
    expect(durable?.audit.map(({ type }) => type)).not.toContain(
      "pairing.accepted",
    );
    await pairing.service.shutdown();
  });

  it("fails closed instead of applying an unpersisted grant widening", async () => {
    const createSocket = vi.fn((url: string) => new WebSocket(url));
    const paired = await pairedServiceFixture({
      createSocket,
      scopes: ["view"],
    });
    const save = vi.spyOn(paired.store, "save").mockRejectedValueOnce(
      new Error("grant vault write failed"),
    );

    await expect(paired.service.updateDevice(
      paired.deviceId,
      ["view", "prompt"],
      [paired.projectId],
      new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    )).rejects.toThrow("grant vault write failed");
    expect(paired.service.state()).toMatchObject({
      available: false,
      enabled: false,
      connection: "disabled",
      activeSessions: 0,
      pendingPairings: [],
      invitation: null,
    });
    await expect(openAuthenticatedSession({
      relayUrl: paired.relayUrl,
      invitation: paired.invitation,
      deviceId: paired.deviceId,
      deviceKeys: paired.deviceKeys,
      grantVersion: 1,
    })).rejects.toThrow();
    save.mockRestore();
    expect((await paired.store.load())?.devices[0]?.scopes).toEqual(["view"]);
    await paired.service.shutdown();
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
        request: Exclude<RemoteRequest, { type: "prompt.send" }>,
      ): Promise<RemoteResponse> => {
        runtimeCalls += 1;
        if (request.type === "state.get" && holdStateRequests) {
          stateRequestsStarted += 1;
          await stateRequestsReleased;
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
      prepareRemotePrompt: async () => ({
        preparationId: crypto.randomUUID(),
      }),
      commitRemotePrompt: async (
        _subject: unknown,
        request: Extract<RemoteRequest, { type: "prompt.send" }>,
        _preparationId: string,
        onPosted?: () => void,
      ): Promise<RemoteResponse> => {
        onPosted?.();
        runtimeCalls += 1;
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
