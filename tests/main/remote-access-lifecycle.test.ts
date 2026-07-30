import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  closeRemoteSocket,
  REMOTE_SHUTDOWN_TIMEOUT_MS,
  RemotePrivacyMonitor,
  RemoteSessionAuthenticationBudget,
} from "../../src/main/remote-access-lifecycle";
import { RemoteAccessService } from "../../src/main/remote-access-service";
import { RemoteAccessStore } from "../../src/main/remote-access-store";
import {
  generateRemoteKeyPair,
  remoteRandomSecret,
} from "../../src/shared/remote-crypto";
import { REMOTE_LIMITS } from "../../src/shared/remote-protocol";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closeCalls = 0;
  terminateCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }

  send(): void {}

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion authentication and shutdown lifecycle", () => {
  it("bounds unauthenticated session crypto attempts and recovers after the window", () => {
    const budget = new RemoteSessionAuthenticationBudget();
    for (
      let attempt = 0;
      attempt < REMOTE_LIMITS.sessionAuthenticationAttemptsPerConnection;
      attempt += 1
    ) {
      expect(budget.take("one-connection", 10_000)).toBe(true);
    }
    expect(budget.take("one-connection", 10_000)).toBe(false);
    expect(budget.take("one-connection", 70_001)).toBe(true);

    const global = new RemoteSessionAuthenticationBudget();
    for (
      let attempt = 0;
      attempt < REMOTE_LIMITS.sessionAuthenticationAttemptsPerMinute;
      attempt += 1
    ) {
      expect(global.take(`connection-${attempt}`, 20_000)).toBe(true);
    }
    expect(global.take("global-exhausted", 20_000)).toBe(false);
    expect(global.take("global-recovered", 80_001)).toBe(true);
  });

  it("finishes graceful, erroring, closed, and stalled socket shutdowns", async () => {
    const closed = new FakeSocket();
    closed.readyState = WebSocket.CLOSED;
    await closeRemoteSocket(closed as unknown as WebSocket);
    expect(closed.terminateCalls).toBe(0);

    const graceful = new FakeSocket();
    const gracefulClose = closeRemoteSocket(
      graceful as unknown as WebSocket,
    );
    graceful.readyState = WebSocket.CLOSED;
    graceful.emit("close");
    await gracefulClose;
    expect(graceful.terminateCalls).toBe(0);

    const erroring = new FakeSocket();
    const errorClose = closeRemoteSocket(erroring as unknown as WebSocket);
    erroring.emit("error", new Error("socket failed"));
    await errorClose;
    expect(erroring.terminateCalls).toBe(1);

    vi.useFakeTimers();
    const stalled = new FakeSocket();
    const stalledClose = closeRemoteSocket(stalled as unknown as WebSocket);
    await vi.advanceTimersByTimeAsync(REMOTE_SHUTDOWN_TIMEOUT_MS);
    await stalledClose;
    expect(stalled.terminateCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes service shutdown bounded and leaves no reconnect or sweep timer", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-shutdown-"));
    directories.push(directory);
    const store = new RemoteAccessStore(join(directory, "remote.vault"), {
      available: () => true,
      encrypt: (value) => new TextEncoder().encode(value),
      decrypt: (value) => new TextDecoder().decode(value),
    });
    const socket = new FakeSocket();
    const service = await RemoteAccessService.create({
      store,
      runtime: {
        remoteRequest: async () => {
          throw new Error("unused");
        },
      },
      createSocket: () => socket as unknown as WebSocket,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });
    await service.setEnabled(true, "ws://127.0.0.1:8787");
    const shuttingDown = service.shutdown();
    await vi.advanceTimersByTimeAsync(REMOTE_SHUTDOWN_TIMEOUT_MS);
    await shuttingDown;

    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
    expect(service.state().activeSessions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an initially locked desktop offline until unlock", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-lock-"));
    directories.push(directory);
    const store = new RemoteAccessStore(join(directory, "remote.vault"), {
      available: () => true,
      encrypt: (value) => new TextEncoder().encode(value),
      decrypt: (value) => new TextDecoder().decode(value),
    });
    await store.save({
      version: 1,
      enabled: true,
      relayUrl: "ws://127.0.0.1:8787",
      hostId: crypto.randomUUID(),
      endpointId: remoteRandomSecret(24),
      keyPair: await generateRemoteKeyPair(),
      devices: [],
      audit: [],
      receipts: [],
      usedSessions: [],
    });
    const power = Object.assign(new EventEmitter(), {
      getSystemIdleState: vi.fn((_idleThreshold: number) => "locked" as const),
    });
    let service: RemoteAccessService | null = null;
    const monitor = new RemotePrivacyMonitor(
      power,
      (locked) => service?.setPrivacyLocked(locked),
    );
    const createSocket = vi.fn(() => new FakeSocket() as unknown as WebSocket);
    service = await RemoteAccessService.create({
      store,
      runtime: {
        remoteRequest: async () => {
          throw new Error("unused");
        },
      },
      autoConnect: false,
      createSocket,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });

    service.setPrivacyLocked(monitor.locked);
    service.startConnections();
    expect(power.getSystemIdleState).toHaveBeenCalledWith(60);
    expect(monitor.locked).toBe(true);
    expect(createSocket).not.toHaveBeenCalled();

    power.emit("unlock-screen");
    expect(createSocket).toHaveBeenCalledTimes(1);
    monitor.shutdown();
    const shuttingDown = service.shutdown();
    await vi.advanceTimersByTimeAsync(REMOTE_SHUTDOWN_TIMEOUT_MS);
    await shuttingDown;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed for an unknown initial state but tolerates unsupported probes", () => {
    const unknownPower = Object.assign(new EventEmitter(), {
      getSystemIdleState: () => "unknown" as const,
    });
    const unknown = new RemotePrivacyMonitor(
      unknownPower,
      () => undefined,
    );
    expect(unknown.locked).toBe(true);
    unknown.shutdown();

    const unsupportedPower = Object.assign(new EventEmitter(), {
      getSystemIdleState: () => {
        throw new Error("unsupported");
      },
    });
    const unsupported = new RemotePrivacyMonitor(
      unsupportedPower,
      () => undefined,
    );
    expect(unsupported.locked).toBe(false);
    unsupported.shutdown();
  });

  it("cannot miss a lock emitted during the initial state sample", () => {
    const power = Object.assign(new EventEmitter(), {
      getSystemIdleState: () => {
        power.emit("lock-screen");
        return "active" as const;
      },
    });
    const monitor = new RemotePrivacyMonitor(power, () => undefined);

    expect(monitor.locked).toBe(true);
    monitor.shutdown();
  });

  it("retains a lock during initialization and applies it before reconnecting", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-lock-"));
    directories.push(directory);
    const store = new RemoteAccessStore(join(directory, "remote.vault"), {
      available: () => true,
      encrypt: (value) => new TextEncoder().encode(value),
      decrypt: (value) => new TextDecoder().decode(value),
    });
    await store.save({
      version: 1,
      enabled: true,
      relayUrl: "ws://127.0.0.1:8787",
      hostId: crypto.randomUUID(),
      endpointId: remoteRandomSecret(24),
      keyPair: await generateRemoteKeyPair(),
      devices: [],
      audit: [],
      receipts: [],
      usedSessions: [],
    });
    const power = new EventEmitter();
    let service: RemoteAccessService | null = null;
    const monitor = new RemotePrivacyMonitor(
      power,
      (locked) => service?.setPrivacyLocked(locked),
    );
    const createSocket = vi.fn(() => new FakeSocket() as unknown as WebSocket);
    const creating = RemoteAccessService.create({
      store,
      runtime: {
        remoteRequest: async () => {
          throw new Error("unused");
        },
      },
      autoConnect: false,
      createSocket,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });

    power.emit("lock-screen");
    service = await creating;
    service.setPrivacyLocked(monitor.locked);
    service.startConnections();
    expect(monitor.locked).toBe(true);
    expect(createSocket).not.toHaveBeenCalled();

    power.emit("unlock-screen");
    expect(createSocket).toHaveBeenCalledTimes(1);
    monitor.shutdown();
    expect(power.listenerCount("lock-screen")).toBe(0);
    expect(power.listenerCount("suspend")).toBe(0);
    expect(power.listenerCount("unlock-screen")).toBe(0);

    const shuttingDown = service.shutdown();
    await vi.advanceTimersByTimeAsync(REMOTE_SHUTDOWN_TIMEOUT_MS);
    await shuttingDown;
    expect(vi.getTimerCount()).toBe(0);
  });
});
