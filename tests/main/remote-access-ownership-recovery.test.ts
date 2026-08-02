import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createRemoteAccessIdentity } from "../../src/main/remote-access-identity";
import { RemoteAccessService } from "../../src/main/remote-access-service";
import { DEFAULT_REMOTE_RELAY_URL } from "../../src/main/remote-access-policy";
import { RemoteAccessStore } from "../../src/main/remote-access-store";
import { RELAY_PROTOCOL_VERSION } from "../../src/shared/remote-protocol";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class RelaySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;

  send(): void {}

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  close(): void {
    this.terminate();
  }
}

function encryptedStore(): RemoteAccessStore {
  const directory = mkdtempSync(join(tmpdir(), "inertia-remote-ownership-"));
  directories.push(directory);
  return new RemoteAccessStore(join(directory, "remote.vault"), {
    available: () => true,
    encrypt: (plaintext) => new TextEncoder().encode(plaintext),
    decrypt: (ciphertext) => new TextDecoder().decode(ciphertext),
  });
}

describe("Remote Companion endpoint ownership recovery", () => {
  it.each([
    [
      "endpoint-missing",
      "missing",
      "The relay lost this endpoint binding. Create a fresh endpoint and re-pair.",
    ],
    [
      "endpoint-owned",
      "owned-by-another-key",
      "The relay endpoint is owned by another signing key.",
    ],
  ] as const)(
    "projects relay %s as manual endpoint recovery",
    async (code, endpointOwnership, message) => {
      const socket = new RelaySocket();
      const store = encryptedStore();
      const { data } = await createRemoteAccessIdentity(
        store,
        DEFAULT_REMOTE_RELAY_URL,
      );
      data.enabled = true;
      data.relayBinding = code === "endpoint-missing" ? {
        relayIdentity: crypto.randomUUID(),
        epoch: 1,
        lastConnectedAt: null,
        connectedAt: new Date().toISOString(),
      } : null;
      await store.save(data);
      const service = await RemoteAccessService.create({
        initialPrivacy: null,
        autoConnect: false,
        store,
        createSocket: () => socket as unknown as WebSocket,
        runtime: { remoteRequest: async () => {
          throw new Error("unused");
        } },
      });
      service.startConnections();
      socket.emit("open");
      socket.emit("message", Buffer.from(JSON.stringify({
        relayProtocolVersion: RELAY_PROTOCOL_VERSION,
        type: "relay.error",
        code,
      })), false);

      expect(service.state()).toMatchObject({
        connectionMessage: message,
        diagnostics: {
          status: "failed",
          endpointOwnership,
          retryClass: "manual",
          failureClass: "endpoint-authentication",
          message,
        },
      });
      await service.shutdown();
    },
  );
});
