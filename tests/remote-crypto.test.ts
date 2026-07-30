import { describe, expect, it } from "vitest";

import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  importRemotePublicKey,
  openPairingRequest,
  openPairingResponse,
  openSessionData,
  openSessionHandshake,
  remoteRandomSecret,
  sealPairingRequest,
  sealPairingResponse,
  sealSessionData,
  sealSessionHandshake,
} from "../src/shared/remote-crypto";
import {
  REMOTE_PROTOCOL_VERSION,
  remoteCipherFrameSchema,
  remotePairingRequestPayloadSchema,
  remoteResponseSchema,
  type RemotePairingInvitation,
} from "../src/shared/remote-protocol";

const invitation: RemotePairingInvitation = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  relayUrl: "wss://relay.invalid/remote",
  endpointId: "endpoint_123",
  hostId: "91f064bc-f7ae-4d2d-91ef-8bc0c91310a0",
  hostPublicKey: "",
  invitationId: "887342a2-3293-46fe-9992-094455503a6e",
  pairingSecret: "",
  expiresAt: "2030-01-01T00:05:00.000Z",
};

describe("Remote Companion HPKE channel", () => {
  it("pairs with a one-time proof and authenticates the desktop response", async () => {
    const hostKeys = await generateRemoteKeyPair();
    const deviceKeys = await generateRemoteKeyPair();
    const hostKeyPair = await importRemoteKeyPair(hostKeys);
    const deviceKeyPair = await importRemoteKeyPair(deviceKeys);
    const activeInvitation = {
      ...invitation,
      hostPublicKey: hostKeys.publicKey,
      pairingSecret: remoteRandomSecret(),
    };
    const request = {
      type: "pair.request" as const,
      requestId: "fc397cee-ea56-4018-bd57-2120296ac6ac",
      invitationId: activeInvitation.invitationId,
      deviceId: "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937",
      deviceLabel: "Travel laptop",
      devicePublicKey: deviceKeys.publicKey,
      createdAt: "2030-01-01T00:00:01.000Z",
      browserVersion: "0.1.0",
    };

    const requestFrame = await sealPairingRequest(activeInvitation, request);
    expect(JSON.stringify(requestFrame)).not.toContain("Travel laptop");
    const openedRequest = remotePairingRequestPayloadSchema.parse(
      await openPairingRequest(activeInvitation, hostKeyPair, requestFrame),
    );
    expect(openedRequest).toEqual(request);

    const responseFrame = await sealPairingResponse(
      hostKeyPair,
      await importRemotePublicKey(deviceKeys.publicKey),
      request.requestId,
      {
        type: "pair.accepted",
        requestId: request.requestId,
        deviceId: request.deviceId,
        hostId: activeInvitation.hostId,
        scopes: ["view"],
        expiresAt: "2030-02-01T00:00:00.000Z",
        grantVersion: 1,
      },
    );
    expect(await openPairingResponse(
      deviceKeyPair,
      await importRemotePublicKey(hostKeys.publicKey),
      responseFrame,
    )).toMatchObject({
      type: "pair.accepted",
      scopes: ["view"],
    });
  });

  it("rejects a phishing invitation mismatch and the wrong pairing proof", async () => {
    const hostKeys = await generateRemoteKeyPair();
    const hostKeyPair = await importRemoteKeyPair(hostKeys);
    const activeInvitation = {
      ...invitation,
      hostPublicKey: hostKeys.publicKey,
      pairingSecret: remoteRandomSecret(),
    };
    const frame = await sealPairingRequest(activeInvitation, { hello: "world" });

    await expect(openPairingRequest(
      { ...activeInvitation, invitationId: crypto.randomUUID() },
      hostKeyPair,
      frame,
    )).rejects.toThrow("mismatch");
    await expect(openPairingRequest(
      { ...activeInvitation, pairingSecret: remoteRandomSecret() },
      hostKeyPair,
      frame,
    )).rejects.toThrow();
  });

  it("authenticates both session directions and rejects replay", async () => {
    const hostKeys = await generateRemoteKeyPair();
    const deviceKeys = await generateRemoteKeyPair();
    const hostKeyPair = await importRemoteKeyPair(hostKeys);
    const deviceKeyPair = await importRemoteKeyPair(deviceKeys);
    const sessionId = "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e";
    const deviceId = "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937";
    const deviceSender = await createAuthenticatedSessionSender(
      invitation.hostId,
      deviceId,
      sessionId,
      deviceKeyPair,
      await importRemotePublicKey(hostKeys.publicKey),
    );
    const hostRecipient = await createAuthenticatedSessionRecipient(
      invitation.hostId,
      deviceId,
      sessionId,
      hostKeyPair,
      await importRemotePublicKey(deviceKeys.publicKey),
      deviceSender.enc,
    );
    const openCiphertext = await sealSessionHandshake(
      deviceSender,
      "session.open",
      sessionId,
      { type: "session.open", sessionId },
    );
    expect(await openSessionHandshake(
      hostRecipient,
      "session.open",
      sessionId,
      openCiphertext,
    )).toMatchObject({ type: "session.open" });

    const dataFrame = await sealSessionData(deviceSender, sessionId, {
      type: "state.get",
    });
    expect(await openSessionData(hostRecipient, dataFrame)).toEqual({
      type: "state.get",
    });
    await expect(openSessionData(hostRecipient, dataFrame)).rejects.toThrow(
      "sequence mismatch",
    );
  });
});

describe("Remote Companion bounded protocol", () => {
  it("rejects malformed and oversized relay frames", () => {
    expect(remoteCipherFrameSchema.safeParse({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      kind: "session.data",
      sessionId: crypto.randomUUID(),
      sequence: -1,
      ciphertext: "valid_base64url",
    }).success).toBe(false);
    expect(remoteCipherFrameSchema.safeParse({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      kind: "session.data",
      sessionId: crypto.randomUUID(),
      sequence: 1,
      ciphertext: "x".repeat(200_000),
    }).success).toBe(false);
  });

  it("strictly validates decrypted response projections", () => {
    expect(remoteResponseSchema.safeParse({
      type: "response",
      requestId: crypto.randomUUID(),
      ok: true,
      result: {
        kind: "state",
        state: {
          generatedAt: new Date().toISOString(),
          projects: [{ id: "project", name: "Safe", path: "/secret" }],
          conversations: [],
          runs: [],
        },
      },
    }).success).toBe(false);
  });
});
