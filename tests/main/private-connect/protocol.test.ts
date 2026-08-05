import { describe, expect, it } from "vitest";

import {
  createPrivateConnectInvitation,
  createPrivateConnectPairingLink,
  parsePrivateConnectPairingFragment,
} from "../../../src/shared/private-connect/pairing-link";
import {
  privateConnectInvitationSchema,
  privateConnectRequestSchema,
  privateConnectResponseSchema,
} from "../../../src/shared/private-connect/protocol";
import { normalizePrivateConnectGrants } from "../../../src/shared/private-connect/grants";
import { scopesForPreset } from "../../../src/shared/private-connect/scopes";

const hostId = "11111111-1111-4111-8111-111111111111";

describe("Private Connect shared contract", () => {
  it("keeps pairing credentials in a clean fragment and rejects query credentials", () => {
    const invitation = createPrivateConnectInvitation(hostId, new Date("2030-01-01T00:00:00.000Z"));
    const link = createPrivateConnectPairingLink("https://host.tailnet.ts.net/", invitation);
    expect(new URL(link).search).toBe("");
    expect(new URL(link).hash.startsWith("#pair=")).toBe(true);
    expect(parsePrivateConnectPairingFragment(new URL(link).hash)).toEqual(invitation);
    expect(() => createPrivateConnectPairingLink("http://host.tailnet.ts.net/", invitation)).toThrow();
  });

  it("rejects extra fields at the pairing and request boundaries", () => {
    const invitation = createPrivateConnectInvitation(hostId);
    expect(privateConnectInvitationSchema.safeParse({ ...invitation, relayUrl: "https://bad.example" }).success).toBe(false);
    expect(privateConnectRequestSchema.safeParse({
      protocolVersion: 1,
      type: "client.ping",
      requestId: "22222222-2222-4222-8222-222222222222",
      arbitrary: true,
    }).success).toBe(false);
  });

  it("normalizes grants and keeps preset scopes explicit", () => {
    expect(normalizePrivateConnectGrants([
      { projectId: "project", conversationIds: ["conversation", "conversation"], includeFutureConversations: false },
      { projectId: "project", conversationIds: ["other"], includeFutureConversations: true },
    ])).toEqual([{
      projectId: "project",
      conversationIds: ["conversation", "other"],
      includeFutureConversations: true,
    }]);
    expect(scopesForPreset("monitor")).toEqual(["private:read"]);
    expect(scopesForPreset("collaborate")).toContain("private:stop");
  });

  it("validates browser responses before they are projected into the UI", () => {
    const requestId = "22222222-2222-4222-8222-222222222222";
    expect(privateConnectResponseSchema.safeParse({ type: "response", requestId, ok: true, result: { kind: "state" } }).success).toBe(true);
    expect(privateConnectResponseSchema.safeParse({ type: "response", requestId, ok: false, code: "unavailable", message: "retry" }).success).toBe(true);
    expect(privateConnectResponseSchema.safeParse({ type: "response", requestId, ok: false, code: "bad", message: "retry" }).success).toBe(false);
    expect(privateConnectResponseSchema.safeParse({ type: "response", requestId, ok: true, result: {}, extra: true }).success).toBe(false);
  });
});
