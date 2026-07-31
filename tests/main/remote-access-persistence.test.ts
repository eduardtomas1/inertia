import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteAccessPersistenceQueue } from "../../src/main/remote-access-persistence";
import {
  RemoteAccessStore,
  type PersistedRemoteAccess,
} from "../../src/main/remote-access-store";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion persistence authority", () => {
  it("poisons queued writes after the first vault failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-persist-"));
    directories.push(directory);
    const store = new RemoteAccessStore(join(directory, "remote.vault"), {
      available: () => true,
      encrypt: (value) => new TextEncoder().encode(value),
      decrypt: (value) => new TextDecoder().decode(value),
    });
    let rejectFirst = (): void => undefined;
    const rejected = new Promise<void>((resolve) => {
      rejectFirst = resolve;
    });
    const save = vi.spyOn(store, "save").mockImplementation(async () => {
      await rejected;
      throw new Error("vault write failed");
    });
    const unavailable = vi.fn();
    const persistence = new RemoteAccessPersistenceQueue(store, unavailable);
    const data: PersistedRemoteAccess = {
      version: 1,
      enabled: false,
      relayUrl: "ws://127.0.0.1:8787/remote",
      hostId: crypto.randomUUID(),
      endpointId: "endpoint",
      keyPair: {
        publicKey: "public",
        privateKey: "private",
      },
      devices: [],
      audit: [],
      receipts: [],
      usedSessions: [],
    };

    const first = persistence.save(data);
    data.enabled = true;
    const second = persistence.save(data);
    rejectFirst();

    await expect(first).rejects.toThrow("vault write failed");
    await expect(second).rejects.toThrow("vault write failed");
    expect(save).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    await persistence.drain();
  });
});
