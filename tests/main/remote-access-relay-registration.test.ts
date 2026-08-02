import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateRemoteEndpointKeyPair,
} from "../../src/main/remote-access-endpoint-auth";
import {
  REMOTE_RELAY_CHALLENGE_CLOCK_SKEW_MS,
  REMOTE_RELAY_CHALLENGE_TTL_MS,
  RemoteRelayRegistration,
} from "../../src/main/remote-access-relay-registration";
import type { PersistedRemoteAccess } from "../../src/main/remote-access-store";
import {
  RELAY_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RelayClientMessage,
  type RelayServerMessage,
} from "../../src/shared/remote-protocol";

const NOW = new Date("2032-01-02T03:04:05.000Z");
const TIMEOUT_MS = 10_000;
const TRANSIT_MS = 250;
const RELAY_IDENTITY = "40e581f4-afc6-4eb3-b663-f0ce27f07145";

type RelayChallenge = Extract<
  RelayServerMessage,
  { type: "relay.register.challenge" }
>;

afterEach(() => vi.restoreAllMocks());

describe("Remote Companion relay registration", () => {
  it.each([
    ["relay clock exactly 30 seconds ahead with delayed delivery", (TRANSIT_MS / 2) + REMOTE_RELAY_CHALLENGE_CLOCK_SKEW_MS, true],
    ["desktop clock exactly 30 seconds ahead with delayed delivery", (TRANSIT_MS / 2) - REMOTE_RELAY_CHALLENGE_CLOCK_SKEW_MS, true],
    ["relay clock beyond the possible delayed-delivery bound", TRANSIT_MS + REMOTE_RELAY_CHALLENGE_CLOCK_SKEW_MS + 1, false],
    ["desktop clock ahead beyond the bound", -REMOTE_RELAY_CHALLENGE_CLOCK_SKEW_MS - 1, false],
  ] as const)("handles %s", (_label, issuedAtOffset, accepted) => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(NOW.getTime())
      .mockReturnValue(NOW.getTime() + TRANSIT_MS);
    const endpointKeyPair = generateRemoteEndpointKeyPair();
    const data = {
      endpointId: "endpoint_test",
      endpointKeyPair,
      relayBinding: null,
    } as PersistedRemoteAccess;
    const sent: RelayClientMessage[] = [];
    const rejected: string[] = [];
    const registration = new RemoteRelayRegistration({
      data: () => data,
      endpointKeyPair: () => endpointKeyPair,
      now: () => NOW,
      persist: async () => undefined,
      send: (message) => sent.push(message),
      reject: (message) => rejected.push(message),
      online: () => undefined,
    });
    registration.begin({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.hello",
      relayVersion: "0.2.0",
      relayIdentity: RELAY_IDENTITY,
      relayProtocol: {
        minimum: RELAY_PROTOCOL_VERSION,
        maximum: RELAY_PROTOCOL_VERSION,
      },
      remoteProtocol: {
        minimum: REMOTE_PROTOCOL_VERSION,
        maximum: REMOTE_PROTOCOL_VERSION,
      },
      endpointAuthentication: "required",
      persistence: "durable",
    });
    sent.length = 0;
    const challenge: RelayChallenge = {
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.register.challenge",
      relayProtocol: {
        minimum: RELAY_PROTOCOL_VERSION,
        maximum: RELAY_PROTOCOL_VERSION,
      },
      remoteProtocol: {
        minimum: REMOTE_PROTOCOL_VERSION,
        maximum: REMOTE_PROTOCOL_VERSION,
      },
      purpose: "claim",
      relayIdentity: RELAY_IDENTITY,
      endpointId: data.endpointId,
      endpointPublicKey: endpointKeyPair.publicKey,
      nonce: "challenge_nonce",
      epoch: 1,
      expiresAt: NOW.getTime() + REMOTE_RELAY_CHALLENGE_TTL_MS
        + issuedAtOffset,
    };

    registration.prove(challenge, TIMEOUT_MS);

    if (accepted) {
      expect(rejected).toEqual([]);
      expect(sent).toEqual([expect.objectContaining({
        type: "relay.register.proof",
        expiresAt: challenge.expiresAt,
      })]);
    } else {
      expect(sent).toEqual([]);
      expect(rejected).toEqual(["The relay endpoint challenge was invalid."]);
    }
  });
});
