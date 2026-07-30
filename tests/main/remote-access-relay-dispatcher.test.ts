import { describe, expect, it, vi } from "vitest";

import { RemoteRelayDispatcher } from "../../src/main/remote-access-relay-dispatcher";
import {
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCipherFrame,
} from "../../src/shared/remote-protocol";

function message(value: object): Buffer {
  return Buffer.from(JSON.stringify({
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    ...value,
  }));
}

function dataFrame(
  sessionId: string,
  sequence: number,
): RemoteCipherFrame {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    kind: "session.data",
    sessionId,
    sequence,
    ciphertext: "valid_ciphertext",
  };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return vi.waitFor(() => {
    expect(predicate()).toBe(true);
  });
}

describe("Remote Companion relay frame ownership", () => {
  it("serializes frames and invalidates ownership before queued disconnect cleanup", async () => {
    const connectionId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sequences: number[] = [];
    const disconnected = vi.fn();
    const dispatcher = new RemoteRelayDispatcher({
      registered: vi.fn(),
      error: vi.fn(),
      frame: async (_id, _epoch, frame) => {
        if (frame.kind !== "session.data") return;
        sequences.push(frame.sequence);
        if (frame.sequence === 0) await released;
      },
      disconnected,
      oversized: vi.fn(),
    });
    dispatcher.receive(message({ type: "relay.peer-connected", connectionId }));
    dispatcher.receive(message({
      type: "relay.frame",
      connectionId,
      frame: dataFrame(sessionId, 0),
    }));
    await waitFor(() => sequences.length === 1);
    dispatcher.receive(message({
      type: "relay.frame",
      connectionId,
      frame: dataFrame(sessionId, 1),
    }));
    expect(sequences).toEqual([0]);

    dispatcher.receive(message({
      type: "relay.peer-disconnected",
      connectionId,
    }));
    release();
    await waitFor(() => disconnected.mock.calls.length === 1);
    expect(sequences).toEqual([0]);
    expect(disconnected.mock.calls[0]?.[0]).toBe(connectionId);
  });

  it("drops a route when its bounded encrypted-frame queue is exhausted", async () => {
    const connectionId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disconnected = vi.fn();
    const dispatcher = new RemoteRelayDispatcher({
      registered: vi.fn(),
      error: vi.fn(),
      frame: () => released,
      disconnected,
      oversized: vi.fn(),
    });
    dispatcher.receive(message({ type: "relay.peer-connected", connectionId }));
    for (
      let sequence = 0;
      sequence <= REMOTE_LIMITS.queuedFramesPerConnection;
      sequence += 1
    ) {
      dispatcher.receive(message({
        type: "relay.frame",
        connectionId,
        frame: dataFrame(sessionId, sequence),
      }));
    }

    expect(disconnected).toHaveBeenCalledTimes(1);
    release();
  });
});
