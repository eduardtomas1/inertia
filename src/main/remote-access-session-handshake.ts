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
  REMOTE_LIMITS,
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
    grantVersion: input.device.grantVersion,
    expiresAt: input.device.expiresAt,
  };
  const ciphertext = await sealSessionHandshake(
    sender,
    "session.accept",
    input.frame.sessionId,
    {
      type: "session.accept",
      sessionId: input.frame.sessionId,
      hostId: input.data.hostId,
      grantVersion: input.device.grantVersion,
      scopes: input.device.scopes,
      projectIds: input.device.projectIds,
      expiresAt: input.device.expiresAt,
      serverTime: input.now().toISOString(),
    },
  );
  return input.current()
    ? { recipient, sender, subject, ciphertext }
    : "stale";
}
