import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  importRemotePublicKey,
  openSessionHandshake,
  sealSessionHandshake,
  type RemoteImportedKeyPair,
  type RemoteRecipientState,
  type RemoteSenderState,
} from "../shared/remote-crypto";
import {
  REMOTE_BROWSER_SESSION_VERSION,
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  remoteSessionOpenPayloadSchema,
  type RemoteAuthorizationSubject,
  type RemoteCipherFrame,
} from "../shared/remote-protocol";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
} from "./remote-access-store";

export interface AuthenticatedRemoteSession {
  recipient: RemoteRecipientState;
  sender: RemoteSenderState & { enc: string };
  subject: RemoteAuthorizationSubject;
  disposition: "accepted" | "revoked" | "expired";
  supportsAuthenticatedRejection: boolean;
  ciphertext: string;
}

export async function authenticateRemoteSession(input: {
  data: PersistedRemoteAccess;
  device: PersistedRemoteDevice;
  frame: Extract<RemoteCipherFrame, { kind: "session.open" }>;
  hostKeys: RemoteImportedKeyPair;
  now(): Date;
  current(): boolean;
}): Promise<AuthenticatedRemoteSession | "stale" | null> {
  let recipient: RemoteRecipientState;
  let payload: ReturnType<typeof remoteSessionOpenPayloadSchema.parse>;
  let devicePublicKey: CryptoKey;
  try {
    devicePublicKey = await importRemotePublicKey(input.device.publicKey);
    if (!input.current()) return "stale";
    recipient = await createAuthenticatedSessionRecipient(
      input.data.hostId,
      input.device.id,
      input.frame.sessionId,
      input.hostKeys,
      devicePublicKey,
      input.frame.enc,
    );
    if (!input.current()) return "stale";
    payload = remoteSessionOpenPayloadSchema.parse(
      await openSessionHandshake(
        recipient,
        "session.open",
        input.frame.sessionId,
        input.frame.ciphertext,
      ),
    );
    if (!input.current()) return "stale";
  } catch {
    return input.current() ? null : "stale";
  }
  if (
    payload.sessionId !== input.frame.sessionId
    || payload.deviceId !== input.device.id
    || Math.abs(Date.parse(payload.createdAt) - input.now().getTime())
      > REMOTE_LIMITS.sessionHandshakeTtlMs
  ) return null;
  const sender = await createAuthenticatedSessionSender(
    input.data.hostId,
    input.device.id,
    input.frame.sessionId,
    input.hostKeys,
    devicePublicKey,
  );
  if (!input.current()) return "stale";
  const subject: RemoteAuthorizationSubject = {
    deviceId: input.device.id,
    sessionId: input.frame.sessionId,
    scopes: [...input.device.scopes],
    projectIds: [...input.device.projectIds],
    grants: structuredClone(input.device.grants),
    grantVersion: input.device.grantVersion,
    expiresAt: input.device.expiresAt,
  };
  const responseTime = input.now();
  const supportsAuthenticatedRejection =
    payload.browserVersion === REMOTE_BROWSER_SESSION_VERSION;
  const disposition = input.device.revokedAt !== null
    ? "revoked"
    : Date.parse(input.device.expiresAt) <= responseTime.getTime()
      ? "expired"
      : "accepted";
  const ciphertext = await sealSessionHandshake(
    sender,
    "session.accept",
    input.frame.sessionId,
    disposition === "accepted"
      ? {
        type: "session.accept",
        sessionId: input.frame.sessionId,
        hostId: input.data.hostId,
        grantVersion: input.device.grantVersion,
        scopes: input.device.scopes,
        projectIds: input.device.projectIds,
        expiresAt: input.device.expiresAt,
        serverTime: responseTime.toISOString(),
      }
      : {
        type: "session.reject",
        sessionId: input.frame.sessionId,
        hostId: input.data.hostId,
        reason: disposition,
        serverTime: responseTime.toISOString(),
      },
  );
  return input.current()
    ? {
      recipient,
      sender,
      subject,
      disposition,
      supportsAuthenticatedRejection,
      ciphertext,
    }
    : "stale";
}

export function rememberRemoteSession(
  data: PersistedRemoteAccess,
  sessionId: string,
  createdAt: string,
): void {
  data.usedSessions.push({ id: sessionId, createdAt });
  if (data.usedSessions.length > REMOTE_LIMITS.deliveryReceipts) {
    data.usedSessions.splice(
      0,
      data.usedSessions.length - REMOTE_LIMITS.deliveryReceipts,
    );
  }
}

export function authenticatedRemoteSessionDecisionFrame(
  sessionId: string,
  authenticated: AuthenticatedRemoteSession,
): RemoteCipherFrame {
  if (!authenticated.supportsAuthenticatedRejection) {
    return {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      kind: "session.close",
      sessionId,
      reason: "shutdown",
    };
  }
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    kind: "session.accept",
    sessionId,
    enc: authenticated.sender.enc,
    ciphertext: authenticated.ciphertext,
  };
}

export function authenticatedRemoteRejectionIsCurrent(input: {
  data: PersistedRemoteAccess;
  device: PersistedRemoteDevice;
  authenticated: Pick<
    AuthenticatedRemoteSession,
    "disposition" | "subject"
  >;
  now: Date;
  current(): boolean;
}): boolean {
  const { authenticated, device } = input;
  const disposition = device.revokedAt !== null
    ? "revoked"
    : Date.parse(device.expiresAt) <= input.now.getTime()
      ? "expired"
      : "accepted";
  return input.current()
    && input.data.devices.includes(device)
    && authenticated.subject.grantVersion === device.grantVersion
    && authenticated.disposition === disposition;
}
