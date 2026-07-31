import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  REMOTE_PRIVACY_LOCKED_MESSAGE,
  REMOTE_PRIVACY_UNVERIFIED_MESSAGE,
  RemotePrivacyMonitor,
} from "../../src/main/remote-access-lifecycle";
import { RemoteAccessService } from "../../src/main/remote-access-service";
import type {
  RemotePrivacySuspension,
} from "../../src/main/remote-access-service-types";
import { RemoteAccessStore } from "../../src/main/remote-access-store";

type IdleState = "active" | "idle" | "locked" | "unknown";

class FakeRelaySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  send(): void {}

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function power(
  getSystemIdleState?: () => IdleState,
): EventEmitter & { getSystemIdleState?: () => IdleState } {
  return getSystemIdleState
    ? Object.assign(new EventEmitter(), { getSystemIdleState })
    : new EventEmitter();
}

function monitor(
  events: EventEmitter & { getSystemIdleState?: () => IdleState },
) {
  const changes: { locked: boolean; suspension: RemotePrivacySuspension | null }[] = [];
  const diagnostics: string[] = [];
  const instance = new RemotePrivacyMonitor(
    events as never,
    (locked, suspension) => changes.push({ locked, suspension }),
    (detail) => diagnostics.push(detail),
  );
  return { instance, changes, diagnostics };
}

describe("desktop privacy state fails closed", () => {
  it("pauses when the lock-state API is missing", () => {
    const { instance, diagnostics } = monitor(power());
    expect(instance.locked).toBe(true);
    expect(instance.suspension).toBe("unverified");
    expect(diagnostics).toEqual([
      "This platform exposes no desktop lock-state probe.",
    ]);
    instance.shutdown();
  });

  it("pauses when the lock-state probe throws", () => {
    const { instance, diagnostics } = monitor(power(() => {
      throw new Error("no probe");
    }));
    expect(instance.locked).toBe(true);
    expect(instance.suspension).toBe("unverified");
    expect(diagnostics).toEqual(["The desktop lock-state probe failed."]);
    instance.shutdown();
  });

  it("pauses when the platform cannot determine the lock state", () => {
    const { instance, diagnostics } = monitor(power(() => "unknown"));
    expect(instance.locked).toBe(true);
    expect(instance.suspension).toBe("unverified");
    expect(diagnostics).toEqual([
      'The desktop lock-state probe reported "unknown".',
    ]);
    instance.shutdown();
  });

  it("stays paused at startup while the desktop is already locked", () => {
    const { instance, diagnostics } = monitor(power(() => "locked"));
    expect(instance.locked).toBe(true);
    expect(instance.lockStateVerified).toBe(true);
    expect(instance.suspension).toBe("locked");
    expect(diagnostics).toEqual([]);
    expect(instance.probeDiagnostic).toBeNull();
    instance.shutdown();
  });

  it("resumes only for an active or idle desktop", () => {
    for (const state of ["active", "idle"] as const) {
      const { instance } = monitor(power(() => state));
      expect(instance.locked).toBe(false);
      expect(instance.lockStateVerified).toBe(true);
      expect(instance.suspension).toBeNull();
      instance.shutdown();
    }
  });

  it("reports only one diagnostic for a failed probe", () => {
    const probe = vi.fn(() => {
      throw new Error("no probe");
    });
    const { instance, diagnostics } = monitor(power(probe as never));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(1);
    expect(instance.probeDiagnostic).toBe(
      "The desktop lock-state probe failed.",
    );
    instance.shutdown();
  });

  it("does not oscillate when the probe keeps failing across monitors", () => {
    const events = power(() => {
      throw new Error("no probe");
    });
    const first = monitor(events);
    const second = monitor(events);
    expect(first.instance.locked).toBe(true);
    expect(second.instance.locked).toBe(true);
    expect(first.changes).toEqual([]);
    expect(second.changes).toEqual([]);
    first.instance.shutdown();
    second.instance.shutdown();
  });

  it("resumes after a trustworthy unlock following a failed initial probe", () => {
    const events = power(() => {
      throw new Error("no probe");
    });
    const { instance, changes } = monitor(events);
    expect(instance.locked).toBe(true);
    expect(instance.lockStateVerified).toBe(false);

    events.emit("unlock-screen");
    expect(instance.locked).toBe(false);
    expect(instance.lockStateVerified).toBe(true);
    expect(instance.suspension).toBeNull();
    expect(instance.probeDiagnostic).toBeNull();
    expect(changes).toEqual([{ locked: false, suspension: null }]);
    instance.shutdown();
  });

  it("upgrades an unverified pause to a verified lock", () => {
    const events = power(() => "unknown");
    const { instance, changes } = monitor(events);
    expect(instance.suspension).toBe("unverified");

    events.emit("lock-screen");
    expect(instance.locked).toBe(true);
    expect(instance.lockStateVerified).toBe(true);
    expect(instance.suspension).toBe("locked");
    expect(changes).toEqual([]);
    instance.shutdown();
  });

  it("locks during an active session and reports it as a verified lock", () => {
    const events = power(() => "active");
    const { instance, changes } = monitor(events);
    expect(instance.locked).toBe(false);

    events.emit("lock-screen");
    expect(instance.locked).toBe(true);
    expect(instance.suspension).toBe("locked");
    expect(changes).toEqual([{ locked: true, suspension: "locked" }]);

    events.emit("unlock-screen");
    expect(instance.locked).toBe(false);
    expect(changes).toEqual([
      { locked: true, suspension: "locked" },
      { locked: false, suspension: null },
    ]);
    instance.shutdown();
  });

  it("treats suspend as a lock", () => {
    const events = power(() => "active");
    const { instance, changes } = monitor(events);
    events.emit("suspend");
    expect(instance.locked).toBe(true);
    expect(changes).toEqual([{ locked: true, suspension: "locked" }]);
    instance.shutdown();
  });

  it("ignores events after shutdown", () => {
    const events = power(() => "active");
    const { instance, changes } = monitor(events);
    instance.shutdown();
    events.emit("lock-screen");
    expect(changes).toEqual([]);
  });

  it("blocks remote view and prompt work while the lock state is unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-unknown-"));
    directories.push(directory);
    const store = new RemoteAccessStore(join(directory, "remote.vault"), {
      available: () => true,
      encrypt: (value) => new TextEncoder().encode(value),
      decrypt: (value) => new TextDecoder().decode(value),
    });
    const createSocket = vi.fn(() => {
      throw new Error("the relay must not be dialled while paused");
    });
    const service = await RemoteAccessService.create({
      store,
      runtime: {
        remoteRequest: async () => {
          throw new Error("unused");
        },
      },
      createSocket: createSocket as never,
    });
    await service.setEnabled(true, "ws://127.0.0.1:8787/remote");

    expect(createSocket).not.toHaveBeenCalled();
    const state = service.state();
    expect(state.connection).not.toBe("online");
    expect(state.connectionMessage).toBe(REMOTE_PRIVACY_UNVERIFIED_MESSAGE);
    expect(state.activeSessions).toBe(0);
    await service.shutdown();
  });

  it("resumes dialling once a trustworthy unlock arrives", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-resume-"));
    directories.push(directory);
    const store = new RemoteAccessStore(join(directory, "remote.vault"), {
      available: () => true,
      encrypt: (value) => new TextEncoder().encode(value),
      decrypt: (value) => new TextDecoder().decode(value),
    });
    const sockets: FakeRelaySocket[] = [];
    const service = await RemoteAccessService.create({
      store,
      runtime: {
        remoteRequest: async () => {
          throw new Error("unused");
        },
      },
      createSocket: (() => {
        const socket = new FakeRelaySocket();
        sockets.push(socket);
        return socket;
      }) as never,
    });
    await service.setEnabled(true, "ws://127.0.0.1:8787/remote");
    expect(sockets).toHaveLength(0);

    service.setPrivacyLocked(false, null);
    expect(sockets).toHaveLength(1);
    expect(service.state().connectionMessage).toBeNull();
    await service.shutdown();
  });

  it("distinguishes the unverified message from the locked message", () => {
    expect(REMOTE_PRIVACY_UNVERIFIED_MESSAGE).toBe(
      "Remote Companion is paused because Inertia could not verify that this "
      + "desktop is unlocked.",
    );
    expect(REMOTE_PRIVACY_LOCKED_MESSAGE).not.toBe(
      REMOTE_PRIVACY_UNVERIFIED_MESSAGE,
    );
  });
});
