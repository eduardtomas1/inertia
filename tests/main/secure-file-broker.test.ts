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
    let spawnedParent = "";
    const broker = new SecureFileBroker({
      spawn: (parent) => {
        spawnedParent = parent;
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
    expect(spawnedParent).toBe(resolve(request.root, "src"));
    expect(child.postMessage).toHaveBeenCalledWith(request);
    broker.close();
  });

  it("spawns root-level file helpers in the project root", async () => {
    const child = new FakeUtilityProcess();
    let spawnedParent = "";
    const broker = new SecureFileBroker({
      spawn: (parent) => {
        spawnedParent = parent;
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

    await expect(broker.perform({
      ...request,
      path: "example.ts",
      parentIdentities: [],
    })).resolves.toEqual(success);
    expect(spawnedParent).toBe(request.root);
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

  it("does not deliver a cancelled replacement that spawns late", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          return utility(child);
        },
        timeoutMs: 100,
        killGraceMs: 10,
      });
      const replacement: SecureFileRequest = {
        ...request,
        operation: "replace",
        expectedDigest: "a".repeat(64),
        contentBase64: Buffer.from("replacement").toString("base64"),
        expectedMode: 0o644,
        mode: 0o644,
      };
      const controller = new AbortController();
      const first = broker.perform(replacement, controller.signal);
      await vi.waitFor(() => expect(children).toHaveLength(1));

      controller.abort();
      expect(children[0]!.kill).toHaveBeenCalledOnce();
      children[0]!.emit("spawn");
      expect(children[0]!.postMessage).not.toHaveBeenCalled();
      expect(children[0]!.kill).toHaveBeenCalledTimes(2);

      let firstSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(firstSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      const blocked = broker.perform(replacement);
      await expect(blocked).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(children).toHaveLength(1);

      const activeOthers = ["src/one.ts", "src/two.ts", "src/three.ts"].map(
        (path) => broker.perform({ ...request, path }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(4);
      for (const child of children.slice(1)) child.emit("spawn");

      const capacityWaiter = broker.perform({
        ...request,
        path: "src/four.ts",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(4);

      children[0]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(5);
      children[4]!.emit("spawn");
      for (const child of children.slice(1)) {
        child.emit("message", success);
        child.emit("exit", 0);
      }
      await expect(Promise.all([...activeOthers, capacityWaiter])).resolves
        .toEqual([success, success, success, success]);
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
