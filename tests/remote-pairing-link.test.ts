import { describe, expect, it } from "vitest";

import {
  createRemotePairingLink,
  parseRemotePairingFragment,
} from "../src/shared/remote-pairing-link";
import type { RemotePairingInvitation } from "../src/shared/remote-protocol";

const invitation: RemotePairingInvitation = {
  protocolVersion: 2,
  relayUrl: "wss://relay.example/remote",
  relayIdentity: "189dd54b-655b-4f8a-ae52-d90531c829c9",
  desktop: {
    kind: "desktop",
    version: "0.2.0",
    relayProtocol: { minimum: 2, maximum: 2 },
    remoteProtocol: { minimum: 2, maximum: 2 },
  },
  endpointId: "endpoint_identifier",
  hostId: "2a46fcf8-2637-4c01-a87f-09c634b86c73",
  hostPublicKey: "valid_host_public_key",
  invitationId: "65bf6aa0-bcdb-4565-ab81-887a9e2c94ff",
  pairingSecret: "short_lived_secret",
  expiresAt: "2026-08-02T12:05:00.000Z",
};

describe("Remote Companion client-fragment pairing links", () => {
  it("round-trips invitation material only through the URL fragment", () => {
    const link = createRemotePairingLink(
      "https://companion.example/private/",
      invitation,
    );
    const url = new URL(link);

    expect(url.search).toBe("");
    expect(url.pathname).toBe("/private/");
    expect(url.hash).toMatch(/^#pair=[A-Za-z0-9_-]+$/u);
    expect(parseRemotePairingFragment(url.hash)).toEqual(invitation);
    expect(`${url.origin}${url.pathname}`).not.toContain(
      invitation.pairingSecret,
    );
  });

  it("rejects query-bearing companion URLs and malformed fragments", () => {
    expect(() => createRemotePairingLink(
      "https://companion.example/?invite=server-visible",
      invitation,
    )).toThrow("query strings");
    expect(() => parseRemotePairingFragment("#pair=not-json"))
      .toThrow("invalid or incompatible");
    expect(parseRemotePairingFragment("")).toBeNull();
  });
});
