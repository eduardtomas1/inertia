import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RemoteCompanionClient,
  waitForRemoteRelayMessage,
  waitForRemoteWebSocketOpen,
} from "../remote/browser/src/remote-client";
import * as deviceStore from "../remote/browser/src/device-store";
import {
  REMOTE_INACTIVITY_EXPIRY_MS,
  type SealedBrowserDeviceProfile,
} from "../remote/browser/src/device-store";
import {
  generateNonExtractableDeviceKeys,
} from "../remote/browser/src/device-keys";
import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  importRemotePublicKey,
  openPairingRequest,
  openSessionHandshake,
  remoteRandomSecret,
  sealPairingResponse,
  sealSessionData,
  sealSessionHandshake,
} from "../src/shared/remote-crypto";
import {
  RELAY_PROTOCOL_VERSION,
  REMOTE_BROWSER_VERSION,
  REMOTE_DESKTOP_COMPATIBILITY,
  REMOTE_LIMITS,
  REMOTE_RELAY_VERSION,
  remoteCipherFrameSchema,
  remotePairingRequestPayloadSchema,
  type RemotePairingInvitation,
  type RemoteRequest,
  type RemoteResponse,
} from "../src/shared/remote-protocol";
import type { RemoteConnectionFailure } from "../remote/browser/src/connection-supervisor";

const TEST_RELAY_IDENTITY = "a669bb38-857d-4b8d-a0aa-3a592197d2c8";
const TEST_ENDPOINT_EPOCH = 1;

function relayConnected(connectionId: string): object {
  return {
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.connected",
    connectionId,
    endpointEpoch: TEST_ENDPOINT_EPOCH,
    relayIdentity: TEST_RELAY_IDENTITY,
    selected: { relayProtocol: 2, remoteProtocol: 2 },
    versions: {
      relay: REMOTE_RELAY_VERSION,
      desktop: REMOTE_DESKTOP_COMPATIBILITY.version,
      browser: REMOTE_BROWSER_VERSION,
    },
  };
}

class FakeBrowserSocket extends EventTarget {
  static instances: FakeBrowserSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  private readonly counts = new Map<string, number>();

  constructor(readonly url: string) {
    super();
    FakeBrowserSocket.instances.push(this);
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, callback, options);
    if (callback) this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, callback, options);
    if (callback) {
      this.counts.set(type, Math.max(0, (this.counts.get(type) ?? 0) - 1));
    }
  }

  listenerCount(type: string): number {
    return this.counts.get(type) ?? 0;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
    queueMicrotask(() => this.message({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.hello",
      relayVersion: REMOTE_RELAY_VERSION,
      relayIdentity: TEST_RELAY_IDENTITY,
      relayProtocol: { minimum: 2, maximum: 2 },
      remoteProtocol: { minimum: 2, maximum: 2 },
      endpointAuthentication: "required",
      persistence: "durable",
    }));
  }

  message(value: unknown): void {
    this.rawMessage(JSON.stringify(value));
  }

  rawMessage(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: value,
    }));
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeBrowserSocket.instances = [];
});

async function beginFakePairing(expiresAt: string): Promise<{
  client: RemoteCompanionClient;
  connectionId: string;
  invitation: RemotePairingInvitation;
  hostKeys: Awaited<ReturnType<typeof generateRemoteKeyPair>>;
  pairing: Promise<void>;
  payload: ReturnType<typeof remotePairingRequestPayloadSchema.parse>;
  socket: FakeBrowserSocket;
}> {
  vi.stubGlobal("WebSocket", FakeBrowserSocket);
  const hostKeys = await generateRemoteKeyPair();
  const invitation: RemotePairingInvitation = {
    protocolVersion: 2,
    relayUrl: "wss://relay.example/remote",
    relayIdentity: TEST_RELAY_IDENTITY,
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
    endpointId: remoteRandomSecret(24),
    hostId: crypto.randomUUID(),
    hostPublicKey: hostKeys.publicKey,
    invitationId: crypto.randomUUID(),
    pairingSecret: remoteRandomSecret(),
    expiresAt,
  };
  const client = new RemoteCompanionClient({
    status: vi.fn(),
    pairingCode: vi.fn(),
    shell: vi.fn(),
    detail: vi.fn(),
    promptResult: vi.fn(),
  });
  const pairing = client.pair(JSON.stringify(invitation), "Test browser");
  await vi.waitFor(() => expect(FakeBrowserSocket.instances).toHaveLength(1));
  const socket = FakeBrowserSocket.instances[0]!;
  socket.open();
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  const connectionId = crypto.randomUUID();
  socket.message(relayConnected(connectionId));
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  const envelope = JSON.parse(socket.sent[1]!) as { frame: unknown };
  const frame = remoteCipherFrameSchema.parse(envelope.frame);
  if (frame.kind !== "pair.request") throw new Error("Missing pairing request.");
  const payload = remotePairingRequestPayloadSchema.parse(
    await openPairingRequest(
      invitation,
      await importRemoteKeyPair(hostKeys),
      frame,
    ),
  );
  return { client, connectionId, invitation, hostKeys, pairing, payload, socket };
}

describe("Remote Companion browser connection ownership", () => {
  it("coalesces overlapping connect requests into one owned attempt", async () => {
    vi.stubGlobal("WebSocket", FakeBrowserSocket);
    const deviceKeys = await generateNonExtractableDeviceKeys();
    const hostKeys = await generateRemoteKeyPair();
    const profile: SealedBrowserDeviceProfile = {
      version: 2,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Test browser",
      publicKey: deviceKeys.publicKey,
      privateKey: deviceKeys.keyPair.privateKey,
      lastUsedAt: new Date().toISOString(),
      hostId: crypto.randomUUID(),
      hostPublicKey: hostKeys.publicKey,
      relayUrl: "wss://relay.example/remote",
      relayIdentity: TEST_RELAY_IDENTITY,
      desktop: REMOTE_DESKTOP_COMPATIBILITY,
      endpointId: "opaque_endpoint",
      scopes: ["view"],
      projectIds: ["project"],
      grantVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const statuses: string[] = [];
    const client = new RemoteCompanionClient({
      status: (message) => statuses.push(message),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    (client as unknown as { profile: SealedBrowserDeviceProfile | null }).profile =
      profile;

    const firstAttempt = client.connect();
    const first = FakeBrowserSocket.instances[0]!;
    const secondAttempt = client.connect();
    expect(FakeBrowserSocket.instances).toHaveLength(1);
    expect(first.closeCalls).toHaveLength(0);

    first.open();
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.message(relayConnected(crypto.randomUUID()));
    await vi.waitFor(() => expect(first.sent).toHaveLength(2));
    (
      client as unknown as {
        supervisor: { stop(message: string): void };
      }
    ).supervisor.stop("cleanup");
    expect(first.closeCalls).toHaveLength(1);
    await Promise.all([firstAttempt, secondAttempt]);
    expect(statuses).toContain("Connecting to the desktop…");
  });

  it("drops queued sends instead of sealing them onto a newer session", async () => {
    const deviceKeys = await generateRemoteKeyPair();
    const hostKeys = await generateRemoteKeyPair();
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const staleSender = await createAuthenticatedSessionSender(
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      await importRemoteKeyPair(deviceKeys),
      await importRemotePublicKey(hostKeys.publicKey),
    );
    const socket = { send: vi.fn() };
    const internals = client as unknown as {
      sender: unknown;
      sessionId: string | null;
      connectionId: string | null;
      socket: unknown;
      outboundTail: Promise<void>;
      attemptEpoch: number;
      request(value: RemoteRequest): Promise<RemoteResponse>;
    };
    let releaseQueue = (): void => undefined;
    internals.outboundTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    internals.sender = staleSender;
    internals.sessionId = crypto.randomUUID();
    internals.connectionId = crypto.randomUUID();
    internals.socket = socket;

    const pending = internals.request({
      type: "state.get",
      requestId: crypto.randomUUID(),
    });

    internals.attemptEpoch += 1;
    internals.sender = await createAuthenticatedSessionSender(
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      await importRemoteKeyPair(deviceKeys),
      await importRemotePublicKey(hostKeys.publicKey),
    );
    internals.sessionId = crypto.randomUUID();
    releaseQueue();

    await expect(pending).rejects.toThrow("The desktop is offline.");
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("clears a grant that expired after initialization instead of reconnecting", async () => {
    vi.stubGlobal("WebSocket", FakeBrowserSocket);
    const deviceKeys = await generateNonExtractableDeviceKeys();
    const hostKeys = await generateRemoteKeyPair();
    const profile: SealedBrowserDeviceProfile = {
      version: 2,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Test browser",
      publicKey: deviceKeys.publicKey,
      privateKey: deviceKeys.keyPair.privateKey,
      lastUsedAt: new Date().toISOString(),
      hostId: crypto.randomUUID(),
      hostPublicKey: hostKeys.publicKey,
      relayUrl: "wss://relay.example/remote",
      relayIdentity: TEST_RELAY_IDENTITY,
      desktop: REMOTE_DESKTOP_COMPATIBILITY,
      endpointId: "opaque_endpoint",
      scopes: ["view"],
      projectIds: ["project"],
      grantVersion: 1,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const statuses: string[] = [];
    const client = new RemoteCompanionClient({
      status: (message) => statuses.push(message),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    (client as unknown as { profile: SealedBrowserDeviceProfile | null }).profile =
      profile;

    await client.connect();

    expect(FakeBrowserSocket.instances).toHaveLength(0);
    expect(client.currentProfile()).toBeNull();
    expect(statuses.at(-1)).toBe("This device grant expired. Pair it again.");
  });

  it("cleans open/relay listeners, timers, and sockets on timeout or close", async () => {
    vi.useFakeTimers();
    const opening = new FakeBrowserSocket("wss://relay.example/remote");
    const openResult = waitForRemoteWebSocketOpen(
      opening as unknown as WebSocket,
    );
    const openRejection = expect(openResult).rejects.toThrow("timed out");
    expect(opening.listenerCount("open")).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await openRejection;
    expect(opening.closeCalls).toHaveLength(1);
    expect(opening.listenerCount("open")).toBe(0);
    expect(opening.listenerCount("error")).toBe(0);
    expect(opening.listenerCount("close")).toBe(0);

    const relaying = new FakeBrowserSocket("wss://relay.example/remote");
    const relayResult = waitForRemoteRelayMessage(
      relaying as unknown as WebSocket,
      () => true,
      1_000,
    );
    const relayRejection = expect(relayResult).rejects.toThrow("closed");
    relaying.close(1000, "closed");
    await relayRejection;
    expect(relaying.listenerCount("message")).toBe(0);
    expect(relaying.listenerCount("error")).toBe(0);
    expect(relaying.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes and releases the owned tunnel after pairing is denied", async () => {
    const attempt = await beginFakePairing(
      new Date(Date.now() + 60_000).toISOString(),
    );
    attempt.socket.message({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId: attempt.connectionId,
      endpointEpoch: TEST_ENDPOINT_EPOCH,
      frame: await sealPairingResponse(
        await importRemoteKeyPair(attempt.hostKeys),
        await importRemotePublicKey(attempt.payload.devicePublicKey),
        attempt.payload.requestId,
        {
          type: "pair.rejected",
          requestId: attempt.payload.requestId,
          reason: "denied",
        },
      ),
    });

    await expect(attempt.pairing).rejects.toThrow("did not approve");
    expect(attempt.socket.closeCalls).toContainEqual([
      1000,
      "pairing attempt ended",
    ]);
    expect((attempt.client as unknown as { socket: unknown }).socket).toBeNull();
  });

  it("closes and releases the owned tunnel after pairing times out", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const attempt = await beginFakePairing(
      new Date(now + 60_000).toISOString(),
    );
    const rejected = expect(attempt.pairing).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(attempt.socket.closeCalls).toContainEqual([
      1000,
      "pairing attempt ended",
    ]);
    expect((attempt.client as unknown as { socket: unknown }).socket).toBeNull();
  });

  it("closes oversized relay envelopes before parsing handshake JSON", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const oversized = new FakeBrowserSocket("wss://relay.example/remote");
    const oversizedResult = waitForRemoteRelayMessage(
      oversized as unknown as WebSocket,
      () => true,
      1_000,
    );
    const startedAt = performance.now();
    oversized.rawMessage("x".repeat(
      REMOTE_LIMITS.relayEnvelopeBytes + 1,
    ));
    await expect(oversizedResult).rejects.toMatchObject({
      message: expect.stringContaining("protocol limit"),
      kind: "terminal",
      code: "relay-envelope-invalid",
    });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(parse).not.toHaveBeenCalled();
    expect(oversized.closeCalls).toEqual([
      [1009, "relay message too large"],
    ]);
    expect(oversized.listenerCount("message")).toBe(0);

    const multibyte = new FakeBrowserSocket("wss://relay.example/remote");
    const multibyteResult = waitForRemoteRelayMessage(
      multibyte as unknown as WebSocket,
      () => true,
      1_000,
    );
    multibyte.rawMessage("\u0800".repeat(
      Math.floor(REMOTE_LIMITS.relayEnvelopeBytes / 3) + 1,
    ));
    await expect(multibyteResult).rejects.toThrow("protocol limit");
    expect(parse).not.toHaveBeenCalled();
    expect(multibyte.closeCalls).toEqual([
      [1009, "relay message too large"],
    ]);
  });

  it("rejects unsupported relay data and ignores bounded malformed JSON", async () => {
    const unsupported = new FakeBrowserSocket("wss://relay.example/remote");
    const unsupportedResult = waitForRemoteRelayMessage(
      unsupported as unknown as WebSocket,
      () => true,
      1_000,
    );
    unsupported.rawMessage(new Uint8Array([1, 2, 3]));
    await expect(unsupportedResult).rejects.toMatchObject({
      message: expect.stringContaining("unsupported"),
      kind: "terminal",
      code: "relay-envelope-invalid",
    });
    expect(unsupported.closeCalls).toEqual([
      [1003, "relay messages must be text"],
    ]);

    const malformed = new FakeBrowserSocket("wss://relay.example/remote");
    const malformedResult = waitForRemoteRelayMessage(
      malformed as unknown as WebSocket,
      (message) => message.type === "relay.error",
      1_000,
    );
    malformed.rawMessage("{");
    malformed.message({
      relayProtocolVersion: 2,
      type: "relay.error",
      code: "desktop-offline",
    });
    await expect(malformedResult).resolves.toMatchObject({
      type: "relay.error",
      code: "desktop-offline",
    });
    expect(malformed.closeCalls).toEqual([]);
  });

  it("applies the pre-parse envelope bound to active session messages", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const socket = new FakeBrowserSocket("wss://relay.example/remote");
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const transportClosed = vi.spyOn(
      (client as unknown as {
        supervisor: { transportClosed(
          generation: number,
          failure: RemoteConnectionFailure,
        ): void };
      }).supervisor,
      "transportClosed",
    );

    await (
      client as unknown as {
        handleMessage(
          generation: number,
          socket: WebSocket,
          raw: unknown,
        ): Promise<void>;
      }
    ).handleMessage(
      0,
      socket as unknown as WebSocket,
      "x".repeat(REMOTE_LIMITS.relayEnvelopeBytes + 1),
    );

    expect(parse).not.toHaveBeenCalled();
    expect(socket.closeCalls).toEqual([
      [1009, "relay message too large"],
    ]);
    expect(transportClosed).toHaveBeenCalledWith(
      0,
      expect.objectContaining({
        kind: "terminal",
        code: "relay-envelope-invalid",
      }),
    );
  });

  it.each([
    ["invalid-message", "terminal"],
    ["endpoint-owned", "terminal"],
    ["desktop-offline", "transient"],
    ["connection-missing", "transient"],
    ["capacity", "transient"],
    ["rate-limited", "transient"],
  ] as const)(
    "classifies active relay error %s as %s",
    async (code, kind) => {
      const client = new RemoteCompanionClient({
        status: vi.fn(),
        pairingCode: vi.fn(),
        shell: vi.fn(),
        detail: vi.fn(),
        promptResult: vi.fn(),
      });
      const transportClosed = vi.spyOn(
        (client as unknown as {
          supervisor: { transportClosed(
            generation: number,
            failure: RemoteConnectionFailure,
          ): void };
        }).supervisor,
        "transportClosed",
      );

      await (
        client as unknown as {
          handleMessage(
            generation: number,
            socket: WebSocket,
            raw: unknown,
          ): Promise<void>;
        }
      ).handleMessage(17, new FakeBrowserSocket("") as unknown as WebSocket, JSON.stringify({
        relayProtocolVersion: 2,
        type: "relay.error",
        code,
      }));

      expect(transportClosed).toHaveBeenCalledWith(
        17,
        expect.objectContaining({ code, kind }),
      );
    },
  );

  it.each([
    "revoked",
    "expired",
    "protocol-error",
    "replay",
  ] as const)(
    "treats plaintext %s close as a non-destructive transient hint",
    async (reason) => {
      const invalidated = vi.fn();
      const authorizationInvalidated = vi.fn();
      const client = new RemoteCompanionClient({
        status: vi.fn(),
        invalidated,
        authorizationInvalidated,
        pairingCode: vi.fn(),
        shell: vi.fn(),
        detail: vi.fn(),
        promptResult: vi.fn(),
      });
      const profile = { deviceLabel: "Retained identity" } as SealedBrowserDeviceProfile;
      const connectionId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const internals = client as unknown as {
        profile: SealedBrowserDeviceProfile | null;
        connectionId: string | null;
        sessionId: string | null;
        supervisor: { transportClosed(
          generation: number,
          failure: RemoteConnectionFailure,
        ): void };
        handleMessage(
          generation: number,
          socket: WebSocket,
          raw: unknown,
        ): Promise<void>;
      };
      internals.profile = profile;
      internals.connectionId = connectionId;
      internals.sessionId = sessionId;
      const transportClosed = vi.spyOn(
        internals.supervisor,
        "transportClosed",
      );

      await internals.handleMessage(9, new FakeBrowserSocket("") as unknown as WebSocket, JSON.stringify({
        relayProtocolVersion: 2,
        type: "relay.frame",
        connectionId,
        endpointEpoch: TEST_ENDPOINT_EPOCH,
        frame: {
          protocolVersion: 2,
          kind: "session.close",
          sessionId,
          reason,
        },
      }));

      expect(transportClosed).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ kind: "transient", code: reason }),
      );
      expect(client.currentProfile()).toBe(profile);
      expect(invalidated).not.toHaveBeenCalled();
      expect(authorizationInvalidated).not.toHaveBeenCalled();
    },
  );

  it("purges authorization cache only from a sealed active invalidation", async () => {
    const hostKeys = await generateRemoteKeyPair();
    const deviceKeys = await generateRemoteKeyPair();
    const hostId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const hostSender = await createAuthenticatedSessionSender(
      hostId,
      deviceId,
      sessionId,
      await importRemoteKeyPair(hostKeys),
      await importRemotePublicKey(deviceKeys.publicKey),
    );
    const deviceRecipient = await createAuthenticatedSessionRecipient(
      hostId,
      deviceId,
      sessionId,
      await importRemoteKeyPair(deviceKeys),
      await importRemotePublicKey(hostKeys.publicKey),
      hostSender.enc,
    );
    const accept = await sealSessionHandshake(
      hostSender,
      "session.accept",
      sessionId,
      { type: "session.accept" },
    );
    await openSessionHandshake(
      deviceRecipient,
      "session.accept",
      sessionId,
      accept,
    );
    const authorityInvalidated = vi.fn();
    const identityInvalidated = vi.fn();
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      invalidated: identityInvalidated,
      authorizationInvalidated: authorityInvalidated,
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const connectionId = crypto.randomUUID();
    const socket = new FakeBrowserSocket("") as unknown as WebSocket;
    Object.assign(client as unknown as Record<string, unknown>, {
      connectionId,
      connectionGeneration: 1,
      sessionId,
      recipient: deviceRecipient,
      profile: { deviceLabel: "Retained identity" },
      socket,
    });
    const frame = await sealSessionData(hostSender, sessionId, {
      type: "session.authority-changed",
      serverTime: new Date().toISOString(),
    });

    await (
      client as unknown as {
        handleMessage(
          generation: number,
          socket: WebSocket,
          raw: unknown,
        ): Promise<void>;
      }
    ).handleMessage(1, socket, JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId,
      endpointEpoch: TEST_ENDPOINT_EPOCH,
      frame,
    }));

    expect(authorityInvalidated).toHaveBeenCalledOnce();
    expect(identityInvalidated).not.toHaveBeenCalled();
    expect(client.currentProfile()).not.toBeNull();
  });

  it("ignores a deferred authority change from a replaced session", async () => {
    const hostKeys = await generateRemoteKeyPair();
    const deviceKeys = await generateRemoteKeyPair();
    const hostId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const oldSessionId = crypto.randomUUID();
    const currentSessionId = crypto.randomUUID();
    const importedHostKeys = await importRemoteKeyPair(hostKeys);
    const importedDeviceKeys = await importRemoteKeyPair(deviceKeys);
    const hostPublicKey = await importRemotePublicKey(hostKeys.publicKey);
    const devicePublicKey = await importRemotePublicKey(deviceKeys.publicKey);
    const oldSender = await createAuthenticatedSessionSender(
      hostId,
      deviceId,
      oldSessionId,
      importedHostKeys,
      devicePublicKey,
    );
    const oldRecipient = await createAuthenticatedSessionRecipient(
      hostId,
      deviceId,
      oldSessionId,
      importedDeviceKeys,
      hostPublicKey,
      oldSender.enc,
    );
    const currentSender = await createAuthenticatedSessionSender(
      hostId,
      deviceId,
      currentSessionId,
      importedHostKeys,
      devicePublicKey,
    );
    const currentRecipient = await createAuthenticatedSessionRecipient(
      hostId,
      deviceId,
      currentSessionId,
      importedDeviceKeys,
      hostPublicKey,
      currentSender.enc,
    );
    for (const [sender, recipient, sessionId] of [
      [oldSender, oldRecipient, oldSessionId],
      [currentSender, currentRecipient, currentSessionId],
    ] as const) {
      const handshake = await sealSessionHandshake(
        sender,
        "session.accept",
        sessionId,
        { type: "session.accept" },
      );
      await openSessionHandshake(
        recipient,
        "session.accept",
        sessionId,
        handshake,
      );
    }
    const oldFrame = await sealSessionData(oldSender, oldSessionId, {
      type: "session.authority-changed",
      serverTime: new Date().toISOString(),
    });
    const currentFrame = await sealSessionData(currentSender, currentSessionId, {
      type: "session.authority-changed",
      serverTime: new Date().toISOString(),
    });
    let releaseDecrypt!: () => void;
    let markDecryptStarted!: () => void;
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    const decryptStarted = new Promise<void>((resolve) => {
      markDecryptStarted = resolve;
    });
    const open = oldRecipient.context.open.bind(oldRecipient.context);
    oldRecipient.context.open = async (...args: Parameters<typeof open>) => {
      markDecryptStarted();
      await decryptGate;
      return await open(...args);
    };

    const authorizationInvalidated = vi.fn();
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      authorizationInvalidated,
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const oldConnectionId = crypto.randomUUID();
    const currentConnectionId = crypto.randomUUID();
    const oldSocket = new FakeBrowserSocket("") as unknown as WebSocket;
    const currentSocket = new FakeBrowserSocket("") as unknown as WebSocket;
    const internals = client as unknown as Record<string, unknown>;
    Object.assign(internals, {
      connectionId: oldConnectionId,
      connectionGeneration: 1,
      sessionId: oldSessionId,
      recipient: oldRecipient,
      socket: oldSocket,
    });
    const handleMessage = (
      client as unknown as {
        handleMessage(
          generation: number,
          socket: WebSocket,
          raw: unknown,
        ): Promise<void>;
      }
    ).handleMessage.bind(client);
    const staleControl = handleMessage(1, oldSocket, JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId: oldConnectionId,
      endpointEpoch: TEST_ENDPOINT_EPOCH,
      frame: oldFrame,
    }));
    await decryptStarted;
    Object.assign(internals, {
      connectionId: currentConnectionId,
      connectionGeneration: 2,
      sessionId: currentSessionId,
      recipient: currentRecipient,
      socket: currentSocket,
    });
    releaseDecrypt();
    await staleControl;
    expect(authorizationInvalidated).not.toHaveBeenCalled();

    await handleMessage(2, currentSocket, JSON.stringify({
      relayProtocolVersion: 2,
      type: "relay.frame",
      connectionId: currentConnectionId,
      endpointEpoch: TEST_ENDPOINT_EPOCH,
      frame: currentFrame,
    }));
    expect(authorizationInvalidated).toHaveBeenCalledOnce();
  });

  it("expires an inactive profile on the local timer while offline", async () => {
    vi.useFakeTimers();
    vi.spyOn(deviceStore, "clearDeviceProfile").mockResolvedValueOnce();
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(now);
    vi.stubGlobal("navigator", { onLine: false });
    const invalidated = vi.fn();
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      invalidated,
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const profile = {
      expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      lastUsedAt: new Date(now).toISOString(),
    } as SealedBrowserDeviceProfile;
    (client as unknown as { profile: SealedBrowserDeviceProfile | null }).profile =
      profile;

    await client.connect();
    await vi.advanceTimersByTimeAsync(REMOTE_INACTIVITY_EXPIRY_MS + 1);

    expect(client.currentProfile()).toBeNull();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(
      (client as unknown as { supervisor: { current(): unknown } })
        .supervisor.current(),
    ).toMatchObject({
      phase: "terminal",
      failure: { code: "grant-expired" },
    });
  });

  it("blocks reconnect and stale writes until a deferred forget is durable", async () => {
    vi.stubGlobal("WebSocket", FakeBrowserSocket);
    let releaseWrite = (): void => undefined;
    const profileWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let releaseClear = (): void => undefined;
    const clearing = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clear = vi.spyOn(deviceStore, "clearDeviceProfile")
      .mockImplementationOnce(async () => await clearing);
    const invalidated = vi.fn();
    const forgetting: boolean[] = [];
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      invalidated,
      forgetting: (value) => forgetting.push(value),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const profile = { deviceLabel: "Forgotten identity" } as SealedBrowserDeviceProfile;
    Object.assign(client as unknown as Record<string, unknown>, {
      profile,
      profileWriteTail: profileWrite,
    });

    const operation = client.forget();
    expect(client.forget()).toBe(operation);
    await client.connect();
    await expect(client.pair("{}", "Browser")).rejects.toThrow(
      "finish being forgotten",
    );
    expect(FakeBrowserSocket.instances).toHaveLength(0);
    expect(clear).not.toHaveBeenCalled();
    expect(forgetting).toEqual([true]);

    releaseWrite();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
    await client.connect();
    expect(FakeBrowserSocket.instances).toHaveLength(0);
    expect(client.currentProfile()).toBe(profile);

    releaseClear();
    await operation;
    expect(client.currentProfile()).toBeNull();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(forgetting).toEqual([true, false]);
  });

  it("releases a failed forget barrier without purging or pretending online", async () => {
    let rejectClear = (_error: Error): void => undefined;
    const clearing = new Promise<void>((_resolve, reject) => {
      rejectClear = reject;
    });
    const clear = vi.spyOn(deviceStore, "clearDeviceProfile")
      .mockImplementationOnce(async () => await clearing);
    const statuses: Array<[string, boolean]> = [];
    const invalidated = vi.fn();
    const forgetting: boolean[] = [];
    const client = new RemoteCompanionClient({
      status: (message, online) => statuses.push([message, online]),
      invalidated,
      forgetting: (value) => forgetting.push(value),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const profile = { deviceLabel: "Retained identity" } as SealedBrowserDeviceProfile;
    (client as unknown as { profile: SealedBrowserDeviceProfile | null }).profile =
      profile;

    const operation = client.forget();
    await client.connect();
    expect(forgetting).toEqual([true]);
    rejectClear(new Error("vault unavailable"));
    await expect(operation).rejects.toThrow("vault unavailable");

    expect(clear).toHaveBeenCalledOnce();
    expect(client.currentProfile()).toBe(profile);
    expect(invalidated).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual([
      "Remote Companion is disconnected, but this browser could not be forgotten. Try again.",
      false,
    ]);
    expect(forgetting).toEqual([true, false]);
    expect(
      (client as unknown as { forgetOperation: Promise<void> | null })
        .forgetOperation,
    ).toBeNull();
  });

  it("serializes terminal profile clearing before a new pairing owner", async () => {
    let releaseClear = (): void => undefined;
    const deferredClear = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clear = vi.spyOn(deviceStore, "clearDeviceProfile")
      .mockImplementationOnce(async () => await deferredClear);
    const clearing: boolean[] = [];
    const invalidated = vi.fn();
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      invalidated,
      profileClearing: (value) => clearing.push(value),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    (client as unknown as { profile: SealedBrowserDeviceProfile | null }).profile =
      { deviceLabel: "Expired identity" } as SealedBrowserDeviceProfile;
    const clearOperation = (
      client as unknown as { clearExpiredProfile(): Promise<void> }
    ).clearExpiredProfile();
    const pairing = client.pair("not-json-yet", "Replacement browser");
    let pairingSettled = false;
    void pairing.finally(() => {
      pairingSettled = true;
    }).catch(() => undefined);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(pairingSettled).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(clearing).toEqual([true]);

    releaseClear();
    await clearOperation;
    await expect(pairing).rejects.toThrow();
    expect(clearing).toEqual([true, false]);
  });

  it("restores a rejected profile when durable clearing fails", async () => {
    const clear = vi.spyOn(deviceStore, "clearDeviceProfile")
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    const statuses: Array<[string, boolean]> = [];
    const clearing: boolean[] = [];
    const invalidated = vi.fn();
    const client = new RemoteCompanionClient({
      status: (message, online) => statuses.push([message, online]),
      invalidated,
      profileClearing: (value) => clearing.push(value),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const profile = {
      deviceLabel: "Rejected identity",
    } as SealedBrowserDeviceProfile;
    (client as unknown as { profile: SealedBrowserDeviceProfile | null }).profile =
      profile;

    await (client as unknown as {
      clearExpiredProfile(): Promise<void>;
    }).clearExpiredProfile();

    expect(clear).toHaveBeenCalledOnce();
    expect(client.currentProfile()).toBe(profile);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(clearing).toEqual([true, false]);
    expect(statuses.at(-1)).toEqual([
      "Remote Companion is disconnected, but its saved pairing could not be cleared. Use Forget this browser and try again.",
      false,
    ]);
  });

  it("reports offline and stops polling when a live refresh is not acknowledged", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = new RemoteCompanionClient({
      status: (message) => statuses.push(message),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {
        context: {
          seal: vi.fn(async () => new Uint8Array([1, 2, 3])),
        },
        sequence: 1,
      },
      sessionId: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
      socket: { send: vi.fn(), close: vi.fn() },
    });

    client.selectConversation(crypto.randomUUID());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(statuses.at(-1)).toBe("The desktop is offline.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("periodically persists activity from authenticated polling", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    vi.setSystemTime(now);
    const deviceKeys = await generateNonExtractableDeviceKeys();
    const hostKeys = await generateRemoteKeyPair();
    const profile: SealedBrowserDeviceProfile = {
      version: 2,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Active browser",
      publicKey: deviceKeys.publicKey,
      privateKey: deviceKeys.keyPair.privateKey,
      lastUsedAt: new Date(now - 2 * 60 * 60 * 1_000).toISOString(),
      hostId: crypto.randomUUID(),
      hostPublicKey: hostKeys.publicKey,
      relayUrl: "wss://relay.example/remote",
      relayIdentity: TEST_RELAY_IDENTITY,
      desktop: REMOTE_DESKTOP_COMPATIBILITY,
      endpointId: "opaque_endpoint",
      scopes: ["view"],
      projectIds: ["project"],
      grantVersion: 1,
      expiresAt: new Date(now + 14 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    const saveOwnedProfile = vi.fn(async (
      _epoch: number,
      _profile: SealedBrowserDeviceProfile,
    ) => true);
    const internals = client as unknown as {
      attemptEpoch: number;
      profile: SealedBrowserDeviceProfile | null;
      supervisor: { grantUpdated(): void };
      persistAuthenticatedActivity(epoch: number): Promise<void>;
      saveOwnedProfile(
        epoch: number,
        profile: SealedBrowserDeviceProfile,
      ): Promise<boolean>;
    };
    internals.profile = profile;
    internals.saveOwnedProfile = saveOwnedProfile;
    const grantUpdated = vi.spyOn(internals.supervisor, "grantUpdated");

    await internals.persistAuthenticatedActivity(internals.attemptEpoch);
    expect(saveOwnedProfile).toHaveBeenCalledTimes(1);
    expect(saveOwnedProfile.mock.calls[0]?.[1].lastUsedAt).toBe(
      new Date(now).toISOString(),
    );
    expect(grantUpdated).toHaveBeenCalledOnce();
    await internals.persistAuthenticatedActivity(internals.attemptEpoch);
    expect(saveOwnedProfile).toHaveBeenCalledTimes(1);

    vi.setSystemTime(now + 60 * 60 * 1_000 + 1);
    await internals.persistAuthenticatedActivity(internals.attemptEpoch);
    expect(saveOwnedProfile).toHaveBeenCalledTimes(2);
    expect(grantUpdated).toHaveBeenCalledTimes(2);
  });

  it("clears stale detail and rejects prompts for the previous selection", async () => {
    const detail = vi.fn();
    const promptResult = vi.fn();
    const request = vi.fn((
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type !== "prompt.send") return new Promise(() => undefined);
      return Promise.resolve({
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "prompt.accepted",
          deliveryId: value.deliveryId,
          turnId: "remote-turn",
        },
      });
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail,
      promptResult,
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });
    const previousId = crypto.randomUUID();
    const selectedId = crypto.randomUUID();

    client.selectConversation(previousId);
    expect(detail).toHaveBeenLastCalledWith(null);
    expect(
      detail.mock.invocationCallOrder[0],
    ).toBeLessThan(request.mock.invocationCallOrder[0]!);
    client.selectConversation(selectedId);
    expect(detail).toHaveBeenLastCalledWith(null);

    await client.sendPrompt(previousId, "stale target");
    expect(promptResult).toHaveBeenLastCalledWith(
      "The selected conversation changed. The prompt was not sent.",
      false,
      previousId,
    );
    expect(request.mock.calls.filter(
      ([value]) => value.type === "prompt.send",
    )).toHaveLength(0);

    await client.sendPrompt(selectedId, "current target");
    expect(request.mock.calls.find(
      ([value]) => value.type === "prompt.send",
    )?.[0]).toMatchObject({
      type: "prompt.send",
      conversationId: selectedId,
      content: "current target",
    });
  });

  it("never replays a prompt after uncertain transport delivery", async () => {
    const promptResult = vi.fn();
    const request = vi.fn(async (_value: RemoteRequest) => {
      throw new Error("socket closed after send");
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult,
    });
    const conversationId = crypto.randomUUID();
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
      selectedConversationId: conversationId,
    });

    await expect(client.sendPrompt(conversationId, "One shot")).resolves
      .toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      type: "prompt.send",
      conversationId,
      content: "One shot",
    });
    expect(promptResult).toHaveBeenLastCalledWith(
      "Delivery is uncertain. The prompt was not retried.",
      true,
      conversationId,
    );
  });

  it("clears current detail when the conversation is archived", async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const conversationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    let detailRequests = 0;
    const detail = vi.fn();
    const request = vi.fn(async (
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type === "state.get") {
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "state",
            state: {
              generatedAt: now,
              projects: [{ id: projectId, name: "Project" }],
              conversations: [],
              runs: [],
            },
          },
        };
      }
      if (value.type === "conversation.get" && detailRequests++ === 0) {
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "conversation",
            detail: {
              generatedAt: now,
              conversation: {
                id: conversationId,
                projectId,
                title: "Conversation",
                providerLabel: "Provider",
                status: "idle",
                pendingLocalApproval: false,
                promptSafety: {
                  supported: true,
                  headline: "Local approval required for reported actions",
                  explanation: "Desktop approval is required for reported actions.",
                },
                updatedAt: now,
              },
              messages: [],
              activities: [],
              subagents: [],
              waitingForLocalAction: false,
            },
          },
        };
      }
      return {
        type: "response",
        requestId: value.requestId,
        ok: false,
        code: "not-found",
        message: "The archived conversation is no longer available.",
      };
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail,
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });

    client.selectConversation(conversationId);
    await vi.waitFor(() => {
      expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({
        conversation: expect.objectContaining({ id: conversationId }),
      }));
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(detail).toHaveBeenLastCalledWith(null));
    expect(detail.mock.calls).toHaveLength(3);
    (
      client as unknown as { disconnect(message: string): void }
    ).disconnect("cleanup");
  });

  it("reuses validated browser projections on explicit unchanged responses", async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const stateValidator = "A".repeat(43);
    const detailValidator = "B".repeat(43);
    const shell = vi.fn();
    const detail = vi.fn();
    let stateReads = 0;
    let detailReads = 0;
    const request = vi.fn(async (
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type === "state.get") {
        stateReads += 1;
        if (stateReads > 1) {
          return {
            type: "response",
            requestId: value.requestId,
            ok: true,
            result: {
              kind: "not-modified",
              validator: stateValidator,
              checkedAt: now,
              resource: { kind: "state" },
            },
          };
        }
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "state",
            validator: stateValidator,
            state: {
              generatedAt: now,
              projects: [{ id: projectId, name: "Project" }],
              conversations: [],
              runs: [],
            },
          },
        };
      }
      if (value.type !== "conversation.get") {
        throw new Error("Unexpected prompt request.");
      }
      detailReads += 1;
      if (detailReads > 1) {
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "not-modified",
            validator: detailValidator,
            checkedAt: now,
            resource: { kind: "conversation", conversationId },
          },
        };
      }
      return {
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "conversation",
          validator: detailValidator,
          detail: {
            generatedAt: now,
            conversation: {
              id: conversationId,
              projectId,
              title: "Conversation",
              providerLabel: "Provider",
              status: "idle",
              pendingLocalApproval: false,
              promptSafety: {
                supported: true,
                headline: "Local approval required",
                explanation: "Desktop approval remains authoritative.",
              },
              updatedAt: now,
            },
            messages: [],
            activities: [],
            subagents: [],
            waitingForLocalAction: false,
          },
        },
      };
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell,
      detail,
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });

    client.selectConversation(conversationId);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]?.[0]).toMatchObject({ type: "state.get" });
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("ifNoneMatch");
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      type: "conversation.get",
      ifNoneMatch: null,
    });
    expect(shell).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      type: "state.get",
      ifNoneMatch: stateValidator,
    });
    expect(request.mock.calls[3]?.[0]).toMatchObject({
      type: "conversation.get",
      ifNoneMatch: detailValidator,
    });
    expect(shell).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(2);
    (
      client as unknown as { disconnect(message: string): void }
    ).disconnect("cleanup");
  });

  it("falls back to legacy reads after a conditional reconnect is rejected", async () => {
    vi.useFakeTimers();
    const validator = "A".repeat(43);
    const shell = vi.fn();
    const request = vi.fn(async (
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type !== "state.get") {
        throw new Error("Unexpected remote request.");
      }
      if (value.ifNoneMatch !== undefined) {
        return {
          type: "response",
          requestId: value.requestId,
          ok: false,
          code: "invalid",
          message: "The remote request was invalid.",
        };
      }
      return {
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "state",
          state: {
            generatedAt: new Date().toISOString(),
            projects: [],
            conversations: [],
            runs: [],
          },
        },
      };
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell,
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
      conditionalProjections: true,
      hasShellProjection: true,
      shellValidator: validator,
    });
    const internals = client as unknown as {
      refresh(epoch: number, generation: number): Promise<void>;
      disconnect(message: string): void;
    };

    await internals.refresh(0, 0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      type: "state.get",
      ifNoneMatch: validator,
    });
    expect(shell).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0]).not.toHaveProperty("ifNoneMatch");
    expect(shell).toHaveBeenCalledTimes(1);
    internals.disconnect("cleanup");
  });

  it("does not let an old not-found response clear a newer selection", async () => {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const oldId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    let oldRequestStarted = (): void => undefined;
    const oldStarted = new Promise<void>((resolve) => {
      oldRequestStarted = resolve;
    });
    let resolveOld = (_response: RemoteResponse): void => undefined;
    const oldResponse = new Promise<RemoteResponse>((resolve) => {
      resolveOld = resolve;
    });
    const detail = vi.fn();
    const request = vi.fn((
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type === "state.get") {
        return Promise.resolve({
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "state",
            state: {
              generatedAt: now,
              projects: [],
              conversations: [],
              runs: [],
            },
          },
        });
      }
      if (
        value.type === "conversation.get"
        && value.conversationId === oldId
      ) {
        oldRequestStarted();
        return oldResponse;
      }
      return Promise.resolve({
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "conversation",
          detail: {
            generatedAt: now,
            conversation: {
              id: currentId,
              projectId,
              title: "Current conversation",
              providerLabel: "Provider",
              status: "idle",
              pendingLocalApproval: false,
              promptSafety: {
                supported: true,
                headline: "Local approval required for reported actions",
                explanation: "Desktop approval is required for reported actions.",
              },
              updatedAt: now,
            },
            messages: [],
            activities: [],
            subagents: [],
            waitingForLocalAction: false,
          },
        },
      });
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail,
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });

    client.selectConversation(oldId);
    await oldStarted;
    client.selectConversation(currentId);
    await vi.waitFor(() => {
      expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({
        conversation: expect.objectContaining({ id: currentId }),
      }));
    });
    resolveOld({
      type: "response",
      requestId: crypto.randomUUID(),
      ok: false,
      code: "not-found",
      message: "The old conversation disappeared.",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({
      conversation: expect.objectContaining({ id: currentId }),
    }));
    (
      client as unknown as { disconnect(message: string): void }
    ).disconnect("cleanup");
  });

  it("keeps one polling loop across repeated conversation selection refreshes", async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    let blockNextState = false;
    let releaseState = (): void => undefined;
    const stateReleased = new Promise<void>((resolve) => {
      releaseState = resolve;
    });
    const request = vi.fn(async (
      value: RemoteRequest,
    ): Promise<RemoteResponse> => {
      if (value.type === "state.get") {
        if (blockNextState) {
          blockNextState = false;
          await stateReleased;
        }
        return {
          type: "response",
          requestId: value.requestId,
          ok: true,
          result: {
            kind: "state",
            state: {
              generatedAt: now,
              projects: [],
              conversations: [],
              runs: [],
            },
          },
        };
      }
      return {
        type: "response",
        requestId: value.requestId,
        ok: true,
        result: {
          kind: "conversation",
          detail: {
            generatedAt: now,
            conversation: {
              id: value.type === "conversation.get"
                ? value.conversationId
                : crypto.randomUUID(),
              projectId: "project",
              title: "Conversation",
              providerLabel: "Provider",
              status: "idle",
              pendingLocalApproval: false,
              promptSafety: {
                supported: true,
                headline: "Local approval required for reported actions",
                explanation: "Desktop approval is required for reported actions.",
              },
              updatedAt: now,
            },
            messages: [],
            activities: [],
            subagents: [],
            waitingForLocalAction: false,
          },
        },
      };
    });
    const client = new RemoteCompanionClient({
      status: vi.fn(),
      pairingCode: vi.fn(),
      shell: vi.fn(),
      detail: vi.fn(),
      promptResult: vi.fn(),
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      sender: {},
      request,
    });

    client.selectConversation(crypto.randomUUID());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(vi.getTimerCount()).toBe(1);

    blockNextState = true;
    client.selectConversation(crypto.randomUUID());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(vi.getTimerCount()).toBe(0);

    client.selectConversation(crypto.randomUUID());
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    expect(vi.getTimerCount()).toBe(1);
    releaseState();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

    for (let index = 0; index < 20; index += 1) {
      client.selectConversation(crypto.randomUUID());
    }
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(26));
    expect(vi.getTimerCount()).toBe(1);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const callsBeforePoll = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(callsBeforePoll + 2);
      });
      expect(vi.getTimerCount()).toBe(1);
    }
  });
});
