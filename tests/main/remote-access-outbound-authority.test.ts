import { describe, expect, it } from "vitest";

import { sendSequencedRemoteResponse } from "../../src/main/remote-access-lifecycle";
import {
  remoteSessionCanCommitPrompt,
  remoteSessionRetainsAuthority,
  type RemoteSessionAuthorityInput,
} from "../../src/main/remote-access-session-admission";
import type {
  ActiveRemoteSession,
} from "../../src/main/remote-access-service-types";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
} from "../../src/main/remote-access-store";
import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  openSessionData,
} from "../../src/shared/remote-crypto";
import type {
  RemoteCipherFrame,
  RemoteResponse,
} from "../../src/shared/remote-protocol";

const HOST_ID = "5f7b2c1e-2a44-4a1f-9d4a-8c6f0d5b1a11";
const DEVICE_ID = "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937";
const SESSION_ID = "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e";
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

type SessionDataFrame = Extract<RemoteCipherFrame, { kind: "session.data" }>;

function response(requestId: string): RemoteResponse {
  return {
    type: "response",
    requestId,
    ok: false,
    code: "unavailable",
    message: "probe",
  };
}

async function outboundFixture() {
  const hostKeys = await generateRemoteKeyPair();
  const deviceKeys = await generateRemoteKeyPair();
  const host = await importRemoteKeyPair(hostKeys);
  const device = await importRemoteKeyPair(deviceKeys);
  const sender = await createAuthenticatedSessionSender(
    HOST_ID,
    DEVICE_ID,
    SESSION_ID,
    host,
    device.publicKey,
  );
  const recipient = await createAuthenticatedSessionRecipient(
    HOST_ID,
    DEVICE_ID,
    SESSION_ID,
    device,
    host.publicKey,
    sender.enc,
  );
  const sent: SessionDataFrame[] = [];
  const session = {
    connectionId: "connection",
    sessionId: SESSION_ID,
    sender,
    outboundTail: Promise.resolve(),
    outboundAbandoned: false,
  };
  return {
    session,
    recipient,
    sent,
    send: (_connectionId: string, frame: SessionDataFrame) => {
      sent.push(frame);
    },
  };
}

function invalidatedDuringEncryption(): () => boolean {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1;
  };
}

function persistedDevice(
  overrides: Partial<PersistedRemoteDevice> = {},
): PersistedRemoteDevice {
  return {
    id: DEVICE_ID,
    label: "Phone",
    publicKey: "aaaa",
    scopes: ["view", "prompt"],
    projectIds: ["project-one"],
    createdAt: "2029-12-01T00:00:00.000Z",
    expiresAt: "2030-02-01T00:00:00.000Z",
    lastSeenAt: null,
    revokedAt: null,
    grantVersion: 3,
    ...overrides,
  };
}

function authorityFixture(
  deviceOverrides: Partial<PersistedRemoteDevice> = {},
): RemoteSessionAuthorityInput {
  const device = persistedDevice(deviceOverrides);
  const data = {
    version: 1,
    enabled: true,
    relayUrl: "wss://relay.example",
    hostId: HOST_ID,
    endpointId: "endpoint",
    keyPair: { publicKey: "aa", privateKey: "bb" },
    devices: [device],
    audit: [],
    receipts: [],
    usedSessions: [],
  } as unknown as PersistedRemoteAccess;
  const session = {
    connectionId: "connection",
    connectionEpoch: 1,
    sessionId: SESSION_ID,
    device,
    recipient: {},
    sender: {},
    subject: {
      deviceId: device.id,
      sessionId: SESSION_ID,
      scopes: [...device.scopes],
      projectIds: [...device.projectIds],
      grantVersion: device.grantVersion,
      expiresAt: device.expiresAt,
    },
    createdAt: NOW,
    lastActivityAt: NOW,
    requestTimes: [],
    promptTimes: [],
    inFlight: new Map(),
    postedPromptDeliveries: new Set<string>(),
    outboundTail: Promise.resolve(),
    outboundAbandoned: false,
  } as unknown as ActiveRemoteSession;
  return {
    data,
    session,
    live: true,
    ownsRoute: true,
    privacyLocked: false,
    stopped: false,
    storeFailed: false,
    now: NOW,
  };
}

describe("remote outbound frame authority", () => {
  it("sends a sealed frame while authority is held throughout", async () => {
    const { session, recipient, sent, send } = await outboundFixture();
    await sendSequencedRemoteResponse(
      session,
      response("11111111-1111-4111-8111-111111111111"),
      () => true,
      send,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sequence).toBe(0);
    expect(await openSessionData(recipient, sent[0]!)).toMatchObject({
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(session.outboundAbandoned).toBe(false);
  });

  it("sends zero frames when authority is lost during encryption", async () => {
    const { session, sent, send } = await outboundFixture();
    await sendSequencedRemoteResponse(
      session,
      response("22222222-2222-4222-8222-222222222222"),
      invalidatedDuringEncryption(),
      send,
    );
    expect(sent).toHaveLength(0);
  });

  it("sends zero frames when authority is already lost before encryption", async () => {
    const { session, sent, send } = await outboundFixture();
    await sendSequencedRemoteResponse(
      session,
      response("33333333-3333-4333-8333-333333333333"),
      () => false,
      send,
    );
    expect(sent).toHaveLength(0);
    expect(session.sender.sequence).toBe(0);
    expect(session.outboundAbandoned).toBe(false);
  });

  it("abandons the outbound channel after discarding a sealed frame", async () => {
    const { session, sent, send } = await outboundFixture();
    await sendSequencedRemoteResponse(
      session,
      response("44444444-4444-4444-8444-444444444444"),
      invalidatedDuringEncryption(),
      send,
    );
    expect(session.outboundAbandoned).toBe(true);
    expect(session.sender.sequence).toBe(1);

    await sendSequencedRemoteResponse(
      session,
      response("55555555-5555-4555-8555-555555555555"),
      () => true,
      send,
    );
    expect(sent).toHaveLength(0);
    expect(session.sender.sequence).toBe(1);
  });

  it("keeps a replacement session's sequence correct after a discarded frame", async () => {
    const dropped = await outboundFixture();
    await sendSequencedRemoteResponse(
      dropped.session,
      response("66666666-6666-4666-8666-666666666666"),
      invalidatedDuringEncryption(),
      dropped.send,
    );
    expect(dropped.sent).toHaveLength(0);

    const replacement = await outboundFixture();
    await sendSequencedRemoteResponse(
      replacement.session,
      response("77777777-7777-4777-8777-777777777777"),
      () => true,
      replacement.send,
    );
    await sendSequencedRemoteResponse(
      replacement.session,
      response("88888888-8888-4888-8888-888888888888"),
      () => true,
      replacement.send,
    );
    expect(replacement.sent.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(await openSessionData(replacement.recipient, replacement.sent[0]!))
      .toMatchObject({ requestId: "77777777-7777-4777-8777-777777777777" });
    expect(await openSessionData(replacement.recipient, replacement.sent[1]!))
      .toMatchObject({ requestId: "88888888-8888-4888-8888-888888888888" });
  });

  it("keeps queued sends ordered and stops all of them after invalidation", async () => {
    const { session, sent, send } = await outboundFixture();
    let live = true;
    const authority = (): boolean => live;
    const first = sendSequencedRemoteResponse(
      session,
      response("99999999-9999-4999-8999-999999999999"),
      authority,
      send,
    );
    const second = sendSequencedRemoteResponse(
      session,
      response("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      authority,
      send,
    );
    live = false;
    await Promise.all([first, second]);
    expect(sent.length).toBeLessThanOrEqual(1);
    for (const frame of sent) expect(frame.sequence).toBe(0);
  });
});

describe("remote session authority predicate", () => {
  it("holds for a live, current, unlocked session", () => {
    expect(remoteSessionRetainsAuthority(authorityFixture())).toBe(true);
    expect(remoteSessionCanCommitPrompt(authorityFixture())).toBe(true);
  });

  it("fails when the device is revoked", () => {
    const input = authorityFixture({
      revokedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("fails when the grant is removed from the store", () => {
    const input = authorityFixture();
    input.data!.devices = [];
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("fails when the grant object is replaced by an equal-looking copy", () => {
    const input = authorityFixture();
    input.data!.devices = [{ ...input.session.device }];
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("fails when the grant version moves on", () => {
    const input = authorityFixture();
    input.session.device.grantVersion = 4;
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("fails when the granted projects change", () => {
    const input = authorityFixture();
    input.session.device.projectIds = ["project-one", "project-two"];
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("fails when the desktop is locked", () => {
    expect(remoteSessionRetainsAuthority({
      ...authorityFixture(),
      privacyLocked: true,
    })).toBe(false);
  });

  it("fails when Remote Companion is disabled", () => {
    const input = authorityFixture();
    input.data!.enabled = false;
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("fails when the encrypted store failed closed", () => {
    expect(remoteSessionRetainsAuthority({
      ...authorityFixture(),
      storeFailed: true,
    })).toBe(false);
    expect(remoteSessionRetainsAuthority({
      ...authorityFixture(),
      data: null,
    })).toBe(false);
  });

  it("fails when the session grant expired", () => {
    expect(remoteSessionRetainsAuthority({
      ...authorityFixture(),
      now: Date.parse("2030-03-01T00:00:00.000Z"),
    })).toBe(false);
  });

  it("fails when the relay connection epoch was replaced", () => {
    expect(remoteSessionRetainsAuthority({
      ...authorityFixture(),
      ownsRoute: false,
    })).toBe(false);
  });

  it("fails when the session is no longer the live one", () => {
    expect(remoteSessionRetainsAuthority({
      ...authorityFixture(),
      live: false,
    })).toBe(false);
  });

  it("fails when the desktop is shutting down", () => {
    expect(remoteSessionRetainsAuthority({
      ...authorityFixture(),
      stopped: true,
    })).toBe(false);
  });

  it("fails once the outbound channel was abandoned", () => {
    const input = authorityFixture();
    input.session.outboundAbandoned = true;
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("fails when the subject describes another session", () => {
    const input = authorityFixture();
    input.session.subject.sessionId = "12341234-1234-4234-8234-123412341234";
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
  });

  it("separates view authority from prompt authority", () => {
    const input = authorityFixture({ scopes: ["view"] });
    input.session.subject.scopes = ["view"];
    expect(remoteSessionRetainsAuthority(input)).toBe(true);
    expect(remoteSessionCanCommitPrompt(input)).toBe(false);
  });

  it("refuses a session that never held view authority", () => {
    const input = authorityFixture({ scopes: ["prompt"] });
    input.session.subject.scopes = ["prompt"];
    expect(remoteSessionRetainsAuthority(input)).toBe(false);
    expect(remoteSessionCanCommitPrompt(input)).toBe(false);
  });
});
