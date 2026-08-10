import { beforeEach, describe, expect, it, vi } from "vitest";

import { isPrivateConnectUuid } from "../../src/shared/private-connect/protocol";
import { browserDeviceId } from "../../src/renderer/private-connect/src/connection";

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
