import { describe, expect, it } from "vitest";

import { authenticatedRemoteRejectionIsCurrent } from "../../src/main/remote-access-session-handshake";
import type {
  PersistedRemoteAccess,
  PersistedRemoteDevice,
} from "../../src/main/remote-access-store";

describe("Remote Companion rejected session ownership", () => {
  it("suppresses a sealed rejection when authority changes during replay persistence", async () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const device = {
      id: crypto.randomUUID(),
      grantVersion: 1,
      revokedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    } as PersistedRemoteDevice;
    const data = { devices: [device] } as PersistedRemoteAccess;
    let releasePersistence = (): void => undefined;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const decision = (async () => {
      await persistence;
      return authenticatedRemoteRejectionIsCurrent({
        data,
        device,
        authenticated: {
          disposition: "revoked",
          subject: { grantVersion: 1 },
        } as Parameters<
          typeof authenticatedRemoteRejectionIsCurrent
        >[0]["authenticated"],
        now,
        current: () => true,
      });
    })();

    device.revokedAt = null;
    device.grantVersion = 2;
    releasePersistence();

    await expect(decision).resolves.toBe(false);
  });

  it("requires the matched device admission to remain current", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const device = {
      grantVersion: 1,
      revokedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    } as PersistedRemoteDevice;
    expect(authenticatedRemoteRejectionIsCurrent({
      data: { devices: [device] } as PersistedRemoteAccess,
      device,
      authenticated: {
        disposition: "revoked",
        subject: { grantVersion: 1 },
      } as Parameters<
        typeof authenticatedRemoteRejectionIsCurrent
      >[0]["authenticated"],
      now,
      current: () => false,
    })).toBe(false);
  });
});
