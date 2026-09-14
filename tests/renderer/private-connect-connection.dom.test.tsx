import { beforeEach, describe, expect, it, vi } from "vitest";

import { isPrivateConnectUuid } from "../../src/shared/private-connect/protocol";
import { browserDeviceId, parsePairingFragment } from "../../src/renderer/private-connect/src/connection";
import { createPrivateConnectInvitation, createPrivateConnectPairingLink } from "../../src/shared/private-connect/pairing-link";

const STORAGE_KEY = "inertia-private-connect-device-id";
const VALID_DEVICE_ID = "55555555-5555-4555-8555-555555555555";
const REPLACEMENT_DEVICE_ID = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("Private Connect browser identity", () => {
  it("reuses a persisted device identifier accepted by the shared boundary", () => {
    window.localStorage.setItem(STORAGE_KEY, VALID_DEVICE_ID);
    const randomUuid = vi.spyOn(crypto, "randomUUID");

    expect(browserDeviceId()).toBe(VALID_DEVICE_ID);
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it.each([
    "------------------------------------",
    "00000000-0000-0000-0000-000000000000",
    "99999999-9999-9999-9999-999999999999",
  ])("replaces malformed persisted identity %s", (persisted) => {
    window.localStorage.setItem(STORAGE_KEY, persisted);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REPLACEMENT_DEVICE_ID);

    expect(isPrivateConnectUuid(persisted)).toBe(false);
    expect(browserDeviceId()).toBe(REPLACEMENT_DEVICE_ID);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(REPLACEMENT_DEVICE_ID);
  });
});

describe("Private Connect browser pairing validation", () => {
  const invitation = createPrivateConnectInvitation(VALID_DEVICE_ID, new Date("2030-01-01T00:00:00.000Z"));
  const fragment = (value: unknown): string => `#pair=${btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;

  it("accepts an invitation produced by the desktop boundary", () => {
    const link = createPrivateConnectPairingLink("https://desktop.example.ts.net/", invitation);
    expect(parsePairingFragment(new URL(link).hash)).toEqual(invitation);
  });

  it.each([
    { hostId: "" },
    { invitationId: "not-a-uuid" },
    { pairingSecret: "short" },
    { pairingSecret: "+".repeat(43) },
    { createdAt: "yesterday" },
    { expiresAt: "tomorrow" },
    { protocolVersion: 2 },
    { redirectUrl: "https://unexpected.example/" },
  ])("rejects malformed or extra invitation fields: %j", (override) => {
    expect(parsePairingFragment(fragment({ ...invitation, ...override }))).toBeNull();
  });

  it.each([null, "", "#pair=", "#pair=!", "#pair=" + "a".repeat(8_193), "#pair=e30&secret=ignored"])("rejects invalid fragment %s", (value) => {
    expect(parsePairingFragment(value)).toBeNull();
  });
});
