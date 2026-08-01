export const ENDPOINT_AUTH_VERSION: 2;
export const ENDPOINT_CHALLENGE_TTL_MS: 5000;
export const ENDPOINT_CHALLENGE_NONCE_BYTES: 32;

export type EndpointProofPurpose = "claim" | "register";

export interface EndpointChallenge {
  purpose: EndpointProofPurpose;
  relayIdentity: string;
  endpointId: string;
  endpointPublicKey: string;
  nonce: string;
  epoch: number;
  expiresAt: number;
}

export interface EndpointProof extends EndpointChallenge {
  type: "relay.register.proof";
  signature: string;
}

export interface EndpointBindingRecord {
  version: 1;
  endpointId: string;
  endpointPublicKey: string;
  epoch: number;
  claimedAt: string;
  lastConnectedAt: string;
}

export class EndpointBindingConflictError extends Error {}
export class EndpointEpochConflictError extends Error {}
export class EndpointBindingStoreError extends Error {}

export function endpointProofTranscript(value: EndpointChallenge): Buffer;
export function verifyEndpointProof(
  value: EndpointChallenge,
  signature: string,
): boolean;

export class EndpointBindingStore {
  static open(options: {
    stateDirectory: string;
    initialize?: boolean;
    maxEndpoints?: number;
    now?: () => number;
  }): Promise<EndpointBindingStore>;

  readonly relayIdentity: string;
  readonly size: number;

  get(endpointId: string): Promise<EndpointBindingRecord | null>;
  claim(input: {
    endpointId: string;
    endpointPublicKey: string;
    connectedAt?: string;
  }): Promise<EndpointBindingRecord>;
  advance(input: {
    endpointId: string;
    endpointPublicKey: string;
    expectedEpoch: number;
    nextEpoch: number;
    connectedAt?: string;
  }): Promise<EndpointBindingRecord>;
}

export type EndpointAuthFailureCode =
  | "capacity"
  | "challenge-expired"
  | "endpoint-missing"
  | "endpoint-owned"
  | "invalid-message"
  | "proof-invalid"
  | "rate-limited"
  | "storage-unavailable";

export type EndpointAuthResult<T> =
  | { ok: true; challenge: T }
  | { ok: false; code: EndpointAuthFailureCode };

export class EndpointAuthenticator {
  constructor(options: {
    store: EndpointBindingStore;
    now?: () => number;
    randomBytes?: (size: number) => Uint8Array;
    verifyProof?: (challenge: EndpointChallenge, signature: string) => boolean;
    challengeTtlMs?: number;
    maxChallenges?: number;
    maxIpFailures?: number;
    maxEndpointFailures?: number;
    maxRateKeys?: number;
  });

  beginClaim(input: {
    socketId: string;
    source: string;
    endpointId: string;
    endpointPublicKey: string;
  }): Promise<EndpointAuthResult<EndpointChallenge>>;
  beginRegistration(input: {
    socketId: string;
    source: string;
    endpointId: string;
  }): Promise<EndpointAuthResult<EndpointChallenge>>;
  prove(
    socketId: string,
    source: string,
    proof: EndpointProof,
  ): Promise<
    | {
        ok: true;
        ownership: "claimed" | "verified";
        binding: EndpointBindingRecord;
      }
    | { ok: false; code: EndpointAuthFailureCode }
  >;
  forgetSocket(socketId: string): void;
}
