import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import type { UtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";

import { SecureFileBroker } from "../../src/main/secure-file-broker";
import type {
  SecureFileRequest,
  SecureFileResult,
} from "../../src/node/secure-file-protocol";

const request: SecureFileRequest = {
  operation: "read",
  root: resolve("/tmp", "workspace"),
  rootIdentity: { dev: "1", ino: "2" },
  parentIdentities: [{ dev: "1", ino: "3" }],
  targetIdentity: { dev: "1", ino: "4" },
  path: "src/example.ts",
  maxBytes: 1024,
};

const success: SecureFileResult = {
  ok: true,
  operation: "read",
  contentBase64: Buffer.from("ok").toString("base64"),
  metadata: {
    digest: "a".repeat(64),
    size: 2,
    modifiedAt: new Date(0).toISOString(),
    mode: 0o644,
  },
};

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
}

function utility(fake: FakeUtilityProcess): UtilityProcess {
  return fake as unknown as UtilityProcess;
}

describe("secure file broker", () => {
  it("delivers one strict request and accepts one validated result", async () => {
    const child = new FakeUtilityProcess();
    const broker = new SecureFileBroker({
      spawn: () => {
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    child.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("message", success);
        child.emit("exit", 0);
      });
    });

    await expect(broker.perform(request)).resolves.toEqual(success);
    expect(child.postMessage).toHaveBeenCalledWith(request);
    broker.close();
  });

  it("serializes operations for the same target", async () => {
    const children: FakeUtilityProcess[] = [];
    const broker = new SecureFileBroker({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });

    const first = broker.perform(request);
    const second = broker.perform(request);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit("message", success);
    children[0]!.emit("exit", 0);
    await expect(first).resolves.toEqual(success);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.emit("message", success);
    children[1]!.emit("exit", 0);
    await expect(second).resolves.toEqual(success);
    broker.close();
  });

  it("kills a timed-out helper and reports an unavailable outcome", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess();
      const broker = new SecureFileBroker({
        spawn: () => {
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 25,
        killGraceMs: 10,
      });
      const pending = broker.perform(request);
      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit("exit", 1);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed helper output without trusting it", async () => {
    const child = new FakeUtilityProcess();
    const broker = new SecureFileBroker({
      spawn: () => {
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    child.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("message", {
          ...success,
          metadata: { ...success.metadata, digest: "not-a-digest" },
        });
        child.emit("exit", 1);
      });
    });

    await expect(broker.perform(request)).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(child.kill).toHaveBeenCalledOnce();
    broker.close();
  });

  it("poisons a target until a killed helper confirms exit", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 25,
        killGraceMs: 10,
      });

      const first = broker.perform(request);
      const second = broker.perform(request);
      await vi.advanceTimersByTimeAsync(35);
      await expect(first).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      await expect(second).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(children).toHaveLength(1);

      children[0]!.emit("exit", 1);
      const third = broker.perform(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(2);
      children[1]!.emit("message", success);
      children[1]!.emit("exit", 0);
      await expect(third).resolves.toEqual(success);
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
