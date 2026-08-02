import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import {
  type RelayClientMessage,
  type RelayEndpointChallenge,
} from "../shared/remote-protocol";

const PROOF_CONTEXT = "inertia-relay/2/endpoint-proof";

export interface RemoteEndpointKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateRemoteEndpointKeyPair(): RemoteEndpointKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });
  return {
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}

export function signRemoteEndpointChallenge(
  challenge: RelayEndpointChallenge,
  keyPair: RemoteEndpointKeyPair,
): Extract<RelayClientMessage, { type: "relay.register.proof" }> {
  const signature = sign(
    "sha256",
    remoteEndpointProofTranscript(challenge),
    {
      key: createPrivateKey({
        key: Buffer.from(keyPair.privateKey, "base64url"),
        format: "der",
        type: "pkcs8",
      }),
      dsaEncoding: "ieee-p1363",
    },
  ).toString("base64url");
  return {
    type: "relay.register.proof",
    ...challenge,
    signature,
  };
}

export function remoteEndpointProofTranscript(
  challenge: RelayEndpointChallenge,
): Buffer {
  const fields = [
    PROOF_CONTEXT,
    challenge.purpose,
    challenge.relayIdentity,
    challenge.endpointId,
    challenge.endpointPublicKey,
    challenge.nonce,
  ].map(lengthPrefixedString);
  return Buffer.concat([
    ...fields,
    unsigned64(challenge.epoch),
    unsigned64(challenge.expiresAt),
  ]);
}

function lengthPrefixedString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function unsigned64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid relay endpoint proof integer.");
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}
