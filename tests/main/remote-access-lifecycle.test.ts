import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  closeRemoteSocket,
  REMOTE_SHUTDOWN_TIMEOUT_MS,
  RemoteSessionAuthenticationBudget,
} from "../../src/main/remote-access-lifecycle";
import { RemoteAccessService } from "../../src/main/remote-access-service";
import { RemoteAccessStore } from "../../src/main/remote-access-store";
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
});
