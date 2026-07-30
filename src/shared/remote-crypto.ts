import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
  type RecipientContext,
  type SenderContext,
} from "@hpke/core";

import {
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCipherFrame,
  type RemotePairingInvitation,
} from "./remote-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export interface RemoteSerializedKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface RemoteImportedKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface RemoteSenderState {
  context: SenderContext;
  sequence: number;
}

export interface RemoteRecipientState {
  context: RecipientContext;
  sequence: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function boundedJsonBytes(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > REMOTE_LIMITS.plaintextBytes) {
    throw new Error("Remote plaintext exceeds the protocol limit.");
  }
  return bytes;
}

function parseJson(bytes: ArrayBuffer): unknown {
  if (bytes.byteLength > REMOTE_LIMITS.plaintextBytes) {
    throw new Error("Remote plaintext exceeds the protocol limit.");
  }
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

function pairingInfo(
  invitation: Pick<RemotePairingInvitation, "hostId" | "invitationId">,
): Uint8Array {
  return encoder.encode(
    `inertia-remote/${REMOTE_PROTOCOL_VERSION}/pair/${invitation.hostId}/${invitation.invitationId}`,
  );
}

function sessionInfo(hostId: string, deviceId: string, sessionId: string): Uint8Array {
  return encoder.encode(
    `inertia-remote/${REMOTE_PROTOCOL_VERSION}/session/${hostId}/${deviceId}/${sessionId}`,
  );
}

function pairingAad(invitationId: string): Uint8Array {
  return encoder.encode(
    `inertia-remote/${REMOTE_PROTOCOL_VERSION}/pair.request/${invitationId}`,
  );
}

function responseAad(requestId: string): Uint8Array {
  return encoder.encode(
    `inertia-remote/${REMOTE_PROTOCOL_VERSION}/pair.response/${requestId}`,
  );
}

function sessionAad(
  kind: "session.open" | "session.accept" | "session.data",
  sessionId: string,
  sequence = 0,
): Uint8Array {
  return encoder.encode(
    `inertia-remote/${REMOTE_PROTOCOL_VERSION}/${kind}/${sessionId}/${sequence}`,
  );
}

export async function generateRemoteKeyPair(): Promise<RemoteSerializedKeyPair> {
  const keyPair = await suite.kem.generateKeyPair();
  return {
    publicKey: bytesToBase64Url(
      new Uint8Array(await suite.kem.serializePublicKey(keyPair.publicKey)),
    ),
    privateKey: bytesToBase64Url(
      new Uint8Array(await suite.kem.serializePrivateKey(keyPair.privateKey)),
    ),
  };
}

export async function importRemoteKeyPair(
  serialized: RemoteSerializedKeyPair,
): Promise<RemoteImportedKeyPair> {
  return {
    publicKey: await suite.kem.deserializePublicKey(
      base64UrlToBytes(serialized.publicKey),
    ),
    privateKey: await suite.kem.deserializePrivateKey(
      base64UrlToBytes(serialized.privateKey),
    ),
  };
}

export async function importRemotePublicKey(value: string): Promise<CryptoKey> {
  return await suite.kem.deserializePublicKey(base64UrlToBytes(value));
}

export async function sealPairingRequest(
  invitation: RemotePairingInvitation,
  payload: unknown,
): Promise<Extract<RemoteCipherFrame, { kind: "pair.request" }>> {
  const recipientPublicKey = await importRemotePublicKey(
    invitation.hostPublicKey,
  );
  const context = await suite.createSenderContext({
    recipientPublicKey,
    info: pairingInfo(invitation),
    psk: {
      id: encoder.encode(invitation.invitationId),
      key: base64UrlToBytes(invitation.pairingSecret),
    },
  });
  const ciphertext = await context.seal(
    boundedJsonBytes(payload),
    pairingAad(invitation.invitationId),
  );
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    kind: "pair.request",
    invitationId: invitation.invitationId,
    enc: bytesToBase64Url(new Uint8Array(context.enc)),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function openPairingRequest(
  invitation: RemotePairingInvitation,
  hostKeyPair: RemoteImportedKeyPair,
  frame: Extract<RemoteCipherFrame, { kind: "pair.request" }>,
): Promise<unknown> {
  if (frame.invitationId !== invitation.invitationId) {
    throw new Error("Pairing invitation mismatch.");
  }
  const context = await suite.createRecipientContext({
    recipientKey: hostKeyPair,
    enc: base64UrlToBytes(frame.enc),
    info: pairingInfo(invitation),
    psk: {
      id: encoder.encode(invitation.invitationId),
      key: base64UrlToBytes(invitation.pairingSecret),
    },
  });
  return parseJson(await context.open(
    base64UrlToBytes(frame.ciphertext),
    pairingAad(invitation.invitationId),
  ));
}

export async function sealPairingResponse(
  hostKeyPair: RemoteImportedKeyPair,
  devicePublicKey: CryptoKey,
  requestId: string,
  payload: unknown,
): Promise<Extract<RemoteCipherFrame, { kind: "pair.response" }>> {
  const context = await suite.createSenderContext({
    recipientPublicKey: devicePublicKey,
    senderKey: hostKeyPair,
    info: encoder.encode(
      `inertia-remote/${REMOTE_PROTOCOL_VERSION}/pair.response/${requestId}`,
    ),
  });
  const ciphertext = await context.seal(
    boundedJsonBytes(payload),
    responseAad(requestId),
  );
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    kind: "pair.response",
    requestId,
    enc: bytesToBase64Url(new Uint8Array(context.enc)),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function openPairingResponse(
  deviceKeyPair: RemoteImportedKeyPair,
  hostPublicKey: CryptoKey,
  frame: Extract<RemoteCipherFrame, { kind: "pair.response" }>,
): Promise<unknown> {
  const context = await suite.createRecipientContext({
    recipientKey: deviceKeyPair,
    senderPublicKey: hostPublicKey,
    enc: base64UrlToBytes(frame.enc),
    info: encoder.encode(
      `inertia-remote/${REMOTE_PROTOCOL_VERSION}/pair.response/${frame.requestId}`,
    ),
  });
  return parseJson(await context.open(
    base64UrlToBytes(frame.ciphertext),
    responseAad(frame.requestId),
  ));
}

export async function createAuthenticatedSessionSender(
  hostId: string,
  deviceId: string,
  sessionId: string,
  senderKeyPair: RemoteImportedKeyPair,
  recipientPublicKey: CryptoKey,
): Promise<RemoteSenderState & { enc: string }> {
  const context = await suite.createSenderContext({
    recipientPublicKey,
    senderKey: senderKeyPair,
    info: sessionInfo(hostId, deviceId, sessionId),
  });
  return {
    context,
    sequence: 0,
    enc: bytesToBase64Url(new Uint8Array(context.enc)),
  };
}

export async function createAuthenticatedSessionRecipient(
  hostId: string,
  deviceId: string,
  sessionId: string,
  recipientKeyPair: RemoteImportedKeyPair,
  senderPublicKey: CryptoKey,
  enc: string,
): Promise<RemoteRecipientState> {
  return {
    context: await suite.createRecipientContext({
      recipientKey: recipientKeyPair,
      senderPublicKey,
      enc: base64UrlToBytes(enc),
      info: sessionInfo(hostId, deviceId, sessionId),
    }),
    sequence: 0,
  };
}

export async function sealSessionHandshake(
  sender: RemoteSenderState,
  kind: "session.open" | "session.accept",
  sessionId: string,
  payload: unknown,
): Promise<string> {
  if (sender.sequence !== 0) throw new Error("Session handshake was already sent.");
  const ciphertext = await sender.context.seal(
    boundedJsonBytes(payload),
    sessionAad(kind, sessionId),
  );
  sender.sequence += 1;
  return bytesToBase64Url(new Uint8Array(ciphertext));
}

export async function openSessionHandshake(
  recipient: RemoteRecipientState,
  kind: "session.open" | "session.accept",
  sessionId: string,
  ciphertext: string,
): Promise<unknown> {
  if (recipient.sequence !== 0) {
    throw new Error("Session handshake replayed.");
  }
  const plaintext = await recipient.context.open(
    base64UrlToBytes(ciphertext),
    sessionAad(kind, sessionId),
  );
  recipient.sequence += 1;
  return parseJson(plaintext);
}

export async function sealSessionData(
  sender: RemoteSenderState,
  sessionId: string,
  payload: unknown,
): Promise<Extract<RemoteCipherFrame, { kind: "session.data" }>> {
  const sequence = sender.sequence;
  const ciphertext = await sender.context.seal(
    boundedJsonBytes(payload),
    sessionAad("session.data", sessionId, sequence),
  );
  sender.sequence += 1;
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    kind: "session.data",
    sessionId,
    sequence,
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function openSessionData(
  recipient: RemoteRecipientState,
  frame: Extract<RemoteCipherFrame, { kind: "session.data" }>,
): Promise<unknown> {
  if (frame.sequence !== recipient.sequence) {
    throw new Error("Remote session sequence mismatch.");
  }
  const plaintext = await recipient.context.open(
    base64UrlToBytes(frame.ciphertext),
    sessionAad("session.data", frame.sessionId, frame.sequence),
  );
  recipient.sequence += 1;
  return parseJson(plaintext);
}

export function remoteRandomSecret(bytes = 32): string {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

export async function remotePairingComparisonCode(
  hostPublicKey: string,
  devicePublicKey: string,
  invitationId: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(
      `inertia-remote-pairing-code\0${hostPublicKey}\0${devicePublicKey}\0${invitationId}`,
    ),
  );
  return (new DataView(digest).getUint32(0) % 1_000_000)
    .toString()
    .padStart(6, "0");
}
